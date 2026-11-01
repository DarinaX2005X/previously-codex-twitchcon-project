import type { RecapPlan, Rect } from '../../shared/contracts/index.js';
import { wrapCaption, type MeasureText, type SceneLayout } from './geometry.js';

export const segment = (t:number,a:number,b:number) => Math.max(0,Math.min(1,(t-a)/(b-a)));
const out = (p:number) => 1-Math.pow(1-p,4);
const mix = (a:number,b:number,p:number) => a+(b-a)*p;
export type ScenePhase = 'opening'|'attempt'|'change'|'origin'|'context'|'assembly'|'now'|'return'|'clear';
export type Plane = Rect & {rotate:number;scale:number;opacity:number;blur:number};
export type CaptionFrame = { text:string; lines:string[]; kind:RecapPlan['beats'][number]['kind']; sourceMs:number; reveal:number; outgoing:number; page:number; pages:number; };
export type SceneFrame = {
  visible:boolean;phase:ScenePhase;timeMs:number;opacity:number;opening:number;openingExit:number;
  aperture:Plane;source:Plane;retainedPlane:Plane|null;retainedCaption:CaptionFrame|null;edgeOffsets:number[];caption:CaptionFrame|null;nextCaption:CaptionFrame|null;
  assembly:number;exit:number;mark:number;mediaId:string|null;mediaTimeMs:number;mediaVisible:boolean;
};
export type SceneSoundEvent = {id:string;kind:string;atMs:number;gain:number};

/** Scene and sound use the same authored landmarks, stretched only for the 15 s context cut. */
export function authoredTime(timeMs:number,plan:RecapPlan):number {
  if(plan.variant==='welcome')return timeMs*12000/plan.durationMs;
  if(plan.durationMs===10000) return timeMs < 4300 ? timeMs : timeMs+2000;
  return timeMs*12000/plan.durationMs;
}
function actualTime(time:number,plan:RecapPlan):number {
  if(plan.durationMs===10000&&plan.variant!=='welcome')return time<=4300?time:time<6300?4300:time-2000;
  return time*plan.durationMs/12000;
}
export function sceneSoundEvents(plan:RecapPlan):SceneSoundEvent[] {
  if(plan.soundEvents.length)return plan.soundEvents;
  const beats=selectedBeats(plan),hasOrigin=beats.some(beat=>beat.kind==='origin');
  const points:[string,number,number][]=[['felt',110,.22],['air',360,.12],['ceramic',2060,.18],...(beats.length>1?[['felt',beats.length===2?6100:3400,.2] as [string,number,number]]:[]),...(hasOrigin?[['ceramic',5150,.14],['ceramic',5340,.1]] as [string,number,number][]:[]),['felt',6250,.2],['air',10000,.12],['resolve',11100,.18]];
  return points.filter(([,t])=>!(plan.durationMs===10000&&t>4300&&t<6300)).map(([kind,t,gain],i)=>({id:`${plan.id}:sound:${i}`,kind,atMs:actualTime(t,plan),gain}));
}
function selectedBeats(plan:RecapPlan):RecapPlan['beats'] {
  // A compact cut can omit a real optional origin. No unsupported story role is manufactured.
  return plan.durationMs===10000&&plan.beats.length>3?plan.beats.filter(beat=>beat.kind!=='origin'):plan.beats;
}
function caption(beat:RecapPlan['beats'][number]|undefined,t:number,start:number,end:number,layout:SceneLayout,measure?:MeasureText,width=layout.bounds.width-112):CaptionFrame|null {
  if(!beat)return null;
  const lines=wrapCaption(beat.text,width,layout.captionSize,measure);
  return {text:beat.text,lines,kind:beat.kind,sourceMs:beat.sourceRange.startMs,reveal:out(segment(t,start,start+380)),outgoing:out(segment(t,end-300,end)),page:0,pages:1};
}

export function sceneTextFits(plan:RecapPlan,layout:SceneLayout,options:{measure?:MeasureText;hasMedia?:boolean;reducedMotion?:boolean}={}):boolean {
  if(options.reducedMotion){const lineCount=plan.beats.reduce((n,b)=>n+wrapCaption(b.text,layout.bounds.width-112,80,options.measure).length,0);return lineCount*84<=layout.bounds.height-120;}
  return plan.beats.every(beat=>wrapCaption(beat.text,layout.bounds.width-(options.hasMedia&&beat.kind!=='now'?650:112),layout.captionSize,options.measure).length<=2);
}

/** No DOM reads, timers, mutable timeline, randomness or accumulated transforms. Seeking is order independent. */
export function renderAt(timeMs:number,plan:RecapPlan,layout:SceneLayout,options:{reducedMotion?:boolean;measure?:MeasureText;hasMedia?:boolean}={}):SceneFrame {
  const t=authoredTime(timeMs,plan), {width:w,height:h}=layout.bounds;
  const visible=timeMs>=0&&timeMs<plan.durationMs;
  const entry=out(segment(t,0,350)), apertureOpen=out(segment(t,1400,2250));
  const join=out(segment(t,6000,7250)), exit=out(segment(t,9750,11100));
  const beats=selectedBeats(plan),first=beats[0],last=beats.at(-1);
  const starts=beats.length<=1?[1900]:beats.length===2?[1900,6500]:beats.length===3?[1900,3400,7000]:[1900,3400,4700,7000];
  const secondPlaneAt=beats.length===2?6000:3250;
  const hasSecond=beats.length>1&&plan.variant!=='welcome';
  const incoming=hasSecond?out(segment(t,secondPlaneAt,beats.length===2?7250:4300)):0;
  const welcome=plan.variant==='welcome';
  let index=hasSecond&&t>=secondPlaneAt?1:0;
  for(let i=2;i<beats.length;i++)if(t>=starts[i]+300)index=i;
  const beat=beats[index],start=starts[index]??1900,end=starts[index+1]!==undefined?starts[index+1]+300:10100;
  const cap=caption(welcome?last:beat,t,welcome?1800:start,welcome?10000:end,layout,options.measure,w-(options.hasMedia&&t<6750?650:112));
  const activeMedia=plan.media.find(m=>m.id===first?.mediaId)??plan.media[0];
  const mediaStart=actualTime(2000,plan);
  const mediaTime=activeMedia?Math.max(activeMedia.inMs,Math.min(activeMedia.outMs,activeMedia.inMs+Math.max(0,timeMs-mediaStart))):0;
  let frame:SceneFrame={visible,phase:!visible?'clear':t<1700?'opening':t>=9750?'return':t>=6000&&t<7250?'assembly':beat?.kind??'context',timeMs,opacity:Math.min(segment(t,0,100),1-segment(t,11600,12000)),opening:out(segment(t,250,1100)),openingExit:out(segment(t,1400,2200)),
    aperture:{x:(hasSecond&&t>=secondPlaneAt?mix(w+48,56,incoming)-28*join:mix(138,28,entry))-exit*88,y:mix(38,24,apertureOpen)+12*Math.sin(segment(t,2250,6000)*Math.PI),width:mix(Math.min(w-88,1160),w-56,apertureOpen)*(1-exit*.86),height:mix(h-66,h-48,apertureOpen)*(1-exit*.62),rotate:mix(-2,0,entry)-incoming*1.6*(1-join),scale:1-.028*Math.sin(segment(t,6100,6500)*Math.PI),opacity:1,blur:8*(1-entry)},
    source:{x:mix(options.hasMedia?w-550:layout.mode==='compact'?w-390:116,w-390,join),y:mix(options.hasMedia?h-320:layout.mode==='compact'?28:h-118,28,join),width:mix(options.hasMedia?490:layout.mode==='compact'?330:Math.min(480,w*.3),330,join),height:mix(options.hasMedia?276:layout.mode==='compact'?60:100,layout.mode==='compact'?60:94,join),rotate:mix(-3,0,join),scale:1,opacity:(1-exit)*(1-segment(t,6400,7200)*.15),blur:Math.abs(Math.sin(segment(t,6000,7250)*Math.PI))*1.2},
    retainedPlane:hasSecond&&t>=secondPlaneAt&&t<7250?{x:28-12*incoming,y:24+18*incoming,width:w-56,height:h-48,rotate:-3*incoming*(1-join),scale:1-.28*incoming*(1-join),opacity:1-join,blur:0}:null,
    retainedCaption:hasSecond&&t>=secondPlaneAt&&t<7250?caption(first,2800,1900,10100,layout,options.measure,w-(options.hasMedia?650:112)):null,
    edgeOffsets:[(1-out(segment(t,0,350)))*140,(1-out(segment(t,60,410)))*100,(1-out(segment(t,120,470)))*90].slice(0,Math.max(1,Math.min(3,beats.length))),caption:cap,nextCaption:null,assembly:join,exit,mark:out(segment(t,10300,11100)),mediaId:activeMedia?.id??null,mediaTimeMs:mediaTime,mediaVisible:!!activeMedia&&t>=2000&&t<10200};
  const nextIndex=index+1;
  if(!welcome&&nextIndex>=2&&beats[nextIndex]&&t>=starts[nextIndex]&&t<starts[nextIndex]+300)frame.nextCaption=caption(beats[nextIndex],t,starts[nextIndex],starts[nextIndex+1]!==undefined?starts[nextIndex+1]+300:10100,layout,options.measure,w-(options.hasMedia&&t<6750?650:112));
  if(options.reducedMotion){
    frame={...frame,phase:visible?last?.kind??'context':'clear',opacity:Math.min(segment(timeMs,0,120),1-segment(timeMs,plan.durationMs-120,plan.durationMs)),opening:0,openingExit:1,aperture:{x:8,y:8,width:w-16,height:h-16,rotate:0,scale:1,opacity:1,blur:0},source:{x:0,y:0,width:0,height:0,rotate:0,scale:1,opacity:0,blur:0},retainedPlane:null,retainedCaption:null,edgeOffsets:[0,0,0],caption:caption(last,8000,7000,10000,layout,options.measure),nextCaption:null,assembly:1,exit:0,mark:0,mediaVisible:false};
  }
  return frame;
}
