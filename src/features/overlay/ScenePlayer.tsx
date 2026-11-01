import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RecapPlan } from '../../shared/contracts/index.js';
import { resolveSceneLayout, type SceneLayout, type MeasureText } from './geometry.js';
import { renderAt, sceneSoundEvents, sceneTextFits, type Plane, type CaptionFrame } from './scene.js';
import { prepareMedia, syncMedia, type PreparedMedia, type MediaResolver } from './media.js';
import { SceneSound } from './sound.js';
import './overlay.css';

export type SceneStatus = 'ready'|'layout_required'|'text_too_long'|'audio_blocked'|'media_unavailable';
export type ScenePlayerProps = {
  plan:RecapPlan|null;timeMs?:number;playing?:boolean;channel?:string;title?:string;
  resolveMedia?:MediaResolver;preparedMedia?:PreparedMedia;reducedMotion?:boolean;soundEnabled?:boolean;volume?:number;
  className?:string;cropToLayout?:boolean;onEnded?:()=>void;onStatus?:(status:SceneStatus)=>void;
};
const timecode=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
const planeStyle=(p:Plane):CSSProperties=>({left:p.x,top:p.y,width:p.width,height:p.height,transform:`perspective(1800px) rotateY(${p.rotate}deg) scale(${p.scale})`,opacity:p.opacity,filter:p.blur>.1?`blur(${p.blur}px)`:undefined});
function useReducedMotion(explicit:boolean|undefined):boolean {
  const [value,setValue]=useState(()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{const query=matchMedia('(prefers-reduced-motion: reduce)'),update=()=>setValue(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  return explicit??value;
}
function Caption({caption,size,highlight=false}: {caption:CaptionFrame;size:number;highlight?:boolean}) {
  return <div className="scene-caption" style={{fontSize:size}} aria-label={caption.text}>
    {caption.lines.map((line,index)=><div key={`${caption.kind}:${caption.page}:${index}`} className="scene-line-mask"><span style={{transform:`translateY(${(1-caption.reveal)*105-caption.outgoing*110}%)`,filter:`blur(${(1-caption.reveal)*5}px)`}}>{highlight&&index===caption.lines.length-1?<mark>{line}</mark>:line}</span></div>)}
  </div>;
}
function Visual({bundle,id,timeMs,playing,onBlocked}: {bundle:PreparedMedia|null;id:string|null;timeMs:number;playing:boolean;onBlocked:()=>void}) {
  const host=useRef<HTMLDivElement>(null),element=id?bundle?.visuals.get(id):null;
  useLayoutEffect(()=>{if(!element||!host.current)return;element.className='scene-media-element';host.current.replaceChildren(element);return()=>{if(element instanceof HTMLVideoElement)element.pause();element.remove();};},[element]);
  useEffect(()=>{if(element instanceof HTMLVideoElement){element.muted=true;syncMedia(element,timeMs/1000,playing,onBlocked);}},[element,timeMs,playing,onBlocked]);
  return <div ref={host} className="scene-media-host"/>;
}

/** Read-only local renderer. It has no trigger, ACK, broadcast or publication API. */
export function ScenePlayer(props:ScenePlayerProps) {
  const {timeMs,playing=false,channel,title,resolveMedia,preparedMedia,soundEnabled=false,volume=.45,cropToLayout=false}=props;
  // Replay snapshots cross a worker boundary every tick. A captured plan is immutable by identity/revision.
  const plan=useMemo(()=>props.plan,[props.plan?.id,props.plan?.revision,props.plan?.privacyEpoch]);
  const root=useRef<HTMLDivElement>(null),[width,setWidth]=useState(1920),[localTime,setLocalTime]=useState(0),[media,setMedia]=useState<PreparedMedia|null>(null),[measure,setMeasure]=useState<MeasureText|undefined>();
  const reduced=useReducedMotion(props.reducedMotion),callbacks=useRef(props);callbacks.current=props;
  const layout=useMemo(()=>plan?resolveSceneLayout(plan.layout):null,[plan]);
  const sound=useRef<SceneSound|null>(null),ended=useRef(false),elapsed=useRef(0);
  useLayoutEffect(()=>{if(!root.current)return;const observer=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width));observer.observe(root.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{let alive=true;void document.fonts.ready.then(()=>{if(!alive)return;const ctx=document.createElement('canvas').getContext('2d');if(ctx)setMeasure(()=>(text:string,size:number,weight=600)=>{ctx.font=`${weight} ${size}px Onest, sans-serif`;return ctx.measureText(text).width;});});return()=>{alive=false;};},[]);
  useEffect(()=>{ended.current=false;elapsed.current=0;setLocalTime(0);},[plan?.id]);
  useEffect(()=>{
    if(!plan||timeMs!==undefined||!playing)return;
    const start=performance.now()-elapsed.current;let frame=0;
    const tick=(now:number)=>{elapsed.current=Math.min(plan.durationMs,now-start);setLocalTime(elapsed.current);if(elapsed.current<plan.durationMs)frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[plan,timeMs,playing]);
  useEffect(()=>{
    if(preparedMedia){setMedia(preparedMedia);return;}
    setMedia(null);if(!plan)return;const controller=new AbortController();let bundle:PreparedMedia|null=null;
    void prepareMedia(plan,resolveMedia,controller.signal).then(result=>{bundle=result;if(!controller.signal.aborted){setMedia(result);if(plan.media.length&&!result.visuals.size)callbacks.current.onStatus?.('media_unavailable');}});
    return()=>{controller.abort();bundle?.release();};
  },[plan,resolveMedia,preparedMedia]);
  useEffect(()=>{if(plan&&!layout)callbacks.current.onStatus?.('layout_required');else if(plan)callbacks.current.onStatus?.('ready');},[plan,layout]);
  useEffect(()=>{
    if(!plan||!soundEnabled||reduced||!playing)return;
    const instance=new SceneSound(volume,()=>callbacks.current.onStatus?.('audio_blocked'));sound.current=instance;void instance.enable();
    return()=>{instance.stop();sound.current=null;};
  },[plan?.id,soundEnabled,volume,reduced,playing]);
  const t=timeMs??localTime;
  const hasMedia=!!media?.visuals.size;
  const fits=!!plan&&!!layout&&sceneTextFits(plan,layout,{measure,hasMedia,reducedMotion:reduced});
  useEffect(()=>{if(plan&&layout&&!fits)callbacks.current.onStatus?.('text_too_long');},[plan,layout,fits]);
  const frame=plan&&layout&&fits?renderAt(t,plan,layout,{reducedMotion:reduced,measure,hasMedia}):null;
  useEffect(()=>{
    if(!plan)return;
    if(playing&&frame?.visible)sound.current?.tick(t,sceneSoundEvents(plan));
    if(media?.narrator&&plan.audio){const active=playing&&t>=plan.audio.startMs&&t<plan.audio.startMs+plan.audio.durationMs&&!!frame?.visible;media.narrator.volume=Math.max(0,Math.min(.7,volume));syncMedia(media.narrator,Math.max(0,t-plan.audio.startMs)/1000,active,()=>callbacks.current.onStatus?.('audio_blocked'));}
    if(t>=plan.durationMs&&!ended.current){ended.current=true;sound.current?.stop();media?.narrator?.pause();callbacks.current.onEnded?.();}
    if(!playing)sound.current?.stop();
  },[t,plan,playing,soundEnabled,frame?.visible,media,volume]);
  useEffect(()=>()=>{media?.narrator?.pause();for(const visual of media?.visuals.values()??[])if(visual instanceof HTMLVideoElement)visual.pause();},[media]);
  const canvasWidth=cropToLayout&&layout?layout.bounds.width:1920,canvasHeight=cropToLayout&&layout?layout.bounds.height:1080;
  const scale=width/canvasWidth;
  const available=frame?.mediaId?media?.visuals.has(frame.mediaId):false;
  const labels=plan?.language==='ru'?{previous:'Ранее',now:'Что происходит сейчас',attempt:'Начали с',change:'Что изменилось',origin:'Откуда это пошло',clip:'Клип недоступен',source:'Источник',old:'Прошлый эфир',welcome:'Добро пожаловать',summary:'История эфира'}:{previous:'Previously',now:'What matters now',attempt:'The goal',change:'What changed',origin:'Where it started',clip:'Clip unavailable',source:'Source',old:'Previous stream',welcome:'Welcome',summary:'The story so far'};
  const arrivals=plan?.arrivals.slice(0,2)??[];
  const extraChannels=(plan?.overflowArrivals.channels??0)+Math.max(0,(plan?.arrivals.length??0)-2);
  const extraViewers=(plan?.overflowArrivals.viewers??0)+(plan?.arrivals.slice(2).reduce((n,a)=>n+a.viewers,0)??0);
  return <div ref={root} className={`scene-player ${props.className??''}`} style={{aspectRatio:`${canvasWidth}/${canvasHeight}`}} data-phase={frame?.phase??'clear'}>
    {plan&&layout&&frame?.visible&&<div className="scene-canvas" style={{width:1920,height:1080,transform:`scale(${scale}) translate(${- (cropToLayout?layout.bounds.x:0)}px,${-(cropToLayout?layout.bounds.y:0)}px)`}}>
      <div className="scene-envelope" style={{left:layout.bounds.x,top:layout.bounds.y,width:layout.bounds.width,height:layout.bounds.height,opacity:frame.opacity}}>
        {!reduced&&frame.edgeOffsets.map((offset,index)=><div key={index} className="scene-source-edge" style={{left:32+offset,top:26+index*12,width:Math.min(1090,layout.bounds.width-140),height:layout.bounds.height-76,transform:`rotate(${(-2+index)*.7}deg) translateY(${-frame.exit*240}px)`,opacity:1-frame.assembly}}/>)}
        <div className={`scene-aperture ${frame.assembly>.12?'scene-aperture--now':''}`} style={planeStyle(frame.aperture)}>
          <div className="scene-opening" style={{opacity:1-frame.openingExit,transform:`translateY(${(1-frame.opening)*110-frame.openingExit*130}px)`}}>
            <strong style={{fontSize:layout.openingSize}}>{labels.previous}</strong>
            {channel&&<span className="scene-channel">{plan.language==='ru'?'на канале':'on'} {channel}</span>}
            <span className="scene-arrivals">{arrivals.length?arrivals.map(a=>`${a.fromLogin} ${plan.language==='ru'?`и ${a.viewers} зрителей`:`and ${a.viewers} viewers`}`).join(', '):title??''}{extraChannels>0?` + ${extraChannels} ${plan.language==='ru'?'каналов':'channels'}, ${extraViewers} ${plan.language==='ru'?'зрителей':'viewers'}`:''}</span>
          </div>
          <div className={`scene-story ${reduced?'scene-story--reduced':''}`} style={{opacity:frame.openingExit,transform:`translateY(${(1-frame.openingExit)*90-frame.exit*100}px)`}}>
            <div className="scene-context">{plan.variant==='welcome'?labels.welcome:reduced?labels.summary:frame.caption?labels[frame.caption.kind]:labels.summary}</div>
            {reduced?<ReducedContents plan={plan} layout={layout}/>:frame.caption&&<Caption caption={frame.caption} size={layout.captionSize} highlight={frame.assembly>.9}/>}
            {!reduced&&frame.nextCaption&&frame.nextCaption.reveal>0&&<div className="scene-next-caption"><Caption caption={frame.nextCaption} size={layout.captionSize}/></div>}
          </div>
        </div>
        {!reduced&&frame.openingExit>.9&&frame.caption&&(available||plan.variant!=='welcome')&&<div className={`scene-source ${available?'scene-source--media':''}`} style={{...planeStyle(frame.source),opacity:frame.source.opacity*(1-frame.exit)}}>
          {available?<><Visual bundle={media} id={frame.mediaId} timeMs={frame.mediaTimeMs} playing={playing&&frame.mediaVisible&&frame.mediaTimeMs<(plan.media.find(m=>m.id===frame.mediaId)?.outMs??0)} onBlocked={()=>callbacks.current.onStatus?.('audio_blocked')}/><span className="scene-source-time">{plan.media.find(m=>m.id===frame.mediaId)?.previousSession?labels.old:labels.source} {timecode(plan.media.find(m=>m.id===frame.mediaId)?.captureStartMs??frame.caption.sourceMs)}</span></>:<><span className="scene-source-time">{labels.source} {timecode(frame.caption.sourceMs)}</span><span className="scene-no-video">{labels.clip}</span></>}
        </div>}
        {!reduced&&frame.mark>0&&<div className="scene-return-mark" style={{opacity:frame.mark*(1-(t/plan.durationMs>.95?(t/plan.durationMs-.95)/.05:0)),transform:`translateX(${-frame.mark*36}px) scale(${1-frame.mark*.15})`}}><span/><span/></div>}
      </div>
    </div>}
  </div>;
}

function ReducedContents({plan,layout}:{plan:RecapPlan;layout:SceneLayout}) {
  return <div className="scene-reduced-content" style={{fontSize:Math.min(layout.captionSize,80)}}>{plan.beats.filter((beat,i,all)=>all.findIndex(b=>b.text===beat.text)===i).map(beat=><p key={beat.id}>{beat.kind==='now'?<mark>{beat.text}</mark>:beat.text}</p>)}</div>;
}
/** Reflowed companion for narrow landing/replay surfaces, using the same immutable permitted plan. */
export function SceneSummary({plan,className=''}:{plan:RecapPlan|null;className?:string}) {
  if(!plan)return null;
  return <section className={`scene-summary ${className}`} aria-label={plan.language==='ru'?'Кратко об эфире':'Stream recap'}>{plan.beats.map(beat=><p key={beat.id} className={beat.kind==='now'?'scene-summary-current':undefined}><span>{plan.language==='ru'?({attempt:'Цель',change:'Что изменилось',origin:'Источник',now:'Сейчас'}[beat.kind]):({attempt:'The goal',change:'What changed',origin:'Where it started',now:'What matters now'}[beat.kind])}</span>{beat.text}</p>)}</section>;
}
export function ScenePreview(props:ScenePlayerProps){return <ScenePlayer {...props} cropToLayout={props.cropToLayout??true}/>;}
