import type { PrivacyTarget, Source } from '../shared/contracts/index.js';
import type { DomainState, DomainEffect } from './types.js';
import { normalizeTerm, overlaps, leafRefs, uniqueRefs } from './evidence.js';

/** Called on a cloned transition state. Storage must commit target + graph + checkpoint atomically. */
export function invalidateDomain(state:DomainState,target:PrivacyTarget,effects:DomainEffect[]):void {
  if(target.sessionId!==state.session.id)return;
  const affected=new Set<string>(),ranges:{startMs:number;endMs:number}[]=[];
  const sourceMatch=(s:Source)=>target.kind==='session'||target.kind==='source'&&s.id===target.id||target.kind==='message'&&s.externalMessageId===target.externalMessageId||target.kind==='user'&&s.actorId===target.actorId&&s.startMs<=target.throughMs||target.kind==='interval'&&overlaps(s.startMs,s.endMs,target.fromMs,target.toMs);
  if(['source','message','user','interval','session'].includes(target.kind)){
    if(!state.tombstones.some(t=>JSON.stringify(t)===JSON.stringify(target)))state.tombstones.push(target);
    for(const source of state.sources)if(sourceMatch(source)){affected.add(source.id);ranges.push(source);source.text=null;source.status='deleted';source.revision++;effects.push({type:'source.persist',source:{...source}});}
    for(const node of Object.values(state.nodes)){const metadata=(node.body as {evidenceMetadata?:Source}|null)?.evidenceMetadata;if(metadata&&sourceMatch(metadata)){affected.add(node.id);ranges.push(node);}}
  }
  if(target.kind==='entity'){const chapter=state.chapters.find(c=>c.id===target.id);if(chapter)state.editorialExcludedRefs=uniqueRefs([...state.editorialExcludedRefs,...leafRefs(state,chapter.dependencyRefs)]);affected.add(target.id);if(!state.suppressedIds.includes(target.id))state.suppressedIds.push(target.id);}
  if(target.kind==='interval')ranges.push({startMs:target.fromMs,endMs:target.toMs});
  if(target.kind==='term'){
    const term=normalizeTerm(target.term);if(!state.blockedTerms.includes(term))state.blockedTerms.push(term);
    for(const lore of state.lore)if([lore.term,...lore.aliases].some(p=>normalizeTerm(p)===term))affected.add(lore.id);
    state.phrases=state.phrases.filter(p=>![p.term,...p.aliases].some(x=>normalizeTerm(x)===term));
  }
  if(target.kind==='session')for(const id of Object.keys(state.nodes))affected.add(id);
  for(const media of state.media)if(ranges.some(r=>overlaps(media.captureStartMs,media.captureEndMs,r.startMs,r.endMs)))affected.add(media.id);
  // Both support and exposure edges participate, regardless of pin, language or object kind.
  let changed=true;while(changed){changed=false;for(const node of Object.values(state.nodes))if(!affected.has(node.id)&&[...node.supports,...node.exposedTo].some(r=>affected.has(r.id))){affected.add(node.id);changed=true;}}
  for(const node of Object.values(state.nodes))if(affected.has(node.id)){node.active=false;node.body=null;node.revision++;effects.push({type:'entity.upsert',node:{...node}});}
  state.memory=state.memory.filter(m=>!affected.has(m.id)&&!m.refs.some(r=>affected.has(r.id)));
  state.chapters=state.chapters.filter(c=>!affected.has(c.id));
  state.lore=state.lore.filter(l=>!affected.has(l.id));
  state.moments=state.moments.filter(m=>!affected.has(m.id));
  state.candidates=state.candidates.filter(c=>!affected.has(c.id)&&!affected.has(c.entityId)&&!c.inputRefs.some(r=>affected.has(r.id)));
  state.phrases=state.phrases.filter(p=>!p.refs.some(r=>affected.has(r.id)));
  state.windows=[];state.openWindow=null;
  const externalClipActions:{clipId:string;manageUrl:string}[]=[];
  for(const media of state.media)if(affected.has(media.id)){media.state='revoked';if(media.clipId&&media.manageUrl)externalClipActions.push({clipId:media.clipId,manageUrl:media.manageUrl});}
  // Keep only identifier/interval metadata for revoked assets, never old media source refs/body.
  state.media=state.media.map(m=>m.state==='revoked'?{...m,refs:[]}:m);
  if(state.pendingGeneration){affected.add(state.pendingGeneration.ticket.jobId);state.pendingGeneration=null;}
  state.session.privacyEpoch++;
  for(const playback of state.playbacks){if(['queued','preparing','playing'].includes(playback.status)){playback.status='cancelled';playback.plan=null;effects.push({type:'playback.cancel',playback:{...playback}});}}
  state.playbacks=state.playbacks.filter(p=>p.status!=='cancelled');
  state.current=null;
  if(state.activeChapterId&&affected.has(state.activeChapterId))state.activeChapterId=null;
  if(state.pendingClipId&&affected.has(state.pendingClipId))state.pendingClipId=null;
  if(state.published){state.published={...state.published,privacyEpoch:state.session.privacyEpoch,current:null,chapters:state.published.chapters.filter(c=>!affected.has(c.id)),lore:state.published.lore.filter(l=>!affected.has(l.id)),moments:state.published.moments.filter(m=>!affected.has(m.id)&&!state.media.some(x=>x.momentId===m.id&&x.state==='revoked'))};}
  if(target.kind==='session'){state.session.title='';state.session.category='';state.session.metadataMaxDependencyEndMs=0;}
  state.lastReceipt={revision:state.session.publicationRevision+1,privacyEpoch:state.session.privacyEpoch,hiddenEntityIds:[...affected].sort(),rebuildStatus:'queued',publicSync:'pending',externalClipActions};
  effects.push({type:'privacy',target,receipt:state.lastReceipt},{type:'cancel',ids:[...affected]});
}
