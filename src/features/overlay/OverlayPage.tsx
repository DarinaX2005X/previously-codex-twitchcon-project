import { useEffect, useRef, useState } from 'react';
import { OverlayController, skipOffsetMs, type OverlayClient, type OverlayView } from './controller.js';
import { prepareMedia } from './media.js';
import { resolveSceneLayout, type MeasureText } from './geometry.js';
import { sceneTextFits } from './scene.js';
import { ScenePlayer, type SceneStatus } from './ScenePlayer.js';

export type OverlayPageProps={client:OverlayClient;channel?:string;title?:string;soundEnabled?:boolean;volume?:number;showDiagnostics?:boolean;onStatus?:(status:OverlayView['status']|SceneStatus)=>void};
const initial:OverlayView={playback:null,media:null,timeMs:0,playing:false,status:'connecting'};
const memoryKey='previously.overlay.completed';
function remembered():Set<string>{try{return new Set(JSON.parse(sessionStorage.getItem(memoryKey)??'[]') as string[]);}catch{return new Set();}}
export function OverlayPage({client,channel,title,soundEnabled,volume,showDiagnostics=false,onStatus}:OverlayPageProps){
  const [view,setView]=useState<OverlayView>(initial),callbacks=useRef(onStatus);callbacks.current=onStatus;
  useEffect(()=>{
    const seen=remembered();
    const controller=new OverlayController({client,remembered:seen,remember:()=>{try{sessionStorage.setItem(memoryKey,JSON.stringify([...seen].slice(-100)));}catch{}},onChange:value=>{setView(value);callbacks.current?.(value.status);},prepare:async(playback,signal)=>{
      const plan=playback.plan;if(!plan)throw new Error('layout_required');
      const layout=resolveSceneLayout(plan.layout);if(!layout)throw new Error('layout_required');
      await document.fonts.load('600 96px Onest');if(signal.aborted)throw new Error('cancelled');
      const canvas=document.createElement('canvas').getContext('2d');
      const measure:MeasureText|undefined=canvas?(text,size,weight=600)=>{canvas.font=`${weight} ${size}px Onest,sans-serif`;return canvas.measureText(text).width;}:undefined;
      const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
      if(!sceneTextFits(plan,layout,{measure,reducedMotion}))throw new Error('text_too_long');
      const media=await prepareMedia(plan,id=>client.mediaUrl(id),signal);
      if(media.visuals.size&&!sceneTextFits(plan,layout,{measure,hasMedia:true,reducedMotion})){media.release();return prepareMedia(plan,undefined,signal);}
      return media;
    }});
    controller.start();let animation=0;const tick=()=>{controller.tick();animation=requestAnimationFrame(tick);};animation=requestAnimationFrame(tick);
    const focus=()=>void controller.refresh();window.addEventListener('focus',focus);
    const visibility=()=>{if(document.hidden)controller.invalidate();else void controller.refresh();};document.addEventListener('visibilitychange',visibility);
    return()=>{cancelAnimationFrame(animation);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',visibility);controller.stop();};
  },[client]);
  return <main className="overlay-page" aria-label="Previously broadcast source" data-overlay-state={view.status}>
    <ScenePlayer plan={view.playing?view.playback?.plan??null:null} timeMs={view.timeMs} skipAtMs={skipOffsetMs(view.playback)??undefined} clipAudio playing={view.playing} preparedMedia={view.media??undefined} channel={channel??view.channel} title={title??view.title} soundEnabled={soundEnabled??view.soundEnabled??false} volume={volume??view.volume??.45} onStatus={status=>callbacks.current?.(status)}/>
    {showDiagnostics&&['disconnected','layout_required','text_too_long'].includes(view.status)&&<p className="overlay-setup-message">{view.status==='disconnected'?'The broadcast source is disconnected. Reconnect it in setup.':view.status==='text_too_long'?'The recap text does not fit at broadcast size. Shorten its published wording before showing it.':'The scene needs more free space. Adjust protected areas in scene settings.'}</p>}
  </main>;
}
