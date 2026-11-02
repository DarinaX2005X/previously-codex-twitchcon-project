import type { Clock, Source, VersionRef } from '../shared/contracts/index.js';
import { asksForClip, isLaughter } from './chat-signals.js';
import { DOMAIN_LIMITS, type DomainState, type DomainEffect, type ReactionWindow } from './types.js';
import { blockedPhrase, normalizeTerm, refOf, uniqueRefs } from './evidence.js';

export function saveMoment(state:DomainState,effects:DomainEffect[],input:{id?:string;atMs:number;label?:string;sourceRefs?:VersionRef[];reasons?:string[];count?:number;distinctActors?:number;baseline?:number},clock:Clock):void {
  const id=input.id??`moment:${state.session.id}:${++state.sequence}`;
  if(state.moments.some(m=>m.id===id)||state.suppressedIds.includes(id))return;
  const refs=uniqueRefs(input.sourceRefs??[]),startMs=Math.max(0,input.atMs-10000),endMs=input.atMs;
  const moment={id,sessionId:state.session.id,revision:1,startMs,endMs,label:(input.label??'Saved moment').slice(0,160),triggerReasons:input.reasons??['owner_save'],clip:null,mediaState:'none' as const,maxDependencyEndMs:endMs,count:input.count??0,distinctActors:input.distinctActors??0,baseline:input.baseline??0,mediaId:null,dependencyRefs:refs};
  state.moments.push(moment);state.moments=state.moments.slice(-DOMAIN_LIMITS.moments);
  state.nodes[id]={id,revision:1,kind:'moment',supports:refs,exposedTo:refs,startMs,endMs,active:true,body:moment};effects.push({type:'entity.upsert',node:state.nodes[id]});
  if(state.settings.autoClips&&state.session.status==='live'&&!state.pendingClipId){state.pendingClipId=id;moment.mediaState='none';effects.push({type:'clip.request',moment,privacyEpoch:state.session.privacyEpoch});state.lastAutoMomentAtMs=clock.now();}
}
function closeWindow(state:DomainState,effects:DomainEffect[],clock:Clock):void {
  const w=state.openWindow;if(!w)return;
  const completed=state.windows.filter(old=>old.startMs>=w.startMs-300000&&old.startMs<w.startMs);
  const baseline=completed.length?completed.reduce((n,x)=>n+x.count,0)/completed.length:0;
  const actors=Object.keys(w.actors).length;
  const warm=completed.length>=3;
  const burst=warm&&w.count>=Math.max(4,baseline*2.5)&&actors>=3;
  const deliberate=actors>=2&&w.clipIt>=2;
  const reaction=actors>=3&&(w.laughter+w.emotes)>=3;
  const cooldown=state.lastAutoMomentAtMs===null||clock.now()-state.lastAutoMomentAtMs>=60000;
  if(cooldown&&(deliberate||burst&&reaction)){saveMoment(state,effects,{atMs:w.startMs+10000,sourceRefs:w.refs,reasons:[...(burst?['activity_burst']:[]),...(w.emotes?['emotes']:[]),...(w.laughter?['laughter']:[]),...(deliberate?['clip_it']:[])],count:w.count,distinctActors:actors,baseline,label:'Chat reaction'},clock);state.lastAutoMomentAtMs=clock.now();}
  state.windows=[...completed,w].slice(-DOMAIN_LIMITS.windows);state.openWindow=null;
}
export function advanceWindows(state:DomainState,effects:DomainEffect[],offsetMs:number,clock:Clock):void {
  if(state.openWindow&&state.openWindow.startMs+10000<=offsetMs)closeWindow(state,effects,clock);
  state.windows=state.windows.filter(w=>w.startMs>=offsetMs-310000).slice(-30);
}
export function observeChat(state:DomainState,source:Source,effects:DomainEffect[],clock:Clock,signals?:{emote?:boolean;laughter?:boolean;clipIt?:boolean},phrase?:string):void {
  if(source.kind!=='chat'||!source.actorId||!source.text||source.text.trim().startsWith('!'))return;
  advanceWindows(state,effects,source.startMs,clock);
  const startMs=Math.floor(source.startMs/10000)*10000;
  if(state.openWindow&&startMs<state.openWindow.startMs)return;
  const w:ReactionWindow=state.openWindow??{startMs,actors:{},count:0,emotes:0,laughter:0,clipIt:0,refs:[]};
  const actorKey=`actor:${source.actorId}`,prior=w.actors[actorKey]??0;
  if(prior>=2||!prior&&Object.keys(w.actors).length>=DOMAIN_LIMITS.actorsPerWindow)return;
  w.actors[actorKey]=prior+1;w.count++;
  // Count each actor once per signal; an actor cannot manufacture a crowd with repetition.
  if(prior===0){if(signals?.emote)w.emotes++;if(signals?.laughter||isLaughter(source.text))w.laughter++;if(signals?.clipIt||asksForClip(source.text))w.clipIt++;}
  if(w.refs.length<100)w.refs.push(refOf(source));state.openWindow=w;
  if(phrase)observePhrase(state,source,phrase);
}
/** Reviewed text contributes lore observations without counting its chat reaction a second time. */
export function observePhrase(state:DomainState,source:Source,phrase:string):void {
  if(source.kind!=='chat'||!source.actorId||!source.text||source.text.trim().startsWith('!'))return;
  const term=normalizeTerm(phrase);
  if(!term||term.length>120||term.startsWith('!')||!/[\p{L}\p{N}]/u.test(term)||blockedPhrase(state,term))return;
  let entry=state.phrases.find(p=>p.term===term||p.aliases.includes(term));
  if(!entry){entry={term,aliases:[],firstMs:source.startMs,lastMs:source.endMs,actors:[],refs:[]};state.phrases.push(entry);}
  entry.lastMs=source.endMs;if(!entry.actors.includes(source.actorId)&&entry.actors.length<20)entry.actors.push(source.actorId);
  entry.refs=uniqueRefs([...entry.refs,refOf(source)]).slice(-20);
  state.phrases=state.phrases.slice(-DOMAIN_LIMITS.phraseCandidates);
}
