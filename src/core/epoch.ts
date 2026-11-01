import { safetyAllowsPublication } from '../shared/contracts/index.js';
import type { Source, VersionRef } from '../shared/contracts/index.js';
import type { DomainState, DomainEffect, StoryCandidate } from './types.js';
import { isRefActive, leafRefs, sourceTombstoned } from './evidence.js';

function sourceFor(state:DomainState,id:string):Source|undefined {
  return state.sources.find(source=>source.id===id)??(state.nodes[id]?.body as {evidenceMetadata?:Source}|null)?.evidenceMetadata;
}
function ownerReviewSource(state:DomainState,refs:VersionRef[]):Source|undefined {
  return leafRefs(state,refs).map(ref=>sourceFor(state,ref.id)).reverse().find(source=>source?.kind==='owner_statement'&&source.status==='active'&&!sourceTombstoned(state,source)&&!state.bannedActors.includes(source.actorId??''));
}

/** SQLite cancels every in-flight ticket on an epoch change; mirror that decision in the checkpoint. */
export function reconcilePrivacyEpoch(state:DomainState,previousEpoch:number,effects:DomainEffect[]):StoryCandidate[] {
  if(state.session.privacyEpoch===previousEpoch)return [];
  const stale=state.candidates.filter(candidate=>candidate.status!=='published'&&candidate.privacyEpoch!==state.session.privacyEpoch);
  state.candidates=state.candidates.filter(candidate=>candidate.status==='published'||candidate.privacyEpoch===state.session.privacyEpoch);
  const safeOwner:StoryCandidate[]=[];
  for(const candidate of stale){
    for(const id of [candidate.id,...candidate.currentNodeId?[candidate.currentNodeId]:[]]){const node=state.nodes[id];if(node?.active){node.active=false;node.body=null;node.revision++;effects.push({type:'entity.upsert',node:structuredClone(node)});}}
    if(candidate.ownerRevision>0&&candidate.ownerRevision===(state.ownerRevisions[candidate.entityId]??0)&&safetyAllowsPublication(candidate.safety)&&candidate.inputRefs.every(ref=>isRefActive(state,ref))&&!state.suppressedIds.includes(candidate.entityId))safeOwner.push({...structuredClone(candidate),id:`epoch:${state.session.privacyEpoch}:${candidate.id}`.slice(0,160),privacyEpoch:state.session.privacyEpoch,status:'pending',currentNodeId:undefined});
  }
  if(stale.some(candidate=>candidate.ownerRevision===0)){
    state.processedSourceRevision=Math.min(state.processedSourceRevision,Math.max(0,state.sourceRevision-1));state.lastCurrentAtMs=null;state.nextGenerationAfterMs=0;
  }
  for(const chapter of state.chapters.filter(chapter=>chapter.edited&&!safetyAllowsPublication(chapter.safety)&&['draft','held'].includes(chapter.publicationState))){
    const source=ownerReviewSource(state,chapter.dependencyRefs);if(!source)continue;
    if(chapter.dependencyRefs.some(ref=>ref.id!==source.id&&!isRefActive(state,ref)))continue;
    effects.push({type:'owner.review.request',kind:'chapter',entityId:chapter.id,entityRevision:chapter.revision,ownerRevision:chapter.ownerEditRevision,sourceId:source.id,sourceRevision:source.revision,privacyEpoch:state.session.privacyEpoch,dependencyRefs:chapter.dependencyRefs});
  }
  for(const lore of state.lore.filter(lore=>lore.status==='held'&&!safetyAllowsPublication(lore.safety))){
    const source=ownerReviewSource(state,lore.dependencyRefs);if(!source||lore.dependencyRefs.some(ref=>ref.id!==source.id&&!isRefActive(state,ref)))continue;
    effects.push({type:'owner.review.request',kind:'lore',entityId:lore.id,entityRevision:lore.revision,sourceId:source.id,sourceRevision:source.revision,privacyEpoch:state.session.privacyEpoch,dependencyRefs:lore.dependencyRefs});
  }
  if(state.pendingClipId){
    const moment=state.moments.find(moment=>moment.id===state.pendingClipId);if(moment){moment.mediaState='unavailable';moment.revision++;const node=state.nodes[moment.id];if(node){node.revision=moment.revision;node.body=moment;effects.push({type:'entity.upsert',node:structuredClone(node)});}}
    state.pendingClipId=null;
  }
  return safeOwner;
}
