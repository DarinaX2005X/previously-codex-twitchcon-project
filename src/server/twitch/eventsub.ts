import WebSocket from 'ws';
import {EventEnvelopeSchema,type EventEnvelope} from '../../shared/contracts/index.js';
import type {ControlStore} from '../auth/control.js';
import {TwitchHelix,type TwitchStream,type BannedUser} from './helix.js';
export type ConnectionState='disconnected'|'connecting'|'welcome'|'subscribing'|'active'|'reconnecting'|'gap'|'revoked';
export type StreamReference={id:string;startedAt:string};
export interface EventSubOptions {
  channelId:string;runId:'live'|string;helix:TwitchHelix;control:ControlStore;
  ingest:(event:EventEnvelope)=>Promise<void>|void;
  resolveSession:(occurredAt:string,streamId?:string)=>Promise<StreamReference|null>|StreamReference|null;
  onStream:(stream:TwitchStream|null,occurredAt:string,streamId?:string)=>Promise<void>|void;
  /** Each snapshot page must be persisted; finish reconciles without resurrecting old source tombstones. */
  bans:{begin:(revision:string)=>Promise<void>|void;page:(revision:string,users:BannedUser[])=>Promise<void>|void;finish:(revision:string)=>Promise<void>|void};
  status?:(state:ConnectionState,detail:{quotesReady:boolean;gapSince:string|null;reason?:string;privacyBlocked?:boolean})=>void;
  now?:()=>number;socketFactory?:(url:string)=>WebSocket;url?:string;mock?:boolean;
}
export function subscriptions(channelId:string){return [
  ...['channel.chat.message','channel.chat.message_delete','channel.chat.clear','channel.chat.clear_user_messages'].map(type=>({type,version:'1',condition:{broadcaster_user_id:channelId,user_id:channelId} as Record<string,string>})),
  ...['channel.ban','channel.unban','stream.online','stream.offline'].map(type=>({type,version:'1',condition:{broadcaster_user_id:channelId} as Record<string,string>})),
  {type:'channel.update',version:'2',condition:{broadcaster_user_id:channelId} as Record<string,string>},
  {type:'channel.raid',version:'1',condition:{to_broadcaster_user_id:channelId} as Record<string,string>},
];}
type Wire={metadata:{message_id:string;message_type:string;message_timestamp:string;subscription_type?:string;subscription_version?:string};payload:{session?:{id:string;keepalive_timeout_seconds:number|null;reconnect_url?:string};subscription?:{type:string;version:string;status:string};event?:Record<string,unknown>}};
const privacyKinds=new Set(['channel.chat.message_delete','channel.chat.clear','channel.chat.clear_user_messages','channel.ban','channel.unban']);
export class TwitchEventSub {
  private sockets=new Set<WebSocket>();private current:WebSocket|null=null;private migrating:WebSocket|null=null;
  private timers=new Map<WebSocket,ReturnType<typeof setTimeout>>();private retry:ReturnType<typeof setTimeout>|null=null;
  private running=false;private backoff=0;private quotesReady=false;private gapSince:string|null=null;private state:ConnectionState='disconnected';
  private chain:Promise<void>=Promise.resolve();private queued=0;private generation=0;
  private privacyDraining=false;private privacyBlocked=false;private unpersistedPrivacy:Wire|null=null;
  private activeKeepaliveMs=10000;
  private readonly now:()=>number;
  constructor(private readonly options:EventSubOptions){this.now=options.now??Date.now;if(!options.mock&&options.runId!=='live')throw new Error('Live EventSub requires live scope');}
  status(){return {state:this.state,quotesReady:this.quotesReady,gapSince:this.gapSince,privacyBlocked:this.privacyBlocked};}
  private set(state:ConnectionState,reason?:string){this.state=state;try{this.options.status?.(state,{quotesReady:this.quotesReady,gapSince:this.gapSince,reason,privacyBlocked:this.privacyBlocked});}catch{/* Status persistence cannot interrupt socket shutdown or recovery. */}}
  async start(){if(this.running)return;this.running=true;this.generation++;this.quotesReady=false;this.schedulePrivacy();await this.chain;if(this.running&&!this.privacyBlocked)this.open(this.options.url??'wss://eventsub.wss.twitch.tv/ws',false);}
  async stop(){this.running=false;this.generation++;if(this.retry)clearTimeout(this.retry);this.retry=null;for(const socket of this.sockets){socket.removeAllListeners('message');this.clearTimer(socket);socket.close();}this.sockets.clear();this.current=null;this.migrating=null;this.quotesReady=false;this.set('disconnected');await this.chain;}
  private clearTimer(socket:WebSocket){const timer=this.timers.get(socket);if(timer)clearTimeout(timer);this.timers.delete(socket);}
  private watchdog(socket:WebSocket,ms:number){this.clearTimer(socket);const timer=setTimeout(()=>{socket.terminate();this.fail('keepalive_timeout');},ms);timer.unref();this.timers.set(socket,timer);}
  private open(url:string,transfer:boolean){
    if(!this.running)return;
    const parsed=new URL(url);
    if(!this.options.mock&&(parsed.protocol!=='wss:'||parsed.hostname!=='eventsub.wss.twitch.tv')){this.fail('invalid_reconnect_url');return;}
    const socket=(this.options.socketFactory??(url=>new WebSocket(url,{maxPayload:256*1024})))(url);this.sockets.add(socket);
    if(transfer)this.migrating=socket;else this.current=socket;
    this.set(transfer?'reconnecting':'connecting');this.watchdog(socket,transfer?30000:15000);
    let keepaliveMs=10000;
    socket.on('message',data=>{
      let wire:Wire;try{wire=JSON.parse(data.toString()) as Wire;if(!wire.metadata?.message_id||!wire.metadata.message_timestamp||!wire.payload)throw new Error();}catch{this.fail('invalid_payload');return;}
      if(wire.metadata.message_type==='session_welcome'){
        keepaliveMs=wire.payload.session?.keepalive_timeout_seconds==null?this.activeKeepaliveMs:Math.max(1000,wire.payload.session.keepalive_timeout_seconds*1000);this.activeKeepaliveMs=keepaliveMs;this.watchdog(socket,keepaliveMs+1000);
        void this.welcome(socket,wire,transfer).catch(()=>this.fail('subscription_or_sync_failed'));return;
      }
      if(['session_keepalive','notification'].includes(wire.metadata.message_type)&&!(socket===this.current&&this.migrating))this.watchdog(socket,keepaliveMs+1000);
      if(wire.metadata.message_type==='session_reconnect') {const url=wire.payload.session?.reconnect_url;if(url&&!this.migrating){this.clearTimer(socket);this.open(url,true);}return;}
      if(wire.metadata.message_type==='revocation'){this.quotesReady=false;this.set('revoked',wire.payload.subscription?.status);this.running=false;this.generation++;for(const item of this.sockets){this.clearTimer(item);item.close();}return;}
      if(wire.metadata.message_type!=='notification')return;
      const privacy=this.privacyWire(wire);
      if(privacy){
        try{this.appendPrivacy(privacy);}catch{
          // Stop the socket immediately. Retain the received control until persistence/application recovers;
          // reconnect must not restore quote readiness while this emergency buffer is nonempty.
          this.unpersistedPrivacy=privacy;this.privacyBlocked=true;this.fail('privacy_persistence_failed');
        }
        this.schedulePrivacy();return;
      }
      if(++this.queued>100){this.queued--;this.fail('ingest_backpressure');return;}
      this.chain=this.chain.then(()=>this.notification(wire)).catch(()=>this.fail('ingest_failed')).finally(()=>{this.queued--;});
    });
    socket.on('error',()=>{if(this.running&&(socket===this.current||socket===this.migrating))this.fail('socket_error');});
    socket.on('close',()=>{this.clearTimer(socket);this.sockets.delete(socket);if(this.running&&(socket===this.current||socket===this.migrating))this.fail('socket_closed');});
  }
  /** Keep only identifiers and cutoffs, never deleted message text or moderation reasons. */
  private privacyWire(wire:Wire):Wire|null {
    const type=wire.payload.subscription?.type??wire.metadata.subscription_type;
    const raw=wire.payload.event;
    if(!type||!privacyKinds.has(type)||!raw||raw.broadcaster_user_id!==this.options.channelId||(wire.payload.subscription?.version??wire.metadata.subscription_version)!=='1')return null;
    if(wire.metadata.message_id.length>140||!Number.isFinite(Date.parse(wire.metadata.message_timestamp)))return null;
    const event:Record<string,unknown>={broadcaster_user_id:this.options.channelId};
    for(const key of ['message_id','target_user_id','user_id','banned_at','ends_at'])if(typeof raw[key]==='string')event[key]=raw[key].slice(0,160);
    if(typeof raw.is_permanent==='boolean')event.is_permanent=raw.is_permanent;
    return {metadata:{message_id:wire.metadata.message_id,message_type:'notification',message_timestamp:wire.metadata.message_timestamp},payload:{subscription:{type,version:'1',status:'enabled'},event}};
  }
  /** Fixed-size durable pages keep both reads and the promise queue bounded during privacy-only bursts. */
  private appendPrivacy(wire:Wire){
    const control=this.options.control;let tail=control.get<number>('eventsub:privacy:tail')??control.get<number>('eventsub:privacy:head')??0;
    let page=control.get<Wire[]>(`eventsub:privacy:page:${tail}`)??[];
    while(page.length>=16){tail++;page=control.get<Wire[]>(`eventsub:privacy:page:${tail}`)??[];}
    control.put(`eventsub:privacy:page:${tail}`,[...page,wire]);
    // The page is authoritative. A crash before this hint is saved is recovered by scanning its next page.
    control.put('eventsub:privacy:tail',tail);
  }
  private schedulePrivacy(){
    if(this.privacyDraining)return;this.privacyDraining=true;
    this.chain=this.chain.then(async()=>{
      const control=this.options.control;
      if(this.unpersistedPrivacy){this.appendPrivacy(this.unpersistedPrivacy);this.unpersistedPrivacy=null;}
      let head=control.get<number>('eventsub:privacy:head')??0;
      for(;;){
        const key=`eventsub:privacy:page:${head}`,page=control.get<Wire[]>(key)??[];
        if(!page.length){
          if(control.get<Wire[]>(`eventsub:privacy:page:${head+1}`)===null)break;
          control.put('eventsub:privacy:head',head+1);control.delete(key);head++;continue;
        }
        const wire=page[0],dedupe=`eventsub:${wire.metadata.message_id}`;
        // An interrupted processing claim is replayable; the downstream repository is itself idempotent.
        if(control.get<{status:string}>(dedupe)?.status==='processing')control.delete(dedupe);
        await this.notification(wire);
        // New frames may have appended while ingest awaited. Remove only the completed head item.
        const latest=control.get<Wire[]>(key)??page;control.put(key,latest.slice(1));
      }
      this.privacyBlocked=false;
    }).catch(()=>{this.privacyBlocked=true;this.fail('privacy_recovery_pending');}).finally(()=>{this.privacyDraining=false;});
  }
  private async welcome(socket:WebSocket,wire:Wire,transfer:boolean){
    const session=wire.payload.session;if(!session?.id)throw new Error('Missing welcome session');
    if(transfer){if(socket!==this.migrating)return;const old=this.current;this.current=socket;this.migrating=null;if(old){this.clearTimer(old);old.close();}this.set('active');return;}
    const version=this.generation;this.set('welcome');this.set('subscribing');
    const sync=`${session.id}:${this.now()}`;await this.options.bans.begin(sync);
    // Subscribe first: Twitch's welcome deadline is ten seconds; synchronize bans afterwards.
    await Promise.all(subscriptions(this.options.channelId).map(sub=>this.options.helix.subscribe(sub.type,sub.version,sub.condition,session.id)));
    if(version!==this.generation||!this.running)return;
    await this.options.helix.bannedUsers(users=>this.options.bans.page(sync,users));
    if(version!==this.generation||!this.running)return;
    await this.options.bans.finish(sync);
    const stream=await this.options.helix.currentStream();if(version!==this.generation||!this.running)return;await this.options.onStream(stream,new Date(this.now()).toISOString());
    if(version!==this.generation||!this.running)return;
    if(this.privacyBlocked||this.unpersistedPrivacy){this.fail('privacy_recovery_pending');return;}
    this.quotesReady=true;this.backoff=0;this.set('active');
  }
  private fail(reason:string){
    if(!this.running||this.retry)return;this.generation++;this.quotesReady=false;this.gapSince??=new Date(this.now()).toISOString();
    // JS message callbacks are synchronous/non-concurrent. Detaching all receivers before invoking
    // status hooks or terminating bounds emergency retention to the one currently accepted frame.
    const sockets=[...this.sockets];this.current=null;this.migrating=null;for(const socket of sockets){socket.removeAllListeners('message');this.clearTimer(socket);socket.terminate();}this.sockets.clear();
    this.set('gap',reason);
    const delay=Math.min(30000,1000*2**Math.min(this.backoff++,5));this.retry=setTimeout(()=>{this.retry=null;this.schedulePrivacy();void this.chain.then(()=>{if(!this.running)return;if(this.privacyBlocked)this.fail('privacy_recovery_pending');else this.open(this.options.url??'wss://eventsub.wss.twitch.tv/ws',false);});},delay);this.retry.unref();
  }
  /** Transport dedupe precedes stream reconciliation and all domain callbacks. */
  private async notification(wire:Wire){
    const type=wire.payload.subscription?.type??wire.metadata.subscription_type;
    const contract=subscriptions(this.options.channelId).find(sub=>sub.type===type);
    if(!contract || (wire.payload.subscription?.version??wire.metadata.subscription_version)!==contract.version)return;
    const raw=wire.payload.event;if(!raw)return;
    const channel=type==='channel.raid'?raw.to_broadcaster_user_id:raw.broadcaster_user_id;
    if(channel!==this.options.channelId)return;
    const key=`eventsub:${wire.metadata.message_id}`;
    if(!this.options.control.claim(key,{status:'processing'},this.now()+7*86400000))return;
    try{
      const occurredAt=new Date(String(raw.banned_at??(type==='stream.online'?raw.started_at:undefined)??wire.metadata.message_timestamp)).toISOString();
      const receivedAt=new Date(this.now()).toISOString();
      // Shared Chat is explicitly unsupported; foreign source messages are never quoted or answered.
      if(type==='channel.chat.message'&&raw.source_broadcaster_user_id&&raw.source_broadcaster_user_id!==this.options.channelId){this.options.control.put(key,{status:'ignored_shared_chat'},this.now()+7*86400000);return;}
      if(type==='stream.online') {await this.options.onStream({id:String(raw.id),started_at:String(raw.started_at),user_id:this.options.channelId,title:'',game_name:''},occurredAt,String(raw.id));}
      if(type==='stream.offline') {
        const live=await this.options.helix.currentStream();
        // A delayed offline may close its old session, but never the currently live stream.
        if(live){await this.options.onStream(live,receivedAt);if(!raw.id||raw.id===live.id){this.options.control.put(key,{status:'stale_offline'},this.now()+7*86400000);return;}}
        await this.options.onStream(null,occurredAt,typeof raw.id==='string'?raw.id:undefined);
      }
      const ref=await this.options.resolveSession(occurredAt,typeof raw.id==='string'&&type?.startsWith('stream.')?raw.id:undefined);
      const offset=ref?Math.max(0,this.nowOffset(occurredAt,ref.startedAt)):null;
      const envelope:EventEnvelope={schemaVersion:1,channelId:this.options.channelId,runId:this.options.runId,eventId:`twitch:${wire.metadata.message_id}`,externalId:wire.metadata.message_id,origin:this.options.mock?'mock':'twitch',kind:type!,occurredAt,receivedAt,sessionId:ref?.id??null,sessionOffsetMs:offset,payload:{...raw,quotesReady:this.quotesReady,late:!privacyKinds.has(type!)&&this.now()-Date.parse(occurredAt)>120000}};
      EventEnvelopeSchema.parse(envelope);await this.options.ingest(envelope);this.options.control.put(key,{status:'done'},this.now()+7*86400000);
    }catch(error){this.options.control.delete(key);throw error;}
  }
  private nowOffset(at:string,start:string){return Math.min(172800000,Date.parse(at)-Date.parse(start));}
}
