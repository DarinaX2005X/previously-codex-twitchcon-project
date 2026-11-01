import {randomUUID,createHash} from 'node:crypto';
import type {MediaRecord} from '../media/cache.js';
import {prepareRecordingMedia} from './recording-media.js';
import {packageRecordingBundle} from './recording-package.js';
import {assertPackageBounds} from '../../replay/package.js';
import type {CommittedTransition} from '../runtime/engine.js';
import type {DomainState} from '../../core/index.js';
import {safetyAllowsPublication,type Clock,type Scope,type Source,type VersionRef} from '../../shared/contracts/index.js';
import type {Principal} from '../runtime/security.js';
import {ApiError} from '../runtime/errors.js';
import {storyInput,type RecordedOutcome,type WordingOutcome} from '../../replay/contracts.js';
import {ManifestSchema,type ExportAsset} from '../../cloud/contracts.js';
import {assertNoCredentials} from './recorder.js';
import {RecordingStore} from './recording-store.js';
import {collectSources,digest,exportBundle,reviewOf,sourceHash,summary} from './recording-review.js';
import type {RecordingRecord,RecordingReview,ReviewedExport,SourceReview,MediaReview,RecordingMedia,RecordingStartEligibility} from './recording-types.js';

export type RecordingOptions={dataDir:string;scope:Scope;clock:Clock;state:(sessionId:string)=>DomainState;source?:(id:string)=>Source|null;providerModel:string;registerExport?:(value:ReviewedExport)=>{exportId:string;status:'staged';publishSeq?:number};resolveMedia?:(id:string)=>Promise<{record:MediaRecord;path:string}>;outputsBlocked?:()=>boolean;};
export type ReviewInput={captureRevision:number;digest:string;reviewedSources:SourceReview[];reviewedOutputHashes:string[];reviewedMedia?:MediaReview[];metadataReviewed:true;};
const fail=(code:string,message:string,status=409)=>new ApiError(status,code,message);
const pristine=(state:DomainState)=>state.sequence===0&&state.sources.length===0&&state.chapters.length===0&&state.memory.length===0&&!state.pendingGeneration&&state.session.privacyEpoch===0;

/** Owner-controlled private recorder. No microphone, provider, OAuth or network methods exist here. */
export class RecordingController {
  readonly store:RecordingStore;private records=new Map<string,RecordingRecord>();private active:string|null=null;
  private lastCaptureWrite=0;
  constructor(readonly options:RecordingOptions){
    if(options.scope.runId!=='live')throw new Error('recording_requires_live_scope');
    this.store=new RecordingStore(options.dataDir);
    for(const record of this.store.list()){
      if(record.scope.channelId!==options.scope.channelId||record.scope.runId!==options.scope.runId)continue;
      if(['armed','recording'].includes(record.status)){record.status='interrupted';record.message='Recording stopped when the process ended. Arm a new recording before the next session.';record.revision++;this.store.write(record);}
      this.records.set(record.id,record);this.validateCurrent(record);
    }
  }
  private authorize(principal:Principal){if(principal.role!=='owner'||principal.channelId!==this.options.scope.channelId||principal.runId!=='live')throw fail('role_forbidden','Only the channel owner can manage recordings.',403);if(principal.expiresAtMs<=this.options.clock.now())throw fail('session_required','Sign in to manage recordings.',401);}
  command<T>(principal:Principal,key:string,request:unknown,action:()=>T):T{this.authorize(principal);if(!/^[\w.-]{8,128}$/.test(key))throw fail('idempotency_required','A recording command needs an idempotency key.',400);return this.store.command(digest({scope:this.options.scope,actor:principal.actorId,key}),digest(request),action);}
  commandAsync<T>(principal:Principal,key:string,request:unknown,action:()=>Promise<T>):Promise<T>{this.authorize(principal);if(!/^[\w.-]{8,128}$/.test(key))throw fail('idempotency_required','A recording command needs an idempotency key.',400);return this.store.commandAsync(digest({scope:this.options.scope,actor:principal.actorId,key}),digest(request),action);}
  private outputGate(){if(this.options.outputsBlocked?.())throw fail('privacy_pending','Recording review and export are blocked while privacy removal is pending.');}
  private eraseMedia(record:RecordingRecord){record.pendingMediaPurge=[...new Set([...(record.pendingMediaPurge??[]),...(record.selectedMedia??[]).map(m=>m.assetId)])];record.selectedMedia=[];record.mediaEvents=[];this.purgeMedia(record);}
  private purgeMedia(record:RecordingRecord){record.pendingMediaPurge=(record.pendingMediaPurge??[]).filter(assetId=>{try{this.store.removeMedia(record.id,assetId);return false;}catch{return true;}});}
  private get(id:string){const record=this.records.get(id);if(!record)throw fail('recording_not_found','This recording is unavailable.',404);this.validateCurrent(record);return record;}
  private persist(record:RecordingRecord){record.revision++;record.receipt=null;this.store.write(record);}
  private invalidate(record:RecordingRecord,reason:string){this.eraseMedia(record);record.status='invalidated';record.message=reason;record.initial=null;record.events=[];record.providers=[];record.sources=[];record.safeSourceHashes=[];record.pending={};record.correction=null;record.receipt=null;record.revision++;if(this.active===record.id)this.active=null;this.store.write(record);}
  private validateCurrent(record:RecordingRecord){
    if(record.pendingMediaPurge?.length){this.purgeMedia(record);this.store.write(record);}
    if(!record.sessionId||['invalidated','failed'].includes(record.status))return;
    try{const state=this.options.state(record.sessionId);if(state.session.privacyEpoch!==record.privacyEpoch)this.invalidate(record,'This recording was erased after a source privacy change. Record a new clean session.');}
    catch(error){if(error instanceof ApiError&&error.code==='recording_invalidated')throw error;this.invalidate(record,'The original session is no longer available.');}
  }
  list(principal:Principal,input:{sessionId?:string}={}){this.authorize(principal);for(const record of this.records.values())this.validateCurrent(record);return {items:[...this.records.values()].map(summary),activeId:this.active,startEligibility:this.startEligibility(input.sessionId),boundary:'Arm before a session or before any context is collected. Earlier provider results cannot be recovered retrospectively.',automaticUpload:false};}
  private startEligibility(sessionId?:string):RecordingStartEligibility{
    const base={sessionId:sessionId??null,canStartCurrent:false,canArmNext:false};
    if(this.active)return {...base,reason:'recording_active'};
    if(this.records.size>=20)return {...base,reason:'retention_limit'};
    if(!sessionId)return {...base,canArmNext:true,reason:'no_session'};
    try{const ready=pristine(this.options.state(sessionId));return {...base,canArmNext:true,canStartCurrent:ready,reason:ready?'ready':'context_started'};}
    catch{return {...base,canArmNext:true,reason:'session_unavailable'};}
  }
  start(principal:Principal,input:{sessionId?:string}={}){
    this.authorize(principal);if(this.active)throw fail('recording_already_active','Stop the current recording before starting another.');if(this.records.size>=20)throw fail('recording_retention_limit','Remove a private recording before starting another.');
    const state=input.sessionId?this.options.state(input.sessionId):null;if(state&&!pristine(state))throw fail('recording_prefix_missing','Arm recording before the session collects context. Earlier provider outcomes were not recorded.');
    if(state)assertNoCredentials({channel:state.channel,session:state.session,settings:state.settings});
    const record:RecordingRecord={schemaVersion:1,id:randomUUID(),scope:{...this.options.scope},status:state?'recording':'armed',revision:1,sessionId:state?.session.id??null,privacyEpoch:state?.session.privacyEpoch??0,startedAt:this.options.clock.iso(),stoppedAt:null,initial:state?{channel:state.channel,session:state.session,settings:state.settings}:null,events:[],providers:[],pending:{},sources:[],safeSourceHashes:[],milestones:[],correction:null,message:null,receipt:null,exportId:null};
    this.store.write(record);this.records.set(record.id,record);this.active=record.id;return summary(record);
  }
  stop(principal:Principal,id:string){this.authorize(principal);const record=this.get(id);if(record.status==='stopped'||record.status==='exported')return summary(record);if(!['armed','recording'].includes(record.status))throw fail('recording_not_active','This recording is no longer active.');record.status='stopped';record.stoppedAt=this.options.clock.iso();record.pending={};if(this.active===id)this.active=null;this.persist(record);return summary(record);}
  remove(principal:Principal,id:string,exportRevoked=false){this.authorize(principal);const record=this.get(id);if(record.exportId&&!exportRevoked)throw fail('recording_export_exists','Revoke the managed export before removing its private recording.');if(this.active===id)this.active=null;this.eraseMedia(record);this.store.remove(id);this.records.delete(id);}
  private mediaCurrent(record:RecordingRecord,media:RecordingMedia){this.outputGate();const state=this.options.state(record.sessionId!),current=state.media.find(m=>m.id===media.id);if(state.session.privacyEpoch!==record.privacyEpoch||!current||current.state!=='ready'||current.revision!==media.media.revision||current.kind!==media.media.kind||current.captureStartMs!==media.media.captureStartMs||current.captureEndMs!==media.media.captureEndMs||!media.media.refs.length||media.media.refs.some(ref=>{const source=this.options.source?.(ref.id)??state.sources.find(s=>s.id===ref.id);return !source||source.status!=='active'||source.revision!==ref.revision;}))throw fail('recording_media_changed','The selected media or its source is no longer available.');}
  async attachMedia(principal:Principal,id:string,mediaId:string){
    this.authorize(principal);this.outputGate();const record=this.get(id);if(record.status!=='stopped'||record.exportId)throw fail('recording_media_locked','Stop the recording before selecting media. Exported recordings cannot be changed.');if(!this.options.resolveMedia)throw fail('recording_media_unavailable','The private media cache is unavailable.');
    const candidate=record.mediaEvents?.findLast(m=>m.media.id===mediaId);if(!candidate||candidate.media.state!=='ready'||!['video','audio'].includes(candidate.media.kind)||candidate.media.previousSession||!candidate.media.refs.length||candidate.media.refs.some(ref=>!record.sources.some(s=>s.id===ref.id&&s.revision===ref.revision)))throw fail('recording_media_unavailable','Choose ready media captured in this recording with its original sources.');
    const cached=await this.options.resolveMedia(mediaId),m=cached.record;
    if(m.state!=='ready'||m.sessionId!==record.sessionId||m.privacyEpoch!==record.privacyEpoch||m.kind!==candidate.media.kind||m.captureStartMs!==candidate.media.captureStartMs||m.captureEndMs!==candidate.media.captureEndMs||digest(m.dependencyRefs)!==digest(candidate.media.refs))throw fail('recording_media_unavailable','The cached media does not match this recording.');
    let prepared:Awaited<ReturnType<typeof prepareRecordingMedia>>;try{prepared=await prepareRecordingMedia(cached,this.store.directory);}catch{throw fail('recording_media_prepare_failed','The selected media could not be prepared within the 3 MB limit. Video requires a working h264_nvenc encoder.');}const {bytes}=prepared;
    const selected:RecordingMedia={id:mediaId,assetId:'media-'+digest(mediaId).slice(0,32),atMs:candidate.atMs,media:structuredClone(candidate.media),hash:digestBytes(bytes),bytes:bytes.length,mime:prepared.mime};this.authorize(principal);if(this.get(id)!==record||record.status!=='stopped')throw fail('recording_media_changed','The recording changed.');this.mediaCurrent(record,selected);if((record.selectedMedia?.length??0)>=12&&!record.selectedMedia?.some(m=>m.id===mediaId))throw fail('recording_media_limit','Choose at most twelve media assets.');this.store.writeMedia(id,selected.assetId,bytes);record.selectedMedia=[...(record.selectedMedia??[]).filter(m=>m.id!==mediaId),selected];this.persist(record);return {attached:true,recordingId:id,mediaId,revision:record.revision};
  }
  detachMedia(principal:Principal,id:string,mediaId:string){this.authorize(principal);const record=this.get(id);if(record.status!=='stopped'||record.exportId)throw fail('recording_media_locked','Exported recordings cannot be changed.');const media=record.selectedMedia?.find(m=>m.id===mediaId);if(media)this.store.removeMedia(id,media.assetId);record.selectedMedia=record.selectedMedia?.filter(m=>m.id!==mediaId);this.persist(record);return {removed:true,recordingId:id,mediaId,revision:record.revision};}
  readMedia(principal:Principal,id:string,mediaId:string){this.authorize(principal);const record=this.get(id),media=record.selectedMedia?.find(m=>m.id===mediaId);if(!media)throw fail('recording_media_unavailable','This media is unavailable.',404);this.mediaCurrent(record,media);const bytes=this.store.readMedia(id,media.assetId);if(bytes.length!==media.bytes||digestBytes(bytes)!==media.hash)throw fail('recording_media_changed','The selected media bytes changed.');return {bytes,mime:media.mime};}
  /** Wire only after the source/domain transaction commits. Capture failures never start external work. */
  onCommittedTransition=(input:CommittedTransition):void=>{
    for(const record of this.records.values())if(record.sessionId===input.sessionId&&input.state.session.privacyEpoch!==record.privacyEpoch){try{this.invalidate(record,'This recording was erased after a source privacy change. Record a new clean session.');}catch{/* Durable domain epoch blocks this capture after restart; in-memory data was already erased. */}}
    const record=this.active?this.records.get(this.active):null;if(!record)return;
    try{
      if(record.status==='armed'){
        if(!pristine(input.previous))return;
        assertNoCredentials({channel:input.previous.channel,session:input.previous.session,settings:input.previous.settings});
        record.sessionId=input.sessionId;record.privacyEpoch=input.previous.session.privacyEpoch;record.initial={channel:input.previous.channel,session:input.previous.session,settings:input.previous.settings};record.status='recording';
      }
      if(record.sessionId!==input.sessionId||record.status!=='recording')return;
      assertNoCredentials(input.event);
      if(record.events.length>=10000||record.providers.length>=10000)throw new Error('recording_capacity');
      const event=structuredClone(input.event),atMs=Math.floor(input.atMs);
      if(event.type==='privacy'||event.type==='ban'||event.type==='chat.clear'){this.invalidate(record,'A privacy action erased this recording. Record a new clean session.');return;}
      // The text recorder excludes screen/audio asset objects entirely, including internal paths.
      if(event.type!=='media')record.events.push({atMs,event});
      if(event.type==='media'){
        const {clipId:_clipId,manageUrl:_manageUrl,clip:_clip,...media}=input.state.media.find(m=>m.id===event.media.id)??event.media;
        if((record.mediaEvents?.length??0)>=100&&!record.mediaEvents?.some(m=>m.media.id===media.id))throw new Error('recording_media_capacity');
        record.mediaEvents=[...(record.mediaEvents??[]).filter(m=>m.media.id!==media.id),{atMs,media:structuredClone(media)}];
      }
      const append=(operation:RecordedOutcome['operation'],request:unknown,output:unknown,delayMs=0,invocationId?:string,error?:string)=>{record.providers.push({operation,model:this.options.providerModel,schemaVersion:'1',promptVersion:'checked-replay-v1',input:structuredClone(request),output:structuredClone(output),delayMs:Math.max(0,Math.min(60000,delayMs)),...(invocationId?{invocationId}:{}),...(error?{error}:{})});};
      if(event.type==='generation.result'||event.type==='generation.failed'){
        const jobId=event.type==='generation.result'?event.ticket.jobId:event.jobId,request=record.pending[jobId]??(input.previous.pendingGeneration?{request:input.previous.pendingGeneration,atMs:Math.max(0,input.previous.pendingGeneration.requestedAtMs-Date.parse(input.previous.session.startedAt))}:null);
        if(!request||request.request.ticket.jobId!==jobId)throw new Error('recording_provider_prefix_missing');
        append('story',storyInput(request.request),event.type==='generation.result'?{patch:event.patch,safety:event.safety,grounding:event.grounding}:null,atMs-request.atMs,jobId,event.type==='generation.failed'?event.reason:undefined);delete record.pending[jobId];
      }
      if(event.type==='source.safety'){
        const source=input.previous.sources.find(s=>s.id===event.id&&s.revision===event.baseRevision);if(!source)throw new Error('recording_source_prefix_missing');
        append('source_safety',source,{text:event.text,safety:event.safety});
        if(source.text===event.text&&safetyAllowsPublication(event.safety))record.safeSourceHashes.push(sourceHash(source));
      }
      if(event.type==='owner.review'){
        const chapter=input.previous.chapters.find(c=>c.id===event.entityId);if(!chapter)throw new Error('recording_owner_prefix_missing');
        const request={title:chapter.title,summary:chapter.summary};append('owner_review',request,{title:event.title,summary:event.summary,safety:event.safety,...event.current?{current:event.current}:{}});
        const source=input.previous.sources.find(s=>s.id===event.sourceId&&s.revision===event.sourceRevision);
        if(source&&source.text===event.summary&&request.title===event.title&&safetyAllowsPublication(event.safety)){record.safeSourceHashes.push(sourceHash(source));record.correction={...request,targetId:event.entityId,language:event.language??source.languageCodes.find((language):language is 'en'|'ru'=>language==='en'||language==='ru')??input.previous.settings.recapLanguage};}
      }
      if(event.type==='presentation'){
        const chapter=input.previous.chapters.find(c=>c.id===event.entityId);if(!chapter)throw new Error('recording_presentation_prefix_missing');
        append('translation',{title:chapter.title,summary:chapter.summary,language:event.language},{title:event.title,summary:event.summary,safety:event.safety,...event.current?{current:event.current}:{}} satisfies WordingOutcome);
      }
      collectSources(record,input.effects.filter(e=>e.type==='source.persist').map(e=>e.source));
      for(const effect of input.effects){if(effect.type==='generation.request')record.pending[effect.request.ticket.jobId]={request:effect.request,atMs};if(effect.type==='publication'&&effect.snapshot.chapters.length&&!record.milestones.some(m=>m.id==='published'))record.milestones.push({id:'published',label:'First published context',atMs});}
      if(event.type==='recap.trigger'&&event.trigger.reason==='raid'&&!record.milestones.some(m=>m.id==='raid'))record.milestones.push({id:'raid',label:'Incoming raid',atMs});
      record.revision++;record.receipt=null;
      // A crash always interrupts capture, so only a stopped recording is exportable.
      // Checkpoint at most once per five seconds instead of rewriting a growing bundle per tick/chat.
      if(this.options.clock.now()-this.lastCaptureWrite>=5000){this.store.write(record);this.lastCaptureWrite=this.options.clock.now();}
    }catch(error){record.status='failed';const code=error instanceof Error?error.message:'';record.message=code==='recording_capacity'?'Recording stopped at its limit of 10,000 events or provider results. This incomplete capture cannot be exported.':code==='recording_media_capacity'?'Recording stopped at its limit of 100 media entries. This incomplete capture cannot be exported.':code==='private_recording_too_large'?'Recording stopped at its 32 MB private capture limit. This incomplete capture cannot be exported.':'Recording stopped because a normalized input could not be saved safely. The live session continues.';record.receipt=null;this.active=null;try{this.persist(record);}catch{/* Original session validity remains authoritative after restart. */}}
  };
  review(principal:Principal,id:string):RecordingReview{this.authorize(principal);this.outputGate();return reviewOf(this.get(id));}
  approve(principal:Principal,id:string,input:ReviewInput){
    this.authorize(principal);this.outputGate();const record=this.get(id),review=reviewOf(record);
    if(review.blockedReasons.length)throw fail('recording_review_blocked',review.blockedReasons[0]!);
    if(input.captureRevision!==record.revision||input.digest!==review.digest)throw fail('recording_review_changed','The recording changed. Review its current contents.');
    if(input.metadataReviewed!==true||review.sources.some(s=>!input.reviewedSources.some(r=>r.id===s.id&&r.revision===s.revision&&r.textHash===s.textHash))||review.outputs.some(o=>!input.reviewedOutputHashes.includes(o.hash)))throw fail('recording_review_incomplete','Review every source excerpt and generated field before exporting.');
    if(review.media.some(m=>!input.reviewedMedia?.some(r=>r.id===m.id&&r.hash===m.hash&&r.visualReviewed===true&&r.audioReviewed===true)))throw fail('recording_media_review_required','Watch or listen to every selected asset and confirm its visual and audio review.');for(const media of record.selectedMedia??[])this.readMedia(principal,id,media.id);
    // Validate exact replay before issuing a receipt, without making any provider call.
    exportBundle(record);
    record.receipt={id:randomUUID(),recordingId:id,captureRevision:record.revision,digest:review.digest,sourceReviews:input.reviewedSources,outputHashes:input.reviewedOutputHashes,mediaReviews:input.reviewedMedia??[],reviewedBy:principal.actorId,reviewedAt:this.options.clock.iso(),privacyEpoch:record.privacyEpoch};this.store.write(record);
    return {receiptId:record.receipt.id,recordingId:id,captureRevision:record.revision,mediaPolicy:'owner-selected' as const,publishing:false};
  }
  export(principal:Principal,id:string,receiptId:string){
    this.authorize(principal);this.outputGate();const record=this.get(id),receipt=record.receipt,review=reviewOf(record);
    if(!receipt||receipt.id!==receiptId||receipt.captureRevision!==record.revision||receipt.digest!==review.digest||receipt.privacyEpoch!==record.privacyEpoch)throw fail('recording_review_required','Review the current recording before exporting.');
    if(!this.options.registerExport)throw fail('recording_export_unconfigured','The private export registry is unavailable.',503);
    const bundle=exportBundle(record),packaged=packageRecordingBundle(bundle);
    const mediaAssets=(record.selectedMedia??[]).map(media=>({asset:{id:media.assetId,hash:media.hash,bytes:media.bytes,mime:media.mime,kind:media.media.kind as 'video'|'audio'} satisfies ExportAsset,bytes:this.readMedia(principal,id,media.id).bytes}));
    const manifest=ManifestSchema.parse({schemaVersion:1,id:bundle.id,revision:1,origin:'own-stream',sourceSessionId:record.sessionId,durationMs:bundle.durationMs,bundleHash:packaged.bundleHash,assets:[...packaged.assets.map(m=>m.asset),...mediaAssets.map(m=>m.asset)],milestones:bundle.milestones,providerVersions:{model:this.options.providerModel,schema:'1',prompt:'checked-replay-v1'}});
    assertPackageBounds(manifest);
    const current=this.options.state(record.sessionId!),refs=new Map<string,VersionRef>();for(const source of record.sources){const live=this.options.source?.(source.id)??current.sources.find(s=>s.id===source.id);if(!live||live.status!=='active')throw fail('recording_source_changed','A recorded source is no longer available.');refs.set(live.id,{id:live.id,revision:live.revision});}
    const result=this.options.registerExport({recordingId:id,reviewReceiptId:receipt.id,scope:this.options.scope,sourceSessionId:record.sessionId!,privacyEpoch:record.privacyEpoch,sourceRefs:[...refs.values()],mediaRefs:(record.selectedMedia??[]).map(m=>({id:m.id,revision:m.media.revision})),intervals:[...record.sources.map(s=>({startMs:s.startMs,endMs:s.endMs})),...(record.selectedMedia??[]).map(m=>({startMs:m.media.captureStartMs,endMs:m.media.captureEndMs}))],manifest,assets:[...packaged.assets,...mediaAssets],bundle});
    record.status='exported';record.exportId=result.exportId;this.store.write(record);return {...result,manifest,uploaded:false,notice:'This export is staged privately. Publishing requires a separate explicit action. Downloaded copies cannot be remotely revoked.'};
  }
}
function digestBytes(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
