import {randomUUID,createHash} from 'node:crypto';
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
import type {RecordingRecord,RecordingReview,ReviewedExport,SourceReview} from './recording-types.js';

export type RecordingOptions={dataDir:string;scope:Scope;clock:Clock;state:(sessionId:string)=>DomainState;source?:(id:string)=>Source|null;providerModel:string;registerExport?:(value:ReviewedExport)=>{exportId:string;status:'staged';publishSeq?:number};};
export type ReviewInput={captureRevision:number;digest:string;reviewedSources:SourceReview[];reviewedOutputHashes:string[];metadataReviewed:true;};
const fail=(code:string,message:string,status=409)=>new ApiError(status,code,message);
const pristine=(state:DomainState)=>state.sequence===0&&state.sources.length===0&&state.chapters.length===0&&state.memory.length===0&&!state.pendingGeneration&&state.session.privacyEpoch===0;

/** Owner-controlled private recorder. No microphone, provider, OAuth or network methods exist here. */
export class RecordingController {
  readonly store:RecordingStore;private records=new Map<string,RecordingRecord>();private active:string|null=null;
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
  private get(id:string){const record=this.records.get(id);if(!record)throw fail('recording_not_found','This recording is unavailable.',404);this.validateCurrent(record);return record;}
  private persist(record:RecordingRecord){record.revision++;record.receipt=null;this.store.write(record);}
  private invalidate(record:RecordingRecord,reason:string){record.status='invalidated';record.message=reason;record.initial=null;record.events=[];record.providers=[];record.sources=[];record.safeSourceHashes=[];record.pending={};record.correction=null;record.receipt=null;record.revision++;if(this.active===record.id)this.active=null;this.store.write(record);}
  private validateCurrent(record:RecordingRecord){
    if(!record.sessionId||['invalidated','failed'].includes(record.status))return;
    try{const state=this.options.state(record.sessionId);if(state.session.privacyEpoch!==record.privacyEpoch)this.invalidate(record,'This recording was erased after a source privacy change. Record a new clean session.');}
    catch(error){if(error instanceof ApiError&&error.code==='recording_invalidated')throw error;this.invalidate(record,'The original session is no longer available.');}
  }
  list(principal:Principal){this.authorize(principal);for(const record of this.records.values())this.validateCurrent(record);return {items:[...this.records.values()].map(summary),activeId:this.active,boundary:'Arm before a session or before any context is collected. Earlier provider results cannot be recovered retrospectively.',automaticUpload:false};}
  start(principal:Principal,input:{sessionId?:string}={}){
    this.authorize(principal);if(this.active)throw fail('recording_already_active','Stop the current recording before starting another.');if(this.records.size>=20)throw fail('recording_retention_limit','Remove a private recording before starting another.');
    const state=input.sessionId?this.options.state(input.sessionId):null;if(state&&!pristine(state))throw fail('recording_prefix_missing','Arm recording before the session collects context. Earlier provider outcomes were not recorded.');
    if(state)assertNoCredentials({channel:state.channel,session:state.session,settings:state.settings});
    const record:RecordingRecord={schemaVersion:1,id:randomUUID(),scope:{...this.options.scope},status:state?'recording':'armed',revision:1,sessionId:state?.session.id??null,privacyEpoch:state?.session.privacyEpoch??0,startedAt:this.options.clock.iso(),stoppedAt:null,initial:state?{channel:state.channel,session:state.session,settings:state.settings}:null,events:[],providers:[],pending:{},sources:[],safeSourceHashes:[],milestones:[],correction:null,message:null,receipt:null,exportId:null};
    this.store.write(record);this.records.set(record.id,record);this.active=record.id;return summary(record);
  }
  stop(principal:Principal,id:string){this.authorize(principal);const record=this.get(id);if(record.status==='stopped'||record.status==='exported')return summary(record);if(!['armed','recording'].includes(record.status))throw fail('recording_not_active','This recording is no longer active.');record.status='stopped';record.stoppedAt=this.options.clock.iso();record.pending={};if(this.active===id)this.active=null;this.persist(record);return summary(record);}
  remove(principal:Principal,id:string){this.authorize(principal);const record=this.get(id);if(record.exportId)throw fail('recording_export_exists','Revoke the managed export before removing its private recording.');if(this.active===id)this.active=null;this.store.remove(id);this.records.delete(id);}
  /** Wire only after the source/domain transaction commits. Capture failures never start external work. */
  onCommittedTransition=(input:CommittedTransition):void=>{
    for(const record of this.records.values())if(record.sessionId===input.sessionId&&input.state.session.privacyEpoch!==record.privacyEpoch)this.invalidate(record,'This recording was erased after a source privacy change. Record a new clean session.');
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
        if(source&&source.text===event.summary&&request.title===event.title&&safetyAllowsPublication(event.safety)){record.safeSourceHashes.push(sourceHash(source));record.correction={...request,targetId:event.entityId};}
      }
      if(event.type==='presentation'){
        const chapter=input.previous.chapters.find(c=>c.id===event.entityId);if(!chapter)throw new Error('recording_presentation_prefix_missing');
        append('translation',{title:chapter.title,summary:chapter.summary,language:event.language},{title:event.title,summary:event.summary,safety:event.safety,...event.current?{current:event.current}:{}} satisfies WordingOutcome);
      }
      collectSources(record,input.effects.filter(e=>e.type==='source.persist').map(e=>e.source));
      for(const effect of input.effects){if(effect.type==='generation.request')record.pending[effect.request.ticket.jobId]={request:effect.request,atMs};if(effect.type==='publication'&&effect.snapshot.chapters.length&&!record.milestones.some(m=>m.id==='published'))record.milestones.push({id:'published',label:'First published context',atMs});}
      if(event.type==='recap.trigger'&&event.trigger.reason==='raid'&&!record.milestones.some(m=>m.id==='raid'))record.milestones.push({id:'raid',label:'Incoming raid',atMs});
      this.persist(record);
    }catch{record.status='failed';record.message='Recording stopped because a normalized input could not be saved safely. The live session continues.';record.receipt=null;this.active=null;try{this.persist(record);}catch{/* Original session validity remains authoritative after restart. */}}
  };
  review(principal:Principal,id:string):RecordingReview{this.authorize(principal);return reviewOf(this.get(id));}
  approve(principal:Principal,id:string,input:ReviewInput){
    this.authorize(principal);const record=this.get(id),review=reviewOf(record);
    if(review.blockedReasons.length)throw fail('recording_review_blocked',review.blockedReasons[0]!);
    if(input.captureRevision!==record.revision||input.digest!==review.digest)throw fail('recording_review_changed','The recording changed. Review its current contents.');
    if(input.metadataReviewed!==true||review.sources.some(s=>!input.reviewedSources.some(r=>r.id===s.id&&r.revision===s.revision&&r.textHash===s.textHash))||review.outputs.some(o=>!input.reviewedOutputHashes.includes(o.hash)))throw fail('recording_review_incomplete','Review every source excerpt and generated field before exporting.');
    // Validate exact replay before issuing a receipt, without making any provider call.
    exportBundle(record);
    record.receipt={id:randomUUID(),recordingId:id,captureRevision:record.revision,digest:review.digest,sourceReviews:input.reviewedSources,outputHashes:input.reviewedOutputHashes,reviewedBy:principal.actorId,reviewedAt:this.options.clock.iso(),privacyEpoch:record.privacyEpoch};this.store.write(record);
    return {receiptId:record.receipt.id,recordingId:id,captureRevision:record.revision,mediaPolicy:'excluded' as const,publishing:false};
  }
  export(principal:Principal,id:string,receiptId:string){
    this.authorize(principal);const record=this.get(id),receipt=record.receipt,review=reviewOf(record);
    if(!receipt||receipt.id!==receiptId||receipt.captureRevision!==record.revision||receipt.digest!==review.digest||receipt.privacyEpoch!==record.privacyEpoch)throw fail('recording_review_required','Review the current recording before exporting.');
    if(!this.options.registerExport)throw fail('recording_export_unconfigured','The private export registry is unavailable.',503);
    const bundle=exportBundle(record),bytes=new TextEncoder().encode(JSON.stringify(bundle));
    const asset:ExportAsset={id:'bundle',hash:digestBytes(bytes),bytes:bytes.length,mime:'application/json',kind:'bundle'};
    const manifest=ManifestSchema.parse({schemaVersion:1,id:bundle.id,revision:1,origin:'own-stream',sourceSessionId:record.sessionId,durationMs:bundle.durationMs,bundleHash:asset.hash,assets:[asset],milestones:bundle.milestones,providerVersions:{model:this.options.providerModel,schema:'1',prompt:'checked-replay-v1'}});
    const current=this.options.state(record.sessionId!),refs=new Map<string,VersionRef>();for(const source of record.sources){const live=this.options.source?.(source.id)??current.sources.find(s=>s.id===source.id);if(!live||live.status!=='active')throw fail('recording_source_changed','A recorded source is no longer available.');refs.set(live.id,{id:live.id,revision:live.revision});}
    const result=this.options.registerExport({recordingId:id,reviewReceiptId:receipt.id,scope:this.options.scope,sourceSessionId:record.sessionId!,privacyEpoch:record.privacyEpoch,sourceRefs:[...refs.values()],intervals:record.sources.map(s=>({startMs:s.startMs,endMs:s.endMs})),manifest,assets:[{asset,bytes}],bundle});
    record.status='exported';record.exportId=result.exportId;this.store.write(record);return {...result,manifest,uploaded:false,notice:'This export is staged privately. Publishing requires a separate explicit action. Downloaded copies cannot be remotely revoked.'};
  }
}
function digestBytes(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
