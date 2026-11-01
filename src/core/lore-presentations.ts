import { safetyAllowsPublication } from '../shared/contracts/index.js';
import type { Clock, Lore, PublicLore, RecapLanguage, Safety, VersionRef } from '../shared/contracts/index.js';
import type { DomainState, DomainEffect, LorePresentation } from './types.js';
import { blockedPhrase, dependencyRange, isRefActive, refOf, stateHash, uniqueRefs } from './evidence.js';

export function retireLorePresentations(state:DomainState,id:string,effects:DomainEffect[],language?:RecapLanguage):void {
  for(const presentation of state.lorePresentations.filter(p=>p.entityId===id&&(!language||p.language===language))){
    const node=state.nodes[presentation.id];if(node?.active){node.active=false;node.body=null;node.revision++;effects.push({type:'entity.upsert',node:structuredClone(node)});}
  }
  state.lorePresentations=state.lorePresentations.filter(p=>p.entityId!==id||!!language&&p.language!==language);
}

export function recordLorePresentation(state:DomainState,lore:Lore,input:{language:RecapLanguage;term:string;explanation:string;safety:Safety;inputRefs?:VersionRef[]},effects:DomainEffect[],clock:Clock):boolean {
  if(!input.term.trim()||input.term.length>120||!input.explanation.trim()||input.explanation.length>700||blockedPhrase(state,lore.term,lore.aliases)||blockedPhrase(state,input.term))return false;
  const refs=uniqueRefs([refOf(lore),...lore.dependencyRefs,...input.inputRefs??[]]);
  if(!refs.every(ref=>isRefActive(state,ref)))return false;
  retireLorePresentations(state,lore.id,effects,input.language);
  const maxDependencyEndMs=Math.max(lore.maxDependencyEndMs,dependencyRange(state,refs).endMs);
  const presentation:LorePresentation={kind:'lore',id:`lore-presentation:${stateHash(lore.id)}:${lore.revision}:${input.language}:${++state.sequence}`,entityId:lore.id,entityRevision:lore.revision,language:input.language,term:input.term.trim(),explanation:input.explanation,safety:structuredClone(input.safety),inputRefs:refs,privacyEpoch:state.session.privacyEpoch,eligibleAtMs:lore.originKind==='owner_confirmed'?clock.now():Date.parse(state.session.startedAt)+maxDependencyEndMs+state.settings.publicationDelaySeconds*1000,maxDependencyEndMs};
  state.lorePresentations.push(presentation);
  const node={id:presentation.id,revision:1,kind:'presentation' as const,supports:[refOf(lore)],exposedTo:refs,startMs:lore.firstSeenMs,endMs:maxDependencyEndMs,active:true,body:structuredClone(presentation)};
  state.nodes[node.id]=node;effects.push({type:'entity.upsert',node});return true;
}

export function safeLorePresentation(state:DomainState,lore:Lore,language:RecapLanguage):LorePresentation|undefined {
  if(!['confirmed','published'].includes(lore.status)||!safetyAllowsPublication(lore.safety)||blockedPhrase(state,lore.term,lore.aliases)||!lore.dependencyRefs.every(ref=>isRefActive(state,ref)))return undefined;
  return state.lorePresentations.find(p=>p.entityId===lore.id&&p.entityRevision===lore.revision&&p.language===language&&safetyAllowsPublication(p.safety)&&state.nodes[p.id]?.active&&p.inputRefs.every(ref=>isRefActive(state,ref)));
}

export function publishedLore(state:DomainState,clock:Clock):PublicLore[] {
  return state.lore.flatMap(lore=>{
    const presentation=safeLorePresentation(state,lore,state.settings.recapLanguage);if(!presentation||presentation.eligibleAtMs>clock.now())return [];
    const {sessionId:_s,revision:_r,status:_st,aliases:_a,dependencyRefs:_d,safety:_sf,...item}=lore;
    return [{...item,term:presentation.term,explanation:presentation.explanation,maxDependencyEndMs:presentation.maxDependencyEndMs}];
  });
}

/** Unconfirmed/held lore does not obstruct a language switch or a raid. */
export function loreLanguageReady(state:DomainState,language:RecapLanguage,clock:Clock):boolean {
  return (state.published?.lore??[]).every(visible=>{const lore=state.lore.find(item=>item.id===visible.id);if(!lore)return false;const presentation=safeLorePresentation(state,lore,language);return !!presentation&&presentation.eligibleAtMs<=clock.now();});
}
