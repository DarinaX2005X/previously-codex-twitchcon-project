import type {DispatchResult,Scope,VersionRef} from '../../shared/contracts/index.js';
import type {SqliteRepository,WorkLease} from '../storage/repository.js';
import type {ControlStore} from '../auth/control.js';
import {TwitchAuthError,TwitchRequestCancelled} from '../auth/tokens.js';
import {HelixError,TwitchHelix,type TwitchClip,type TwitchMarker} from './helix.js';
type Repository=Pick<SqliteRepository,'enqueueOutbox'|'claimOutbox'|'renewOutbox'|'finishOutbox'|'enqueueJob'|'claimJob'|'renewJob'|'finishJob'|'recordRemoteArtifact'>;
export interface EffectContext {sessionId:string;privacyEpoch:number;dependencyRefs:VersionRef[];captureStartMs?:number;captureEndMs?:number}
export type MarkerContext=EffectContext&{momentId:string;streamId:string;expiresAtMs:number};
export type MarkerResult={status:'queued'|'sent'|'unavailable'|'cancelled'|'unknown_outcome';reason?:string;externalId?:string;positionSeconds?:number};
export interface EffectsOptions {
  scope:Scope;helix:TwitchHelix;repository:Repository;control:ControlStore;now?:()=>number;
  /** Synchronous final fence: epoch, active session, publication, actor ban and dependency revisions. */
  allowed:(context:EffectContext&{kind:string;actorId?:string})=>boolean;
  prepareMedia:(input:EffectContext&{id:string;url:string;kind:'video';mimeType:string;captureStartMs:number;captureEndMs:number})=>Promise<unknown>;
  onClip:(input:EffectContext&{clip:TwitchClip|null;status:'pending'|'ready'|'unavailable'|'revoked';reason?:string;previousSession?:boolean})=>Promise<void>|void;
  onResult?:(id:string,result:DispatchResult)=>void;
  onMarker?:(input:MarkerContext,result:MarkerResult)=>void;
  previousPermitted?:(clip:TwitchClip)=>boolean;
}
type ChatPayload=EffectContext&{message:string;actorId:string;expiresAtMs:number;key:string};
type ClipPayload=EffectContext&{key:string;clipId?:string;createdAtMs?:number;outboxId?:string};
type Queue={globalAt:number;actors:Record<string,number>;pending:{key:string;expiresAtMs:number}[]};
export class TwitchEffects {
  private readonly now:()=>number;private busy=false;
  constructor(private readonly options:EffectsOptions){this.now=options.now??Date.now;if(options.scope.runId!=='live')throw new Error('Real effects require live scope');}
  isOwnEcho(messageId:string){return this.options.control.get(`outgoing:${messageId}`)!==null;}
  enqueueChat(input:EffectContext&{message:string;actorId:string;key:string}):{queued:boolean;reason?:string;id?:string}{
    const now=this.now();if(!this.options.allowed({...input,kind:'chat'}))return {queued:false,reason:'privacy_or_session'};
    if([...input.message].length>500)return {queued:false,reason:'message_too_long'};
    const q=this.options.control.get<Queue>('chat:queue')??{globalAt:-Infinity,actors:{},pending:[]};
    q.pending=q.pending.filter(item=>item.expiresAtMs>now);q.actors=Object.fromEntries(Object.entries(q.actors).filter(([,at])=>now-at<30000));
    if(q.pending.some(item=>item.key===input.key)||this.options.control.get(`chat:key:${input.key}`))return {queued:false,reason:'duplicate'};
    if(q.pending.length>=3)return {queued:false,reason:'queue_full'};
    if(q.actors[input.actorId]!==undefined&&now-q.actors[input.actorId]<30000)return {queued:false,reason:'actor_cooldown'};
    const sendAt=Math.max(now,q.globalAt+10000);if(sendAt>=now+15000)return {queued:false,reason:'global_cooldown'};
    const payload:ChatPayload={...input,expiresAtMs:now+15000};
    const id=this.options.repository.enqueueOutbox(this.options.scope,{sessionId:input.sessionId,kind:'chat',businessKey:input.key,payload,nextAtMs:sendAt,dependencyRefs:input.dependencyRefs});
    q.globalAt=sendAt;q.actors[input.actorId]=now;q.pending.push({key:input.key,expiresAtMs:payload.expiresAtMs});this.options.control.put('chat:queue',q);this.options.control.put(`chat:key:${input.key}`,true,now+7*86400000);return {queued:true,id};
  }
  enqueueClip(input:EffectContext&{key:string;auto:boolean;autoEnabled:boolean}){
    if((input.auto&&!input.autoEnabled)||!this.options.allowed({...input,kind:'clip'}))return null;
    if(input.captureStartMs===undefined||input.captureEndMs===undefined)throw new Error('Clip requires conservative capture interval');
    if(input.auto&&!this.options.control.claim('clip:auto-cooldown',true,this.now()+60000))return null;
    if(!this.options.control.claim('clip:pending',{key:input.key},this.now()+120000))return null;
    try{return this.options.repository.enqueueOutbox(this.options.scope,{sessionId:input.sessionId,kind:'clip',businessKey:input.key,payload:input,dependencyRefs:input.dependencyRefs});}catch(error){this.options.control.delete('clip:pending');throw error;}
  }
  enqueueMarker(input:MarkerContext&{key:string;description:string;enabled:boolean}){if(!input.enabled||input.expiresAtMs<=this.now()||!this.options.allowed({...input,kind:'marker'}))return null;return this.options.repository.enqueueOutbox(this.options.scope,{sessionId:input.sessionId,kind:'marker',businessKey:input.key,payload:input,dependencyRefs:input.dependencyRefs});}
  /** One scheduler tick; all retries and polls return to durable jobs, never an in-memory pending array. */
  async tick(){if(this.busy)return;this.busy=true;try{const lease=this.options.repository.claimOutbox(this.options.scope,{kinds:['chat','clip','marker'],leaseMs:30000});if(lease)await this.dispatch(lease);const job=this.options.repository.claimJob(this.options.scope,{kinds:['clip.poll'],leaseMs:30000});if(job)await this.poll(job);}finally{this.busy=false;}}
  private releaseClip(key:string){if(this.options.control.get<{key:string}>('clip:pending')?.key===key)this.options.control.delete('clip:pending');}
  private finish(lease:WorkLease,result:DispatchResult,marker?:TwitchMarker){this.options.repository.finishOutbox(this.options.scope,lease.id,lease.leaseToken,result.status==='unknown_outcome'?'unknown_outcome':result.status==='sent'?'done':'failed');if(lease.kind==='clip'&&result.status!=='sent'&&result.status!=='unknown_outcome')this.releaseClip((lease.payload as ClipPayload)?.key);if(lease.kind==='marker')this.options.onMarker?.(lease.payload as MarkerContext,{status:result.status==='sent'?'sent':result.status==='unknown_outcome'?'unknown_outcome':result.status==='cancelled'?'cancelled':'unavailable',...(result.reason?{reason:result.reason}:{}),...(result.externalId?{externalId:result.externalId}:{}),...(marker?{positionSeconds:marker.position_seconds}:{})});this.options.onResult?.(lease.id,result);}
  private async dispatch(lease:WorkLease){
    const input=lease.payload as ChatPayload&ClipPayload&MarkerContext&{description:string};
    if(!input||!this.options.allowed({...input,kind:lease.kind})||(lease.kind==='chat'&&input.expiresAtMs<=this.now())){this.finish(lease,{status:'cancelled',reason:'expired_or_revoked'});return;}
    let markerSendStarted=false;
    try{
      if(lease.kind==='chat'){
        const last=this.options.control.get<number>('chat:last-send')??-Infinity;
        if(this.now()-last<10000){this.options.repository.finishOutbox(this.options.scope,lease.id,lease.leaseToken,'failed',last+10000);return;}
        this.options.control.put('chat:last-send',this.now());const result=await this.options.helix.sendChat(input.message,()=>this.options.allowed({...input,kind:'chat'})&&input.expiresAtMs>this.now());
        if(result?.message_id)this.options.control.put(`outgoing:${result.message_id}`,true,this.now()+7*86400000);
        this.finish(lease,result?.is_sent?{status:'sent',externalId:result.message_id}:{status:'dropped',reason:result?.drop_reason?.code??'not_sent'});
      }else if(lease.kind==='clip'){
        const created=await this.options.helix.createClip(()=>this.options.allowed({...input,kind:'clip'}));if(!created?.id){this.finish(lease,{status:'unknown_outcome',reason:'missing_clip_id'});return;}
        this.options.repository.recordRemoteArtifact(this.options.scope,lease.id,created.id);
        if(!this.options.allowed({...input,kind:'clip'})){this.finish(lease,{status:'cancelled',externalId:created.id,reason:'privacy_changed_cleanup_required'});return;}
        this.options.repository.enqueueJob(this.options.scope,{sessionId:input.sessionId,kind:'clip.poll',businessKey:`clip.poll:${created.id}`,payload:{...input,clipId:created.id,createdAtMs:this.now(),outboxId:lease.id},dependencyRefs:input.dependencyRefs,nextAtMs:this.now()+1000});
        await this.options.onClip({...input,clip:null,status:'pending'});this.finish(lease,{status:'sent',externalId:created.id});
      }else{
        if(input.expiresAtMs<=this.now()){this.finish(lease,{status:'cancelled',reason:'marker_expired'});return;}
        // Get Streams cannot reveal Store past broadcasts. Twitch validates VOD/rerun eligibility at POST.
        // Requiring a published archive here would incorrectly suppress valid markers early in a live stream.
        const stream=await this.options.helix.currentStream();
        if(!stream||stream.id!==input.streamId||stream.user_id!==this.options.scope.channelId||stream.type!=='live'){this.finish(lease,{status:'dropped',reason:'marker_stream_not_live'});return;}
        if(input.expiresAtMs<=this.now()||!this.options.allowed({...input,kind:'marker'})){this.finish(lease,{status:'cancelled',reason:'expired_or_revoked'});return;}
        markerSendStarted=true;
        const marker=await this.options.helix.marker(input.description,()=>input.expiresAtMs>this.now()&&this.options.allowed({...input,kind:'marker'}));
        if(typeof marker?.id!=='string'||!marker.id||!Number.isInteger(marker.position_seconds)||marker.position_seconds<0){this.finish(lease,{status:'unknown_outcome',reason:'marker_confirmation_missing'});return;}
        this.finish(lease,{status:'sent',externalId:marker.id},marker);
      }
    }catch(error){
      if(error instanceof TwitchRequestCancelled){this.finish(lease,{status:'cancelled',reason:'privacy_changed'});return;}
      if(error instanceof TwitchAuthError){this.finish(lease,{status:'dropped',reason:error.code});return;}
      if(lease.kind==='marker'&&!markerSendStarted){this.finish(lease,{status:'dropped',reason:'marker_live_check_unavailable'});return;}
      if(lease.kind==='clip')await this.options.onClip({...input,clip:null,status:'unavailable',reason:error instanceof HelixError?error.code:'unknown_outcome'});
      if(error instanceof HelixError){if(error.status===429&&lease.kind==='chat'&&this.now()+Math.max(error.retryAfterMs,1000)<input.expiresAtMs)this.options.repository.finishOutbox(this.options.scope,lease.id,lease.leaseToken,'failed',this.now()+Math.max(error.retryAfterMs,1000));else this.finish(lease,{status:error.status>=500?'unknown_outcome':'dropped',reason:lease.kind==='marker'&&[400,403,404].includes(error.status)?'marker_vod_or_permission_unavailable':error.code});}
      else this.finish(lease,{status:'unknown_outcome',reason:'network_outcome_unknown'});
    }
  }
  private async poll(job:WorkLease){
    const input=job.payload as ClipPayload;const repo=this.options.repository;
    const finish=(state:'done'|'failed',next?:number)=>{if(next===undefined)this.releaseClip(input?.key);return repo.finishJob(this.options.scope,job.id,job.leaseToken,state,next);};
    if(!input?.clipId||!this.options.allowed({...input,kind:'clip.poll'})){finish('failed');return;}
    try{
      const clip=await this.options.helix.getClip(input.clipId);
      if(!clip){if(this.now()-(input.createdAtMs??0)<60000){finish('failed',this.now()+2000);return;}await this.options.onClip({...input,clip:null,status:'unavailable',reason:'clip_processing_timeout'});finish('failed');return;}
      if(clip.broadcaster_id!==this.options.scope.channelId)throw new Error('Wrong clip broadcaster');
      const url=await this.options.helix.downloadUrl(clip.id);
      if(!url){await this.options.onClip({...input,clip,status:'unavailable',reason:'download_unavailable'});finish('failed');return;}
      if(!this.options.allowed({...input,kind:'clip.poll'})){finish('failed');return;}
      // A VOD offset can arrive later. Until alignment is independently verified keep the wider capture interval.
      const renewal=setInterval(()=>repo.renewJob(this.options.scope,job.id,job.leaseToken),10000);renewal.unref();
      try{await this.options.prepareMedia({...input,id:`clip:${clip.id}`,url,kind:'video',mimeType:'video/mp4',captureStartMs:input.captureStartMs!,captureEndMs:input.captureEndMs!});}finally{clearInterval(renewal);}
      const safe=this.options.allowed({...input,kind:'clip.poll'});await this.options.onClip({...input,clip,status:safe?'ready':'revoked',reason:safe?undefined:'privacy_changed_cleanup_required'});finish(safe?'done':'failed');
    }catch(error){if(this.now()-(input.createdAtMs??0)<60000&&job.attempts<3){finish('failed',this.now()+Math.min(10000,1000*3**job.attempts));return;}await this.options.onClip({...input,clip:null,status:'unavailable',reason:error instanceof HelixError?error.code:'media_unavailable'});finish('failed');}
  }
  async previousCandidate(before:string){const clips=await this.options.helix.previousClips(before,this.now());return clips.find(clip=>this.options.previousPermitted?.(clip)===true)??null;}
  /** Owner Preview/Use calls this after choosing a metadata candidate; caller supplies its original session and provenance. */
  async preparePrevious(clip:TwitchClip,context:EffectContext){
    if(!this.options.previousPermitted?.(clip)||clip.broadcaster_id!==this.options.scope.channelId)throw new Error('Previous clip is not permitted');
    const url=await this.options.helix.downloadUrl(clip.id);if(!url){await this.options.onClip({...context,clip,status:'unavailable',reason:'download_unavailable',previousSession:true});return false;}
    if(!this.options.allowed({...context,kind:'previous.clip'}))return false;
    await this.options.prepareMedia({...context,id:`clip:${clip.id}`,url,kind:'video',mimeType:'video/mp4',captureStartMs:context.captureStartMs??0,captureEndMs:context.captureEndMs??Math.ceil(clip.duration*1000)});
    const safe=this.options.previousPermitted?.(clip)&&this.options.allowed({...context,kind:'previous.clip'});await this.options.onClip({...context,clip,status:safe?'ready':'revoked',previousSession:true});return Boolean(safe);
  }
}
