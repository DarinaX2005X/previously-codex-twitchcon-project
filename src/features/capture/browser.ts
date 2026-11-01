import { useSyncExternalStore } from 'react';
import type { CaptureLease } from '../../shared/contracts/index.js';
import { CaptureController, type CaptureEnvironment, type CaptureTransport, type CaptureDevice } from './controller.js';
export function createBrowserCaptureEnvironment():CaptureEnvironment {
  return {now:()=>performance.now(),digest:async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))).map(byte=>byte.toString(16).padStart(2,'0')).join(''),every:(fn,ms)=>setInterval(fn,ms),cancelTimer:timer=>{if(timer!==undefined)clearInterval(timer as ReturnType<typeof setInterval>);},open:async()=>{
    if(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('Secure microphone capture is unavailable.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
    let context:AudioContext;try{context=new AudioContext();}catch(error){stream.getTracks().forEach(track=>track.stop());throw error;}
    let node:AudioWorkletNode|undefined,source:MediaStreamAudioSourceNode|undefined;let stopped=false;
    const stop=()=>{if(stopped)return;stopped=true;stream.getTracks().forEach(track=>track.stop());if(node){node.port.onmessage=null;node.disconnect();}source?.disconnect();void context.close();};
    const device:CaptureDevice={sampleRate:context.sampleRate,stop,start:async(onFrame,onLost)=>{await context.audioWorklet.addModule('/worklets/pcm-capture.js');if(stopped)return;node=new AudioWorkletNode(context,'previously-pcm');node.port.onmessage=event=>{if(!stopped&&event.data instanceof Float32Array)onFrame(event.data);};source=context.createMediaStreamSource(stream);source.connect(node);const mute=context.createGain();mute.gain.value=0;node.connect(mute);mute.connect(context.destination);for(const track of stream.getAudioTracks())track.addEventListener('ended',()=>{if(!stopped)onLost();},{once:true});await context.resume();}};return device;
  }};
}
export function createCaptureHttpTransport(csrf:()=>string,base='/api/owner'):CaptureTransport {
  const request=async(path:string,method:string,body:unknown)=>{const response=await fetch(base+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf(),'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});if(!response.ok){const error=new Error('Capture request failed.');if(response.status===409)error.name='CaptureConflict';throw error;}return response.json();};
  return {lease:(sessionId,browserId,takeover)=>request('/capture/lease','POST',{sessionId,browserId,takeover}) as Promise<CaptureLease>,renew:(lease,browserId)=>request('/capture/lease','PUT',{token:lease.token,browserId}) as Promise<CaptureLease>,pause:async(lease,browserId)=>{await request('/capture/pause','POST',{token:lease.token,browserId});},upload:async(bytes,metadata,signal)=>{const body=new FormData();body.set('metadata',JSON.stringify(metadata));body.set('file',new Blob([new Uint8Array(bytes)],{type:'audio/wav'}),'chunk.wav');const response=await fetch(base+'/audio',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':csrf(),'Idempotency-Key':`${metadata.sessionId}.${metadata.leaseEpoch}.${metadata.sequence}`},body,signal});if(!response.ok)throw new Error('Audio upload failed.');}};
}
export function useCapture(controller:CaptureController){return useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);}
