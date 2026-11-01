import type { OverlayLayout, PublicSnapshot, RecapPlan, RecapTrigger, VersionRef } from '../shared/contracts/index.js';
import type { DomainMedia, DomainState } from './types.js';
import { isRefActive, uniqueRefs } from './evidence.js';

/** Every public consumer uses this projection; this selector never falls back to drafts. */
export const selectPublicSnapshot=(state:DomainState):PublicSnapshot|null=>state.published;
export function compileRecap(snapshot:PublicSnapshot,layout:OverlayLayout,trigger:RecapTrigger,options:{media?:DomainMedia[];durationMs?:10000|12000|15000;welcomeOnly?:boolean;generatedAt?:string}={}):RecapPlan {
  const media=options.media??[],duration=options.durationMs??12000;
  const texts:{kind:'attempt'|'change'|'now';text:string}[]=[];
  if(!options.welcomeOnly&&snapshot.current){
    if(snapshot.current.goal)texts.push({kind:'attempt',text:snapshot.current.goal});
    if(snapshot.current.change)texts.push({kind:'change',text:snapshot.current.change});
    if(snapshot.current.now&&!texts.some(t=>t.text===snapshot.current!.now))texts.push({kind:'now',text:snapshot.current.now});
  }
  if(!options.welcomeOnly&&texts.length<2){for(const chapter of [...snapshot.chapters].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.endMs-a.endMs).slice(0,3)){if(!texts.some(t=>t.text===chapter.summary))texts.push({kind:texts.length?'change':'attempt',text:chapter.summary.slice(0,300)});if(texts.length>=3)break;}}
  const welcome=texts.length<2||!!options.welcomeOnly,selected=welcome?[]:texts.slice(0,3);
  const deps:VersionRef[]=welcome?[]:snapshot.chapters.slice(-6).map(c=>({id:c.id,revision:c.revision}));
  const permitted=media.filter(m=>m.state==='ready'&&m.ownerApproved&&(welcome?m.previousSession:!m.previousSession&&snapshot.moments.some(x=>x.id===m.momentId&&x.mediaState==='ready'))).slice(0,welcome?1:3);
  const total=welcome?5000:duration;
  return {id:`recap:${trigger.id}`,sessionId:snapshot.session.id,revision:snapshot.revision,privacyEpoch:snapshot.privacyEpoch,language:snapshot.language,variant:welcome?'welcome':permitted.length?'full':'compact',durationMs:total,dependencyRefs:uniqueRefs([...deps,...permitted.flatMap(m=>[{id:m.id,revision:m.revision},...m.refs])]),layout,arrivals:trigger.reason==='raid'?[{triggerId:trigger.id,fromLogin:(trigger.fromLogin??'').slice(0,25),viewers:Math.max(0,trigger.viewers??0)}]:[],overflowArrivals:{channels:0,viewers:0},beats:selected.map((t,i)=>({id:`beat:${trigger.id}:${i}`,kind:t.kind,text:t.text.slice(0,300),atMs:Math.round(i*total/selected.length),untilMs:Math.round((i+1)*total/selected.length),sourceRange:{startMs:snapshot.chapters.at(-1)?.startMs??0,endMs:snapshot.current?.maxDependencyEndMs??snapshot.chapters.at(-1)?.endMs??0},sourceIds:deps.map(r=>r.id).slice(0,20),mediaId:permitted[i]?.id??null})),media:permitted.map(m=>({id:m.id,kind:m.kind==='image'?'image':'video',inMs:0,outMs:Math.min(m.durationMs,total),captureStartMs:m.captureStartMs,captureEndMs:m.captureEndMs,previousSession:m.previousSession})),audio:null,soundEvents:[],generatedAt:options.generatedAt??trigger.occurredAt};
}
export function canDispatch(state:DomainState,input:{sessionId:string;privacyEpoch:number;dependencyRefs:VersionRef[]}):boolean {
  return input.sessionId===state.session.id&&input.privacyEpoch===state.session.privacyEpoch&&input.dependencyRefs.every(ref=>isRefActive(state,ref));
}
