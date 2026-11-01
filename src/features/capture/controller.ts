import type { CaptureLease } from '../../shared/contracts/index.js';
import { encodeWav } from '../../server/audio/wav.js';

export type CaptureState={status:'idle'|'permission_pending'|'listening'|'paused'|'denied'|'no_device'|'device_lost'|'conflict'|'delayed'|'error'|'closing';level:number;message:string|null;droppedChunks:number};
export type AudioMetadata={sessionId:string;leaseEpoch:number;captureEpoch:number;sequence:number;startMs:number;endMs:number;sampleRate:number;sha256:string;token:string;browserId:string};
export interface CaptureTransport {lease(sessionId:string,browserId:string,takeover:boolean):Promise<CaptureLease>;renew(lease:CaptureLease,browserId:string):Promise<CaptureLease>;pause(lease:CaptureLease,browserId:string):Promise<void>;upload(bytes:Uint8Array,metadata:AudioMetadata,signal:AbortSignal):Promise<void>}
export interface CaptureDevice {sampleRate:number;stop():void;start(onFrame:(frame:Float32Array)=>void,onLost:()=>void):Promise<void>}
export interface CaptureEnvironment {open():Promise<CaptureDevice>;now():number;digest(bytes:Uint8Array):Promise<string>;every(callback:()=>void,ms:number):unknown;cancelTimer(timer:unknown):void}
type Chunk={samples:Float32Array;startMs:number;endMs:number;sequence:number};
export class CaptureController {
  private state:CaptureState={status:'idle',level:0,message:null,droppedChunks:0};private listeners=new Set<()=>void>();
  private device:CaptureDevice|null=null;private lease:CaptureLease|null=null;private timer:unknown;private generation=0;private frameBuffer:Float32Array[]=[];private frameCount=0;private sequence=0;private nextStart=0;private queue:Chunk[]=[];private active:AbortController|null=null;private startedAt=0;private renewing=false;private draining:Promise<void>|null=null;
  constructor(private readonly transport:CaptureTransport,private readonly environment:CaptureEnvironment,readonly browserId:string){}
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private update(patch:Partial<CaptureState>){this.state={...this.state,...patch};for(const listener of this.listeners)listener();}
  async start(sessionId:string,takeover=false):Promise<void> {
    if(this.device||this.state.status==='permission_pending')return;
    const generation=++this.generation;this.update({status:'permission_pending',message:null,level:0});
    let device:CaptureDevice|null=null;
    try {
      device=await this.environment.open();if(generation!==this.generation){device.stop();return;}
      const lease=await this.transport.lease(sessionId,this.browserId,takeover);if(generation!==this.generation){device.stop();await this.transport.pause(lease,this.browserId).catch(()=>{});return;}
      this.device=device;this.lease=lease;this.sequence=0;this.nextStart=lease.anchorOffsetMs;this.startedAt=this.environment.now();
      await device.start(frame=>{if(generation===this.generation)this.receive(frame);},()=>{if(generation===this.generation){void this.pause();this.update({status:'device_lost',message:'Microphone disconnected. Choose a device and start again.'});}});
      if(generation!==this.generation){device.stop();return;}
      this.update({status:'listening'});this.timer=this.environment.every(()=>{void this.renew();},4000);
    }catch(error){device?.stop();if(generation!==this.generation)return;this.device=null;const name=error instanceof Error?error.name:'';this.update({status:name==='NotAllowedError'?'denied':name==='NotFoundError'?'no_device':name==='CaptureConflict'?'conflict':'error',message:name==='NotAllowedError'?'Microphone permission was denied.':name==='NotFoundError'?'No microphone is available.':name==='CaptureConflict'?'Microphone is active in another window.':'Could not start the microphone.'});}
  }
  resume(sessionId:string){return this.start(sessionId);}
  takeover(sessionId:string){return this.start(sessionId,true);}
  private async renew(){if(!this.lease||this.renewing)return;this.renewing=true;const generation=this.generation;try{const lease=await this.transport.renew(this.lease,this.browserId);if(generation===this.generation)this.lease=lease;}catch{if(generation===this.generation){await this.pause();this.update({status:'conflict',message:'Capture lease ended. Start listening to reconnect.'});}}finally{this.renewing=false;}}
  private receive(frame:Float32Array){if(!this.device||!['listening','delayed'].includes(this.state.status))return;let sum=0;for(const value of frame)sum+=value*value;this.update({level:Math.min(1,Math.sqrt(sum/Math.max(1,frame.length))*4)});this.frameBuffer.push(new Float32Array(frame));this.frameCount+=frame.length;const size=this.device.sampleRate*20;while(this.frameCount>=size)this.makeChunk(size);}
  private takeSamples(count:number){const samples=new Float32Array(count);let offset=0;while(offset<count){const frame=this.frameBuffer[0],take=Math.min(frame.length,count-offset);samples.set(frame.subarray(0,take),offset);offset+=take;if(take===frame.length)this.frameBuffer.shift();else this.frameBuffer[0]=frame.slice(take);}this.frameCount-=count;return samples;}
  private makeChunk(count:number){if(!this.device||!this.lease)return;const samples=this.takeSamples(count),duration=count/this.device.sampleRate*1000;const chunk={samples,startMs:Math.round(this.nextStart),endMs:Math.round(this.nextStart+duration),sequence:this.sequence++};this.nextStart+=duration;
    const elapsed=this.environment.now()-this.startedAt,drift=Math.abs(this.nextStart-this.lease.anchorOffsetMs-elapsed);
    if(drift>3000){void this.pause();this.update({status:'error',message:'Microphone timing drifted. Start listening again.'});return;}
    if(this.queue.length+(this.active?1:0)>=2){this.update({status:'delayed',droppedChunks:this.state.droppedChunks+1,message:'Some audio was skipped while uploads were delayed.'});return;}
    this.queue.push(chunk);void this.pump();
  }
  private pump():Promise<void>{if(this.draining)return this.draining;this.draining=this.drain().finally(()=>{this.draining=null;if(this.queue.length&&this.device&&this.lease)void this.pump();});return this.draining;}
  private async drain(){const generation=this.generation;while(this.queue.length&&this.lease&&this.device&&generation===this.generation){const chunk=this.queue.shift()!,lease=this.lease,sampleRate=this.device.sampleRate;const controller=new AbortController();this.active=controller;try{const bytes=encodeWav(chunk.samples,sampleRate),sha256=await this.environment.digest(bytes);if(generation!==this.generation)return;await this.transport.upload(bytes,{sessionId:lease.sessionId,leaseEpoch:lease.epoch,captureEpoch:lease.captureEpoch,sequence:chunk.sequence,startMs:chunk.startMs,endMs:chunk.endMs,sampleRate,sha256,token:lease.token,browserId:this.browserId},controller.signal);}catch{if(generation===this.generation)this.update({status:this.state.status==='closing'?'closing':'delayed',droppedChunks:this.state.droppedChunks+1,message:'An audio chunk could not be uploaded.'});}finally{if(this.active===controller)this.active=null;}}
  }
  /** Privacy pause never flushes. Cancels permission-pending, stops tracks, erases queued samples. */
  async pause():Promise<void>{++this.generation;const lease=this.lease;this.environment.cancelTimer(this.timer);this.timer=undefined;this.device?.stop();this.device=null;this.lease=null;this.active?.abort();this.active=null;this.queue=[];this.frameBuffer=[];this.frameCount=0;this.update({status:'paused',level:0,message:null});if(lease)await this.transport.pause(lease,this.browserId).catch(()=>{});}
  /** Normal offline preserves the bounded tail. A concurrent pause wins via generation and server epoch. */
  async offline(endedOffsetMs:number):Promise<void>{if(!this.device||!this.lease)return;const generation=this.generation;const remaining=Math.max(0,Math.min(this.frameCount,Math.floor((endedOffsetMs-this.nextStart)*this.device.sampleRate/1000)));this.update({status:'closing',level:0});if(remaining>=this.device.sampleRate)this.makeChunk(remaining);this.frameBuffer=[];this.frameCount=0;this.device.stop();await this.pump();if(generation!==this.generation)return;this.environment.cancelTimer(this.timer);this.device=null;this.lease=null;this.update({status:'idle',message:null});}
  dispose(){return this.pause();}
}
