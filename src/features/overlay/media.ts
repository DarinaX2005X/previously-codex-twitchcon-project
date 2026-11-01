import type { RecapPlan } from '../../shared/contracts/index.js';

export type MediaResolver = (id:string) => string | undefined;
export type PreparedMedia = { visuals: Map<string,HTMLVideoElement|HTMLImageElement>; narrator: HTMLAudioElement|null; release():void };
export function emptyMedia():PreparedMedia {return {visuals:new Map(),narrator:null,release(){}};}
export function releaseElement(element:HTMLMediaElement|HTMLImageElement):void {
  if(element instanceof HTMLMediaElement) {element.pause();element.removeAttribute('src');element.load();}
  else element.removeAttribute('src');
  element.remove();
}
/** Prepared bytes stay inside the current sink. A preview never acknowledges or dispatches a broadcast. */
export async function prepareMedia(plan:RecapPlan,resolve:MediaResolver|undefined,signal:AbortSignal,timeoutMs=1500):Promise<PreparedMedia> {
  const bundle=emptyMedia(), all:(HTMLMediaElement|HTMLImageElement)[]=[];
  let released=false;
  bundle.release=()=>{if(released)return;released=true;for(const el of all)releaseElement(el);bundle.visuals.clear();bundle.narrator=null;};
  signal.addEventListener('abort',bundle.release,{once:true});
  if(!resolve||signal.aborted)return bundle;
  const load=(id:string,kind:'video'|'image'|'audio',inMs=0)=>new Promise<void>(done=>{
    const src=resolve(id);if(!src||signal.aborted){done();return;}
    const el=kind==='image'?new Image():document.createElement(kind);all.push(el);
    let settled=false;let timer:ReturnType<typeof setTimeout>;
    const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);el.removeEventListener('error',error);el.removeEventListener('loadeddata',ready);el.removeEventListener('load',ready);el.removeEventListener('seeked',seeked);signal.removeEventListener('abort',error);
      if(ok&&!signal.aborted&&!released){if(kind==='audio')bundle.narrator=el as HTMLAudioElement;else bundle.visuals.set(id,el as HTMLVideoElement|HTMLImageElement);}else releaseElement(el);done();};
    const error=()=>finish(false),seeked=()=>finish(true);
    const ready=()=>{if(el instanceof HTMLMediaElement&&inMs>0&&Math.abs(el.currentTime-inMs/1000)>.05){if(!Number.isFinite(el.duration)||inMs/1000>=el.duration){finish(false);return;}el.currentTime=inMs/1000;el.addEventListener('seeked',seeked,{once:true});}else finish(true);};
    el.addEventListener('error',error,{once:true});el.addEventListener(kind==='image'?'load':'loadeddata',ready,{once:true});signal.addEventListener('abort',error,{once:true});timer=setTimeout(error,timeoutMs);
    if(el instanceof HTMLMediaElement){el.preload='auto';if(el instanceof HTMLVideoElement){el.muted=true;el.playsInline=true;}}
    el.src=src;
  });
  await Promise.all([...plan.media.map(m=>load(m.id,m.kind,m.inMs)),...(plan.audio?[load(plan.audio.id,'audio')]:[])]);
  return bundle;
}
export function desiredVideoTime(plan:RecapPlan,id:string,sceneTimeMs:number,mediaStartMs:number):number|null {
  const media=plan.media.find(m=>m.id===id);if(!media)return null;
  return Math.max(media.inMs,Math.min(media.outMs,media.inMs+Math.max(0,sceneTimeMs-mediaStartMs)))/1000;
}
/** Drift correction is anchored to the scene, never to the preceding video frame. */
const playAttempts=new WeakMap<HTMLMediaElement,{pending:boolean;blocked:boolean}>();
export function syncMedia(element:HTMLMediaElement,targetSeconds:number,playing:boolean,onBlocked?:()=>void):void {
  const target=Number.isFinite(element.duration)?Math.min(Math.max(0,element.duration-.04),targetSeconds):targetSeconds;
  if(Math.abs(element.currentTime-target)>.12&&!element.seeking)element.currentTime=target;
  const attempt=playAttempts.get(element)??{pending:false,blocked:false};playAttempts.set(element,attempt);
  if(playing&&element.paused&&!attempt.pending&&!attempt.blocked){attempt.pending=true;void element.play().catch(()=>{attempt.blocked=true;onBlocked?.();}).finally(()=>{attempt.pending=false;});}
  else if(!playing){attempt.blocked=false;if(!element.paused)element.pause();}
}
