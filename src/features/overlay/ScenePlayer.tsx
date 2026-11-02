import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RecapPlan } from '../../shared/contracts/index.js';
import { resolveSceneLayout, type MeasureText } from './geometry.js';
import { renderAt, sceneSoundEvents, sceneTextFits, type SceneObject } from './scene.js';
import { prepareMedia, syncMedia, type PreparedMedia, type MediaResolver } from './media.js';
import { SceneSound } from './sound.js';
import './overlay.css';

export type SceneStatus = 'ready'|'layout_required'|'text_too_long'|'audio_blocked'|'media_unavailable';
export type ScenePlayerProps = {
  plan:RecapPlan|null;timeMs?:number;playing?:boolean;channel?:string;title?:string;
  resolveMedia?:MediaResolver;preparedMedia?:PreparedMedia;reducedMotion?:boolean;soundEnabled?:boolean;volume?:number;
  className?:string;cropToLayout?:boolean;onEnded?:()=>void;onStatus?:(status:SceneStatus)=>void;
  /** Capture mode: media elements are seeked to the exact scene time and never free-run. */
  frameExact?:boolean;
  /** Called with the media bundle once it is prepared (capture tooling waits on it). */
  onMediaReady?:(media:PreparedMedia)=>void;
};
function useReducedMotion(explicit:boolean|undefined):boolean {
  const [value,setValue]=useState(()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{const query=matchMedia('(prefers-reduced-motion: reduce)'),update=()=>setValue(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  return explicit??value;
}

function MediaHost({bundle,plan,media,playing,frameExact,onBlocked}:{bundle:PreparedMedia|null;plan:RecapPlan;media:NonNullable<SceneObject['media']>;playing:boolean;frameExact:boolean;onBlocked:()=>void}) {
  const host=useRef<HTMLDivElement>(null),element=bundle?.visuals.get(media.id)??null;
  useLayoutEffect(()=>{if(!element||!host.current)return;element.className='pv-media-element';host.current.replaceChildren(element);return()=>{if(element instanceof HTMLVideoElement)element.pause();element.remove();};},[element]);
  const spec=plan.media.find(m=>m.id===media.id);
  const target=spec?Math.min(spec.outMs,spec.inMs+media.timeMs)/1000:0;
  useEffect(()=>{
    if(!(element instanceof HTMLVideoElement))return;
    element.muted=true;
    if(frameExact){if(!element.paused)element.pause();const max=Number.isFinite(element.duration)?Math.max(0,element.duration-.02):target;const want=Math.min(target,max);if(Math.abs(element.currentTime-want)>.001)element.currentTime=want;}
    else syncMedia(element,target,playing&&media.playing,onBlocked);
  },[element,target,playing,media.playing,frameExact,onBlocked]);
  return <div ref={host} className="pv-media" style={{left:media.x,top:media.y,width:media.w,height:media.h,borderRadius:media.radius,opacity:media.opacity}}/>;
}

/** The P mark from the brand: a vermilion card over an earlier card, with the play-notch P. */
function Mark({o}:{o:SceneObject}) {
  const s=o.w, back=o.mark?.back??0, glyph=o.mark?.glyph??0;
  return <>
    <span className="pv-mark-back" style={{width:s*72/74,height:s*72/74,borderRadius:s*.27,transform:`translate(${-back*s*14/74}px,${-back*s*12/74}px)`,opacity:Math.min(1,back*3)}}/>
    <span className="pv-mark-front" style={{borderRadius:o.radius}}/>
    <svg className="pv-mark-glyph" viewBox="18 16 74 74" style={{transform:`scale(${.4+.6*glyph})`,opacity:Math.min(1,glyph*2.5)}} aria-hidden="true"><path fillRule="evenodd" d="M36 33A4 4 0 0 1 40 29H60A17 17 0 0 1 60 63H51V75A4 4 0 0 1 47 79H40A4 4 0 0 1 36 75Z M51.5 46L66 38.5L66 53.5Z" fill="#14171B"/></svg>
  </>;
}

/** Read-only local renderer. It has no trigger, ACK, broadcast or publication API. */
export function ScenePlayer(props:ScenePlayerProps) {
  const {timeMs,playing=false,channel,title,resolveMedia,preparedMedia,soundEnabled=false,volume=.45,cropToLayout=false,frameExact=false}=props;
  // Replay snapshots cross a worker boundary every tick. A captured plan is immutable by identity/revision.
  const plan=useMemo(()=>props.plan,[props.plan?.id,props.plan?.revision,props.plan?.privacyEpoch]);
  const uid=useId().replace(/[^a-zA-Z0-9]/g,'');
  const root=useRef<HTMLDivElement>(null),[width,setWidth]=useState(1920),[localTime,setLocalTime]=useState(0),[media,setMedia]=useState<PreparedMedia|null>(null),[measure,setMeasure]=useState<MeasureText|undefined>();
  const reduced=useReducedMotion(props.reducedMotion),callbacks=useRef(props);callbacks.current=props;
  const layout=useMemo(()=>plan?resolveSceneLayout(plan.layout):null,[plan]);
  const sound=useRef<SceneSound|null>(null),ended=useRef(false),elapsed=useRef(0);
  useLayoutEffect(()=>{if(!root.current)return;setWidth(root.current.getBoundingClientRect().width);const observer=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width));observer.observe(root.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{let alive=true;void document.fonts.load('800 96px Onest').catch(()=>{}).then(()=>document.fonts.ready).then(()=>{if(!alive)return;const ctx=document.createElement('canvas').getContext('2d');if(ctx)setMeasure(()=>(text:string,size:number,weight=600)=>{ctx.font=`${weight} ${size}px Onest, sans-serif`;ctx.letterSpacing=weight>=800?`${-.03*size}px`:`${-.01*size}px`;return ctx.measureText(text).width;});});return()=>{alive=false;};},[]);
  useEffect(()=>{ended.current=false;elapsed.current=0;setLocalTime(0);},[plan?.id]);
  useEffect(()=>{
    if(!plan||timeMs!==undefined||!playing)return;
    const start=performance.now()-elapsed.current;let frame=0;
    const tick=(now:number)=>{elapsed.current=Math.min(plan.durationMs,now-start);setLocalTime(elapsed.current);if(elapsed.current<plan.durationMs)frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[plan,timeMs,playing]);
  useEffect(()=>{
    if(preparedMedia){setMedia(preparedMedia);callbacks.current.onMediaReady?.(preparedMedia);return;}
    setMedia(null);if(!plan)return;const controller=new AbortController();let bundle:PreparedMedia|null=null;
    void prepareMedia(plan,resolveMedia,controller.signal,frameExact?8000:1500).then(result=>{bundle=result;if(!controller.signal.aborted){setMedia(result);callbacks.current.onMediaReady?.(result);if(plan.media.length&&!result.visuals.size)callbacks.current.onStatus?.('media_unavailable');}});
    return()=>{controller.abort();bundle?.release();};
  },[plan,resolveMedia,preparedMedia,frameExact]);
  useEffect(()=>{if(plan&&!layout)callbacks.current.onStatus?.('layout_required');else if(plan)callbacks.current.onStatus?.('ready');},[plan,layout]);
  useEffect(()=>{
    if(!plan||!soundEnabled||reduced||!playing)return;
    const instance=new SceneSound(volume,()=>callbacks.current.onStatus?.('audio_blocked'));sound.current=instance;void instance.enable();
    return()=>{instance.stop();sound.current=null;};
  },[plan?.id,soundEnabled,volume,reduced,playing]);
  const t=timeMs??localTime;
  const availableMedia=useMemo(()=>media?(id:string)=>media.visuals.has(id):()=>false,[media]);
  const options={reducedMotion:reduced,measure,availableMedia,channel,title};
  const fits=!!plan&&!!layout&&sceneTextFits(plan,layout,options);
  useEffect(()=>{if(plan&&layout&&!fits)callbacks.current.onStatus?.('text_too_long');},[plan,layout,fits]);
  const frame=plan&&layout&&fits?renderAt(t,plan,layout,options):null;
  const events=useMemo(()=>plan&&layout?sceneSoundEvents(plan,layout,{measure,availableMedia,channel,title}):[],[plan,layout,measure,availableMedia,channel,title]);
  useEffect(()=>{
    if(!plan)return;
    if(playing&&frame?.visible)sound.current?.tick(t,events);
    if(media?.narrator&&plan.audio){const active=playing&&t>=plan.audio.startMs&&t<plan.audio.startMs+plan.audio.durationMs&&!!frame?.visible;media.narrator.volume=Math.max(0,Math.min(.7,volume));syncMedia(media.narrator,Math.max(0,t-plan.audio.startMs)/1000,active,()=>callbacks.current.onStatus?.('audio_blocked'));}
    if(t>=plan.durationMs&&!ended.current){ended.current=true;sound.current?.stop();media?.narrator?.pause();callbacks.current.onEnded?.();}
    if(!playing)sound.current?.stop();
  },[t,plan,playing,soundEnabled,frame?.visible,media,volume,events]);
  useEffect(()=>()=>{media?.narrator?.pause();for(const visual of media?.visuals.values()??[])if(visual instanceof HTMLVideoElement)visual.pause();},[media]);
  const canvasWidth=cropToLayout&&layout?layout.bounds.width:1920,canvasHeight=cropToLayout&&layout?layout.bounds.height:1080;
  const scale=width/canvasWidth;
  const blocked=()=>callbacks.current.onStatus?.('audio_blocked');
  const blurred=frame?.objects.filter(o=>(o.blurX??0)>0||(o.blurY??0)>0)??[];
  return <div ref={root} className={`scene-player ${props.className??''}`} style={{aspectRatio:`${canvasWidth}/${canvasHeight}`}} data-phase={frame?.phase??'clear'} data-time-ms={Math.round(t)} aria-label={frame?.caption?.text}>
    {plan&&layout&&frame?.visible&&frame.objects.length>0&&<div className="scene-canvas" style={{width:1920,height:1080,transform:`scale(${scale}) translate(${-(cropToLayout?layout.bounds.x:0)}px,${-(cropToLayout?layout.bounds.y:0)}px)`}}>
      <svg className="pv-defs" width="0" height="0" aria-hidden="true"><defs>{blurred.map(o=><filter key={o.key} id={`mb${uid}${o.key.replace(/[^a-zA-Z0-9]/g,'')}`} x="-60%" y="-60%" width="220%" height="220%" colorInterpolationFilters="sRGB"><feGaussianBlur stdDeviation={`${(o.blurX??0)/2} ${(o.blurY??0)/2}`}/></filter>)}</defs></svg>
      <div className="pv-clip" style={{left:frame.clip.x,top:frame.clip.y,width:frame.clip.width,height:frame.clip.height}}>
        <div className="pv-stage" style={{left:frame.band.x-frame.clip.x,top:frame.band.y-frame.clip.y,width:frame.band.width,height:frame.band.height}}>
          {frame.objects.map(o=>{
            const persp=o.rotX||o.rotY?`perspective(1800px) rotateX(${o.rotX??0}deg) rotateY(${o.rotY??0}deg) `:'';
            const style:CSSProperties&Record<string,string|number|undefined>={width:o.w,height:o.h,borderRadius:o.radius,opacity:o.opacity,zIndex:o.z,
              transform:`translate3d(${o.x}px,${o.y}px,0) ${persp}rotate(${o.rot}deg) scale(${o.sx},${o.sy})`,transformOrigin:o.origin==='tl'?'0 0':'50% 50%',
              background:o.fill,filter:(o.blurX||o.blurY)?`url(#mb${uid}${o.key.replace(/[^a-zA-Z0-9]/g,'')})`:undefined,'--lift':o.lift??0};
            return <div key={o.key} className={`pv-o pv-${o.kind} pv-tone-${o.tone}${o.mask?' pv-mask':''}`} style={style} data-key={o.key}>
              {o.media&&<MediaHost bundle={media} plan={plan} media={o.media} playing={playing} frameExact={frameExact} onBlocked={blocked}/>}
              {o.kind==='mark'&&<Mark o={o}/>}
              {o.runs.map(r=><span key={r.key} className={`pv-run${r.tabular?' pv-tabular':''}`} style={{left:r.x,top:r.y,fontSize:r.size,fontWeight:r.weight,color:r.color,opacity:r.opacity,letterSpacing:r.weight>=800?'-.03em':'-.01em',
                transform:`translate(${r.dx??0}px,${r.dy}px) scale(${r.scale})`,filter:r.blur>.4?`blur(${r.blur.toFixed(1)}px)`:undefined}}>{r.text}</span>)}
              {o.sheen!==undefined&&<span className="pv-sheen" style={{transform:`translateX(${-60+o.sheen*220}%) skewX(-18deg)`}}/>}
            </div>;
          })}
        </div>
      </div>
    </div>}
  </div>;
}

/** Reflowed companion for narrow landing/replay surfaces, using the same immutable permitted plan. */
export function SceneSummary({plan,className=''}:{plan:RecapPlan|null;className?:string}) {
  if(!plan)return null;
  const focalId=plan.beats.find(beat=>beat.kind==='now')?.id??plan.beats.at(-1)?.id;
  return <section className={`scene-summary ${className}`} aria-label={plan.language==='ru'?'Кратко об эфире':'Stream recap'}>{plan.beats.map(beat=><p key={beat.id} className={beat.id===focalId?'scene-summary-current':undefined}><span>{plan.language==='ru'?({attempt:'Цель',change:'Что изменилось',origin:'Источник',now:'Сейчас',context:'Контекст эфира'}[beat.kind]):({attempt:'The goal',change:'What changed',origin:'Where it started',now:'What matters now',context:'Stream context'}[beat.kind])}</span>{beat.text}</p>)}</section>;
}
export function ScenePreview(props:ScenePlayerProps){return <ScenePlayer {...props} cropToLayout={props.cropToLayout??true}/>;}
