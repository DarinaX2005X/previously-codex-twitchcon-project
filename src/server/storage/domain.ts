import { createHash, randomUUID } from 'node:crypto';
import type { DomainState, DerivedNode, StoryCandidate, GenerationRequest } from '../../core/types.js';
import type { Scope, Source, VersionRef, EventEnvelope, PrivacyTarget, InvalidationReceipt, Lore } from '../../shared/contracts/index.js';
import { EventEnvelopeSchema, SourceSchema, SessionSchema, SettingsSchema, ChapterSchema, PublicSnapshotSchema, GenerationTicketSchema, safetyAllowsPublication } from '../../shared/contracts/index.js';
import type { SqliteRepository } from './repository.js';
import { StorageDatabase, StorageError, integer, json } from './database.js';
import type { DomainCheckpoint, DomainEntity, DomainHydration, DomainCommitInput, DomainCommitResult } from './domain-types.js';

const canonical=(value:unknown):string=>{
  if(value===null || typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
};
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const CHECKPOINT_BYTES=16_777_216;

/** The reducer runs before entering this adapter. Only persistence and fence checks run here. */
export class DomainPersistence {
  constructor(private readonly db:StorageDatabase,private readonly now:()=>number,private readonly repository:SqliteRepository) {}
  private scoped(scope:Scope){return [scope.channelId,scope.runId] as const;}
  checkpoint(scope:Scope,sessionId:string):DomainCheckpoint {
    const session=this.repository.getSession(scope,sessionId);
    const row=this.db.get('SELECT revision,privacy_epoch,body FROM domain_checkpoints WHERE channel_id=? AND run_id=? AND session_id=?',...this.scoped(scope),sessionId);
    return {revision:Number(row?.revision ?? 0),privacyEpoch:session.privacyEpoch,checkpoint:row?.body && Number(row.privacy_epoch)===session.privacyEpoch ? JSON.parse(String(row.body)) as DomainState : null};
  }
  hydration(scope:Scope,sessionId:string,options:{checkpointOnly?:boolean}={}):DomainHydration {
    const checkpoint=this.checkpoint(scope,sessionId),session=this.repository.getSession(scope,sessionId),settings=this.repository.getSettings(scope);
    const channel=this.db.get('SELECT login FROM channels WHERE channel_id=? AND run_id=?',...this.scoped(scope))!;
    // A valid checkpoint already contains these records. Its caller must request
    // the full recovery projection if checkpoint validation fails.
    const recoveryRecords=!options.checkpointOnly || !checkpoint.checkpoint;
    const sources=recoveryRecords ? this.db.all('SELECT id FROM sources WHERE channel_id=? AND run_id=? AND session_id=? ORDER BY start_ms DESC,id DESC LIMIT 500',...this.scoped(scope),sessionId).reverse().map(row=>this.repository.getSource(scope,String(row.id))!) : [];
    const rows=recoveryRecords ? this.db.all(`SELECT * FROM entities WHERE channel_id=? AND run_id=? AND session_id=? ORDER BY
      CASE kind WHEN 'chapter' THEN 0 WHEN 'lore' THEN 1 WHEN 'moment' THEN 2 WHEN 'current_state' THEN 3 WHEN 'media' THEN 4 ELSE 5 END,
      CASE status WHEN 'active' THEN 0 ELSE 1 END,COALESCE(end_ms,0) DESC,id LIMIT 2000`,...this.scoped(scope),sessionId) : [];
    const entities:DomainEntity[]=rows.map(row=>{
      const edges=this.db.all('SELECT parent_id,parent_revision,kind FROM dependencies WHERE channel_id=? AND run_id=? AND child_id=?',...this.scoped(scope),String(row.id));
      const refs=(kind:string)=>edges.filter(edge=>edge.kind===kind).map(edge=>({id:String(edge.parent_id),revision:Number(edge.parent_revision)}));
      return {id:String(row.id),revision:Number(row.revision),kind:String(row.kind) as DerivedNode['kind'],supports:refs('supports'),exposedTo:refs('exposed_to'),startMs:Number(row.start_ms ?? 0),endMs:Number(row.end_ms ?? 0),active:row.status==='active',body:row.body===null ? null : JSON.parse(String(row.body)),ownerRevision:Number(row.owner_revision),ownerLocked:Boolean(row.owner_locked),pinned:Boolean(row.pinned)};
    });
    const candidates:StoryCandidate[]=[];
    for(const row of recoveryRecords ? this.db.all("SELECT body,status FROM publication_candidates WHERE channel_id=? AND run_id=? AND session_id=? AND body IS NOT NULL AND status IN ('pending','published') ORDER BY revision DESC LIMIT 1200",...this.scoped(scope),sessionId) : []) {
      const candidate=JSON.parse(String(row.body)) as StoryCandidate;
      if(candidate.id && candidate.chapter && candidate.inputRefs)candidates.push({...candidate,status:String(row.status) as StoryCandidate['status']});
    }
    // Historical leaf metadata preserves privacy/author fences without hydrating raw transcripts.
    const known=new Set([...sources.map(source=>source.id),...entities.map(entity=>entity.id)]),roots=[...new Set([...entities.map(entity=>entity.id),...candidates.flatMap(candidate=>candidate.inputRefs.map(ref=>ref.id))])];
    if(roots.length) {
      const query=`WITH RECURSIVE ancestors(id) AS (SELECT value FROM json_each(?) UNION SELECT d.parent_id FROM dependencies d JOIN ancestors a ON a.id=d.child_id WHERE d.channel_id=? AND d.run_id=?) SELECT s.id FROM sources s JOIN ancestors a ON a.id=s.id WHERE s.channel_id=? AND s.run_id=? ORDER BY s.start_ms,s.id LIMIT 32000`;
      for(const row of this.db.all(query,json(roots),...this.scoped(scope),...this.scoped(scope))) {
        const id=String(row.id);if(known.has(id))continue;const source=this.repository.getSource(scope,id)!;const {text:_text,...evidenceMetadata}=source;
        entities.push({id,revision:source.revision,kind:'provider_cache',supports:[],exposedTo:[],startMs:source.startMs,endMs:source.endMs,active:source.status==='active',body:{evidenceMetadata},ownerRevision:0,ownerLocked:false,pinned:false});known.add(id);
      }
    }
    const tombstones:PrivacyTarget[]=[];
    for(const row of this.db.all('SELECT * FROM source_tombstones WHERE channel_id=? AND run_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1000',...this.scoped(scope),sessionId)) {
      const id=String(row.target_id ?? '');
      switch(row.kind){case 'source':case 'entity':tombstones.push({kind:row.kind,sessionId,id});break;case 'message':tombstones.push({kind:'message',sessionId,externalMessageId:id});break;case 'user':tombstones.push({kind:'user',sessionId,actorId:id,throughMs:Number(row.to_ms)});break;case 'interval':tombstones.push({kind:'interval',sessionId,fromMs:Number(row.from_ms),toMs:Number(row.to_ms)});break;case 'session':tombstones.push({kind:'session',sessionId});break;}
    }
    const capture=this.db.get('SELECT epoch FROM capture_leases WHERE channel_id=? AND run_id=? AND session_id=?',...this.scoped(scope),sessionId);
    const blockedLore:Lore[]=[];
    for(const row of this.db.all("SELECT body FROM control_state WHERE channel_id=? AND run_id=? AND key LIKE 'blocked-lore:%' ORDER BY key LIMIT 500",...this.scoped(scope))) {
      const stub=JSON.parse(String(row.body)) as {id:string;sessionId:string;revision:number;term:string;aliases:string[];firstSeenMs:number;status:'blocked'|'observed'};
      if(stub.sessionId===sessionId)blockedLore.push({...stub,explanation:'',originMs:null,originKind:'unknown',momentId:null,maxDependencyEndMs:0,dependencyRefs:[],safety:{moderation:'unavailable',pii:'review',checkedAt:null,reason:null}});
    }
    return {...checkpoint,channel:{id:scope.channelId,login:String(channel.login),displayName:String(channel.login)},session,settings,sources,entities,candidates,published:checkpoint.checkpoint?.published ?? null,tombstones,blockedTerms:this.repository.listBlockedTerms(scope,sessionId,{limit:500}),bannedActors:this.db.all('SELECT actor_id FROM channel_bans WHERE channel_id=? AND run_id=? ORDER BY actor_id LIMIT 1000',...this.scoped(scope)).map(row=>String(row.actor_id)),captureEpoch:Number(capture?.epoch ?? checkpoint.checkpoint?.captureEpoch ?? 0),chatClearThroughMs:this.repository.controlGet<number>(scope,`chat-clear:${sessionId}`),blockedLore};
  }
  private activeRef(scope:Scope,ref:VersionRef):boolean {
    const row=this.db.get('SELECT revision,status FROM sources WHERE channel_id=? AND run_id=? AND id=?',...this.scoped(scope),ref.id) ?? this.db.get('SELECT revision,status FROM entities WHERE channel_id=? AND run_id=? AND id=?',...this.scoped(scope),ref.id);
    return !!row && row.status==='active' && Number(row.revision)===ref.revision;
  }
  private eventContext(scope:Scope,event:EventEnvelope<unknown>,privacyEpoch:number):VersionRef[]|null {
    const payload=event.payload && typeof event.payload==='object' ? event.payload as Record<string,unknown> : {},type=typeof payload.type==='string' ? payload.type : event.kind;
    const source=SourceSchema.safeParse(payload.source);
    if(source.success && this.repository.sourcePolicy(scope,source.data)==='deleted')return null;
    if(type==='generation.result'){
      const ticket=GenerationTicketSchema.safeParse(payload.ticket);if(!ticket.success)return null;
      const value=ticket.data,job=this.db.get('SELECT ticket,status FROM generation_jobs WHERE channel_id=? AND run_id=? AND id=?',...this.scoped(scope),value.jobId);
      if(value.channelId!==scope.channelId || value.runId!==scope.runId || value.sessionId!==event.sessionId || value.privacyEpoch!==privacyEpoch || !job || job.status!=='registered' || canonical(JSON.parse(String(job.ticket)))!==canonical(value) || !value.inputRefs.every(ref=>this.activeRef(scope,ref)))return null;
      return value.inputRefs;
    }
    if(['source.safety','owner.review','lore.review'].includes(type)){
      const id=type==='source.safety' ? payload.id : payload.sourceId,revision=type==='source.safety' ? payload.baseRevision : payload.sourceRevision;
      if(typeof id!=='string' || typeof revision!=='number' || !this.activeRef(scope,{id,revision}))return null;
      if(type==='owner.review' && typeof payload.entityId==='string'){
        const entity=this.repository.getEntity(scope,payload.entityId);if(!entity || entity.status!=='active' || entity.ownerRevision!==payload.ownerRevision)return null;
      }
      return [{id,revision}];
    }
    if(type==='presentation'){
      if(typeof payload.entityId!=='string')return null;const entity=this.repository.getEntity(scope,payload.entityId);
      if(!entity || entity.status!=='active' || entity.revision!==payload.baseRevision || entity.ownerRevision!==payload.ownerRevision)return null;
      return [{id:entity.id,revision:entity.revision}];
    }
    if(type==='media'){
      if(payload.privacyEpoch!==privacyEpoch)return null;
      const media=payload.media as {refs?:VersionRef[]}|undefined;if(!media || !Array.isArray(media.refs) || !media.refs.every(ref=>this.activeRef(scope,ref)))return null;
      return media.refs;
    }
    return [];
  }
  private edges(scope:Scope,id:string,refs:VersionRef[],kind:'supports'|'exposed_to') {
    if(refs.length>500)throw new StorageError('capacity','Dependency set exceeds its limit.');
    for(const ref of refs){if(ref.id===id || !this.activeRef(scope,ref))throw new StorageError('conflict','Domain dependency is unavailable or changed.');
      this.db.run('INSERT INTO dependencies VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id,run_id,parent_id,child_id,kind) DO UPDATE SET parent_revision=excluded.parent_revision',...this.scoped(scope),ref.id,ref.revision,id,kind);
    }
  }
  private source(scope:Scope,eventId:string,source:Source) {
    if(!SourceSchema.safeParse(source).success || source.channelId!==scope.channelId || source.runId!==scope.runId)throw new StorageError('invalid_input','Domain source does not match its scope.');
    const policy=this.repository.sourcePolicy(scope,source);
    if((policy==='deleted' && (source.text!==null || source.status!=='deleted')) || (policy==='quarantined' && source.status==='active'))throw new StorageError('conflict','Source controls changed before the transition committed.');
    const old=this.repository.getSource(scope,source.id);
    if(old){
      if(old.sessionId!==source.sessionId)throw new StorageError('inaccessible','Source belongs to another session.');
      if(canonical(old)===canonical(source))return;
      if(source.revision<old.revision || source.revision>old.revision+1 || (source.revision===old.revision && source.status==='active'))throw new StorageError('conflict','Source revision changed.');
      if(old.status==='deleted' && source.status!=='deleted')throw new StorageError('conflict','A deleted source cannot be restored.');
      this.db.run('UPDATE events SET payload=NULL WHERE channel_id=? AND run_id=? AND id IN (SELECT event_id FROM sources WHERE channel_id=? AND run_id=? AND id=?)',...this.scoped(scope),...this.scoped(scope),source.id);
    } else if(this.repository.getEntity(scope,source.id))throw new StorageError('conflict','Source ID is already used by an entity.');
    const {text:_text,...metadata}=source;
    this.db.run(`INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,run_id,id) DO UPDATE SET event_id=excluded.event_id,revision=excluded.revision,kind=excluded.kind,start_ms=excluded.start_ms,end_ms=excluded.end_ms,actor_id=excluded.actor_id,external_message_id=excluded.external_message_id,status=excluded.status,text=excluded.text,metadata=excluded.metadata`,...this.scoped(scope),source.id,source.sessionId,eventId,source.revision,source.kind,source.startMs,source.endMs,source.actorId,source.externalMessageId,source.status,source.status==='deleted' ? null : source.text,json(metadata,32768));
    if(source.status==='deleted')this.db.run('UPDATE events SET payload=NULL WHERE channel_id=? AND run_id=? AND id=?',...this.scoped(scope),eventId);
  }
  private nodes(scope:Scope,state:DomainState,nodes:DerivedNode[],ownerAction:boolean) {
    const final=[...new Map(nodes.map(node=>[node.id,node])).values()];
    for(const node of final){
      integer(node.revision);const old=this.repository.getEntity(scope,node.id);
      if(old && old.sessionId!==state.session.id)throw new StorageError('inaccessible','Entity belongs to another session.');
      if(this.repository.getSource(scope,node.id))throw new StorageError('conflict','Entity ID is already used by a source.');
      const body=node.active ? node.body : null,ownerRevision=state.ownerRevisions[node.id] ?? old?.ownerRevision ?? 0,ownerLocked=state.ownerLocks.includes(node.id) || old?.ownerLocked || false;
      if(old){
        if(node.active && old.status!=='active')throw new StorageError('conflict','A hidden entity cannot be restored.');
        if(node.active && (node.revision<old.revision || node.revision>old.revision+1))throw new StorageError('conflict','Entity revision changed.');
        if(node.active && node.revision===old.revision && canonical(old.body)!==canonical(body))throw new StorageError('conflict','Entity content changed without a revision.');
        if(old.ownerLocked && node.active && canonical(old.body)!==canonical(body) && !ownerAction)throw new StorageError('conflict','Owner wording is locked.');
        if(ownerRevision<old.ownerRevision || ownerRevision>old.ownerRevision+1)throw new StorageError('conflict','Owner revision changed.');
        if(ownerRevision>old.ownerRevision){
          this.db.run("UPDATE publication_candidates SET status='invalid',body=NULL WHERE channel_id=? AND run_id=? AND entity_id=?",...this.scoped(scope),node.id);
          this.db.run('DELETE FROM public_pointers WHERE channel_id=? AND run_id=? AND entity_id=?',...this.scoped(scope),node.id);
        }
      }
      if(node.kind==='lore' && node.active){const lore=body as {term?:string;aliases?:string[]};if([lore.term,...lore.aliases ?? []].some(term=>term && this.repository.isTermBlocked(scope,state.session.id,term)))throw new StorageError('conflict','This lore term is blocked.');}
      const pinned=node.kind==='chapter' ? Boolean((body as {pinned?:boolean}|null)?.pinned) : old?.pinned ?? false;
      this.db.run(`INSERT INTO entities(channel_id,run_id,id,session_id,kind,revision,owner_revision,owner_locked,pinned,status,body,start_ms,end_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(channel_id,run_id,id) DO UPDATE SET revision=MAX(entities.revision,excluded.revision),owner_revision=excluded.owner_revision,owner_locked=excluded.owner_locked,pinned=excluded.pinned,status=excluded.status,body=excluded.body,start_ms=excluded.start_ms,end_ms=excluded.end_ms`,...this.scoped(scope),node.id,state.session.id,node.kind,node.revision,ownerRevision,Number(ownerLocked),Number(pinned),node.active ? 'active' : 'hidden',node.active ? json(body) : null,node.startMs,node.endMs);
      if(!node.active)this.db.run('DELETE FROM public_pointers WHERE channel_id=? AND run_id=? AND entity_id=?',...this.scoped(scope),node.id);
    }
    for(const node of final)if(node.active){this.db.run('DELETE FROM dependencies WHERE channel_id=? AND run_id=? AND child_id=?',...this.scoped(scope),node.id);this.edges(scope,node.id,node.supports,'supports');this.edges(scope,node.id,node.exposedTo,'exposed_to');}
  }
  private candidate(scope:Scope,sessionId:string,candidate:StoryCandidate) {
    const entity=this.repository.getEntity(scope,candidate.entityId),session=this.repository.getSession(scope,sessionId);
    if(!entity || entity.sessionId!==sessionId || entity.status!=='active' || entity.ownerRevision!==candidate.ownerRevision || candidate.chapter.sessionId!==sessionId || !ChapterSchema.safeParse(candidate.chapter).success)throw new StorageError('conflict','Candidate entity or owner revision changed.');
    const old=this.db.get('SELECT * FROM publication_candidates WHERE channel_id=? AND run_id=? AND id=?',...this.scoped(scope),candidate.id);
    if(candidate.privacyEpoch!==session.privacyEpoch && !(old?.status==='published' && candidate.status==='published'))throw new StorageError('conflict','Candidate privacy epoch changed.');
    if(!candidate.inputRefs.every(ref=>this.activeRef(scope,ref)))throw new StorageError('conflict','Candidate context changed.');
    if(old){
      const previous=old.body ? JSON.parse(String(old.body)) as StoryCandidate : null;
      if(!previous || previous.entityId!==candidate.entityId || previous.revision!==candidate.revision || previous.ownerRevision!==candidate.ownerRevision || previous.privacyEpoch!==candidate.privacyEpoch || canonical(previous.inputRefs)!==canonical(candidate.inputRefs) || previous.chapter.title!==candidate.chapter.title || previous.chapter.summary!==candidate.chapter.summary)throw new StorageError('conflict','Immutable candidate content changed.');
    } else {
      const count=this.db.get("SELECT COUNT(*) AS n FROM publication_candidates WHERE channel_id=? AND run_id=? AND entity_id=? AND status='pending'",...this.scoped(scope),candidate.entityId)!;
      if(Number(count.n)>=4)throw new StorageError('capacity','Candidate queue is full.');
    }
    if(candidate.status==='published' && (!safetyAllowsPublication(candidate.safety) || candidate.eligibleAtMs>this.now()))throw new StorageError('conflict','Candidate is not eligible for publication.');
    this.db.run(`INSERT INTO publication_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,run_id,id) DO UPDATE SET status=excluded.status,safe=excluded.safe,body=excluded.body`,...this.scoped(scope),candidate.id,sessionId,candidate.entityId,candidate.revision,candidate.ownerRevision,candidate.privacyEpoch,candidate.eligibleAtMs,candidate.status==='rejected' ? 'invalid' : candidate.status,Number(safetyAllowsPublication(candidate.safety)),json(candidate));
    this.edges(scope,candidate.id,candidate.inputRefs,'exposed_to');
    if(candidate.status==='published')this.db.run('INSERT INTO public_pointers VALUES(?,?,?,?) ON CONFLICT(channel_id,run_id,entity_id) DO UPDATE SET candidate_id=excluded.candidate_id',...this.scoped(scope),candidate.entityId,candidate.id);
  }
  private generation(scope:Scope,sessionId:string,request:GenerationRequest) {
    const ticket=request.ticket,session=this.repository.getSession(scope,sessionId),entity=this.repository.getEntity(scope,request.entityId);
    if(!GenerationTicketSchema.safeParse(ticket).success || ticket.channelId!==scope.channelId || ticket.runId!==scope.runId || ticket.sessionId!==sessionId || ticket.privacyEpoch!==session.privacyEpoch)throw new StorageError('conflict','Generation ticket scope or epoch changed.');
    if(entity ? entity.sessionId!==sessionId || entity.status!=='active' || entity.revision!==ticket.baseEntityRevision || entity.ownerLocked || entity.ownerRevision!==(ticket.ownerEditRevision ?? 0) : ticket.baseEntityRevision!==0)throw new StorageError('conflict','Generation target changed.');
    const old=this.db.get('SELECT ticket FROM generation_jobs WHERE channel_id=? AND run_id=? AND id=?',...this.scoped(scope),ticket.jobId);
    if(old){if(canonical(JSON.parse(String(old.ticket)))!==canonical(ticket))throw new StorageError('conflict','Generation ID was reused.');return;}
    this.edges(scope,ticket.jobId,ticket.inputRefs,'exposed_to');
    this.db.run("INSERT INTO generation_jobs VALUES(?,?,?,?,?,?,'registered')",...this.scoped(scope),ticket.jobId,sessionId,request.entityId,json(ticket));
    for(const ref of ticket.inputRefs)this.db.run('INSERT INTO generation_inputs VALUES(?,?,?,?,?)',...this.scoped(scope),ticket.jobId,ref.id,ref.revision);
    this.repository.enqueueJob(scope,{id:ticket.jobId,sessionId,kind:'story',businessKey:`generation:${ticket.jobId}`,payload:{request},dependencyRefs:ticket.inputRefs});
  }
  apply(scope:Scope,sessionId:string,input:DomainCommitInput):DomainCommitResult {
    const supplied=input.event,event:EventEnvelope<unknown>=supplied ?? {...scope,schemaVersion:1,eventId:randomUUID(),externalId:input.idempotencyKey ?? randomUUID(),origin:scope.runId==='live' ? 'owner' : 'replay',kind:'domain.transition',occurredAt:new Date(this.now()).toISOString(),receivedAt:new Date(this.now()).toISOString(),sessionId,sessionOffsetMs:null,payload:input.requestBody ?? {}};
    if(!EventEnvelopeSchema.safeParse(event).success || event.channelId!==scope.channelId || event.runId!==scope.runId || event.sessionId!==sessionId)throw new StorageError('invalid_input','Domain event does not match its scope.');
    const mutationKey=input.idempotencyKey ?? `event:${hash([event.origin,event.externalId])}`,requestBody=input.requestBody ?? {sessionId,kind:event.kind,origin:event.origin,payload:event.payload};
    return this.db.transaction(()=>{
      const replay=this.repository.getDomainMutation(scope,mutationKey,requestBody);
      if(replay){if(replay.kind!=='domain' || replay.sessionId!==sessionId)throw new StorageError('conflict','Mutation belongs to another operation.');return {applied:false,duplicate:true,revision:replay.revision,privacyEpoch:replay.privacyEpoch!,...(replay.receipt ? {receipt:replay.receipt} : {})};}
      const existingEvent=this.db.get('SELECT id,domain_processed,payload FROM events WHERE channel_id=? AND run_id=? AND origin=? AND external_id=?',...this.scoped(scope),event.origin,event.externalId);
      const before=this.checkpoint(scope,sessionId),sessionBefore=this.repository.getSession(scope,sessionId);
      if(existingEvent && (existingEvent.domain_processed || existingEvent.payload===null))return {applied:false,duplicate:true,revision:before.revision,privacyEpoch:before.privacyEpoch};
      if(before.revision!==input.expectedRevision || before.privacyEpoch!==input.expectedPrivacyEpoch)throw new StorageError('conflict','Domain checkpoint changed.');
      const eventPayload=event.payload && typeof event.payload==='object' ? event.payload as Record<string,unknown> : {},eventType=typeof eventPayload.type==='string' ? eventPayload.type : event.kind;
      const requestShape=input.requestBody as {operation?:unknown;input?:{blocked?:unknown}}|undefined;
      const explicitUnblock=eventType==='term.unblock' || requestShape?.operation==='lore.block' && requestShape.input?.blocked===false;
      const removedTerms=(before.checkpoint?.blockedTerms ?? (explicitUnblock ? this.repository.listBlockedTerms(scope,sessionId,{limit:500}) : [])).filter(term=>!input.transition.state.blockedTerms.includes(term));
      const removingBlock=removedTerms.length>0;
      if(input.expectedEntity){const entity=this.repository.getEntity(scope,input.expectedEntity.id),allowHidden=removingBlock && entity?.kind==='lore';if(!entity || entity.sessionId!==sessionId || (entity.status!=='active'&&!allowHidden) || entity.revision!==input.expectedEntity.revision)throw new StorageError('conflict','Entity revision changed.');}
      const state=structuredClone(input.transition.state),effects=input.transition.effects;
      if(state.session.id!==sessionId || state.session.channelId!==scope.channelId || state.session.runId!==scope.runId || state.channel.id!==scope.channelId || !SessionSchema.safeParse(state.session).success || !SettingsSchema.safeParse(state.settings).success || ![before.revision,before.revision+1].includes(state.revision))throw new StorageError('invalid_input','Domain checkpoint does not match its scope or revision.');
      if(state.sources.length>500 || state.chapters.length>300 || state.lore.length>50 || state.moments.length>200 || state.memory.length>64 || state.candidates.length>1200 || effects.length>5000)throw new StorageError('capacity','Domain checkpoint exceeds its bounds.');
      const eventId=existingEvent ? String(existingEvent.id) : event.eventId;
      const initialEventRefs=this.eventContext(scope,event,before.privacyEpoch);
      if(!existingEvent)this.repository.ingest(initialEventRefs===null ? {...event,payload:null} : event);
      else if(initialEventRefs===null)this.db.run('UPDATE events SET payload=NULL WHERE channel_id=? AND run_id=? AND id=?',...this.scoped(scope),eventId);
      const sourceChanges=[...new Map(effects.filter(effect=>effect.type==='source.persist').map(effect=>[effect.source.id,effect.source])).values()];
      const receipts:InvalidationReceipt[]=[];
      for(const [index,effect] of effects.entries())if(effect.type==='privacy')receipts.push(this.repository.invalidate(scope,effect.target,{idempotencyKey:`domain-privacy:${hash([mutationKey,index])}`,reason:'privacy'}));
      const clearBefore=this.repository.controlGet<number>(scope,`chat-clear:${sessionId}`),clearChanged=state.chatClearThroughMs!==null && (clearBefore===null || state.chatClearThroughMs>clearBefore);
      const corrections=sourceChanges.filter(source=>{const old=this.repository.getSource(scope,source.id);return old && source.status!=='deleted' && source.revision>old.revision && ['allowed','redacted'].includes(old.moderation);}).map(source=>source.id);
      if(corrections.length || clearChanged)receipts.push(this.repository.invalidateSourceVersions(scope,sessionId,corrections,{idempotencyKey:`domain-revision:${hash(mutationKey)}`,reason:'source_revision'}));
      if(clearChanged)this.repository.controlPut(scope,`chat-clear:${sessionId}`,state.chatClearThroughMs);
      const currentSession=this.repository.getSession(scope,sessionId);
      if(state.session.privacyEpoch!==currentSession.privacyEpoch)throw new StorageError('conflict','Domain privacy epoch does not match its persisted fences.');
      const oldBans=before.checkpoint?.bannedActors ?? [];
      for(const actor of state.bannedActors)this.db.run('INSERT INTO channel_bans VALUES(?,?,?) ON CONFLICT DO NOTHING',...this.scoped(scope),actor);
      for(const actor of oldBans)if(!state.bannedActors.includes(actor))this.db.run('DELETE FROM channel_bans WHERE channel_id=? AND run_id=? AND actor_id=?',...this.scoped(scope),actor);
      if(['unban','channel.unban'].includes(eventType) && typeof eventPayload.actorId==='string')this.db.run('DELETE FROM channel_bans WHERE channel_id=? AND run_id=? AND actor_id=?',...this.scoped(scope),eventPayload.actorId);
      for(const term of removedTerms)this.repository.unblockTerm(scope,term);
      for(const source of sourceChanges){if(source.sessionId!==sessionId)throw new StorageError('inaccessible','Source belongs to another session.');this.source(scope,eventId,source);}
      const payload=event.payload && typeof event.payload==='object' ? event.payload as {type?:unknown} : {};
      const ownerAction=event.kind.startsWith('owner.') || event.kind.startsWith('lore.') || typeof payload.type==='string' && (payload.type.startsWith('owner.') || payload.type.startsWith('lore.')) || sourceChanges.some(source=>source.kind==='owner_statement') || Object.entries(state.ownerRevisions).some(([id,revision])=>revision>(before.checkpoint?.ownerRevisions[id] ?? 0));
      this.nodes(scope,state,effects.filter(effect=>effect.type==='entity.upsert').map(effect=>effect.node),ownerAction);
      for(const lore of state.lore)if(lore.explanation==='' && ['blocked','observed'].includes(lore.status)){
        const entity=this.repository.getEntity(scope,lore.id);
        if(entity?.kind==='lore' && entity.status!=='active'){
          if(lore.revision<entity.revision || lore.revision>entity.revision+1)throw new StorageError('conflict','Lore control revision changed.');
          this.db.run('UPDATE entities SET revision=? WHERE channel_id=? AND run_id=? AND id=?',lore.revision,...this.scoped(scope),lore.id);
          this.repository.controlPut(scope,`blocked-lore:${lore.id}`,{id:lore.id,sessionId,revision:lore.revision,term:lore.term,aliases:lore.aliases,firstSeenMs:lore.firstSeenMs,status:lore.status});
        }
      }
      const oldSettings=this.repository.getSettings(scope);
      if(input.settingsPatch){const settings=this.repository.updateSettings(scope,input.settingsPatch.baseRevision,input.settingsPatch.patch);if(canonical({...state.settings,revision:settings.revision})!==canonical(settings))throw new StorageError('conflict','Settings and domain transition disagree.');state.settings=settings;}
      else if(canonical({...state.settings,revision:oldSettings.revision})!==canonical(oldSettings))state.settings=this.repository.updateSettings(scope,oldSettings.revision,state.settings);
      else state.settings=oldSettings;
      if(state.settings.listeningPaused && !oldSettings.listeningPaused){this.db.run('UPDATE capture_leases SET epoch=MAX(epoch+1,?),expires_at_ms=0,actor_id=NULL WHERE channel_id=? AND run_id=? AND session_id=?',state.captureEpoch,...this.scoped(scope),sessionId);this.db.run("UPDATE jobs SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND session_id=? AND kind='stt' AND state IN ('queued','running')",...this.scoped(scope),sessionId);}
      this.repository.updateSession(scope,sessionId,{title:state.session.title,category:state.session.category,status:state.session.status,endedAt:state.session.endedAt,metadataMaxDependencyEndMs:state.session.metadataMaxDependencyEndMs,finalizedAt:state.session.finalizedAt,finalSnapshotAckAt:state.session.finalSnapshotAckAt});
      state.session.publicationRevision=Math.max(currentSession.publicationRevision,state.session.publicationRevision);
      this.db.run('UPDATE sessions SET publication_revision=? WHERE channel_id=? AND run_id=? AND id=?',state.session.publicationRevision,...this.scoped(scope),sessionId);
      const keep=new Set(state.candidates.map(candidate=>candidate.id));
      for(const row of this.db.all("SELECT id FROM publication_candidates WHERE channel_id=? AND run_id=? AND session_id=? AND status='pending'",...this.scoped(scope),sessionId))if(!keep.has(String(row.id)))this.db.run("UPDATE publication_candidates SET status='superseded',body=NULL WHERE channel_id=? AND run_id=? AND id=?",...this.scoped(scope),String(row.id));
      for(const candidate of state.candidates)this.candidate(scope,sessionId,candidate);
      const publications=effects.filter(effect=>effect.type==='publication'),lastPublication=publications.at(-1),priorityPublication=publications.some(effect=>effect.priority);
      if(lastPublication && priorityPublication){
        if(!receipts.length){this.db.run('UPDATE channels SET privacy_revision=privacy_revision+1 WHERE channel_id=? AND run_id=?',...this.scoped(scope));this.db.run('UPDATE publication_sync SET pending_privacy=1 WHERE channel_id=? AND run_id=?',...this.scoped(scope));}
        // One final projection represents this atomic transition. Retract intents created
        // by the privacy helper are superseded here, while standalone privacy keeps them.
        this.db.run("UPDATE outbox SET state='cancelled',payload=NULL,frozen_body=NULL,frozen_hash=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND session_id=? AND kind IN ('publish','retract','export_manifest') AND state IN ('queued','running')",...this.scoped(scope),sessionId);
      }
      for(const effect of effects){
        if(effect.type==='generation.request')this.generation(scope,sessionId,effect.request);
        if(effect.type==='owner.review.request'){
          const id=`owner-review:${hash([scope,sessionId,effect.entityId,effect.ownerRevision ?? 0,effect.sourceId,effect.sourceRevision,effect.privacyEpoch]).slice(0,40)}`;
          if(effect.privacyEpoch!==state.session.privacyEpoch)throw new StorageError('conflict','Owner review epoch changed.');
          this.repository.enqueueJob(scope,{id,sessionId,kind:'owner.review',businessKey:id,payload:effect,dependencyRefs:effect.dependencyRefs});
        }
        if(effect.type==='cancel')for(const id of effect.ids){for(const table of ['jobs','outbox'])this.db.run(`UPDATE ${table} SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND id=? AND state IN ('queued','running')`,...this.scoped(scope),id);this.db.run("UPDATE generation_jobs SET status='cancelled' WHERE channel_id=? AND run_id=? AND id=? AND status='registered'",...this.scoped(scope),id);}
        if(effect.type==='publication' && effect===lastPublication){
          const snapshot={...effect.snapshot,privacyEpoch:state.session.privacyEpoch,revision:state.session.publicationRevision};
          if(!PublicSnapshotSchema.safeParse(snapshot).success || snapshot.session.id!==sessionId || snapshot.channel.id!==scope.channelId)throw new StorageError('invalid_input','Publication does not match the public contract.');
          const refs=[...snapshot.chapters,...snapshot.lore,...snapshot.moments].flatMap(item=>{const entity=this.repository.getEntity(scope,item.id);return entity ? [{id:entity.id,revision:entity.revision}] : [];});
          this.repository.preparePublication(scope,{sessionId,kind:priorityPublication ? 'retract' : 'publish',businessKey:`domain-publication:${sessionId}:${snapshot.revision}:${hash(snapshot).slice(0,16)}`,payload:{snapshot,final:effect.final,affectedSessionIds:receipts.length ? this.db.all('SELECT id FROM sessions WHERE channel_id=? AND run_id=? AND privacy_epoch>0',...this.scoped(scope)).map(row=>String(row.id)) : [sessionId],affectedIds:[...new Set(receipts.flatMap(receipt=>receipt.hiddenEntityIds))]},priority:priorityPublication ? 1000 : 0,dependencyRefs:refs});
          state.published=snapshot;
        }
        if(effect.type==='clip.request')this.repository.enqueueJob(scope,{id:`clip-intent:${effect.moment.id}:${effect.privacyEpoch}`,sessionId,kind:'twitch.clip.intent',businessKey:`clip-intent:${effect.moment.id}:${effect.privacyEpoch}`,payload:{moment:effect.moment,privacyEpoch:effect.privacyEpoch},dependencyRefs:effect.moment.dependencyRefs});
        if(effect.type==='clip.cleanup')this.repository.enqueueOutbox(scope,{sessionId,kind:'clip_cleanup',businessKey:`clip-cleanup:${effect.clipId}`,payload:{clipId:effect.clipId,manageUrl:effect.manageUrl,cleanupOnly:true},priority:1000});
        if(effect.type==='playback.prepare' || effect.type==='playback.start' || effect.type==='playback.cancel')this.repository.enqueueOutbox(scope,{id:`${effect.type}:${effect.playback.id}`,sessionId,kind:'playback',businessKey:`${effect.type}:${effect.playback.id}`,payload:{action:effect.type.slice('playback.'.length),playback:effect.playback},priority:effect.type==='playback.cancel' ? 1000 : 0,dependencyRefs:effect.playback.plan?.dependencyRefs ?? []});
      }
      if(before.checkpoint?.pendingGeneration && !state.pendingGeneration)this.db.run("UPDATE generation_jobs SET status='committed' WHERE channel_id=? AND run_id=? AND id=? AND status='registered'",...this.scoped(scope),before.checkpoint.pendingGeneration.ticket.jobId);
      if(receipts.length){const last=receipts.at(-1)!;state.lastReceipt={...last,revision:state.session.publicationRevision,hiddenEntityIds:[...new Set(receipts.flatMap(receipt=>receipt.hiddenEntityIds))],externalClipActions:receipts.flatMap(receipt=>receipt.externalClipActions)};}
      const eventRefs=[...new Map([...(initialEventRefs ?? []).filter(ref=>this.activeRef(scope,ref)),...effects.flatMap(effect=>effect.type==='entity.upsert'&&effect.node.active ? [{id:effect.node.id,revision:effect.node.revision}] : effect.type==='source.persist'&&effect.source.status==='active' ? [{id:effect.source.id,revision:effect.source.revision}] : [])].map(ref=>[ref.id,ref])).values()];
      this.edges(scope,eventId,eventRefs,'exposed_to');
      // Validate persisted source/node versions again before retaining a sensitive checkpoint.
      const savedSources=new Map(this.db.all('SELECT id,revision,text,status FROM sources WHERE channel_id=? AND run_id=? AND id IN (SELECT value FROM json_each(?))',...this.scoped(scope),json(state.sources.map(source=>source.id))).map(row=>[String(row.id),row]));
      for(const source of state.sources){const saved=savedSources.get(source.id);if(saved && (source.revision!==Number(saved.revision) || source.text!==saved.text || source.status!==saved.status))throw new StorageError('conflict','Checkpoint contains stale source content.');}
      // Standalone invalidation inside this transaction may advance the capture
      // lease beyond the reducer's epoch (for example, Forget the whole session).
      const capture=this.db.get('SELECT epoch FROM capture_leases WHERE channel_id=? AND run_id=? AND session_id=?',...this.scoped(scope),sessionId);
      state.captureEpoch=Number(capture?.epoch ?? state.captureEpoch);
      const body=json(state,CHECKPOINT_BYTES);
      this.db.run('INSERT INTO domain_checkpoints VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id,run_id,session_id) DO UPDATE SET revision=excluded.revision,privacy_epoch=excluded.privacy_epoch,body=excluded.body,updated_at_ms=excluded.updated_at_ms',...this.scoped(scope),sessionId,state.revision,state.session.privacyEpoch,body,this.now());
      this.db.run('UPDATE events SET domain_processed=1 WHERE channel_id=? AND run_id=? AND id=?',...this.scoped(scope),eventId);
      const receipt=receipts.length ? state.lastReceipt! : undefined,result:DomainCommitResult={applied:state.revision!==before.revision || effects.length>0,duplicate:false,revision:state.revision,privacyEpoch:state.session.privacyEpoch,checkpoint:state,...(receipt ? {receipt} : {})};
      this.db.run('INSERT INTO domain_mutations VALUES(?,?,?,?,?,?,?,?,?)',...this.scoped(scope),sessionId,mutationKey,hash(requestBody),eventId,state.revision,state.session.privacyEpoch,receipt ? json(receipt) : null);
      this.repository.recordDomainMutation(scope,mutationKey,requestBody,{kind:'domain',sessionId,revision:state.revision,privacyEpoch:state.session.privacyEpoch,...(receipt ? {receipt} : {})});
      return result;
    });
  }
}
