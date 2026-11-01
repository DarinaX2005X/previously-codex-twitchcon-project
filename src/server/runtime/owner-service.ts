import { createHash, randomUUID } from 'node:crypto';
import { canDispatch, compileRecap, recapLineage } from '../../core/recap.js';
import type { DomainEvent, DomainState } from '../../core/types.js';
import type { Channel, Chapter, Clock, EventEnvelope, InvalidationReceipt, Lore, Moment, OwnerSnapshot, OwnerHistoryQuery, OwnerHistoryPage, PlaybackRef, RecapPlan, Safety, Scope, Settings, Source } from '../../shared/contracts/index.js';
import { safetyAllowsPublication, SettingsSchema } from '../../shared/contracts/index.js';
import type { SafetyService } from '../providers/safety.js';
import type { createStorage, SqliteRepository, WorkLease } from '../storage/index.js';
import type { JobResult } from './scheduler.js';
import { ApiError } from './errors.js';
import type { ChapterPatch, LorePatch, OwnerMutation, OwnerRevisionMutation, OwnerService, PlaybackAck, SessionQuery, SettingsPatch, SourceQuery } from './owner-routes.js';
import type { Principal } from './security.js';
import { historyItem, loadHistoryEntity } from './history.js';

export type OwnerDispatchOptions = {envelope?: EventEnvelope; idempotencyKey?: string; requestBody?: unknown; expectedEntity?: {id: string; revision: number}; settingsPatch?: {baseRevision: number; patch: SettingsPatch}};
export interface OwnerEnginePort {
  readonly scope: Scope;
  readonly channel: Channel;
  readonly clock: Clock;
  readonly repository: SqliteRepository;
  readonly storage: Pick<ReturnType<typeof createStorage>, 'budget'>;
  readonly safety: Pick<SafetyService, 'inspectBatch'>;
  state(sessionId: string): DomainState;
  entityState?(sessionId: string, entityId: string): DomainState;
  activeSessionId(): string | null;
  outputsBlocked?(): boolean;
  dispatch(sessionId: string, event: DomainEvent, options?: OwnerDispatchOptions): Promise<DomainState>;
  statuses(): OwnerSnapshot['status'];
  presentOwnerChapter?(sessionId: string, entityId: string): Promise<void>;
  presentOwnerLore?(sessionId: string, entityId: string): Promise<void>;
}
type ResultRef = {kind: 'chapter'|'lore'|'moment'|'playback'; sessionId: string; id: string} | {kind: 'settings'} | {kind: 'receipt'; value: InvalidationReceipt} | {kind: 'void'};
type MutationRecord = {hash: string; result?: ResultRef};
const pending: Safety = {moderation: 'pending', pii: 'pending', checkedAt: null, reason: 'owner_review_pending'};
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString()); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string,unknown>;} catch { /* Invalid opaque cursor. */ }
  throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is invalid.');
}
const conflict = () => new ApiError(409, 'revision_conflict', 'This item changed. Your edits have not been applied; refresh its revision before trying again.');

/** Owner-only projection and commands. Public consumers must use the published projection. */
export class RuntimeOwnerService implements OwnerService {
  private tail: Promise<unknown> = Promise.resolve();
  private requestBody: unknown;
  constructor(private readonly engine: OwnerEnginePort) {}
  private authorize(principal: Principal): void {
    const {scope, clock} = this.engine;
    if (principal.expiresAtMs <= clock.now()) throw new ApiError(401, 'session_required', 'Sign in to continue.');
    if (principal.channelId !== scope.channelId || principal.runId !== scope.runId || (scope.runId === 'live' ? principal.role !== 'owner' : principal.role !== 'demo')) throw new ApiError(403, 'role_forbidden', 'This session cannot access that resource.');
  }
  private state(id: string): DomainState {this.engine.repository.getSession(this.engine.scope,id); return this.engine.state(id);}
  private entityState(sessionId: string, entityId: string): DomainState {
    return this.engine.entityState?.(sessionId, entityId) ?? loadHistoryEntity(this.engine.repository, this.engine.repository.getSession(this.engine.scope, sessionId), this.state(sessionId), entityId);
  }
  private entity(id: string, kind: 'chapter'|'lore'|'playback') {
    const row = this.engine.repository.getEntity(this.engine.scope,id);
    if (!row || row.kind !== kind || row.status !== 'active') throw new ApiError(404,'not_found','This item is unavailable.');
    return {row, state: kind === 'playback' ? this.state(row.sessionId) : this.entityState(row.sessionId,id)};
  }
  private resolve(ref: ResultRef): unknown {
    if (ref.kind === 'void') return undefined;
    if (ref.kind === 'settings') return this.engine.repository.getSettings(this.engine.scope);
    if (ref.kind === 'receipt') return ref.value;
    let state:DomainState;
    try{state=ref.kind === 'chapter' || ref.kind === 'lore' ? this.entityState(ref.sessionId,ref.id) : this.state(ref.sessionId);}
    catch(error){if(error instanceof ApiError&&error.status===404)throw new ApiError(409,'result_withdrawn','The earlier result has been withdrawn.');throw error;}
    const values = ref.kind === 'chapter' ? state.chapters : ref.kind === 'lore' ? state.lore : ref.kind === 'moment' ? state.moments : state.playbacks;
    const result = values.find(value=>value.id===ref.id);
    if (!result) throw new ApiError(409,'result_withdrawn','The earlier result has been withdrawn.');
    return structuredClone(result);
  }
  private mutate<T>(context: OwnerMutation, operation: string, input: unknown, action: () => Promise<ResultRef> | ResultRef): Promise<T> {
    this.authorize(context.principal);
    if (!/^[\w.-]{8,128}$/.test(context.idempotencyKey)) throw new ApiError(400,'idempotency_required','An idempotency key is required.');
    const run = async () => {
      const repository=this.engine.repository, scope=this.engine.scope, key=`owner-mutation:${context.idempotencyKey}`;
      const body={operation,input,baseRevision:'baseRevision' in context ? context.baseRevision : undefined};
      const fingerprint=hash(body);
      const old=repository.controlGet<MutationRecord>(scope,key);
      if (old) {if(old.hash!==fingerprint) throw new ApiError(409,'idempotency_conflict','This idempotency key was used for a different request.'); if(old.result)return this.resolve(old.result) as T; throw new ApiError(409,'mutation_pending','This request is still pending or its outcome needs reconciliation.');}
      const receipt=repository.getDomainMutation(scope,context.idempotencyKey,body);
      if(receipt){
        const data=input as {id?:string;sessionId?:string};
        const sessionId=receipt.sessionId;
        let result:ResultRef;
        if(receipt.kind==='settings'||operation==='settings')result={kind:'settings'};
        else if(receipt.receipt&&(operation==='privacy'||operation.endsWith('.delete')))result={kind:'receipt',value:receipt.receipt};
        else if(operation.startsWith('playback.'))result={kind:'void'};
        else if(sessionId&&operation==='moment.save')result={kind:'moment',sessionId,id:`moment:${hash(context.idempotencyKey).slice(0,32)}`};
        else if(sessionId&&operation==='recap.trigger')result={kind:'playback',sessionId,id:`playback:owner:${hash(context.idempotencyKey).slice(0,32)}`};
        else if(sessionId&&data.id)result={kind:operation.startsWith('chapter.')?'chapter':'lore',sessionId,id:data.id};
        else throw new ApiError(409,'result_withdrawn','The earlier result is no longer available.');
        return this.resolve(result) as T;
      }
      this.requestBody=body;
      const result=await action();repository.controlPut(scope,key,{hash:fingerprint,result});return this.resolve(result) as T;
    };
    const result=this.tail.then(run,run);this.tail=result.catch(()=>undefined);return result;
  }
  private options(context: OwnerMutation, _requestBody: unknown): OwnerDispatchOptions {return {idempotencyKey:context.idempotencyKey,requestBody:this.requestBody};}
  private statement(state: DomainState, principal: Principal, text: string): Source {
    const at=Math.max(0,Math.min(172_800_000,this.engine.clock.now()-Date.parse(state.session.startedAt)));
    return {...this.engine.scope,id:`owner:${randomUUID()}`,sessionId:state.session.id,revision:1,kind:'owner_statement',startMs:at,endMs:at,actorId:principal.actorId,languageCodes:[state.settings.recapLanguage],timePrecision:'event',text,status:'active',externalMessageId:null,moderation:'pending'};
  }
  private async review(fields: {id: string; text: string}[],signal?: AbortSignal) {
    try {const reviewed=await this.engine.safety.inspectBatch(fields,signal);if(reviewed.length!==fields.length || fields.some(f=>!reviewed.some(r=>r.id===f.id)))throw new Error('Incomplete review');return reviewed;}
    catch {return fields.map(field=>({...field,safety:{moderation:'unavailable',pii:'review',checkedAt:this.engine.clock.iso(),reason:'safety_unavailable'} as Safety}));}
  }
  private combined(results: {safety: Safety}[]): Safety {
    return {moderation:results.some(r=>r.safety.moderation==='blocked')?'blocked':results.every(r=>r.safety.moderation==='allowed')?'allowed':'unavailable',pii:results.every(r=>['allowed','redacted'].includes(r.safety.pii))?(results.some(r=>r.safety.pii==='redacted')?'redacted':'allowed'):'review',checkedAt:this.engine.clock.iso(),reason:results.find(r=>r.safety.reason)?.safety.reason??null};
  }
  /** Durable jobs contain only identifiers; text is read from the current private state for each attempt. */
  async executeReview(job: WorkLease,signal: AbortSignal): Promise<JobResult> {
    type ReviewRequest={kind:'chapter'|'lore';entityId:string;entityRevision:number;ownerRevision?:number;sourceId:string;sourceRevision:number;privacyEpoch:number};
    const value=job.payload as Partial<ReviewRequest>|null;
    if(job.kind!=='owner.review'||!value||!['chapter','lore'].includes(value.kind??'')||typeof value.entityId!=='string'||typeof value.sourceId!=='string'||!Number.isSafeInteger(value.entityRevision)||!Number.isSafeInteger(value.sourceRevision)||value.privacyEpoch!==job.privacyEpoch)return {state:'failed'};
    const request=value as ReviewRequest;
    const current=()=>{
      const row=this.engine.repository.getEntity(this.engine.scope,request.entityId);if(!row||row.status!=='active')return null;
      let state:DomainState;try{state=this.entityState(job.sessionId,request.entityId);}catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}
      const source=this.engine.repository.getSource(this.engine.scope,request.sourceId);
      if(state.session.privacyEpoch!==request.privacyEpoch||!source||source.sessionId!==job.sessionId||source.kind!=='owner_statement'||source.revision!==request.sourceRevision||source.status!=='active')return null;
      const chapter=request.kind==='chapter'?state.chapters.find(c=>c.id===request.entityId):undefined;
      const lore=request.kind==='lore'?state.lore.find(l=>l.id===request.entityId):undefined;
      const entity=chapter??lore;
      if(!entity||!entity.dependencyRefs.some(ref=>ref.id===source.id&&ref.revision===source.revision)||chapter&&(chapter.ownerEditRevision!==request.ownerRevision||chapter.publicationState!=='held')||lore&&(lore.revision!==request.entityRevision||lore.status!=='held'))return null;
      return {state,source,chapter,lore};
    };
    if(signal.aborted||!this.engine.repository.renewJob(this.engine.scope,job.id,job.leaseToken))return {state:'done'};
    const before=current();if(!before)return {state:'done'};
    const fields=before.chapter?[{id:'title',text:before.chapter.title},{id:'summary',text:before.chapter.summary}]:[{id:'term',text:before.lore!.term},{id:'explanation',text:before.lore!.explanation},...before.lore!.aliases.map((text,index)=>({id:`alias:${index}`,text}))];
    const results=await this.review(fields,signal);
    if(signal.aborted||!this.engine.repository.renewJob(this.engine.scope,job.id,job.leaseToken))return {state:'done'};
    const after=current();if(!after)return {state:'done'};
    const safety=this.combined(results),unavailable=results.some(result=>result.safety.moderation==='unavailable'&&['safety_unavailable','moderation_unavailable','provider_unavailable'].includes(result.safety.reason??''));
    if(unavailable&&job.attempts<3)return {state:'failed',retryAtMs:this.engine.clock.now()+2000*2**Math.max(0,job.attempts-1)};
    if(unavailable)safety.reason='owner_review_unavailable';
    if(after.chapter){
      const reviewed=await this.engine.dispatch(job.sessionId,{type:'owner.review',entityId:request.entityId,ownerRevision:request.ownerRevision!,sourceId:request.sourceId,sourceRevision:request.sourceRevision,privacyEpoch:request.privacyEpoch,title:results.find(r=>r.id==='title')!.text,summary:results.find(r=>r.id==='summary')!.text,safety});
      if(safetyAllowsPublication(safety)&&reviewed.chapters.some(c=>c.id===request.entityId&&c.ownerEditRevision===request.ownerRevision)){
        // A failed alternate presentation cannot revoke the already committed primary review.
        try {await this.engine.presentOwnerChapter?.(job.sessionId,request.entityId);} catch { /* Alternate language remains held. */ }
      }
    }else{
      const reviewed=await this.engine.dispatch(job.sessionId,{type:'lore.review',id:request.entityId,baseRevision:request.entityRevision,sourceId:request.sourceId,sourceRevision:request.sourceRevision,privacyEpoch:request.privacyEpoch,term:results.find(r=>r.id==='term')!.text,explanation:results.find(r=>r.id==='explanation')!.text,aliases:after.lore!.aliases.map((_,index)=>results.find(r=>r.id===`alias:${index}`)!.text),originMs:after.lore!.originMs,safety});
      if(safetyAllowsPublication(safety)&&reviewed.lore.some(l=>l.id===request.entityId&&l.revision===request.entityRevision+1&&safetyAllowsPublication(l.safety))){
        try {await this.engine.presentOwnerLore?.(job.sessionId,request.entityId);} catch { /* The reviewed original remains available; the alternate language stays held. */ }
      }
    }
    return {state:unavailable?'failed':'done'};
  }
  bootstrap(principal: Principal): OwnerSnapshot {this.authorize(principal); const id=this.engine.activeSessionId();return this.snapshot(id ? this.state(id) : null);}
  getSession(principal: Principal,id: string): OwnerSnapshot {this.authorize(principal);return this.snapshot(this.state(id));}
  private snapshot(state: DomainState|null): OwnerSnapshot {
    const publication=this.engine.repository.getPublicationState(this.engine.scope),budget=this.engine.storage.budget.status(),status=this.engine.statuses();
    const visible = this.engine.outputsBlocked?.() ? null : state;
    return structuredClone({channel:this.engine.channel,session:state?.session??null,settings:this.engine.repository.getSettings(this.engine.scope),status,published:visible?.published??null,drafts:visible?.chapters.filter(c=>c.publicationState==='draft')??[],held:[...visible?.chapters.filter(c=>c.publicationState==='held')??[],...visible?.lore.filter(l=>l.status==='held')??[]],lore:visible?.lore??[],moments:visible?.moments??[],playback:visible?.playbacks??[],sync:{state:status.cloud.state==='error'?'error':status.cloud.state==='unconfigured'?'unconfigured':publication.pendingPrivacy||publication.publishSeq>publication.ackSeq?'pending':'synced',revision:publication.publishSeq,acknowledgedRevision:publication.ackSeq||null,lastSyncedAt:publication.lastSyncedAtMs===null?null:new Date(publication.lastSyncedAtMs).toISOString(),pendingPrivacy:publication.pendingPrivacy||Boolean(this.engine.outputsBlocked?.())},revision:state?.revision??0,serverNow:this.engine.clock.iso(),budget:{limitUsd:budget.limitMicroUsd/1e6,committedUsd:budget.committedMicroUsd/1e6,reservedUsd:budget.reservedMicroUsd/1e6,paidCallsEnabled:budget.enabled}});
  }
  listSessions(principal: Principal,query: SessionQuery) {
    this.authorize(principal);const cursor=decode(query.cursor),limit=Math.max(1,Math.min(50,Math.floor(query.limit)));
    if(cursor&&(typeof cursor.startedAt!=='string'||typeof cursor.id!=='string'))throw new ApiError(400,'invalid_cursor','The pagination cursor is invalid.');
    const rows=this.engine.repository.listSessions(this.engine.scope,{limit,cursor:cursor as {startedAt:string;id:string}|undefined});
    return {items:rows.map(row=>this.engine.repository.getSession(this.engine.scope,row.id)),nextCursor:rows.length===limit?encode({startedAt:rows.at(-1)!.startedAt,id:rows.at(-1)!.id}):null};
  }
  listSources(principal: Principal,query: SourceQuery) {
    this.authorize(principal);if(this.engine.outputsBlocked?.())throw new ApiError(503,'privacy_recovery_pending','Sources are unavailable until the pending chat removal is applied.',true);this.engine.repository.getSession(this.engine.scope,query.sessionId);
    const cursor=decode(query.cursor),limit=Math.max(1,Math.min(100,Math.floor(query.limit)));
    if(cursor&&(typeof cursor.startMs!=='number'||typeof cursor.id!=='string'||cursor.sessionId!==query.sessionId))throw new ApiError(400,'invalid_cursor','The pagination cursor is invalid.');
    const rows=this.engine.repository.listSources(this.engine.scope,query.sessionId,{limit,cursor:cursor as {startMs:number;id:string}|undefined,fromMs:query.fromMs,toMs:query.toMs});
    return {items:rows,nextCursor:rows.length===limit?encode({startMs:rows.at(-1)!.startMs,id:rows.at(-1)!.id,sessionId:query.sessionId}):null};
  }
  listHistory(principal: Principal,query: OwnerHistoryQuery): OwnerHistoryPage {
    this.authorize(principal);
    if(this.engine.outputsBlocked?.())throw new ApiError(503,'privacy_recovery_pending','History is paused until the pending chat removal is applied.',true);
    const repository=this.engine.repository,session=repository.getSession(this.engine.scope,query.sessionId),settings=repository.getSettings(this.engine.scope);
    const filter=query.filter??'all',limit=Math.max(1,Math.min(50,Math.floor(query.limit))),decoded=decode(query.cursor);
    if(decoded&&(typeof decoded.id!=='string'||!decoded.id||typeof decoded.startMs!=='number'||!Number.isSafeInteger(decoded.startMs)||decoded.startMs<0||decoded.sessionId!==query.sessionId||decoded.kind!==query.kind||decoded.filter!==filter))throw new ApiError(400,'invalid_cursor','The pagination cursor is invalid.');
    if(decoded&&(decoded.privacyEpoch!==session.privacyEpoch||decoded.language!==settings.recapLanguage))throw new ApiError(409,'history_changed','History changed. Reload it before continuing.');
    let cursor=decoded?{startMs:decoded.startMs as number,id:decoded.id as string}:undefined,nextCursor:typeof cursor|null=null;
    const items:OwnerHistoryPage['items']=[];
    for(let pageCount=0;pageCount<4&&items.length<limit;pageCount++){
      const page=repository.listEntityHistory(this.engine.scope,session.id,{kind:query.kind,limit:limit-items.length,cursor});
      for(const row of page.items){const item=historyItem(repository,{channel:this.engine.channel,session,settings},row.id,filter,this.engine.clock.now());if(item)items.push(item);}
      nextCursor=page.nextCursor;if(!nextCursor)break;cursor=nextCursor;
    }
    return {items,nextCursor:nextCursor?encode({...nextCursor,sessionId:session.id,kind:query.kind,filter,privacyEpoch:session.privacyEpoch,language:settings.recapLanguage}):null,privacyEpoch:session.privacyEpoch,language:settings.recapLanguage};
  }
  setSettings(context: OwnerRevisionMutation,patch: SettingsPatch): Promise<Settings> {
    return this.mutate(context,'settings',patch,async()=>{
      const current=this.engine.repository.getSettings(this.engine.scope);if(current.revision!==context.baseRevision)throw conflict();
      SettingsSchema.parse({...current,...patch,revision:current.revision+1});const sessionId=this.engine.activeSessionId();
      if(sessionId)await this.engine.dispatch(sessionId,{type:'tick'},{...this.options(context,{operation:'settings',patch,baseRevision:context.baseRevision}),settingsPatch:{baseRevision:context.baseRevision,patch}});
      else this.engine.repository.updateSettings(this.engine.scope,context.baseRevision,patch,{idempotencyKey:context.idempotencyKey,requestBody:this.requestBody});
      return {kind:'settings'};
    });
  }
  editChapter(context: OwnerRevisionMutation,id: string,patch: ChapterPatch): Promise<Chapter> {
    return this.mutate(context,'chapter.edit',{id,patch},async()=>{
      const {state}=this.entity(id,'chapter'),chapter=state.chapters.find(c=>c.id===id);if(!chapter||chapter.revision!==context.baseRevision)throw conflict();
      let next=state;
      if(patch.title!==undefined||patch.summary!==undefined){
        const title=patch.title??chapter.title,summary=patch.summary??chapter.summary,source=this.statement(state,context.principal,summary);
        next=await this.engine.dispatch(state.session.id,{type:'owner.edit',entityId:id,baseRevision:chapter.revision,source,title,summary,safety:pending,pinned:patch.pinned},{...this.options(context,{operation:'chapter.edit',id,patch,baseRevision:context.baseRevision}),expectedEntity:{id,revision:context.baseRevision}});
      }
      if(patch.pinned!==undefined&&patch.title===undefined&&patch.summary===undefined)await this.engine.dispatch(state.session.id,{type:'owner.pin',entityId:id,baseRevision:next.chapters.find(c=>c.id===id)!.revision,pinned:patch.pinned},{...this.options(context,{operation:'chapter.edit',id,patch,baseRevision:context.baseRevision}),expectedEntity:{id,revision:context.baseRevision}});
      return {kind:'chapter',sessionId:state.session.id,id};
    });
  }
  deleteChapter(context: OwnerRevisionMutation,id: string): Promise<InvalidationReceipt> {return this.remove(context,id,'chapter');}
  deleteLore(context: OwnerRevisionMutation,id: string): Promise<InvalidationReceipt> {return this.remove(context,id,'lore');}
  private remove(context: OwnerRevisionMutation,id: string,kind: 'chapter'|'lore'): Promise<InvalidationReceipt> {
    return this.mutate(context,`${kind}.delete`,{id},async()=>{const {row,state}=this.entity(id,kind);if(row.revision!==context.baseRevision)throw conflict();const target={kind:'entity' as const,sessionId:state.session.id,id};const next=await this.engine.dispatch(state.session.id,{type:'privacy',target,reason:'owner_delete'},{...this.options(context,{operation:`${kind}.delete`,id,baseRevision:context.baseRevision}),expectedEntity:{id,revision:context.baseRevision}});if(!next.lastReceipt)throw new ApiError(503,'save_failed','The deletion could not be saved.');return {kind:'receipt',value:next.lastReceipt};});
  }
  privacy(context: OwnerMutation,input: Parameters<OwnerService['privacy']>[1]): Promise<InvalidationReceipt> {
    return this.mutate(context,'privacy',input,async()=>{this.state(input.target.sessionId);const next=await this.engine.dispatch(input.target.sessionId,{type:'privacy',...input},this.options(context,{operation:'privacy',...input}));if(!next.lastReceipt)throw new ApiError(503,'save_failed','The privacy change could not be saved.');return {kind:'receipt',value:next.lastReceipt};});
  }
  editLore(context: OwnerRevisionMutation,id: string,patch: LorePatch): Promise<Lore> {return this.changeLore(context,id,patch,'lore.edit');}
  confirmLore(context: OwnerRevisionMutation,id: string): Promise<Lore> {return this.changeLore(context,id,{},'lore.confirm');}
  private changeLore(context: OwnerRevisionMutation,id: string,patch: LorePatch,operation: string): Promise<Lore> {
    return this.mutate(context,operation,{id,patch},async()=>{
      const {state}=this.entity(id,'lore'),lore=state.lore.find(l=>l.id===id);if(!lore||lore.revision!==context.baseRevision)throw conflict();
      const value={term:patch.term??lore.term,explanation:patch.explanation??lore.explanation,aliases:patch.aliases??lore.aliases,originMs:patch.originMs===undefined?lore.originMs:patch.originMs},source=this.statement(state,context.principal,value.explanation);
      await this.engine.dispatch(state.session.id,{type:'lore.edit',id,baseRevision:lore.revision,source,...value},{...this.options(context,{operation,id,patch,baseRevision:context.baseRevision}),expectedEntity:{id,revision:context.baseRevision}});
      return {kind:'lore',sessionId:state.session.id,id};
    });
  }
  blockLore(context: OwnerRevisionMutation,id: string,blocked: boolean): Promise<Lore> {
    return this.mutate(context,'lore.block',{id,blocked},async()=>{
      const row=this.engine.repository.getEntity(this.engine.scope,id);if(!row||row.kind!=='lore')throw new ApiError(404,'not_found','This item is unavailable.');
      const state=this.entityState(row.sessionId,id),lore=state.lore.find(l=>l.id===id);if(!lore||lore.revision!==context.baseRevision)throw conflict();
      const event:DomainEvent=blocked?{type:'privacy',target:{kind:'term',sessionId:state.session.id,term:lore.term},reason:'owner_block'}:{type:'term.unblock',term:lore.term};
      await this.engine.dispatch(state.session.id,event,{...this.options(context,{operation:'lore.block',id,blocked,baseRevision:context.baseRevision}),expectedEntity:{id,revision:context.baseRevision}});
      return {kind:'lore',sessionId:state.session.id,id};
    });
  }
  saveMoment(context: OwnerMutation,input: {sessionId: string;label?: string}): Promise<Moment> {
    return this.mutate(context,'moment.save',input,async()=>{const state=this.state(input.sessionId),id=`moment:${hash(context.idempotencyKey).slice(0,32)}`,atMs=Math.max(0,Math.min(172_800_000,this.engine.clock.now()-Date.parse(state.session.startedAt)));await this.engine.dispatch(input.sessionId,{type:'moment.save',id,atMs},this.options(context,{operation:'moment.save',...input}));return {kind:'moment',sessionId:input.sessionId,id};});
  }
  previewRecap(principal: Principal,sessionId: string): RecapPlan|null {
    this.authorize(principal);if(this.engine.outputsBlocked?.())return null;const state=this.state(sessionId);if(!state.published)return null;
    return compileRecap(state.published,state.settings.layout,{id:'owner-preview',sessionId,reason:'manual',occurredAt:this.engine.clock.iso()},{...recapLineage(state),media:state.media.filter(media=>canDispatch(state,{sessionId,privacyEpoch:state.session.privacyEpoch,dependencyRefs:media.refs})),durationMs:state.settings.recapDurationMs,generatedAt:this.engine.clock.iso(),narrationEnabled:state.settings.narrationEnabled});
  }
  triggerRecap(context: OwnerMutation,input: {sessionId: string;reason: 'manual'|'hotkey'}): Promise<PlaybackRef> {
    if(this.engine.outputsBlocked?.())return Promise.reject(new ApiError(503,'privacy_recovery_pending','Recap output is paused until the pending chat removal is applied.',true));
    return this.mutate(context,'recap.trigger',input,async()=>{this.state(input.sessionId);const triggerId=`owner:${hash(context.idempotencyKey).slice(0,32)}`;const state=await this.engine.dispatch(input.sessionId,{type:'recap.trigger',trigger:{id:triggerId,...input,occurredAt:this.engine.clock.iso()}},this.options(context,{operation:'recap.trigger',...input}));const playback=state.playbacks.find(p=>p.id===`playback:${triggerId}`)??state.playbacks.find(p=>p.status==='queued');if(!playback)throw new ApiError(409,'recap_unavailable','A recap could not be prepared.');return {kind:'playback',sessionId:input.sessionId,id:playback.id};});
  }
  cancelRecap(context: OwnerMutation,id: string): Promise<void> {return this.playback(context,id,'cancel');}
  acknowledgeRecap(context: OwnerMutation,id: string,input: PlaybackAck): Promise<void> {return this.playback(context,id,input.state==='started'?'start':input.state==='ended'?'end':input.state,input);}
  private playback(context: OwnerMutation,id: string,action: 'prepared'|'start'|'end'|'cancel'|'error',input?: PlaybackAck): Promise<void> {
    return this.mutate(context,`playback.${action}`,{id,input},async()=>{const {state}=this.entity(id,'playback');const playback=state.playbacks.find(p=>p.id===id);if(!playback||['ended','cancelled','skipped'].includes(playback.status))return {kind:'void'};await this.engine.dispatch(state.session.id,{type:'playback',id,action},this.options(context,{operation:`playback.${action}`,id,input}));return {kind:'void'};});
  }
}
export const createOwnerService = (engine: OwnerEnginePort): RuntimeOwnerService => new RuntimeOwnerService(engine);
