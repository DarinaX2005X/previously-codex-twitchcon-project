import type { PlaybackRef } from '../../shared/contracts/index.js';
import type { PreparedMedia } from './media.js';

export type OverlayState = {sessionId:string|null;privacyEpoch:number;revision:number;serverNow:string;active:PlaybackRef|null;queued:PlaybackRef[];channel?:string;title?:string;soundEnabled?:boolean;volume?:number};
export type OverlayUpdate = {event:string;data?:{sessionId?:string|null;revision?:number;affectedIds?:string[]}};
export interface OverlayClient {
  getState(signal?:AbortSignal):Promise<OverlayState>;
  acknowledge(id:string,state:'prepared'|'started'|'ended'|'error',timestamp:string):Promise<unknown>;
  subscribe(handlers:{onHeartbeat:()=>void;onUpdate:(update:OverlayUpdate)=>void;onDisconnect:()=>void}):()=>void;
  mediaUrl(id:string):string;
}
export type OverlayView = {playback:PlaybackRef|null;media:PreparedMedia|null;timeMs:number;playing:boolean;status:'connecting'|'idle'|'preparing'|'playing'|'disconnected'|'layout_required'|'text_too_long';channel?:string;title?:string;soundEnabled?:boolean;volume?:number};
export class SceneClock {
  private serverAt=0;private monoAt=0;private anchored=false;
  anchor(serverNow:string,monotonicNow:number):void {const server=Date.parse(serverNow);if(!Number.isFinite(server))throw new Error('Invalid scene clock.');this.serverAt=this.anchored?Math.max(server,this.serverNow(monotonicNow)):server;this.monoAt=monotonicNow;this.anchored=true;}
  serverNow(monotonicNow:number):number {return this.anchored?this.serverAt+Math.max(0,monotonicNow-this.monoAt):NaN;}
  elapsed(startAt:string,monotonicNow:number):number {return this.serverNow(monotonicNow)-Date.parse(startAt);}
}
export type OverlayControllerOptions = {
  client:OverlayClient;prepare:(playback:PlaybackRef,signal:AbortSignal)=>Promise<PreparedMedia>;
  onChange:(view:OverlayView)=>void;now?:()=>number;remembered?:Set<string>;remember?:(id:string)=>void;
};
/** One active scene. Scheduling and raid coalescence remain exclusively in the canonical server reducer. */
export class OverlayController {
  private readonly clock=new SceneClock();private readonly now:()=>number;private readonly completed:Set<string>;
  private active:PlaybackRef|null=null;private media:PreparedMedia|null=null;private pending:AbortController|null=null;
  private request:AbortController|null=null;private generation=0;private live=true;private prepared=false;private started=false;
  private leaseUntil=0;private poll:ReturnType<typeof setInterval>|null=null;private unsubscribe:(()=>void)|null=null;
  private channel:string|undefined;private title:string|undefined;private soundEnabled:boolean|undefined;private volume:number|undefined;private refreshAgain=false;
  constructor(private readonly options:OverlayControllerOptions){this.now=options.now??(()=>performance.now());this.completed=options.remembered??new Set();}
  start():void {
    this.unsubscribe=this.options.client.subscribe({onHeartbeat:()=>{this.leaseUntil=this.now()+6000;},onUpdate:update=>{
      if(update.event==='privacy.invalidated'||update.event==='playback.cancel'||update.event==='snapshot.reset'){this.invalidate();}
      void this.refresh();
    },onDisconnect:()=>{ /* Keep the current short lease; RAF tick fails closed at its deadline. */ }});
    void this.refresh();this.poll=setInterval(()=>void this.refresh(),2000);
  }
  private emit(status:OverlayView['status'],timeMs=0,playing=false):void {this.options.onChange({playback:this.active,media:this.media,timeMs,playing,status,channel:this.channel,title:this.title,soundEnabled:this.soundEnabled,volume:this.volume});}
  private remember(id:string):void {this.completed.add(id);if(this.completed.size>100){const first=this.completed.values().next().value;if(first)this.completed.delete(first);}this.options.remember?.(id);}
  private clear(markCompleted:boolean):void {
    ++this.generation;this.pending?.abort();this.pending=null;
    if(markCompleted&&this.active)this.remember(this.active.id);
    this.media?.release();this.media=null;this.active=null;this.prepared=false;this.started=false;
  }
  invalidate():void {
    this.request?.abort();this.request=null;this.clear(true);this.emit('idle');
  }
  async refresh():Promise<void> {
    if(!this.live)return;if(this.request){this.refreshAgain=true;return;}
    const request=new AbortController();this.request=request;
    try {
      const state=await this.options.client.getState(request.signal);
      if(!this.live||request.signal.aborted)return;
      this.clock.anchor(state.serverNow,this.now());this.leaseUntil=this.now()+6000;this.channel=state.channel;this.title=state.title;this.soundEnabled=state.soundEnabled;this.volume=state.volume;
      const playback=state.active;
      if(!playback?.plan||this.completed.has(playback.id)||playback.plan.privacyEpoch!==state.privacyEpoch||playback.plan.sessionId!==state.sessionId){this.clear(!!this.active);this.emit('idle');return;}
      if(this.active?.id===playback.id){
        if(this.active.plan?.privacyEpoch!==playback.plan.privacyEpoch||this.active.plan?.revision!==playback.plan.revision){this.clear(true);this.emit('idle');return;}
        this.active=playback;this.tick();return;
      }
      this.clear(!!this.active);this.active=playback;this.emit('preparing');
      const token=this.generation,controller=new AbortController();this.pending=controller;
      void this.options.prepare(playback,controller.signal).then(async media=>{
        if(!this.live||controller.signal.aborted||token!==this.generation){media.release();return;}
        this.media=media;this.prepared=true;
        if(playback.status==='preparing'&&!playback.startAt){await this.ack('prepared');await this.refresh();}
        else this.tick();
      }).catch(error=>{
        if(controller.signal.aborted||token!==this.generation)return;
        const status=error instanceof Error&&error.message==='text_too_long'?'text_too_long':'layout_required';
        void this.ack('error').catch(()=>{});this.clear(true);this.emit(status);
      });
    }catch{if(!request.signal.aborted)this.tick();}
    finally{if(this.request===request)this.request=null;if(this.refreshAgain){this.refreshAgain=false;void this.refresh();}}
  }
  private ack(state:'prepared'|'started'|'ended'|'error'):Promise<unknown> {
    const active=this.active;if(!active)return Promise.resolve();
    return this.options.client.acknowledge(active.id,state,new Date(this.clock.serverNow(this.now())).toISOString());
  }
  tick():void {
    if(!this.live)return;
    if(this.now()>=this.leaseUntil){if(this.active)this.clear(true);this.emit('disconnected');return;}
    const active=this.active;if(!active||!active.plan)return;
    if(!this.prepared||!active.startAt){this.emit('preparing');return;}
    const elapsed=this.clock.elapsed(active.startAt,this.now());
    if(!Number.isFinite(elapsed)||(!this.started&&elapsed>3000)){void this.ack('error').catch(()=>{});this.clear(true);this.emit('idle');return;}
    if(elapsed<0){this.emit('preparing');return;}
    if(elapsed>=active.plan.durationMs){void this.ack('ended').catch(()=>{});this.clear(true);this.emit('idle');return;}
    if(!this.started){this.started=true;const token=this.generation;void this.ack('started').catch(()=>{if(token===this.generation){this.clear(true);this.emit('idle');}});}
    this.emit('playing',elapsed,true);
  }
  stop():void {this.live=false;if(this.poll)clearInterval(this.poll);this.unsubscribe?.();this.request?.abort();this.clear(false);this.emit('idle');}
}
