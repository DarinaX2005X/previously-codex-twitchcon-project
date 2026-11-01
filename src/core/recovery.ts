import { ChapterSchema, LoreSchema, MomentSchema, GroundedClaimSchema, safetyAllowsPublication } from '../shared/contracts/index.js';
import type { Channel, Session, Settings, Source, PrivacyTarget, PublicSnapshot, Lore, Clock } from '../shared/contracts/index.js';
import type { DomainState, DerivedNode, StoryCandidate, DomainMedia, LorePresentation } from './types.js';
import { createDomainState, hydrateDomainState } from './reducer.js';
import { isRefActive, leafRefs, uniqueRefs, sourceTombstoned, blockedPhrase } from './evidence.js';
import { publishedLore } from './lore-presentations.js';

/** Structural port: the SQLite adapter returns this without importing server code into the browser. */
export type DomainHydrationInput={
  channel:Channel;session:Session;settings:Settings;revision:number;privacyEpoch:number;checkpoint:DomainState|null;
  sources:Source[];entities:(DerivedNode&{ownerRevision:number;ownerLocked:boolean;pinned:boolean})[];
  candidates:StoryCandidate[];published:PublicSnapshot|null;tombstones:PrivacyTarget[];blockedTerms:string[];bannedActors:string[];
  captureEpoch:number;chatClearThroughMs:number|null;
  blockedLore?:Lore[];
};

/** Reconstructs only surviving authoritative records. It never revives queued playback after restart. */
export function recoverDomainState(input:DomainHydrationInput,options:{resumePlayback?:boolean;clock?:Clock}={}):DomainState {
  if(input.checkpoint){
    try {
      const restored=hydrateDomainState(input.checkpoint,{privacyEpoch:input.privacyEpoch,blockedTerms:input.blockedTerms,bannedActors:input.bannedActors,tombstones:input.tombstones});
      restored.revision=input.revision;restored.session={...input.session};restored.settings=structuredClone(input.settings);restored.captureEpoch=input.captureEpoch;restored.chatClearThroughMs=input.chatClearThroughMs;
      if(!options.resumePlayback){restored.playbacks=[];restored.playbackTiming={};}
      return restored;
    } catch { /* Standalone privacy invalidation deliberately destroys a stale checkpoint. */ }
  }
  const state=createDomainState({channel:input.channel,session:{...input.session,privacyEpoch:input.privacyEpoch},settings:input.settings,tombstones:input.tombstones,blockedTerms:input.blockedTerms,bannedActors:input.bannedActors});
  state.revision=input.revision;state.captureEpoch=input.captureEpoch;state.chatClearThroughMs=input.chatClearThroughMs;
  state.sources=structuredClone(input.sources).filter(s=>s.sessionId===state.session.id).slice(-500).map(s=>sourceTombstoned(state,s)||state.bannedActors.includes(s.actorId??'')?{...s,text:null,status:'deleted' as const}:s);
  state.nodes=Object.fromEntries(input.entities.map(n=>[n.id,structuredClone(n)]));
  for(const n of input.entities){
    state.ownerRevisions[n.id]=n.ownerRevision;if(n.ownerLocked)state.ownerLocks.push(n.id);
    if(!n.active){state.suppressedIds.push(n.id);if(n.kind==='chapter')state.editorialExcludedRefs.push(...leafRefs(state,[...n.supports,...n.exposedTo]));continue;}
    if(n.kind==='chapter'){const c=ChapterSchema.safeParse(n.body);if(c.success)state.chapters.push({...c.data,revision:n.revision,pinned:n.pinned,ownerEditRevision:n.ownerRevision});}
    if(n.kind==='lore'){const l=LoreSchema.safeParse(n.body);if(l.success&&!blockedPhrase(state,l.data.term,l.data.aliases))state.lore.push(l.data);}
    if(n.kind==='moment'){const m=MomentSchema.safeParse(n.body);if(m.success)state.moments.push(m.data);}
    if(n.kind==='presentation'&&n.body&&typeof n.body==='object'&&'kind' in n.body&&n.body.kind==='lore')state.lorePresentations.push(structuredClone(n.body as LorePresentation));
    if(n.kind==='claim'){
      const claim=GroundedClaimSchema.safeParse(n.body);
      if(claim.success){const refs=leafRefs(state,claim.data.support);if(refs.length&&refs.every(r=>isRefActive(state,r)))state.memory.push({id:n.id,text:claim.data.text,refs,role:claim.data.role,firstAtMs:n.startMs,lastAtMs:n.endMs});}
    }
    if(n.kind==='media'&&n.body&&typeof n.body==='object'&&'state' in n.body){const m=n.body as DomainMedia;if(['pending','ready','unavailable','revoked'].includes(m.state))state.media.push(structuredClone(m));}
  }
  state.editorialExcludedRefs=uniqueRefs(state.editorialExcludedRefs);
  state.chapters=state.chapters.sort((a,b)=>a.startMs-b.startMs||a.revision-b.revision).slice(-300);
  state.lore=[...state.lore,...structuredClone(input.blockedLore??[]).filter(l=>!state.lore.some(existing=>existing.id===l.id))].slice(-50);state.moments=state.moments.slice(-200);state.media=state.media.slice(-200);
  state.lorePresentations=state.lorePresentations.filter(p=>state.lore.some(l=>l.id===p.entityId&&l.revision===p.entityRevision)&&p.inputRefs.every(ref=>isRefActive(state,ref))).slice(-100);
  state.memory.sort((a,b)=>a.firstAtMs-b.firstAtMs);if(state.memory.length>64)state.memory=[state.memory[0]!,...state.memory.slice(-63)];
  state.candidates=structuredClone(input.candidates).filter(c=>(c.status==='published'||c.privacyEpoch===state.session.privacyEpoch)&&!state.suppressedIds.includes(c.entityId)&&c.ownerRevision===(state.ownerRevisions[c.entityId]??0)&&c.inputRefs.every(r=>isRefActive(state,r)));
  for(const c of state.candidates)if(!state.nodes[c.id])state.nodes[c.id]={id:c.id,revision:1,kind:'presentation',supports:c.chapter.dependencyRefs,exposedTo:c.inputRefs,startMs:c.chapter.startMs,endMs:c.chapter.maxDependencyEndMs,active:true,body:c};
  const selected:StoryCandidate[]=[];
  for(const id of new Set(state.candidates.map(c=>c.entityId))){const candidate=state.candidates.filter(c=>c.entityId===id&&c.status==='published'&&c.language===state.settings.recapLanguage&&safetyAllowsPublication(c.safety)).sort((a,b)=>b.revision-a.revision)[0];if(candidate)selected.push(candidate);}
  selected.sort((a,b)=>a.chapter.startMs-b.chapter.startMs);
  state.activeChapterId=state.chapters.at(-1)?.id??null;
  const latest=selected.find(c=>c.entityId===state.activeChapterId)??selected.at(-1);state.current=latest?.current??null;
  if(input.published&&input.published.privacyEpoch===state.session.privacyEpoch){state.published=structuredClone(input.published);state.metadataReviewed=true;}
  else if(selected.length||state.session.status==='finalized'){
    const asOf=new Date(Date.parse(state.session.startedAt)+Math.max(0,...selected.map(c=>c.chapter.maxDependencyEndMs))).toISOString();
    state.published={schemaVersion:1,channel:state.channel,session:{id:state.session.id,title:'',category:'',startedAt:state.session.startedAt,endedAt:state.session.endedAt,status:state.session.status,metadataMaxDependencyEndMs:0},revision:state.session.publicationRevision,privacyEpoch:state.session.privacyEpoch,language:state.settings.recapLanguage,asOf,publishedAt:state.session.finalizedAt??asOf,liveLeaseUntil:null,current:state.current,chapters:selected.map(({chapter:c})=>{const {sessionId:_s,ownerEditRevision:_o,publicationState:_p,eligibleAt:_e,safety:_sf,dependencyRefs:_d,...value}=c;return value;}),lore:[],moments:[],gaps:[],lastSyncedAt:state.session.finalSnapshotAckAt,vodUrl:null};
  }
  state.sequence=Math.max(input.revision*1000,...input.entities.flatMap(n=>[...n.id.matchAll(/:(\d+)(?=:|$)/g)].map(m=>Number(m[1]))),0);
  state.sourceRevision=state.sources.length;state.processedSourceRevision=0;
  if(state.session.status==='closing'&&state.session.endedAt){const endedAtMs=Date.parse(state.session.endedAt);state.closing={endedAtMs,intakeUntilMs:endedAtMs+90000,deadlineMs:endedAtMs+240000,tailDrained:false,finalProcessedRevision:0,failed:false};}
  if(state.published){const recoveryTime=state.session.finalSnapshotAckAt??state.session.finalizedAt??state.published.publishedAt;state.published.lore=publishedLore(state,options.clock??{now:()=>Date.parse(recoveryTime),iso:()=>recoveryTime});}
  return state;
}
