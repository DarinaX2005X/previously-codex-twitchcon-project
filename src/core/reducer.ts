import { defaultSettings, safetyAllowsPublication, SourceSchema, SettingsSchema } from '../shared/contracts/index.js';
import type { Channel, Session, Settings, Clock, Safety, VersionRef, Chapter, CurrentState, PublicSnapshot, Source, Lore, RecapLanguage } from '../shared/contracts/index.js';
import { DOMAIN_LIMITS, type DomainState, type DomainEvent, type DomainEffect, type DomainTransition, type DerivedNode, type StoryCandidate } from './types.js';
import { buildEvidencePacket, packetRefs, validateStoryPatch, canonical, stateHash, uniqueRefs, refOf, isRefActive, sourceAllowed, sourceTombstoned, dependencyRange, leafRefs, blockedPhrase, normalizeTerm, evidencePacketBytes, EVIDENCE_PACKET_BYTE_CAP, overlaps } from './evidence.js';
import { invalidateDomain } from './privacy.js';
import { advanceWindows, observeChat, observePhrase, saveMoment } from './moments.js';
import { compileRecap, canDispatch } from './recap.js';
import { reconcilePrivacyEpoch } from './epoch.js';
import { publishedLore, loreLanguageReady, recordLorePresentation, retireLorePresentations } from './lore-presentations.js';

const iso=(ms:number)=>new Date(ms).toISOString();
const offset=(s:DomainState,c:Clock)=>Math.max(0,c.now()-Date.parse(s.session.startedAt));
const safeDefault:Safety={moderation:'pending',pii:'pending',checkedAt:null,reason:null};
const ownerLanguage=(source:Source,fallback:RecapLanguage):RecapLanguage=>source.languageCodes.find((language):language is RecapLanguage=>language==='en'||language==='ru')??fallback;
export function createDomainState(input:{channel:Channel;session:Session;settings?:Settings;blockedTerms?:string[];bannedActors?:string[];tombstones?:DomainState['tombstones']}):DomainState {
  return {version:1,revision:0,channel:structuredClone(input.channel),session:structuredClone(input.session),metadataReviewed:false,settings:structuredClone(input.settings??defaultSettings),sources:[],nodes:{},memory:[],chapters:[],lore:[],lorePresentations:[],moments:[],media:[],candidates:[],published:null,current:null,activeChapterId:null,ownerRevisions:{},ownerLocks:[],suppressedIds:[],editorialExcludedRefs:[],tombstones:structuredClone(input.tombstones??[]),bannedActors:[...input.bannedActors??[]],blockedTerms:(input.blockedTerms??[]).map(normalizeTerm),captureEpoch:0,chatClearThroughMs:null,sourceRevision:0,processedSourceRevision:0,lastCurrentAtMs:null,lastChapterAtMs:null,pendingGeneration:null,boundary:null,sequence:0,windows:[],openWindow:null,lastAutoMomentAtMs:null,pendingClipId:null,phrases:[],playbacks:[],playbackTiming:{},seenTriggers:[],lastRecapRevision:null,closing:null,nextGenerationAfterMs:0,gaps:[],lastReceipt:null};
}
function upsertNode(s:DomainState,effects:DomainEffect[],node:DerivedNode){s.nodes[node.id]=node;effects.push({type:'entity.upsert',node:structuredClone(node)});}
function promotePlayback(s:DomainState,effects:DomainEffect[],clock:Clock){
  if(s.playbacks.some(p=>['preparing','playing'].includes(p.status)))return;
  const next=s.playbacks.find(p=>p.status==='queued');if(!next)return;
  if(!next.plan||!canDispatch(s,next.plan)){next.status='cancelled';next.plan=null;effects.push({type:'playback.cancel',playback:structuredClone(next)});return;}
  next.status='preparing';next.startAt=null;s.playbackTiming[next.id]={prepareAtMs:clock.now(),startAtMs:null};effects.push({type:'playback.prepare',playback:structuredClone(next)});
}
function advancePlayback(s:DomainState,effects:DomainEffect[],clock:Clock){
  for(const p of s.playbacks){const timing=s.playbackTiming[p.id];if(!timing)continue;
    if(p.status==='preparing'&&p.startAt===null&&timing.prepareAtMs!==null&&clock.now()-timing.prepareAtMs>=1500){p.status='cancelled';p.plan=null;effects.push({type:'playback.cancel',playback:structuredClone(p)});}
    else if(p.status==='preparing'&&p.startAt!==null&&clock.now()-Date.parse(p.startAt)>3000){p.status='skipped';p.plan=null;effects.push({type:'playback.cancel',playback:structuredClone(p)});}
    else if(p.status==='playing'&&p.plan&&p.startAt&&clock.now()>=Date.parse(p.startAt)+p.plan.durationMs){p.status='ended';effects.push({type:'playback.cancel',playback:structuredClone(p)});}
  }
  promotePlayback(s,effects,clock);
}
function publish(s:DomainState,effects:DomainEffect[],clock:Clock,priority=false,final=false){
  final=final||s.session.status==='finalized';if(final)s.session.finalSnapshotAckAt=null;
  const old=s.published,hold=s.settings.publicationDelaySeconds*1000;
  const matured=(end:number)=>Date.parse(s.session.startedAt)+end+hold<=clock.now();
  const chapters=old?.chapters??[];
  const lore=publishedLore(s,clock);
  const moments=s.moments.filter(m=>m.dependencyRefs.every(r=>isRefActive(s,r))&&matured(m.maxDependencyEndMs)).map(({sessionId:_s,revision:_r,count:_c,distinctActors:_a,baseline:_b,mediaId:_m,dependencyRefs:_d,...m})=>m);
  const metadataSafe=s.metadataReviewed&&matured(s.session.metadataMaxDependencyEndMs);
  const contentEnd=Math.max(old?Date.parse(old.asOf)-Date.parse(s.session.startedAt):0,...chapters.map(c=>c.maxDependencyEndMs),...lore.map(l=>l.maxDependencyEndMs),...moments.map(m=>m.maxDependencyEndMs),s.current?.maxDependencyEndMs??0);
  s.session.publicationRevision++;
  s.published={schemaVersion:1,channel:s.channel,session:{id:s.session.id,title:metadataSafe?s.session.title:old?.session.title??'',category:metadataSafe?s.session.category:old?.session.category??'',startedAt:s.session.startedAt,endedAt:s.session.endedAt,status:s.session.status,metadataMaxDependencyEndMs:metadataSafe?s.session.metadataMaxDependencyEndMs:old?.session.metadataMaxDependencyEndMs??0},revision:s.session.publicationRevision,privacyEpoch:s.session.privacyEpoch,language:s.settings.recapLanguage,asOf:iso(Date.parse(s.session.startedAt)+contentEnd),publishedAt:clock.iso(),liveLeaseUntil:final?null:iso(clock.now()+30000),current:s.current,chapters,lore,moments,gaps:s.gaps,lastSyncedAt:old?.lastSyncedAt??null,vodUrl:old?.vodUrl??null};
  effects.push({type:'publication',snapshot:structuredClone(s.published),priority,final});
}
function publicChapter(c:Chapter){const {sessionId:_s,ownerEditRevision:_o,publicationState:_p,eligibleAt:_e,safety:_sf,dependencyRefs:_d,...publicValue}=c;return publicValue;}
function eligibleCandidates(s:DomainState,effects:DomainEffect[],clock:Clock):boolean {
  let changed=false;
  const entities=[...new Set(s.candidates.map(c=>c.entityId))];
  for(const entityId of entities){
    const eligible=s.candidates.filter(c=>c.entityId===entityId&&(c.status==='pending'&&c.privacyEpoch===s.session.privacyEpoch||c.status==='published'&&!s.published?.chapters.some(p=>p.id===entityId&&p.revision===c.revision))&&c.language===s.settings.recapLanguage&&c.eligibleAtMs<=clock.now()&&c.ownerRevision===(s.ownerRevisions[entityId]??0)&&!s.suppressedIds.includes(entityId)&&safetyAllowsPublication(c.safety)&&c.inputRefs.every(r=>isRefActive(s,r))).sort((a,b)=>b.revision-a.revision);
    const next=eligible[0];if(!next)continue;
    const prev=s.published?.chapters.find(c=>c.id===entityId);
    if(prev&&prev.revision>next.revision){next.status='rejected';continue;}
    next.status='published';for(const candidate of s.candidates)if(candidate.entityId===entityId&&candidate.language===next.language&&candidate.revision<next.revision)candidate.status='rejected';
    const canonicalChapter=s.chapters.find(c=>c.id===entityId&&c.revision===next.revision);if(canonicalChapter)canonicalChapter.publicationState='published';
    if(!s.published)publish(s,effects,clock);
    s.published!.chapters=[...s.published!.chapters.filter(c=>c.id!==entityId),{...publicChapter(next.chapter),pinned:s.chapters.find(c=>c.id===entityId)?.pinned??next.chapter.pinned}].sort((a,b)=>a.startMs-b.startMs||a.id.localeCompare(b.id)).slice(-300);
    if(entityId===s.activeChapterId)s.current=next.current;
    changed=true;
  }
  if(changed)publish(s,effects,clock);
  return changed;
}
function addCandidate(s:DomainState,effects:DomainEffect[],candidate:StoryCandidate):boolean {
  const group=s.candidates.filter(c=>c.entityId===candidate.entityId&&c.status!=='rejected');
  if(group.length>=4){const removable=group.some(c=>c.status==='published')?group.filter(c=>c.status==='pending').sort((a,b)=>a.revision-b.revision)[0]:undefined;if(removable)s.candidates=s.candidates.filter(c=>c.id!==removable.id);else {effects.push({type:'held',reason:'candidate_capacity',entityId:candidate.entityId});return false;}}
  if(candidate.current){candidate.currentNodeId=`current:${stateHash(candidate.id)}`;upsertNode(s,effects,{id:candidate.currentNodeId,revision:1,kind:'current_state',supports:candidate.chapter.dependencyRefs,exposedTo:candidate.inputRefs,startMs:candidate.chapter.startMs,endMs:candidate.chapter.maxDependencyEndMs,active:true,body:{state:candidate.current,claimIds:candidate.chapter.claimIds}});}
  s.candidates.push(structuredClone(candidate));effects.push({type:'candidate.save',candidate:structuredClone(candidate)});
  upsertNode(s,effects,{id:candidate.id,revision:1,kind:'presentation',supports:candidate.chapter.dependencyRefs,exposedTo:uniqueRefs([...candidate.inputRefs,...candidate.currentNodeId?[{id:candidate.currentNodeId,revision:1}]:[]]),startMs:candidate.chapter.startMs,endMs:candidate.chapter.maxDependencyEndMs,active:true,body:structuredClone(candidate)});
  return true;
}
function requestGeneration(s:DomainState,effects:DomainEffect[],clock:Clock){
  if(s.pendingGeneration||s.session.status==='finalized'||s.settings.listeningPaused&&s.session.status!=='closing'||s.sourceRevision<=s.processedSourceRevision||clock.now()<s.nextGenerationAfterMs)return;
  const final=s.session.status==='closing';
  if(final&&s.closing&&clock.now()>s.closing.deadlineMs)return;
  const currentDue=s.lastCurrentAtMs===null||clock.now()-s.lastCurrentAtMs>=45000;
  const chapterDue=s.lastChapterAtMs===null||clock.now()-s.lastChapterAtMs>=120000;
  if(!final&&!s.boundary&&!currentDue)return;
  const packet=buildEvidencePacket(s);if(!packet.sources.length&&!packet.memory.length)return;
  let entityId=s.activeChapterId;
  if(!entityId||s.boundary||s.ownerLocks.includes(entityId)||s.suppressedIds.includes(entityId)){entityId=`chapter:${s.session.id}:${++s.sequence}`;}
  // Freeze chapter context before the target's draft revision changes. Input IDs are immutable.
  packet.chapters=packet.chapters.map(chapter=>{
    const id=`context:${chapter.id}:${chapter.revision}`;
    if(!s.nodes[id])upsertNode(s,effects,{id,revision:1,kind:'provider_cache',supports:leafRefs(s,[refOf(chapter)]),exposedTo:leafRefs(s,[refOf(chapter)]),startMs:chapter.startMs,endMs:chapter.maxDependencyEndMs,active:true,body:chapter});
    return {...chapter,id,revision:1};
  });
  while(evidencePacketBytes(packet)>EVIDENCE_PACKET_BYTE_CAP&&packet.chapters.length)packet.chapters.shift();
  const inputRefs=packetRefs(s,packet),range=dependencyRange(s,inputRefs),chapter=s.chapters.find(c=>c.id===entityId);
  const ticket={channelId:s.session.channelId,runId:s.session.runId,jobId:`generation:${s.session.id}:${++s.sequence}`,sessionId:s.session.id,privacyEpoch:s.session.privacyEpoch,baseEntityRevision:chapter?.revision??0,inputRefs,inputHash:stateHash(packet),schemaVersion:1,promptVersion:'grounded-v1',recapLanguage:s.settings.recapLanguage,eligibleAt:iso(Date.parse(s.session.startedAt)+range.endMs+s.settings.publicationDelaySeconds*1000),ownerEditRevision:s.ownerRevisions[entityId]??0};
  const reason=final?'final':s.boundary??(chapterDue?'chapter':'current');
  const request={ticket,entityId,reason,packet,requestedAtMs:clock.now(),sourceRevision:s.sourceRevision} as const;
  s.pendingGeneration=request;s.lastCurrentAtMs=clock.now();if(reason!=='current')s.lastChapterAtMs=clock.now();effects.push({type:'generation.request',request:structuredClone(request)});
}
function acceptSource(s:DomainState,source:Source,effects:DomainEffect[],clock:Clock,captureEpoch?:number):boolean {
  if(!SourceSchema.safeParse(source).success||source.sessionId!==s.session.id||source.channelId!==s.session.channelId||source.runId!==s.session.runId||source.endMs<source.startMs)return false;
  if((source.kind==='chat'||source.kind==='speech')&&(s.settings.listeningPaused||captureEpoch!==undefined&&captureEpoch!==s.captureEpoch))return false;
  if(source.kind!=='owner_statement'&&s.session.status==='finalized')return false;
  if(source.kind!=='owner_statement'&&s.closing&&(clock.now()>s.closing.intakeUntilMs||source.endMs>s.closing.endedAtMs-Date.parse(s.session.startedAt)))return false;
  if(source.kind==='chat'&&offset(s,clock)-source.endMs>120000)return false;
  if(source.kind==='chat'&&s.chatClearThroughMs!==null&&source.startMs<=s.chatClearThroughMs)source={...source,status:'quarantined'};
  const old=s.sources.find(x=>x.id===source.id);if(old&&old.revision>=source.revision)return false;
  if(sourceTombstoned(s,source)||s.bannedActors.includes(source.actorId??'')){effects.push({type:'source.persist',source:{...source,text:null,status:'deleted'}});if(s.media.some(m=>m.state!=='revoked'&&overlaps(m.captureStartMs,m.captureEndMs,source.startMs,source.endMs))){invalidateDomain(s,{kind:'source',sessionId:s.session.id,id:source.id},effects,[source]);publish(s,effects,clock,true);}return false;}
  if(old){
    const existingTombstones=[...s.tombstones];invalidateDomain(s,{kind:'source',sessionId:s.session.id,id:old.id},effects);s.tombstones=existingTombstones;
    // Correction invalidates descendants but must not leave a delete tombstone for the replacement.
    const privacyIndex=effects.findIndex(e=>e.type==='privacy'&&e.target.kind==='source'&&e.target.id===old.id);if(privacyIndex>=0)effects.splice(privacyIndex,1);
    effects.splice(0,effects.length,...effects.filter(e=>e.type!=='source.persist'||e.source.id!==old.id));
    publish(s,effects,clock,true);
  }
  s.sources=s.sources.filter(x=>x.id!==source.id);s.sources.push(structuredClone(source));s.sourceRevision++;
  effects.push({type:'source.persist',source:structuredClone(source)});return true;
}
function commitStory(s:DomainState,event:Extract<DomainEvent,{type:'generation.result'}>,effects:DomainEffect[],clock:Clock){
  const result=validateStoryPatch(s,event.ticket,event.patch,event.grounding);
  if(!result.valid){effects.push({type:'held',reason:result.reason??'invalid_story'});if(s.pendingGeneration?.ticket.jobId===event.ticket.jobId){s.processedSourceRevision=s.pendingGeneration.sourceRevision;s.pendingGeneration=null;}return;}
  const request=s.pendingGeneration!;s.pendingGeneration=null;s.processedSourceRevision=request.sourceRevision;
  if(s.closing)s.closing.finalProcessedRevision=request.sourceRevision;
  if(event.patch.action==='hold'){s.boundary=null;return;}
  const refs=event.ticket.inputRefs,range=dependencyRange(s,refs),entityId=request.entityId,previous=s.chapters.find(c=>c.id===entityId),revision=(previous?.revision??0)+1;
  const claimId=(id:string)=>`claim:${stateHash(event.ticket.jobId)}:${id.slice(0,80)}`;
  const candidateId=`candidate:${event.ticket.jobId}:${event.ticket.recapLanguage}`;
  const role=(name:string)=>event.patch.claims.find(c=>c.role===name)?.text.slice(0,300)??null;
  const current:CurrentState={goal:role('goal')??s.current?.goal??null,change:role('change'),now:role('state')??role('attempt')??role('outcome'),sourceTimeMs:range.endMs,maxDependencyEndMs:range.endMs};
  const chapter:Chapter={id:entityId,sessionId:s.session.id,revision,title:(event.patch.title??'Stream update').slice(0,120),summary:event.patch.claims.map(c=>c.text).join(' ').slice(0,700),startMs:previous?.startMs??range.startMs,endMs:range.endMs,mood:'neutral',claimIds:event.patch.claims.map(c=>claimId(c.id)),momentIds:s.moments.filter(m=>m.startMs>=range.startMs&&m.endMs<=range.endMs).slice(-12).map(m=>m.id),pinned:previous?.pinned??false,edited:false,sourceLabels:leafRefs(s,refs).slice(-12).map(r=>{const source=s.sources.find(x=>x.id===r.id)??(s.nodes[r.id]?.body as {evidenceMetadata?:Source}|null)?.evidenceMetadata;return {id:r.id,type:source?.kind??'speech',atMs:source?.startMs??0,label:source?.kind==='chat'?'Chat report':'Spoken context'};}),maxDependencyEndMs:range.endMs,ownerEditRevision:s.ownerRevisions[entityId]??0,publicationState:'draft',eligibleAt:event.ticket.eligibleAt,safety:event.safety,dependencyRefs:refs};
  const candidate:StoryCandidate={id:candidateId,entityId,revision,ownerRevision:chapter.ownerEditRevision,privacyEpoch:s.session.privacyEpoch,inputRefs:refs,eligibleAtMs:Date.parse(event.ticket.eligibleAt),chapter,current,safety:event.safety,language:event.ticket.recapLanguage,status:'pending'};
  if(!addCandidate(s,effects,candidate))return;
  for(const proposed of event.patch.claims){
    const claim={...proposed,id:claimId(proposed.id)},id=claim.id,old=s.nodes[id];
    upsertNode(s,effects,{id,revision:old?.revision??1,kind:'claim',supports:claim.support,exposedTo:refs,startMs:dependencyRange(s,claim.support).startMs,endMs:range.endMs,active:true,body:claim});
    if(!s.memory.some(m=>m.id===id)){s.memory.push({id,text:claim.text,refs:leafRefs(s,claim.support),role:claim.role,firstAtMs:dependencyRange(s,claim.support).startMs,lastAtMs:range.endMs});}
  }
  // Preserve the first goal/fact independently; retire other old memory rather than merge prose.
  if(s.memory.length>64)s.memory=[s.memory[0]!,...s.memory.slice(-63)];
  upsertNode(s,effects,{id:entityId,revision,kind:'chapter',supports:event.patch.claims.flatMap(c=>c.support),exposedTo:refs,startMs:chapter.startMs,endMs:range.endMs,active:true,body:chapter});
  for(const [i,relation] of event.patch.relations.entries())upsertNode(s,effects,{id:`relation:${event.ticket.jobId}:${i}`,revision:1,kind:'relation',supports:relation.support,exposedTo:refs,startMs:range.startMs,endMs:range.endMs,active:true,body:{...relation,from:claimId(relation.from),to:claimId(relation.to)}});
  s.chapters=[...s.chapters.filter(c=>c.id!==entityId),chapter].slice(-DOMAIN_LIMITS.chapters);s.activeChapterId=entityId;s.boundary=null;
}
function prune(s:DomainState){
  s.candidates=s.candidates.filter(c=>c.status!=='rejected');
  s.lorePresentations=s.lorePresentations.filter(p=>s.lore.some(l=>l.id===p.entityId&&l.revision===p.entityRevision)&&s.nodes[p.id]?.active).slice(-100);
  const roots=new Set([...s.chapters.flatMap(c=>[c.id,...c.claimIds]),...s.lore.map(l=>l.id),...s.lorePresentations.map(p=>p.id),...s.moments.map(m=>m.id),...s.media.map(m=>m.id),...s.candidates.flatMap(c=>[c.id,...c.currentNodeId?[c.currentNodeId]:[]]),...s.memory.map(m=>m.id),...s.playbacks.map(p=>p.id),...s.pendingGeneration?.ticket.inputRefs.map(r=>r.id)??[]]);
  for(const source of s.sources)if(source.kind==='channel_metadata'&&source.endMs===s.session.metadataMaxDependencyEndMs)roots.add(source.id);
  for(const node of Object.values(s.nodes)){const metadata=(node.body as {evidenceMetadata?:Source}|null)?.evidenceMetadata;if(metadata?.kind==='channel_metadata'&&metadata.endMs===s.session.metadataMaxDependencyEndMs)roots.add(node.id);}
  for(const node of Object.values(s.nodes))if(node.kind==='relation'&&node.body&&typeof node.body==='object'&&'from' in node.body&&roots.has(String(node.body.from)))roots.add(node.id);
  const visit=(id:string)=>{const node=s.nodes[id];if(!node)return;for(const ref of [...node.supports,...node.exposedTo])if(!roots.has(ref.id)){roots.add(ref.id);visit(ref.id);}};
  for(const id of [...roots])visit(id);
  s.nodes=Object.fromEntries(Object.entries(s.nodes).filter(([id,n])=>roots.has(id)&&n.active));
  // Recent raw context is bounded; older grounded excerpts survive only while referenced.
  const recent=s.sources.slice(-DOMAIN_LIMITS.sources),recentIds=new Set(recent.map(x=>x.id));
  // Historical leaf metadata keeps erasure/author fences and time ranges, never an 8-hour transcript.
  for(const x of s.sources)if(!recentIds.has(x.id)&&roots.has(x.id)){const {text:_text,...metadata}=x;s.nodes[x.id]={id:x.id,revision:x.revision,kind:'provider_cache',supports:[],exposedTo:[],startMs:x.startMs,endMs:x.endMs,active:x.status==='active',body:{evidenceMetadata:metadata}};}
  s.sources=recent;
  s.media=s.media.slice(-200);s.playbacks=s.playbacks.filter(p=>['queued','preparing','playing'].includes(p.status)).slice(0,2);s.playbackTiming=Object.fromEntries(Object.entries(s.playbackTiming).filter(([id])=>s.playbacks.some(p=>p.id===id)));s.gaps=s.gaps.slice(-100);
}

export function reduceDomain(previous:DomainState,event:DomainEvent,clock:Clock):DomainTransition {
  const s=structuredClone(previous),effects:DomainEffect[]=[];
  switch(event.type){
    case 'source': {
      if(event.botOutput)break;
      if(acceptSource(s,event.source,effects,clock,event.captureEpoch))observeChat(s,event.source,effects,clock,event.signals,sourceAllowed(s,event.source)?event.phrase:undefined);
      break;
    }
    case 'source.safety':{
      const source=s.sources.find(x=>x.id===event.id);if(!source||source.revision!==event.baseRevision||source.status==='deleted'||sourceTombstoned(s,source)||s.bannedActors.includes(source.actorId??''))break;
      if(s.session.status==='finalized'&&['speech','chat'].includes(source.kind)){effects.push({type:'held',reason:'session_finalized',entityId:source.id});break;}
      const next={...source,revision:source.revision+1,text:event.text,moderation:safetyAllowsPublication(event.safety)?(event.safety.pii==='redacted'?'redacted' as const:'allowed' as const):'unavailable' as const,status:safetyAllowsPublication(event.safety)?'active' as const:'quarantined' as const};
      if(['allowed','redacted'].includes(source.moderation)){if(acceptSource(s,next,effects,clock)&&sourceAllowed(s,next)&&next.text&&next.text.length<=80)observePhrase(s,next,next.text);break;}
      s.sources=s.sources.map(x=>x.id===source.id?next:x);s.sourceRevision++;effects.push({type:'source.persist',source:structuredClone(next)});
      const replace=(refs:VersionRef[])=>refs.map(r=>r.id===source.id?refOf(next):r);
      if(s.openWindow)s.openWindow.refs=replace(s.openWindow.refs);for(const window of s.windows)window.refs=replace(window.refs);
      for(const phrase of s.phrases){phrase.refs=replace(phrase.refs);phrase.actors=[...new Set(phrase.refs.map(r=>s.sources.find(x=>x.id===r.id)?.actorId).filter((actor):actor is string=>!!actor))];}
      if(sourceAllowed(s,next)&&next.text&&next.text.length<=80)observePhrase(s,next,next.text);
      if(!safetyAllowsPublication(event.safety)){
        const affected=s.moments.filter(m=>m.dependencyRefs.some(r=>r.id===source.id)).map(m=>m.id);
        for(const id of affected){const node=s.nodes[id];if(node)upsertNode(s,effects,{...node,revision:node.revision+1,active:false,body:null});}
        s.moments=s.moments.filter(m=>!affected.includes(m.id));if(s.pendingClipId&&affected.includes(s.pendingClipId))s.pendingClipId=null;
        for(const media of s.media)if(media.momentId&&affected.includes(media.momentId)){media.state='revoked';const node=s.nodes[media.id];if(node)upsertNode(s,effects,{...node,revision:node.revision+1,active:false,body:null});if(media.clipId&&media.manageUrl)effects.push({type:'clip.cleanup',clipId:media.clipId,manageUrl:media.manageUrl});}
        if(s.openWindow)s.openWindow.refs=s.openWindow.refs.filter(r=>r.id!==source.id);for(const window of s.windows)window.refs=window.refs.filter(r=>r.id!==source.id);
        if(affected.length)effects.push({type:'cancel',ids:affected});
      }else for(const m of s.moments)if(m.dependencyRefs.some(r=>r.id===source.id)){m.dependencyRefs=replace(m.dependencyRefs);m.revision++;upsertNode(s,effects,{id:m.id,revision:m.revision,kind:'moment',supports:m.dependencyRefs,exposedTo:m.dependencyRefs,startMs:m.startMs,endMs:m.maxDependencyEndMs,active:true,body:m});}
      break;
    }
    case 'tick':advanceWindows(s,effects,offset(s,clock),clock);advancePlayback(s,effects,clock);break;
    case 'metadata':if(event.atMs>=s.session.metadataMaxDependencyEndMs&&safetyAllowsPublication(event.safety)&&(!s.metadataReviewed||event.title!==s.session.title||event.category!==s.session.category)){
      const source:Source={channelId:s.session.channelId,runId:s.session.runId,sessionId:s.session.id,id:`metadata:${stateHash(s.session.id)}:${++s.sequence}`,revision:1,kind:'channel_metadata',startMs:event.atMs,endMs:event.atMs,actorId:null,languageCodes:[s.settings.recapLanguage],timePrecision:'event',text:`${event.title.slice(0,200)} — ${event.category.slice(0,100)}`,status:'active',externalMessageId:null,moderation:event.safety.pii==='redacted'?'redacted':'allowed'};
      if(acceptSource(s,source,effects,clock)){s.metadataReviewed=true;s.session.title=event.title.slice(0,200);s.session.category=event.category.slice(0,100);s.session.metadataMaxDependencyEndMs=event.atMs;s.boundary='metadata';}
    }break;
    case 'topic':if(event.sourceRefs.length&&event.sourceRefs.every(r=>isRefActive(s,r))){s.boundary='topic';s.sourceRevision++;}break;
    case 'generation.result':commitStory(s,event,effects,clock);break;
    case 'generation.failed':if(s.pendingGeneration?.ticket.jobId===event.jobId){s.pendingGeneration=null;s.nextGenerationAfterMs=clock.now()+45000;if(s.closing)s.closing.failed=true;effects.push({type:'held',reason:event.reason});}break;
    case 'privacy':if(event.target.sessionId===s.session.id){invalidateDomain(s,event.target,effects);publish(s,effects,clock,true);}break;
    case 'ban':if(!s.bannedActors.includes(event.actorId))s.bannedActors.push(event.actorId);invalidateDomain(s,{kind:'user',sessionId:s.session.id,actorId:event.actorId,throughMs:event.throughMs},effects);publish(s,effects,clock,true);break;
    case 'unban':s.bannedActors=s.bannedActors.filter(a=>a!==event.actorId);break;
    case 'pause':if(s.settings.listeningPaused!==event.paused){s.settings.listeningPaused=event.paused;s.captureEpoch++;if(event.paused&&s.pendingGeneration){effects.push({type:'cancel',ids:[s.pendingGeneration.ticket.jobId]});s.pendingGeneration=null;} }break;
    case 'settings':{
      if(event.baseRevision!==s.settings.revision||event.settings.revision!==event.baseRevision+1||!SettingsSchema.safeParse(event.settings).success){effects.push({type:'held',reason:'settings_revision_changed'});break;}
      const languageChanged=event.settings.recapLanguage!==s.settings.recapLanguage;
      const ready=!languageChanged||loreLanguageReady(s,event.settings.recapLanguage,clock)&&(s.published?.chapters??[]).every(c=>s.candidates.some(p=>p.entityId===c.id&&p.revision===c.revision&&p.language===event.settings.recapLanguage&&safetyAllowsPublication(p.safety)&&(p.status==='published'||p.privacyEpoch===s.session.privacyEpoch)&&p.inputRefs.every(r=>isRefActive(s,r))));
      if(!ready){effects.push({type:'held',reason:'language_not_ready'});break;}
      const pauseChanged=event.settings.listeningPaused!==s.settings.listeningPaused;s.settings=structuredClone(event.settings);
      if(pauseChanged){s.captureEpoch++;if(s.settings.listeningPaused&&s.pendingGeneration){effects.push({type:'cancel',ids:[s.pendingGeneration.ticket.jobId]});s.pendingGeneration=null;}}
      if(languageChanged){if(s.pendingGeneration){effects.push({type:'cancel',ids:[s.pendingGeneration.ticket.jobId]});s.pendingGeneration=null;}if(s.published){s.published.chapters=[];s.published.lore=[];s.published.language=s.settings.recapLanguage;}s.current=null;if(!eligibleCandidates(s,effects,clock)&&s.published)publish(s,effects,clock);}
      break;
    }
    case 'chat.clear':{
      if(s.chatClearThroughMs!==null&&event.throughMs<=s.chatClearThroughMs)break;
      s.chatClearThroughMs=Math.max(s.chatClearThroughMs??0,event.throughMs);
      const targets=s.sources.filter(source=>source.kind==='chat'&&source.startMs<=event.throughMs).map(source=>structuredClone(source));
      const tombstones=[...s.tombstones],epoch=s.session.privacyEpoch;
      for(const source of targets){invalidateDomain(s,{kind:'source',sessionId:s.session.id,id:source.id},effects);const updated={...source,status:'quarantined' as const,revision:source.revision+1};s.sources=s.sources.map(x=>x.id===source.id?updated:x);}
      s.tombstones=tombstones;s.session.privacyEpoch=epoch+1;
      effects.splice(0,effects.length,...effects.filter(e=>e.type!=='privacy'&&!(e.type==='source.persist'&&targets.some(t=>t.id===e.source.id))));
      for(const source of targets)effects.push({type:'source.persist',source:{...source,status:'quarantined',revision:source.revision+1}});
      s.openWindow=null;s.phrases=[];publish(s,effects,clock,true);break;
    }
    case 'owner.pin':{const c=s.chapters.find(c=>c.id===event.entityId);if(c&&c.revision===event.baseRevision){c.pinned=event.pinned;c.revision++;const node=s.nodes[c.id];if(node)upsertNode(s,effects,{...node,revision:c.revision,body:c});if(s.pendingGeneration?.entityId===c.id){effects.push({type:'cancel',ids:[s.pendingGeneration.ticket.jobId]});s.pendingGeneration=null;}const p=s.published?.chapters.find(p=>p.id===c.id);if(p)p.pinned=event.pinned;publish(s,effects,clock);}break;}
    case 'owner.edit':{
      const old=s.chapters.find(c=>c.id===event.entityId);if(!old||old.revision!==event.baseRevision||event.source.kind!=='owner_statement'||s.suppressedIds.includes(old.id))break;
      const oldRefs=old.dependencyRefs;if(!acceptSource(s,event.source,effects,clock))break;
      const ownerRevision=(s.ownerRevisions[old.id]??0)+1;s.ownerRevisions[old.id]=ownerRevision;if(!s.ownerLocks.includes(old.id))s.ownerLocks.push(old.id);
      s.candidates=s.candidates.filter(c=>c.entityId!==old.id);for(const n of Object.values(s.nodes))if(n.kind==='presentation'&&(n.body as StoryCandidate)?.entityId===old.id){n.active=false;n.body=null;n.revision++;effects.push({type:'entity.upsert',node:structuredClone(n)});}
      if(s.pendingGeneration?.entityId===old.id){effects.push({type:'cancel',ids:[s.pendingGeneration.ticket.jobId]});s.pendingGeneration=null;}
      if(s.published)s.published.chapters=s.published.chapters.filter(c=>c.id!==old.id);s.current=null;
      const refs=uniqueRefs([...oldRefs,refOf(event.source)]),range=dependencyRange(s,refs),chapter:Chapter={...old,revision:old.revision+1,ownerEditRevision:ownerRevision,title:event.title.slice(0,120),summary:event.summary.slice(0,700),pinned:event.pinned??old.pinned,edited:true,publicationState:safetyAllowsPublication(event.safety)?'draft':'held',safety:event.safety,eligibleAt:clock.iso(),dependencyRefs:refs,maxDependencyEndMs:range.endMs};
      s.chapters=s.chapters.map(c=>c.id===old.id?chapter:c);upsertNode(s,effects,{id:old.id,revision:chapter.revision,kind:'chapter',supports:refs,exposedTo:refs,startMs:old.startMs,endMs:range.endMs,active:true,body:chapter});
      addCandidate(s,effects,{id:`owner:${old.id}:${ownerRevision}`,entityId:old.id,revision:chapter.revision,ownerRevision,privacyEpoch:s.session.privacyEpoch,inputRefs:refs,eligibleAtMs:clock.now(),chapter,current:{goal:null,change:null,now:chapter.summary.slice(0,300),sourceTimeMs:range.endMs,maxDependencyEndMs:range.endMs},safety:event.safety,language:event.language??ownerLanguage(event.source,s.settings.recapLanguage),status:'pending'});
      if(!safetyAllowsPublication(event.safety))effects.push({type:'owner.review.request',kind:'chapter',entityId:old.id,entityRevision:chapter.revision,ownerRevision,sourceId:event.source.id,sourceRevision:event.source.revision,privacyEpoch:s.session.privacyEpoch,dependencyRefs:refs});
      for(const p of s.playbacks){p.status='cancelled';p.plan=null;effects.push({type:'playback.cancel',playback:structuredClone(p)});}publish(s,effects,clock,true);break;
    }
    case 'owner.review':{
      const old=s.chapters.find(c=>c.id===event.entityId),source=s.sources.find(x=>x.id===event.sourceId)??(s.nodes[event.sourceId]?.body as {evidenceMetadata?:Source}|null)?.evidenceMetadata;
      if(!old||old.ownerEditRevision!==event.ownerRevision||event.privacyEpoch!==undefined&&event.privacyEpoch!==s.session.privacyEpoch||!source||source.kind!=='owner_statement'||source.revision!==event.sourceRevision||source.status==='deleted'||sourceTombstoned(s,source)||s.suppressedIds.includes(old.id))break;
      const nextSource={...source,revision:source.revision+1,text:event.summary.slice(0,700),moderation:safetyAllowsPublication(event.safety)?(event.safety.pii==='redacted'?'redacted' as const:'allowed' as const):'unavailable' as const};
      s.sources=[...s.sources.filter(x=>x.id!==source.id),nextSource];effects.push({type:'source.persist',source:nextSource});
      const refs=old.dependencyRefs.map(r=>r.id===source.id?refOf(nextSource):r),range=dependencyRange(s,refs);
      const chapter:Chapter={...old,revision:old.revision+1,title:event.title.slice(0,120),summary:event.summary.slice(0,700),publicationState:safetyAllowsPublication(event.safety)?'draft':'held',safety:event.safety,dependencyRefs:refs,eligibleAt:clock.iso(),maxDependencyEndMs:range.endMs};
      for(const candidate of s.candidates.filter(c=>c.entityId===old.id)){const n=s.nodes[candidate.id];if(n)upsertNode(s,effects,{...n,revision:n.revision+1,active:false,body:null});}
      s.candidates=s.candidates.filter(c=>c.entityId!==old.id);s.chapters=s.chapters.map(c=>c.id===old.id?chapter:c);
      upsertNode(s,effects,{id:old.id,revision:chapter.revision,kind:'chapter',supports:refs,exposedTo:refs,startMs:chapter.startMs,endMs:range.endMs,active:true,body:chapter});
      addCandidate(s,effects,{id:`owner:${old.id}:${event.ownerRevision}:review:${chapter.revision}`,entityId:old.id,revision:chapter.revision,ownerRevision:event.ownerRevision,privacyEpoch:s.session.privacyEpoch,inputRefs:refs,eligibleAtMs:clock.now(),chapter,current:event.current?{...event.current,sourceTimeMs:range.endMs,maxDependencyEndMs:range.endMs}:{goal:null,change:null,now:chapter.summary.slice(0,300),sourceTimeMs:range.endMs,maxDependencyEndMs:range.endMs},safety:event.safety,language:event.language??ownerLanguage(source,s.settings.recapLanguage),status:'pending'});break;
    }
    case 'candidate.safety':{const c=s.candidates.find(c=>c.id===event.candidateId);if(c&&c.privacyEpoch===s.session.privacyEpoch&&c.inputRefs.every(r=>isRefActive(s,r))){c.safety=event.safety;c.chapter.safety=event.safety;effects.push({type:'candidate.save',candidate:structuredClone(c)});}break;}
    case 'presentation':{
      const c=s.chapters.find(x=>x.id===event.entityId);if(!c||c.revision!==event.baseRevision||c.ownerEditRevision!==event.ownerRevision||!event.inputRefs.every(r=>isRefActive(s,r)))break;
      const existing=s.candidates.find(x=>x.entityId===c.id&&x.revision===c.revision);
      const range=dependencyRange(s,uniqueRefs([...c.dependencyRefs,...event.inputRefs]));
      addCandidate(s,effects,{id:`presentation:${c.id}:${c.revision}:${event.language}`,entityId:c.id,revision:c.revision,ownerRevision:c.ownerEditRevision,privacyEpoch:s.session.privacyEpoch,inputRefs:uniqueRefs([...c.dependencyRefs,...event.inputRefs]),eligibleAtMs:existing?.eligibleAtMs??Date.parse(c.eligibleAt),chapter:{...c,title:event.title.slice(0,120),summary:event.summary.slice(0,700),safety:event.safety},current:event.current?{...event.current,sourceTimeMs:range.endMs,maxDependencyEndMs:range.endMs}:{goal:null,change:null,now:event.summary.slice(0,300),sourceTimeMs:range.endMs,maxDependencyEndMs:range.endMs},safety:event.safety,language:event.language,status:'pending'});break;
    }
    case 'language':{
      // Whole projection switch requires every currently published chapter's checked revision.
      const ids=s.published?.chapters??[];
      if(loreLanguageReady(s,event.language,clock)&&ids.every(c=>s.candidates.some(p=>p.entityId===c.id&&p.revision===c.revision&&p.language===event.language&&safetyAllowsPublication(p.safety)&&(p.status==='published'||p.privacyEpoch===s.session.privacyEpoch)&&p.inputRefs.every(r=>isRefActive(s,r))))){s.settings.recapLanguage=event.language;if(s.published){s.published.chapters=[];s.published.lore=[];}s.current=null;if(!eligibleCandidates(s,effects,clock)&&s.published)publish(s,effects,clock);}else effects.push({type:'held',reason:'language_not_ready'});break;
    }
    case 'lore.propose':{
      const term=normalizeTerm(event.term),observation=s.phrases.find(p=>p.term===term||p.aliases.includes(term));
      if(blockedPhrase(s,term,event.aliases)||!observation||observation.actors.length<2||![...event.originRefs,...event.exposureRefs??[]].every(r=>isRefActive(s,r)))break;
      const originSources=leafRefs(s,event.originRefs).map(r=>s.sources.find(x=>x.id===r.id)??(s.nodes[r.id]?.body as {evidenceMetadata?:Source}|null)?.evidenceMetadata);
      const ownerOrigin=originSources.some(source=>source?.kind==='owner_statement');
      const known=event.originRefs.length>0&&!!event.grounding?.acceptedClaimIds.includes(event.id)&&originSources.some(source=>source?.kind==='speech'||source?.kind==='owner_statement');
      const refs=uniqueRefs([...observation.refs,...event.originRefs,...event.exposureRefs??[]]),range=dependencyRange(s,refs),old=s.lore.find(l=>l.id===event.id);
      const conflict=!!old&&old.originKind!=='unknown'&&old.explanation!==event.explanation;
      const lore:Lore={id:event.id,sessionId:s.session.id,revision:(old?.revision??0)+1,term,explanation:event.explanation.slice(0,700),firstSeenMs:old?.firstSeenMs??observation.firstMs,originMs:known&&!conflict?dependencyRange(s,event.originRefs).startMs:null,originKind:known&&!conflict?(ownerOrigin?'owner_confirmed':'spoken'):'unknown',momentId:null,maxDependencyEndMs:range.endMs,status:known&&!conflict&&safetyAllowsPublication(event.safety)?'confirmed':'held',aliases:(event.aliases??[]).map(normalizeTerm).slice(0,16),dependencyRefs:refs,safety:event.safety};
      retireLorePresentations(s,lore.id,effects);s.lore=[...s.lore.filter(l=>l.id!==lore.id),lore].slice(-50);upsertNode(s,effects,{id:lore.id,revision:lore.revision,kind:'lore',supports:event.originRefs,exposedTo:refs,startMs:lore.firstSeenMs,endMs:range.endMs,active:true,body:lore});recordLorePresentation(s,lore,{language:event.language??s.settings.recapLanguage,term:lore.term,explanation:lore.explanation,safety:lore.safety},effects,clock);break;
    }
    case 'lore.confirm':{
      const lore=s.lore.find(l=>l.id===event.id);if(!lore||lore.revision!==event.baseRevision||blockedPhrase(s,lore.term,lore.aliases)||event.source.kind!=='owner_statement'||!acceptSource(s,event.source,effects,clock))break;
      retireLorePresentations(s,lore.id,effects);
      lore.revision++;lore.explanation=event.explanation.slice(0,700);lore.originKind='owner_confirmed';lore.originMs=event.source.startMs;lore.status=safetyAllowsPublication(event.safety)?'confirmed':'held';lore.safety=event.safety;lore.dependencyRefs=uniqueRefs([...lore.dependencyRefs,refOf(event.source)]);lore.maxDependencyEndMs=Math.max(lore.maxDependencyEndMs,event.source.endMs);
      if(!safetyAllowsPublication(event.safety))effects.push({type:'owner.review.request',kind:'lore',entityId:lore.id,entityRevision:lore.revision,sourceId:event.source.id,sourceRevision:event.source.revision,privacyEpoch:s.session.privacyEpoch,dependencyRefs:lore.dependencyRefs});
      upsertNode(s,effects,{id:lore.id,revision:lore.revision,kind:'lore',supports:lore.dependencyRefs,exposedTo:lore.dependencyRefs,startMs:lore.firstSeenMs,endMs:lore.maxDependencyEndMs,active:true,body:lore});recordLorePresentation(s,lore,{language:event.language??ownerLanguage(event.source,s.settings.recapLanguage),term:lore.term,explanation:lore.explanation,safety:lore.safety},effects,clock);break;
    }
    case 'lore.edit':{
      const lore=s.lore.find(l=>l.id===event.id),term=normalizeTerm(event.term??lore?.term??''),aliases=(event.aliases??lore?.aliases??[]).map(normalizeTerm).slice(0,16);
      if(!lore||lore.revision!==event.baseRevision||s.suppressedIds.includes(lore.id)||blockedPhrase(s,lore.term,lore.aliases)||blockedPhrase(s,term,aliases)||event.source.kind!=='owner_statement'||!acceptSource(s,event.source,effects,clock))break;
      retireLorePresentations(s,lore.id,effects);
      lore.revision++;lore.term=term;lore.aliases=aliases;lore.explanation=event.explanation.slice(0,700);lore.status='held';lore.safety={...safeDefault};lore.dependencyRefs=uniqueRefs([...lore.dependencyRefs,refOf(event.source)]);lore.maxDependencyEndMs=Math.max(lore.maxDependencyEndMs,event.source.endMs);if(event.originMs!==undefined)lore.originMs=event.originMs;
      effects.push({type:'owner.review.request',kind:'lore',entityId:lore.id,entityRevision:lore.revision,sourceId:event.source.id,sourceRevision:event.source.revision,privacyEpoch:s.session.privacyEpoch,dependencyRefs:lore.dependencyRefs});
      upsertNode(s,effects,{id:lore.id,revision:lore.revision,kind:'lore',supports:lore.dependencyRefs,exposedTo:lore.dependencyRefs,startMs:lore.firstSeenMs,endMs:lore.maxDependencyEndMs,active:true,body:lore});
      if(s.published)s.published.lore=s.published.lore.filter(l=>l.id!==lore.id);for(const p of s.playbacks){p.status='cancelled';p.plan=null;effects.push({type:'playback.cancel',playback:structuredClone(p)});}publish(s,effects,clock,true);break;
    }
    case 'lore.review':{
      const lore=s.lore.find(l=>l.id===event.id),source=s.sources.find(x=>x.id===event.sourceId)??(s.nodes[event.sourceId]?.body as {evidenceMetadata?:Source}|null)?.evidenceMetadata,term=normalizeTerm(event.term??lore?.term??''),aliases=(event.aliases??lore?.aliases??[]).map(normalizeTerm).slice(0,16);
      if(!lore||lore.revision!==event.baseRevision||event.privacyEpoch!==undefined&&event.privacyEpoch!==s.session.privacyEpoch||!source||source.revision!==event.sourceRevision||source.kind!=='owner_statement'||source.status==='deleted'||sourceTombstoned(s,source)||s.suppressedIds.includes(lore.id)||blockedPhrase(s,lore.term,lore.aliases)||blockedPhrase(s,term,aliases))break;
      retireLorePresentations(s,lore.id,effects);
      const next={...source,revision:source.revision+1,text:event.explanation.slice(0,700),moderation:safetyAllowsPublication(event.safety)?(event.safety.pii==='redacted'?'redacted' as const:'allowed' as const):'unavailable' as const};s.sources=[...s.sources.filter(x=>x.id!==source.id),next];effects.push({type:'source.persist',source:next});
      lore.revision++;lore.term=term;lore.aliases=aliases;lore.explanation=event.explanation.slice(0,700);lore.safety=event.safety;lore.status=safetyAllowsPublication(event.safety)?'confirmed':'held';lore.originKind='owner_confirmed';lore.originMs=event.originMs===undefined?(lore.originMs??source.startMs):event.originMs;lore.dependencyRefs=lore.dependencyRefs.map(r=>r.id===source.id?refOf(next):r);
      upsertNode(s,effects,{id:lore.id,revision:lore.revision,kind:'lore',supports:lore.dependencyRefs,exposedTo:lore.dependencyRefs,startMs:lore.firstSeenMs,endMs:lore.maxDependencyEndMs,active:true,body:lore});recordLorePresentation(s,lore,{language:event.language??ownerLanguage(source,s.settings.recapLanguage),term:lore.term,explanation:lore.explanation,safety:lore.safety},effects,clock);publish(s,effects,clock);break;
    }
    case 'lore.presentation':{
      const lore=s.lore.find(l=>l.id===event.id);if(!lore||lore.revision!==event.baseRevision||event.privacyEpoch!==s.session.privacyEpoch||!event.inputRefs.every(ref=>isRefActive(s,ref))||!['confirmed','published'].includes(lore.status))break;
      recordLorePresentation(s,lore,event,effects,clock);break;
    }
    case 'term.unblock':s.blockedTerms=s.blockedTerms.filter(t=>t!==normalizeTerm(event.term));for(const l of s.lore)if(l.status==='blocked'&&[l.term,...l.aliases].some(t=>normalizeTerm(t)===normalizeTerm(event.term))){l.status='observed';l.revision++;}break;
    case 'moment.save':if((event.sourceRefs??[]).every(r=>isRefActive(s,r)))saveMoment(s,effects,{...event,label:'Saved moment'},clock);break;
    case 'media':{
      const previousMedia=s.media.find(x=>x.id===event.media.id),m={...event.media,revision:previousMedia?Math.max(previousMedia.revision+1,event.media.revision):event.media.revision};
      const forgottenCapture=!m.previousSession&&(s.tombstones.some(t=>t.kind==='session'||t.kind==='interval'&&overlaps(m.captureStartMs,m.captureEndMs,t.fromMs,t.toMs))||s.sources.some(source=>source.status==='deleted'&&overlaps(m.captureStartMs,m.captureEndMs,source.startMs,source.endMs)));
      if(event.privacyEpoch!==s.session.privacyEpoch||forgottenCapture||!m.refs.every(r=>isRefActive(s,r))||m.momentId&&!s.moments.some(x=>x.id===m.momentId)){if(m.clipId&&m.manageUrl)effects.push({type:'clip.cleanup',clipId:m.clipId,manageUrl:m.manageUrl});break;}
      s.media=[...s.media.filter(x=>x.id!==m.id),structuredClone(m)];upsertNode(s,effects,{id:m.id,revision:m.revision,kind:'media',supports:m.refs,exposedTo:m.refs,startMs:m.captureStartMs,endMs:m.captureEndMs,active:m.state!=='revoked',body:m});
      const moment=s.moments.find(x=>x.id===m.momentId);if(moment){moment.mediaId=m.id;moment.mediaState=m.state;moment.clip=m.state==='ready'&&m.clip?m.clip:null;moment.maxDependencyEndMs=Math.max(moment.maxDependencyEndMs,m.captureEndMs);moment.revision++;upsertNode(s,effects,{id:moment.id,revision:moment.revision,kind:'moment',supports:moment.dependencyRefs,exposedTo:moment.dependencyRefs,startMs:moment.startMs,endMs:moment.maxDependencyEndMs,active:true,body:moment});if(m.state!=='pending')s.pendingClipId=null;}
      break;
    }
    case 'recap.trigger':{
      if(event.trigger.sessionId!==s.session.id||s.seenTriggers.includes(event.trigger.id))break;s.seenTriggers=[...s.seenTriggers,event.trigger.id].slice(-1000);
      if(!s.published)publish(s,effects,clock);
      const active=s.playbacks.find(p=>['preparing','playing'].includes(p.status)),queued=s.playbacks.find(p=>p.status==='queued');
      if(queued?.plan){if(event.trigger.reason==='raid'){if(queued.plan.arrivals.length<5)queued.plan.arrivals.push({triggerId:event.trigger.id,fromLogin:(event.trigger.fromLogin??'').slice(0,25),viewers:event.trigger.viewers??0});else {queued.plan.overflowArrivals.channels++;queued.plan.overflowArrivals.viewers+=event.trigger.viewers??0;}}break;}
      const unchanged=s.lastRecapRevision===s.published!.revision;
      const plan=compileRecap(s.published!,s.settings.layout,event.trigger,{media:s.media.filter(m=>m.refs.every(r=>isRefActive(s,r))),durationMs:s.settings.recapDurationMs,welcomeOnly:!!active||unchanged,generatedAt:clock.iso()});
      plan.dependencyRefs=plan.dependencyRefs.map(ref=>{const candidate=s.candidates.find(c=>c.entityId===ref.id&&c.revision===ref.revision&&c.language===s.settings.recapLanguage&&c.status==='published');return candidate?{id:candidate.id,revision:1}:ref;});
      const playback={id:`playback:${event.trigger.id}`,status:active?'queued' as const:'preparing' as const,plan,startAt:null};s.playbacks.push(playback);s.lastRecapRevision=s.published!.revision;
      s.playbackTiming[playback.id]={prepareAtMs:active?null:clock.now(),startAtMs:null};
      upsertNode(s,effects,{id:playback.id,revision:1,kind:'playback',supports:plan.dependencyRefs,exposedTo:plan.dependencyRefs,startMs:0,endMs:offset(s,clock),active:true,body:playback});if(!active)effects.push({type:'playback.prepare',playback:structuredClone(playback)});break;
    }
    case 'playback':{
      const p=s.playbacks.find(p=>p.id===event.id);if(!p)break;
      if(event.action==='cancel'||event.action==='error'){p.status='cancelled';p.plan=null;effects.push({type:'playback.cancel',playback:structuredClone(p)});}
      else if(event.action==='end')p.status='ended';
      else if(!p.plan||!canDispatch(s,p.plan)){p.status='cancelled';p.plan=null;effects.push({type:'playback.cancel',playback:structuredClone(p)});}
      else if(event.action==='prepared'&&p.status==='preparing'&&p.startAt===null){p.startAt=iso(clock.now()+300);s.playbackTiming[p.id]={prepareAtMs:s.playbackTiming[p.id]?.prepareAtMs??clock.now(),startAtMs:clock.now()+300};effects.push({type:'playback.start',playback:structuredClone(p)});}
      else if(event.action==='start'&&p.status==='preparing'&&p.startAt){p.status=clock.now()-Date.parse(p.startAt)>3000?'skipped':'playing';}
      if(['ended','cancelled','skipped'].includes(p.status))promotePlayback(s,effects,clock);
      break;
    }
    case 'closing':if(s.session.status==='live'&&Number.isFinite(Date.parse(event.endedAt))){s.session.status='closing';s.session.endedAt=event.endedAt;const endedAtMs=Date.parse(event.endedAt);s.closing={endedAtMs,intakeUntilMs:endedAtMs+90000,deadlineMs:endedAtMs+240000,tailDrained:false,finalProcessedRevision:s.processedSourceRevision,failed:false};if(s.pendingGeneration){effects.push({type:'cancel',ids:[s.pendingGeneration.ticket.jobId]});s.pendingGeneration=null;}if(s.sourceRevision>0)s.processedSourceRevision=Math.min(s.processedSourceRevision,s.sourceRevision-1);s.nextGenerationAfterMs=0;}break;
    case 'tail.drained':if(s.closing)s.closing.tailDrained=true;break;
    case 'cloud.ack':if(event.revision===s.session.publicationRevision){if(s.session.status==='finalized')s.session.finalSnapshotAckAt=event.at;if(s.published)s.published.lastSyncedAt=event.at;if(s.lastReceipt)s.lastReceipt.publicSync='synced';}break;
    case 'gap':s.gaps.push({startMs:event.startMs,endMs:event.endMs});break;
  }
  for(const candidate of reconcilePrivacyEpoch(s,previous.session.privacyEpoch,effects))addCandidate(s,effects,candidate);
  eligibleCandidates(s,effects,clock);
  if(!s.published&&publishedLore(s,clock).length)publish(s,effects,clock);
  if(s.published&&s.session.status!=='finalized'){
    const matured=(end:number)=>Date.parse(s.session.startedAt)+end+s.settings.publicationDelaySeconds*1000<=clock.now();
    const lore=publishedLore(s,clock);
    const moments=s.moments.filter(m=>m.dependencyRefs.every(r=>isRefActive(s,r))&&matured(m.maxDependencyEndMs)).map(({sessionId:_s,revision:_r,count:_c,distinctActors:_a,baseline:_b,mediaId:_m,dependencyRefs:_d,...m})=>m);
    if(canonical(lore)!==canonical(s.published.lore)||canonical(moments)!==canonical(s.published.moments)||s.metadataReviewed&&matured(s.session.metadataMaxDependencyEndMs)&&s.published.session.title!==s.session.title)publish(s,effects,clock);
  }
  const closing=s.closing;
  if(closing&&s.session.status==='closing'){
    const drained=closing.tailDrained,deadline=clock.now()>=closing.deadlineMs;
    const unresolvedSources=s.sources.filter(source=>['speech','chat'].includes(source.kind)&&source.status!=='deleted'&&source.status!=='blocked'&&!sourceTombstoned(s,source)&&!['allowed','redacted'].includes(source.moderation)&&source.endMs<=closing.endedAtMs-Date.parse(s.session.startedAt));
    const remaining=s.candidates.some(c=>c.status==='pending'&&c.language===s.settings.recapLanguage);
    if(deadline||drained&&!s.pendingGeneration&&s.processedSourceRevision>=s.sourceRevision&&!remaining&&!unresolvedSources.length){
      if(deadline&&(!closing.tailDrained||closing.failed||s.pendingGeneration||s.processedSourceRevision<s.sourceRevision||remaining||unresolvedSources.length)){s.gaps.push({startMs:Math.max(0,Math.min(s.published?.current?.sourceTimeMs??0,...unresolvedSources.map(source=>source.startMs))),endMs:Math.max(0,closing.endedAtMs-Date.parse(s.session.startedAt))});if(s.pendingGeneration)effects.push({type:'cancel',ids:[s.pendingGeneration.ticket.jobId]});s.pendingGeneration=null;}
      s.session.status='finalized';s.session.finalizedAt=clock.iso();publish(s,effects,clock,false,true);
    }
  }
  requestGeneration(s,effects,clock);
  prune(s);
  if(effects.length||event.type!=='tick'||s.windows.length!==previous.windows.length||s.openWindow?.startMs!==previous.openWindow?.startMs)s.revision=previous.revision+1;
  return {state:s,effects};
}

/** Checkpoints are storage-private and contain evidence. Never expose them as public replay exports. */
export const exportDomainState=(state:DomainState):DomainState=>structuredClone(state);
export function hydrateDomainState(checkpoint:DomainState,authority:{privacyEpoch:number;blockedTerms?:string[];bannedActors?:string[];tombstones?:DomainState['tombstones']}):DomainState {
  if(checkpoint.version!==1||checkpoint.session.privacyEpoch!==authority.privacyEpoch)throw new Error('stale_domain_checkpoint');
  const state=structuredClone(checkpoint);state.playbackTiming??={};state.editorialExcludedRefs??=[];state.nextGenerationAfterMs??=0;state.chatClearThroughMs??=null;state.metadataReviewed??=false;state.lorePresentations??=[];
  for(const p of state.playbacks)state.playbackTiming[p.id]??={prepareAtMs:p.status==='queued'?null:Date.parse(p.plan?.generatedAt??state.session.startedAt),startAtMs:p.startAt?Date.parse(p.startAt):null};
  state.blockedTerms=[...new Set([...state.blockedTerms,...authority.blockedTerms??[]].map(normalizeTerm))];state.bannedActors=[...new Set([...state.bannedActors,...authority.bannedActors??[]])];state.tombstones=[...state.tombstones,...authority.tombstones??[]];
  if(state.sources.some(s=>s.text!==null&&(sourceTombstoned(state,s)||state.bannedActors.includes(s.actorId??'')))||state.lore.some(l=>blockedPhrase(state,l.term,l.aliases)&&!(l.status==='blocked'&&l.explanation==='')))throw new Error('unsanitized_domain_checkpoint');
  prune(state);return state;
}
export function loreAnswer(state:DomainState,term:string):string {
  const normalized=normalizeTerm(term);if(blockedPhrase(state,normalized))return state.settings.recapLanguage==='ru'?'Происхождение не подтверждено.':'Its origin is not confirmed.';
  const canonicalLore=state.lore.find(l=>[l.term,...l.aliases].some(term=>normalizeTerm(term)===normalized));
  const lore=state.published?.lore.find(l=>normalizeTerm(l.term)===normalized||l.id===canonicalLore?.id);
  return lore?.explanation??(state.settings.recapLanguage==='ru'?'Происхождение не подтверждено.':'Its origin is not confirmed.');
}






