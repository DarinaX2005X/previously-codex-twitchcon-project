import { createHash, randomUUID } from 'node:crypto';
import type { Scope, Source, Session, Settings, EventEnvelope, VersionRef, GenerationTicket, StoryPatch, PrivacyTarget, InvalidationReceipt, CommitResult } from '../../shared/contracts/index.js';
import { SourceSchema, EventEnvelopeSchema, GenerationTicketSchema, StoryPatchSchema, PrivacyTargetSchema } from '../../shared/contracts/index.js';
import { StorageDatabase, StorageError, integer, json } from './database.js';
import { ControlPersistence } from './control.js';
import type { MutationReceipt } from './domain-types.js';
import type { DomainCommitInput, DomainCommitResult, DomainHydration, DomainCheckpoint } from './domain-types.js';
import { DomainPersistence } from './domain.js';
import { HistoryPersistence } from './history.js';
import type {EntityGraph,EntityHistoryCursor,EntityHistoryPage} from './domain-types.js';

export type WorkInput = {id?: string; sessionId: string; kind: string; businessKey: string; payload: unknown; priority?: number; nextAtMs?: number; dependencyRefs?: VersionRef[]};
export type WorkLease = {id: string; sessionId: string; kind: string; payload: unknown; privacyEpoch: number; leaseToken: string; leaseUntilMs: number; attempts: number; publishSeq: number|null;frozenPublication?:{body:string;bodyHash:string}};
export type EntityInput = {id: string; sessionId: string; kind: 'claim'|'relation'|'chapter'|'current_state'|'presentation'|'lore'|'moment'|'media'|'playback'|'provider_cache'|'export'; body: unknown; refs: VersionRef[]; startMs?: number; endMs?: number};
export type PrivacyOptions = {idempotencyKey: string; reason: string};
export type AcceptedAudio={sessionId:string;actorId:string;leaseEpoch:number;captureEpoch:number;sequence:number;sha256:string;startMs:number;endMs:number;sampleRate:number;rawPath:string;receivedAtMs:number;privacyEpoch:number};
export const normalizeBlockedTerm=(term:string):string=>term.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export class SqliteRepository {
  private readonly controls:ControlPersistence;
  private readonly domain:DomainPersistence;
  getEntityGraph(scope:Scope,sessionId:string,id:string):EntityGraph|null{return new HistoryPersistence(this.db,this).graph(scope,sessionId,id);}
  listEntityHistory(scope:Scope,sessionId:string,options:{kind:'chapter'|'lore';limit?:number;cursor?:EntityHistoryCursor}):EntityHistoryPage{return new HistoryPersistence(this.db,this).page(scope,sessionId,options);}
  findGenerationHistory(scope:Scope,sessionId:string,options:{text:string;limit?:number}):string[]{return new HistoryPersistence(this.db,this).generation(scope,sessionId,options);}
  constructor(private readonly db: StorageDatabase, private readonly now: () => number) {this.controls=new ControlPersistence(db,now);this.domain=new DomainPersistence(db,now,this);}
  getDomainCheckpoint(scope:Scope,sessionId:string):DomainCheckpoint{return this.domain.checkpoint(scope,sessionId);}
  getDomainHydration(scope:Scope,sessionId:string,options?:{checkpointOnly?:boolean}):DomainHydration{return this.domain.hydration(scope,sessionId,options);}
  applyDomainTransition(scope:Scope,sessionId:string,input:DomainCommitInput):DomainCommitResult{return this.domain.apply(scope,sessionId,input);}
  /** An intake batch stays atomic; domain transitions still keep their own savepoint fences. */
  runDomainBatch<T>(action:()=>T):T{return this.db.transaction(action);}
  controlGet<T=unknown>(scope:Scope,key:string):T|null{return this.controls.get<T>(scope,key);}
  controlPut(scope:Scope,key:string,value:unknown,expiresAtMs?:number):void{this.controls.put(scope,key,value,expiresAtMs);}
  controlDelete(scope:Scope,key:string):boolean{return this.controls.delete(scope,key);}
  controlTake<T=unknown>(scope:Scope,key:string):T|null{return this.controls.take<T>(scope,key);}
  controlClaim(scope:Scope,key:string,value:unknown,expiresAtMs?:number):boolean{return this.controls.claim(scope,key,value,expiresAtMs);}
  controlUpdate<T>(scope:Scope,key:string,updater:(current:T|null)=>T|null,expiresAtMs?:number):T|null{return this.controls.update(scope,key,updater,expiresAtMs);}
  runIdempotentControl<T>(scope:Scope,key:string,requestBody:unknown,action:()=>T):T {
    return this.db.transaction(()=>{
      if(!key || key.length>256)throw new StorageError('invalid_input','Control mutation key exceeds its limit.');
      const storageKey=`control-receipt:${digest(key)}`,requestHash=digest(requestBody),previous=this.controlGet<{requestHash:string;result:T}>(scope,storageKey);
      if(previous){if(previous.requestHash!==requestHash)throw new StorageError('conflict','Idempotency key was already used for a different request.');return previous.result;}
      const result=action();if(result instanceof Promise || (result && typeof result==='object' && 'then' in result))throw new StorageError('invalid_input','Control mutations must be synchronous.');
      this.controlPut(scope,storageKey,{requestHash,result});return result;
    });
  }
  getSettings(scope:Scope):Settings{return this.controls.settings(scope);}
  updateSettings(scope:Scope,baseRevision:number,patch:Partial<Omit<Settings,'revision'>>,options?:{idempotencyKey:string;requestBody:unknown}):Settings {
    return this.db.transaction(()=>{
      if(options) {
        const old=this.getDomainMutation(scope,options.idempotencyKey,options.requestBody);
        if(old){if(old.kind!=='settings')throw new StorageError('conflict','Mutation key was used for another operation.');return this.getSettings(scope);}
      }
      const settings=this.controls.updateSettings(scope,baseRevision,patch);
      if(options)this.recordDomainMutation(scope,options.idempotencyKey,options.requestBody,{kind:'settings',sessionId:null,revision:settings.revision});
      return settings;
    });
  }
  getDomainMutation(scope:Scope,key:string,requestBody:unknown):MutationReceipt|null {
    if(!key || key.length>160)throw new StorageError('invalid_input','Mutation key exceeds its limit.');
    const marker=this.controlGet<{requestHash:string;result:MutationReceipt}>(scope,`mutation:${digest(key)}`);
    if(!marker)return null;
    if(marker.requestHash!==digest(requestBody))throw new StorageError('conflict','Idempotency key was already used for a different request.');
    return marker.result;
  }
  recordDomainMutation(scope:Scope,key:string,requestBody:unknown,result:MutationReceipt):void {
    const previous=this.getDomainMutation(scope,key,requestBody);
    if(previous)return;
    this.controlPut(scope,`mutation:${digest(key)}`,{requestHash:digest(requestBody),result});
  }
  private scope(scope: Scope) { return [scope.channelId, scope.runId] as const; }
  private session(scope: Scope, id: string) {
    const row = this.db.get('SELECT * FROM sessions WHERE channel_id=? AND run_id=? AND id=?', ...this.scope(scope), id);
    if (!row) throw new StorageError('inaccessible', 'Session is unavailable in this scope.');
    return row;
  }
  ensureChannel(scope: Scope, login: string): void {
    this.db.transaction(() => {
      this.db.run('INSERT INTO channels(channel_id,run_id,login) VALUES(?,?,?) ON CONFLICT DO NOTHING', ...this.scope(scope), login);
      this.db.run('INSERT INTO publication_sync(channel_id,run_id) VALUES(?,?) ON CONFLICT DO NOTHING', ...this.scope(scope));
    });
  }
  createSession(scope: Scope, input: {id: string; startedAt: string; twitchStreamId?: string|null;title?:string;category?:string}) {
    return this.db.transaction(() => {
      if (input.twitchStreamId) {
        const existing = this.db.get('SELECT id FROM sessions WHERE channel_id=? AND run_id=? AND stream_id=?', ...this.scope(scope), input.twitchStreamId);
        if (existing) return {id: String(existing.id), created: false};
      }
      this.db.run('INSERT INTO sessions(channel_id,run_id,id,stream_id,started_at,title,category) VALUES(?,?,?,?,?,?,?)', ...this.scope(scope), input.id, input.twitchStreamId ?? null, input.startedAt,input.title ?? '',input.category ?? '');
      return {id: input.id, created: true};
    });
  }
  getSession(scope: Scope, id: string):Session {
    const row = this.session(scope,id);
    return {...scope,id: String(row.id),twitchStreamId:row.stream_id === null ? null : String(row.stream_id),title:String(row.title),category:String(row.category), startedAt: String(row.started_at), endedAt: row.ended_at === null ? null : String(row.ended_at), status: String(row.status) as Session['status'], privacyEpoch: Number(row.privacy_epoch), publicationRevision: Number(row.publication_revision),metadataMaxDependencyEndMs:Number(row.metadata_end_ms),finalizedAt:row.finalized_at === null ? null : String(row.finalized_at),finalSnapshotAckAt:row.final_snapshot_ack_at === null ? null : String(row.final_snapshot_ack_at)};
  }
  updateSession(scope:Scope,id:string,patch:Partial<Pick<Session,'title'|'category'|'status'|'endedAt'|'metadataMaxDependencyEndMs'|'finalizedAt'|'finalSnapshotAckAt'>>):Session {
    return this.db.transaction(()=>{
      const current=this.getSession(scope,id),next={...current,...patch};
      if (this.sessionForgotten(scope,id) && (next.title || next.category || next.metadataMaxDependencyEndMs)) throw new StorageError('conflict','Forgotten session metadata cannot be restored.');
      const metadataFence=this.controlGet<number>(scope,`metadata-fence:${id}`);
      if(metadataFence!==null && (next.title || next.category) && next.metadataMaxDependencyEndMs<=metadataFence)throw new StorageError('conflict','Forgotten channel metadata requires a newer observation.');
      if ((current.status==='finalized' && next.status!=='finalized') || (current.status==='closing' && next.status==='live')) throw new StorageError('conflict','A closed session cannot be reopened.');
      if (next.status==='finalized' && (!next.endedAt || !next.finalizedAt)) throw new StorageError('invalid_input','Finalization requires end and finalization times.');
      if (next.title.length>200 || next.category.length>100) throw new StorageError('invalid_input','Session metadata exceeds its limit.');
      this.db.run('UPDATE sessions SET title=?,category=?,status=?,ended_at=?,metadata_end_ms=?,finalized_at=?,final_snapshot_ack_at=? WHERE channel_id=? AND run_id=? AND id=?',next.title,next.category,next.status,next.endedAt,integer(next.metadataMaxDependencyEndMs),next.finalizedAt,next.finalSnapshotAckAt,...this.scope(scope),id);
      return next;
    });
  }
  listSessions(scope: Scope, options: {limit?: number; cursor?: {startedAt: string; id: string}} = {}) {
    const limit = Math.min(integer(options.limit ?? 50, 1),50), cursor = options.cursor;
    const rows = this.db.all(`SELECT id,started_at,ended_at,status FROM sessions WHERE channel_id=? AND run_id=?
      ${cursor ? 'AND (started_at>? OR (started_at=? AND id>?))' : ''} ORDER BY started_at,id LIMIT ?`,
    ...this.scope(scope), ...(cursor ? [cursor.startedAt,cursor.startedAt,cursor.id] : []), limit);
    return rows.map(row => this.getSession(scope,String(row.id)));
  }
  getActiveSession(scope:Scope):Session|null {
    const row=this.db.get("SELECT id FROM sessions WHERE channel_id=? AND run_id=? AND status IN ('live','closing') ORDER BY started_at DESC,id DESC LIMIT 1",...this.scope(scope));
    return row ? this.getSession(scope,String(row.id)) : null;
  }
  listOpenSessions(scope:Scope,limit=100):Session[] {
    return this.db.all("SELECT id FROM sessions WHERE channel_id=? AND run_id=? AND status IN ('live','closing') ORDER BY started_at DESC,id DESC LIMIT ?",...this.scope(scope),Math.min(integer(limit,1),100)).map(row=>this.getSession(scope,String(row.id)));
  }
  private ref(scope: Scope, ref: VersionRef): boolean {
    const source = this.db.get('SELECT revision,status FROM sources WHERE channel_id=? AND run_id=? AND id=?', ...this.scope(scope),ref.id);
    const entity = source ?? this.db.get('SELECT revision,status FROM entities WHERE channel_id=? AND run_id=? AND id=?',...this.scope(scope),ref.id);
    return !!entity && entity.status === 'active' && Number(entity.revision) === ref.revision;
  }
  private edges(scope: Scope, childId: string, refs: VersionRef[], kind: 'supports'|'exposed_to'): void {
    for (const ref of refs) {
      if (!this.ref(scope,ref)) throw new StorageError('conflict','A dependency is unavailable or changed.');
      this.db.run('INSERT INTO dependencies VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',...this.scope(scope),ref.id,ref.revision,childId,kind);
    }
  }
  private tombstoned(scope: Scope, source: Source): boolean {
    return !!this.db.get(`SELECT 1 FROM source_tombstones WHERE channel_id=? AND run_id=? AND session_id=? AND (
      kind='session' OR (kind='source' AND target_id=?) OR (kind='message' AND target_id=?) OR
      (kind='user' AND target_id=? AND to_ms>=?) OR (kind='interval' AND ranges_overlap(from_ms,to_ms,?,?))) LIMIT 1`,
    ...this.scope(scope), source.sessionId, source.id, source.externalMessageId, source.actorId,source.startMs,source.startMs,source.endMs);
  }
  private sessionForgotten(scope:Scope,sessionId:string):boolean {
    return !!this.db.get("SELECT 1 FROM source_tombstones WHERE channel_id=? AND run_id=? AND session_id=? AND kind='session' LIMIT 1",...this.scope(scope),sessionId);
  }
  ingest(event: EventEnvelope<unknown>, effects: {sources?: Source[]; jobs?: WorkInput[]; outbox?: WorkInput[]} = {}): {accepted: boolean; eventId: string} {
    if (!EventEnvelopeSchema.safeParse(event).success || effects.sources?.some(source=>!SourceSchema.safeParse(source).success)) throw new StorageError('invalid_input','Evidence does not match the shared contract.');
    return this.db.transaction(() => {
      const old = this.db.get('SELECT id FROM events WHERE channel_id=? AND run_id=? AND origin=? AND external_id=?',...this.scope(event),event.origin,event.externalId);
      if (old) return {accepted:false,eventId:String(old.id)};
      if (event.sessionId) this.session(event,event.sessionId);
      this.db.run('INSERT INTO events(channel_id,run_id,id,session_id,external_id,origin,kind,occurred_at,received_at,offset_ms,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)',...this.scope(event),event.eventId,event.sessionId,event.externalId,event.origin,event.kind,event.occurredAt,event.receivedAt,event.sessionOffsetMs,event.payload===null ? null : json(event.payload));
      let redacted = event.sessionId!==null && this.sessionForgotten(event,event.sessionId);
      for (const source of effects.sources ?? []) {
        if (source.channelId !== event.channelId || source.runId !== event.runId || source.sessionId !== event.sessionId) throw new StorageError('inaccessible','Source scope does not match its event.');
        redacted = this.insertSource(event,source) || redacted;
      }
      if (redacted) this.db.run('UPDATE events SET payload=NULL WHERE channel_id=? AND run_id=? AND id=?',...this.scope(event),event.eventId);
      // A delete-before-create event must not produce chat or clip effects.
      if (!redacted) {
        for (const job of effects.jobs ?? []) this.insertWork('jobs',event,job);
        for (const job of effects.outbox ?? []) this.insertWork('outbox',event,job);
      }
      return {accepted:true,eventId:event.eventId};
    });
  }
  private insertSource(event: EventEnvelope<unknown>, source: Source): boolean {
    integer(source.startMs); integer(source.endMs);
    if (source.endMs < source.startMs) throw new StorageError('invalid_input','Source time range is invalid.');
    const deleted = this.tombstoned(event,source) || source.status==='deleted' || source.status==='blocked';
    const {text: _text, ...metadata} = source;
    if (this.db.get('SELECT 1 FROM entities WHERE channel_id=? AND run_id=? AND id=?',...this.scope(event),source.id)) throw new StorageError('conflict','Source ID is already used by an entity.');
    this.db.run('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',...this.scope(event),source.id,source.sessionId,event.eventId,source.revision,source.kind,source.startMs,source.endMs,source.actorId,source.externalMessageId,deleted ? 'deleted' : source.status,deleted ? null : source.text,json(metadata,32768));
    return deleted;
  }
  getSource(scope: Scope,id: string): Source|null {
    const row = this.db.get('SELECT * FROM sources WHERE channel_id=? AND run_id=? AND id=?',...this.scope(scope),id);
    return row ? {...JSON.parse(String(row.metadata)),revision:Number(row.revision),status:row.status,text:row.text} as Source : null;
  }
  listSources(scope: Scope,sessionId: string,options: {limit?:number;cursor?:{startMs:number;id:string};fromMs?:number;toMs?:number} = {}): Source[] {
    this.session(scope,sessionId);
    const limit = Math.min(integer(options.limit ?? 100,1),500), cursor=options.cursor;
    const rows=this.db.all(`SELECT * FROM sources WHERE channel_id=? AND run_id=? AND session_id=? ${cursor ? 'AND (start_ms>? OR (start_ms=? AND id>?))' : ''} ${options.fromMs!==undefined ? 'AND end_ms>=?' : ''} ${options.toMs!==undefined ? 'AND start_ms<=?' : ''} ORDER BY start_ms,id LIMIT ?`,...this.scope(scope),sessionId,...(cursor ? [cursor.startMs,cursor.startMs,cursor.id] : []),...(options.fromMs!==undefined ? [integer(options.fromMs)] : []),...(options.toMs!==undefined ? [integer(options.toMs)] : []),limit);
    return rows.map(row=>({...JSON.parse(String(row.metadata)),revision:Number(row.revision),status:row.status,text:row.text} as Source));
  }
  saveEntity(scope: Scope,input: EntityInput): void {
    this.db.transaction(()=>this.insertEntity(scope,input));
  }
  private insertEntity(scope: Scope,input: EntityInput): void {
    this.session(scope,input.sessionId);
    if(this.sessionForgotten(scope,input.sessionId)) throw new StorageError('conflict','The session was forgotten.');
    if (input.kind==='lore' && this.loreTerms(input.body).some(term=>this.isTermBlocked(scope,input.sessionId,term))) throw new StorageError('conflict','This lore term is blocked.');
    if (this.db.get('SELECT 1 FROM sources WHERE channel_id=? AND run_id=? AND id=?',...this.scope(scope),input.id)) throw new StorageError('conflict','Entity ID is already used by a source.');
    this.db.run('INSERT INTO entities(channel_id,run_id,id,session_id,kind,body,start_ms,end_ms) VALUES(?,?,?,?,?,?,?,?)',...this.scope(scope),input.id,input.sessionId,input.kind,json(input.body),input.startMs ?? null,input.endMs ?? null);
    this.edges(scope,input.id,input.refs,'supports');
  }
  getEntity(scope:Scope,id:string) {
    const row=this.db.get('SELECT * FROM entities WHERE channel_id=? AND run_id=? AND id=?',...this.scope(scope),id);
    if (!row) return null;
    return {id:String(row.id),sessionId:String(row.session_id),kind:String(row.kind),revision:Number(row.revision),ownerRevision:Number(row.owner_revision),ownerLocked:Boolean(row.owner_locked),pinned:Boolean(row.pinned),status:String(row.status),body:row.body === null ? null : JSON.parse(String(row.body)) as unknown};
  }
  listEntities(scope:Scope,sessionId:string,options:{kind?:EntityInput['kind'];status?:'active'|'hidden';limit?:number;afterId?:string}={}) {
    this.session(scope,sessionId);
    const rows=this.db.all(`SELECT id FROM entities WHERE channel_id=? AND run_id=? AND session_id=? AND id>? ${options.kind ? 'AND kind=?' : ''} ${options.status ? 'AND status=?' : ''} ORDER BY id LIMIT ?`,...this.scope(scope),sessionId,options.afterId ?? '',...(options.kind ? [options.kind] : []),...(options.status ? [options.status] : []),Math.min(integer(options.limit ?? 100,1),500));
    return rows.map(row=>this.getEntity(scope,String(row.id))!);
  }
  private loreTerms(body:unknown):string[] {
    if (!body || typeof body!=='object') return [];
    const value=body as {term?:unknown;canonicalPhrase?:unknown;aliases?:unknown};
    return [value.term,value.canonicalPhrase,...(Array.isArray(value.aliases) ? value.aliases : [])].filter((term):term is string=>typeof term==='string').map(normalizeBlockedTerm);
  }
  isTermBlocked(scope:Scope,_sessionId:string,term:string):boolean {
    return !!this.db.get('SELECT 1 FROM blocked_terms WHERE channel_id=? AND run_id=? AND term=?',...this.scope(scope),normalizeBlockedTerm(term));
  }
  listBlockedTerms(scope:Scope,sessionId:string,options:{limit?:number;afterTerm?:string}={}):string[] {
    this.session(scope,sessionId);
    return this.db.all('SELECT term FROM blocked_terms WHERE channel_id=? AND run_id=? AND term>? ORDER BY term LIMIT ?',...this.scope(scope),options.afterTerm ?? '',Math.min(integer(options.limit ?? 100,1),500)).map(row=>String(row.term));
  }
  unblockTerm(scope:Scope,term:string):boolean {
    return this.db.transaction(()=>{
      const normalized=normalizeBlockedTerm(term),changed=this.db.run('DELETE FROM blocked_terms WHERE channel_id=? AND run_id=? AND term=?',...this.scope(scope),normalized).changes===1;
      if(changed)for(const row of this.db.all('SELECT session_id,body,revision FROM domain_checkpoints WHERE channel_id=? AND run_id=? AND body IS NOT NULL',...this.scope(scope))) {
        const body=JSON.parse(String(row.body)) as {blockedTerms?:string[];revision:number};
        body.blockedTerms=(body.blockedTerms ?? []).filter(value=>normalizeBlockedTerm(value)!==normalized);body.revision=Number(row.revision)+1;
        this.db.run('UPDATE domain_checkpoints SET revision=?,body=?,updated_at_ms=? WHERE channel_id=? AND run_id=? AND session_id=?',body.revision,json(body,8_388_608),this.now(),...this.scope(scope),String(row.session_id));
      }
      return changed;
    });
  }
  sourcePolicy(scope:Scope,source:Source):'active'|'deleted'|'quarantined' {
    if(this.tombstoned(scope,source) || (source.actorId && this.db.get('SELECT 1 FROM channel_bans WHERE channel_id=? AND run_id=? AND actor_id=?',...this.scope(scope),source.actorId)))return 'deleted';
    const cutoff=this.controlGet<number>(scope,`chat-clear:${source.sessionId}`);
    if(source.kind==='chat' && cutoff!==null && source.startMs<=cutoff)return 'quarantined';
    return 'active';
  }
  /** Idempotent startup reconciliation also resumes an interrupted global-block upgrade. */
  reconcileLegacyTermBlocks():void {
    const matches=new Map<string,{scope:Scope;sessionId:string;term:string}>();
    for(const row of this.db.raw.prepare("SELECT channel_id,run_id,session_id,body FROM entities WHERE kind='lore' AND status='active' AND body IS NOT NULL").iterate()) {
      const scope={channelId:String(row.channel_id),runId:String(row.run_id)},sessionId=String(row.session_id);
      for(const term of this.loreTerms(JSON.parse(String(row.body)))) if(this.isTermBlocked(scope,sessionId,term)) {
        matches.set(digest([scope,term]),{scope,sessionId,term});
      }
    }
    for(const [key,{scope,sessionId,term}] of matches) this.invalidate(scope,{kind:'term',sessionId,term},{idempotencyKey:`global-term-upgrade:${key}`,reason:'scope_upgrade'});
  }
  private insertWork(table:'jobs'|'outbox',scope:Scope,input:WorkInput): string {
    const session=this.session(scope,input.sessionId);
    if(input.kind!=='retract' && this.sessionForgotten(scope,input.sessionId)) throw new StorageError('conflict','The session was forgotten.');
    const previous=this.db.get(`SELECT id FROM ${table} WHERE channel_id=? AND run_id=? AND business_key=?`,...this.scope(scope),input.businessKey);
    if (previous) return String(previous.id);
    const pending=this.db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE channel_id=? AND run_id=? AND ${input.kind==='stt' ? "state='queued' AND kind='stt'" : "state IN ('queued','running')"}`,...this.scope(scope))!;
    if (Number(pending.count)>=(input.kind==='stt' ? 3 : 1000) && input.kind!=='retract') throw new StorageError('capacity','Durable work queue is full.');
    const id=input.id ?? randomUUID();
    this.db.run(`INSERT INTO ${table}(channel_id,run_id,id,session_id,kind,business_key,payload,privacy_epoch,priority,next_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`,...this.scope(scope),id,input.sessionId,input.kind,input.businessKey,json(input.payload),Number(session.privacy_epoch),input.priority ?? 0,input.nextAtMs ?? this.now());
    if (table==='outbox' && ['publish','retract','export_manifest'].includes(input.kind)) this.assignPublicationSequence(scope,id);
    this.edges(scope,id,input.dependencyRefs ?? [],'exposed_to');
    return id;
  }
  enqueueJob(scope:Scope,input:WorkInput): string { return this.db.transaction(()=>this.insertWork('jobs',scope,input)); }
  enqueueOutbox(scope:Scope,input:WorkInput): string { return this.db.transaction(()=>this.insertWork('outbox',scope,input)); }
  private claim(table:'jobs'|'outbox',scope:Scope,options:{kinds?:string[];leaseMs?:number;sessionId?:string}):WorkLease|null {
    const leaseMs=Math.min(integer(options.leaseMs ?? 30000,1),120000),now=this.now();
    return this.db.transaction(()=>{
      if (table==='outbox') this.db.run("UPDATE outbox SET state='unknown_outcome',lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND state='running' AND lease_until_ms<=? AND kind IN ('chat','clip','marker')",...this.scope(scope),now);
      const row=this.db.get(`SELECT w.* FROM ${table} w JOIN sessions s ON s.channel_id=w.channel_id AND s.run_id=w.run_id AND s.id=w.session_id
        WHERE w.channel_id=? AND w.run_id=? AND w.privacy_epoch=s.privacy_epoch AND w.next_at_ms<=?
        AND (w.state='queued' OR (w.state='running' AND w.lease_until_ms<=?))
        AND (SELECT COUNT(*) FROM ${table} active WHERE active.channel_id=w.channel_id AND active.run_id=w.run_id AND active.kind=w.kind AND active.state='running' AND active.lease_until_ms>? AND (w.kind<>'story' OR active.session_id=w.session_id)) < CASE WHEN w.kind='stt' THEN 2 ELSE 1 END
        ${options.sessionId ? 'AND w.session_id=?' : ''}
        ${options.kinds?.length ? `AND w.kind IN (${options.kinds.map(()=>'?').join(',')})` : ''}
        ORDER BY w.priority DESC,w.next_at_ms,w.id LIMIT 1`,...this.scope(scope),now,now,now,...(options.sessionId ? [options.sessionId] : []),...(options.kinds ?? []));
      if (!row) return null;
      const token=randomUUID();
      this.db.run(`UPDATE ${table} SET state='running',lease_token=?,lease_until_ms=?,attempts=attempts+1 WHERE channel_id=? AND run_id=? AND id=?`,token,now+leaseMs,...this.scope(scope),String(row.id));
      return {id:String(row.id),sessionId:String(row.session_id),kind:String(row.kind),payload:row.payload === null ? null : JSON.parse(String(row.payload)) as unknown,privacyEpoch:Number(row.privacy_epoch),leaseToken:token,leaseUntilMs:now+leaseMs,attempts:Number(row.attempts)+1,publishSeq:row.publish_seq == null ? null : Number(row.publish_seq),...(row.frozen_body ? {frozenPublication:{body:String(row.frozen_body),bodyHash:String(row.frozen_hash)}} : {})};
    });
  }
  claimJob(scope:Scope,options:{kinds?:string[];leaseMs?:number;sessionId?:string} = {}) { return this.claim('jobs',scope,options); }
  claimOutbox(scope:Scope,options:{kinds?:string[];leaseMs?:number;sessionId?:string} = {}) { return this.claim('outbox',scope,options); }
  private renew(table:'jobs'|'outbox',scope:Scope,id:string,leaseToken:string,leaseMs:number):boolean {
    const now=this.now();
    return this.db.run(`UPDATE ${table} SET lease_until_ms=? WHERE channel_id=? AND run_id=? AND id=? AND lease_token=? AND state='running' AND lease_until_ms>?`,now+Math.min(integer(leaseMs,1),120000),...this.scope(scope),id,leaseToken,now).changes === 1;
  }
  renewJob(scope:Scope,id:string,leaseToken:string,leaseMs=30000) { return this.renew('jobs',scope,id,leaseToken,leaseMs); }
  renewOutbox(scope:Scope,id:string,leaseToken:string,leaseMs=30000) { return this.renew('outbox',scope,id,leaseToken,leaseMs); }
  private finish(table:'jobs'|'outbox',scope:Scope,id:string,leaseToken:string,state:'done'|'failed'|'unknown_outcome',nextAtMs?:number):boolean {
    if (state==='unknown_outcome' && nextAtMs!=null) throw new StorageError('invalid_input','An ambiguous external effect cannot be automatically retried.');
    return this.db.run(`UPDATE ${table} SET state=?,next_at_ms=COALESCE(?,next_at_ms),lease_token=NULL,lease_until_ms=NULL,payload=CASE WHEN ?='done' THEN NULL ELSE payload END
      WHERE channel_id=? AND run_id=? AND id=? AND lease_token=? AND state='running' AND lease_until_ms>?`,nextAtMs == null ? state : 'queued',nextAtMs ?? null,state,...this.scope(scope),id,leaseToken,this.now()).changes === 1;
  }
  finishJob(scope:Scope,id:string,leaseToken:string,state:'done'|'failed'|'unknown_outcome',nextAtMs?:number) { return this.finish('jobs',scope,id,leaseToken,state,nextAtMs); }
  finishOutbox(scope:Scope,id:string,leaseToken:string,state:'done'|'failed'|'unknown_outcome',nextAtMs?:number) { return this.finish('outbox',scope,id,leaseToken,state,nextAtMs); }
  pendingJobCount(scope:Scope,sessionId:string,kinds?:string[]):number {
    this.session(scope,sessionId);if(kinds && kinds.length>32)throw new StorageError('invalid_input','Job kind filter exceeds its limit.');
    return Number(this.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE channel_id=? AND run_id=? AND session_id=? AND state IN ('queued','running') ${kinds?.length ? `AND kind IN (${kinds.map(()=>'?').join(',')})` : ''}`,...this.scope(scope),sessionId,...(kinds ?? []))!.n);
  }
  cancelSessionEffects(scope:Scope,sessionId:string,kinds:string[]=['chat','clip','marker']):{cancelled:number;unknown:number} {
    return this.db.transaction(()=>{
      this.session(scope,sessionId);if(!kinds.length || kinds.some(kind=>!['chat','clip','marker'].includes(kind)))throw new StorageError('invalid_input','Unsupported session effect cancellation.');
      const placeholders=kinds.map(()=>'?').join(',');
      let cancelled=Number(this.db.run(`UPDATE outbox SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND session_id=? AND state='queued' AND kind IN (${placeholders})`,...this.scope(scope),sessionId,...kinds).changes);
      const unknown=Number(this.db.run(`UPDATE outbox SET state='unknown_outcome',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND session_id=? AND state='running' AND kind IN (${placeholders})`,...this.scope(scope),sessionId,...kinds).changes);
      if(kinds.includes('clip'))cancelled+=Number(this.db.run("UPDATE jobs SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND session_id=? AND kind='twitch.clip.intent' AND state IN ('queued','running')",...this.scope(scope),sessionId).changes);
      return {cancelled,unknown};
    });
  }
  registerGeneration(ticket:GenerationTicket,entityId:string):void {
    if (!GenerationTicketSchema.safeParse(ticket).success) throw new StorageError('invalid_input','Generation ticket does not match the shared contract.');
    this.db.transaction(()=>{
      const session=this.session(ticket,ticket.sessionId), entity=this.getEntity(ticket,entityId);
      if (Number(session.privacy_epoch)!==ticket.privacyEpoch || !entity || entity.sessionId!==ticket.sessionId || entity.status!=='active' || entity.ownerLocked || entity.revision!==ticket.baseEntityRevision) throw new StorageError('conflict','Generation context changed.');
      if (ticket.inputRefs.length>500) throw new StorageError('capacity','Generation context exceeds 500 records.');
      this.edges(ticket,ticket.jobId,ticket.inputRefs,'exposed_to');
      this.db.run('INSERT INTO generation_jobs VALUES(?,?,?,?,?,?,\'registered\')',...this.scope(ticket),ticket.jobId,ticket.sessionId,entityId,json(ticket));
      for (const ref of ticket.inputRefs) this.db.run('INSERT INTO generation_inputs VALUES(?,?,?,?,?)',...this.scope(ticket),ticket.jobId,ref.id,ref.revision);
    });
  }
  commitStory(ticket:GenerationTicket,patch:StoryPatch):CommitResult {
    if (!GenerationTicketSchema.safeParse(ticket).success || !StoryPatchSchema.safeParse(patch).success) return {committed:false,reason:'invalid_contract'};
    return this.db.transaction(()=>{
      const job=this.db.get('SELECT * FROM generation_jobs WHERE channel_id=? AND run_id=? AND id=?',...this.scope(ticket),ticket.jobId);
      if (!job || job.status!=='registered' || digest(JSON.parse(String(job.ticket)))!==digest(ticket)) return {committed:false,reason:'ticket_unavailable'};
      const session=this.session(ticket,ticket.sessionId), entity=this.getEntity(ticket,String(job.entity_id));
      if (Number(session.privacy_epoch)!==ticket.privacyEpoch) return {committed:false,reason:'privacy_changed'};
      if (!entity || entity.sessionId!==ticket.sessionId || entity.status!=='active' || entity.ownerLocked || entity.revision!==ticket.baseEntityRevision || entity.ownerRevision!==(ticket.ownerEditRevision ?? 0)) return {committed:false,reason:'owner_or_entity_changed'};
      if (patch.sessionId!==ticket.sessionId || patch.baseRevision!==ticket.baseEntityRevision || !ticket.inputRefs.every(ref=>this.ref(ticket,ref))) return {committed:false,reason:'inputs_changed'};
      const allowed=new Map(ticket.inputRefs.map(ref=>[ref.id,ref.revision]));
      const supports=[...patch.claims.flatMap(claim=>claim.support),...patch.relations.flatMap(relation=>relation.support)];
      const claimIds=new Set(patch.claims.map(claim=>claim.id));
      if (patch.claims.some(claim=>!claim.support.length) || supports.some(ref=>allowed.get(ref.id)!==ref.revision) || patch.relations.some(relation=>!claimIds.has(relation.from)||!claimIds.has(relation.to)||!relation.support.length)) return {committed:false,reason:'unsupported_claim'};
      if (patch.action==='hold') { this.db.run("UPDATE generation_jobs SET status='committed' WHERE channel_id=? AND run_id=? AND id=?",...this.scope(ticket),ticket.jobId); return {committed:true,revision:entity.revision}; }
      const count=this.db.get("SELECT COUNT(*) AS count FROM publication_candidates WHERE channel_id=? AND run_id=? AND entity_id=? AND status='pending'",...this.scope(ticket),entity.id)!;
      if (Number(count.count)>=4) return {committed:false,reason:'candidate_capacity'};
      const eligible=Date.parse(ticket.eligibleAt);
      if (!Number.isFinite(eligible)) throw new StorageError('invalid_input','Candidate eligibility time is invalid.');
      const candidateId=randomUUID(),revision=entity.revision+1;
      // Previous chapter text is valid model context, but the mutable chapter cannot be
      // the candidate's version fence after this commit increments its revision.
      // Preserve that exact context as an immutable graph node. Its link to the chapter
      // keeps owner edits/deletion transitive, while later ordinary drafts do not expire it.
      const selfRef=ticket.inputRefs.find(ref=>ref.id===entity.id);
      const contextId=`context:${candidateId}`;
      if(selfRef) this.insertEntity(ticket,{id:contextId,sessionId:ticket.sessionId,kind:'provider_cache',body:{originalRef:selfRef,body:entity.body},refs:[selfRef]});
      const candidateRef=(ref:VersionRef):VersionRef=>ref.id===entity.id ? {id:contextId,revision:1} : ref;
      this.db.run('UPDATE entities SET revision=?,body=? WHERE channel_id=? AND run_id=? AND id=?',revision,json(patch),...this.scope(ticket),entity.id);
      this.db.run('INSERT INTO publication_candidates VALUES(?,?,?,?,?,?,?,?,?,\'pending\',0,?)',...this.scope(ticket),candidateId,ticket.sessionId,entity.id,revision,entity.ownerRevision,ticket.privacyEpoch,eligible,json(patch));
      this.edges(ticket,candidateId,ticket.inputRefs.map(candidateRef),'exposed_to');
      this.edges(ticket,entity.id,ticket.inputRefs.filter(ref=>ref.id!==entity.id),'exposed_to');
      this.edges(ticket,candidateId,supports.map(candidateRef),'supports');
      this.db.run("UPDATE generation_jobs SET status='committed' WHERE channel_id=? AND run_id=? AND id=?",...this.scope(ticket),ticket.jobId);
      return {committed:true,candidateId,revision};
    });
  }
  markCandidateSafe(scope:Scope,id:string,result:{moderation:'allowed'|'rejected';pii:'allowed'|'rejected'}):boolean {
    return this.db.run("UPDATE publication_candidates SET safe=? WHERE channel_id=? AND run_id=? AND id=? AND status='pending'",Number(result.moderation==='allowed'&&result.pii==='allowed'),...this.scope(scope),id).changes===1;
  }
  registerOwnerCandidate(scope:Scope,entityId:string,ownerRevision:number,body:unknown,refs:VersionRef[]):string {
    return this.db.transaction(()=>{
      const entity=this.getEntity(scope,entityId);
      if (!entity || entity.status!=='active' || !entity.ownerLocked || entity.ownerRevision!==ownerRevision) throw new StorageError('conflict','Owner revision changed.');
      const count=this.db.get("SELECT COUNT(*) AS count FROM publication_candidates WHERE channel_id=? AND run_id=? AND entity_id=? AND status='pending'",...this.scope(scope),entityId)!;
      if (Number(count.count)>=4) throw new StorageError('capacity','Candidate queue is full.');
      const session=this.session(scope,entity.sessionId),id=randomUUID();
      this.db.run('INSERT INTO publication_candidates VALUES(?,?,?,?,?,?,?,?,?,\'pending\',0,?)',...this.scope(scope),id,entity.sessionId,entityId,entity.revision,ownerRevision,Number(session.privacy_epoch),this.now(),json(body));
      this.edges(scope,id,refs,'exposed_to');
      this.edges(scope,entityId,refs,'exposed_to');
      // Preserve lineage even if an editorial caller omits the old supporting refs.
      this.db.run("INSERT OR IGNORE INTO dependencies SELECT channel_id,run_id,parent_id,parent_revision,?,'exposed_to' FROM dependencies WHERE channel_id=? AND run_id=? AND child_id=?",id,...this.scope(scope),entityId);
      return id;
    });
  }
  publishEligible(scope:Scope,entityId:string): {candidateId:string;revision:number;body:unknown}|null {
    return this.db.transaction(()=>{
      const row=this.db.get(`SELECT c.* FROM publication_candidates c JOIN entities e ON e.channel_id=c.channel_id AND e.run_id=c.run_id AND e.id=c.entity_id
        JOIN sessions s ON s.channel_id=c.channel_id AND s.run_id=c.run_id AND s.id=c.session_id
        WHERE c.channel_id=? AND c.run_id=? AND c.entity_id=? AND c.status='pending' AND c.safe=1 AND c.eligible_at_ms<=?
        AND c.owner_revision=e.owner_revision AND e.status='active' AND c.privacy_epoch=s.privacy_epoch ORDER BY c.revision DESC LIMIT 1`,...this.scope(scope),entityId,this.now());
      if (!row) return null;
      const refs=this.db.all('SELECT parent_id,parent_revision FROM dependencies WHERE channel_id=? AND run_id=? AND child_id=?',...this.scope(scope),String(row.id));
      if (!refs.every(ref=>this.ref(scope,{id:String(ref.parent_id),revision:Number(ref.parent_revision)}))) return null;
      this.db.run('INSERT INTO public_pointers VALUES(?,?,?,?) ON CONFLICT(channel_id,run_id,entity_id) DO UPDATE SET candidate_id=excluded.candidate_id',...this.scope(scope),entityId,String(row.id));
      this.db.run("UPDATE publication_candidates SET status='superseded' WHERE channel_id=? AND run_id=? AND entity_id=? AND revision<?",...this.scope(scope),entityId,Number(row.revision));
      this.db.run("UPDATE publication_candidates SET status='published' WHERE channel_id=? AND run_id=? AND id=?",...this.scope(scope),String(row.id));
      this.db.run('UPDATE sessions SET publication_revision=publication_revision+1 WHERE channel_id=? AND run_id=? AND id=?',...this.scope(scope),String(row.session_id));
      this.insertWork('outbox',scope,{sessionId:String(row.session_id),kind:'publish',businessKey:`candidate:${String(row.id)}`,payload:{candidateId:String(row.id),entityId},priority:0});
      return {candidateId:String(row.id),revision:Number(row.revision),body:JSON.parse(String(row.body)) as unknown};
    });
  }
  getPublished(scope:Scope,entityId:string):unknown|null {
    const row=this.db.get(`SELECT c.body FROM public_pointers p JOIN publication_candidates c ON c.channel_id=p.channel_id AND c.run_id=p.run_id AND c.id=p.candidate_id JOIN entities e ON e.channel_id=p.channel_id AND e.run_id=p.run_id AND e.id=p.entity_id WHERE p.channel_id=? AND p.run_id=? AND p.entity_id=? AND c.status='published' AND e.status='active'`,...this.scope(scope),entityId);
    return row?.body ? JSON.parse(String(row.body)) as unknown : null;
  }
  editEntity(scope:Scope,id:string,baseRevision:number,body:unknown):number {
    return this.db.transaction(()=>{
      const entity=this.getEntity(scope,id);
      if (!entity) throw new StorageError('inaccessible','Entity is unavailable.');
      if (entity.status!=='active'||entity.revision!==baseRevision) throw new StorageError('conflict','Entity has changed.');
      this.db.run('UPDATE entities SET revision=revision+1,owner_revision=owner_revision+1,owner_locked=1,body=? WHERE channel_id=? AND run_id=? AND id=?',json(body),...this.scope(scope),id);
      this.db.run("UPDATE publication_candidates SET status='invalid',body=NULL WHERE channel_id=? AND run_id=? AND entity_id=?",...this.scope(scope),id);
      this.db.run('DELETE FROM public_pointers WHERE channel_id=? AND run_id=? AND entity_id=?',...this.scope(scope),id);
      this.db.raw.exec('CREATE TEMP TABLE IF NOT EXISTS affected(id TEXT PRIMARY KEY); DELETE FROM affected;');
      this.db.run(`INSERT OR IGNORE INTO affected WITH RECURSIVE descendants(id) AS (SELECT child_id FROM dependencies WHERE channel_id=? AND run_id=? AND parent_id=? UNION SELECT d.child_id FROM dependencies d JOIN descendants a ON a.id=d.parent_id WHERE d.channel_id=? AND d.run_id=?) SELECT id FROM descendants`,...this.scope(scope),id,...this.scope(scope));
      this.db.run("UPDATE entities SET status='hidden',body=NULL,revision=revision+1 WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)",...this.scope(scope));
      this.db.run("UPDATE publication_candidates SET status='invalid',body=NULL WHERE channel_id=? AND run_id=? AND (id IN (SELECT id FROM affected) OR entity_id IN (SELECT id FROM affected))",...this.scope(scope));
      this.db.run('DELETE FROM public_pointers WHERE channel_id=? AND run_id=? AND (entity_id IN (SELECT id FROM affected) OR candidate_id IN (SELECT id FROM affected))',...this.scope(scope));
      for (const table of ['jobs','outbox'] as const) this.db.run(`UPDATE ${table} SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)`,...this.scope(scope));
      this.insertWork('outbox',scope,{sessionId:entity.sessionId,kind:'retract',businessKey:`owner-edit:${id}:${baseRevision+1}`,payload:{entityId:id},priority:100});
      return baseRevision+1;
    });
  }
  pinEntity(scope:Scope,id:string,baseRevision:number,pinned:boolean):boolean {
    return this.db.transaction(()=>{
      const entity=this.getEntity(scope,id);
      if(!entity || entity.status!=='active' || entity.revision!==baseRevision) return false;
      this.db.run("UPDATE entities SET pinned=?,revision=revision+1 WHERE channel_id=? AND run_id=? AND id=? AND revision=? AND status='active'",Number(pinned),...this.scope(scope),id,baseRevision);
      this.db.run('UPDATE sessions SET publication_revision=publication_revision+1 WHERE channel_id=? AND run_id=? AND id=?',...this.scope(scope),entity.sessionId);
      this.insertWork('outbox',scope,{sessionId:entity.sessionId,kind:'publish',businessKey:`pin:${id}:${baseRevision+1}`,payload:{entityId:id,revision:baseRevision+1,pinned},priority:10});
      return true;
    });
  }
  private clearAffectedMetadata(scope:Scope):void {
    const rows=this.db.all(`SELECT e.id,e.metadata_end_ms FROM sessions e WHERE e.channel_id=? AND e.run_id=? AND EXISTS(
      SELECT 1 FROM sources s JOIN affected a ON a.id=s.id WHERE s.channel_id=e.channel_id AND s.run_id=e.run_id AND s.session_id=e.id AND s.kind='channel_metadata' AND s.end_ms=e.metadata_end_ms)`,...this.scope(scope));
    for(const row of rows){const id=String(row.id),old=this.controlGet<number>(scope,`metadata-fence:${id}`);this.controlPut(scope,`metadata-fence:${id}`,Math.max(old ?? 0,Number(row.metadata_end_ms)));this.db.run("UPDATE sessions SET title='',category='',metadata_end_ms=0 WHERE channel_id=? AND run_id=? AND id=?",...this.scope(scope),id);}
  }
  /** Invalidates exposed old versions without tombstoning the corrected/quarantined source. */
  invalidateSourceVersions(scope:Scope,sessionId:string,sourceIds:string[],options:PrivacyOptions):InvalidationReceipt {
    return this.db.transaction(()=>{
      this.session(scope,sessionId);if(sourceIds.length>500)throw new StorageError('capacity','Source revision batch exceeds its limit.');
      const requestHash=digest({sessionId,sourceIds:[...sourceIds].sort(),operation:'source_revision'});
      const previous=this.db.get('SELECT request_hash,receipt FROM privacy_receipts WHERE channel_id=? AND run_id=? AND idempotency_key=?',...this.scope(scope),options.idempotencyKey);
      if(previous){if(previous.request_hash!==requestHash)throw new StorageError('conflict','Source revision key was already used.');return JSON.parse(String(previous.receipt)) as InvalidationReceipt;}
      this.db.raw.exec('CREATE TEMP TABLE IF NOT EXISTS affected(id TEXT PRIMARY KEY); DELETE FROM affected; CREATE TEMP TABLE IF NOT EXISTS affected_sessions(id TEXT PRIMARY KEY); DELETE FROM affected_sessions;');
      this.db.run('INSERT INTO affected_sessions VALUES(?)',sessionId);
      for(const id of sourceIds)this.db.run('INSERT OR IGNORE INTO affected SELECT id FROM sources WHERE channel_id=? AND run_id=? AND session_id=? AND id=?',...this.scope(scope),sessionId,id);
      this.db.run(`INSERT OR IGNORE INTO affected SELECT e.id FROM entities e WHERE e.channel_id=? AND e.run_id=? AND e.session_id=? AND e.kind='media'
        AND EXISTS(SELECT 1 FROM sources s JOIN affected a ON a.id=s.id WHERE s.channel_id=e.channel_id AND s.run_id=e.run_id AND ranges_overlap(s.start_ms,s.end_ms,e.start_ms,e.end_ms))`,...this.scope(scope),sessionId);
      this.db.run(`INSERT OR IGNORE INTO affected WITH RECURSIVE descendants(id) AS (SELECT id FROM affected UNION SELECT d.child_id FROM dependencies d JOIN descendants a ON a.id=d.parent_id WHERE d.channel_id=? AND d.run_id=?) SELECT id FROM descendants`,...this.scope(scope));
      for(const table of ['entities','jobs','outbox','generation_jobs'])this.db.run(`INSERT OR IGNORE INTO affected_sessions SELECT session_id FROM ${table} WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)`,...this.scope(scope));
      this.clearAffectedMetadata(scope);
      const hiddenEntityIds=this.db.all('SELECT id FROM entities WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)',...this.scope(scope)).map(row=>String(row.id));
      const externalClipActions:{clipId:string;manageUrl:string}[]=[];
      for(const row of this.db.all("SELECT body FROM entities WHERE channel_id=? AND run_id=? AND kind IN ('media','moment') AND id IN (SELECT id FROM affected) AND body IS NOT NULL",...this.scope(scope))){const value=JSON.parse(String(row.body)) as {clipId?:unknown};if(typeof value.clipId==='string')externalClipActions.push({clipId:value.clipId,manageUrl:'https://dashboard.twitch.tv/content/clips'});}
      this.db.run('UPDATE events SET payload=NULL WHERE channel_id=? AND run_id=? AND (id IN (SELECT id FROM affected) OR id IN (SELECT event_id FROM sources WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)))',...this.scope(scope),...this.scope(scope));
      this.db.run("UPDATE entities SET body=NULL,status='hidden',revision=revision+1 WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)",...this.scope(scope));
      this.db.run("UPDATE publication_candidates SET body=NULL,status='invalid' WHERE channel_id=? AND run_id=? AND (id IN (SELECT id FROM affected) OR entity_id IN (SELECT id FROM affected))",...this.scope(scope));
      this.db.run('DELETE FROM public_pointers WHERE channel_id=? AND run_id=? AND (entity_id IN (SELECT id FROM affected) OR candidate_id IN (SELECT id FROM affected))',...this.scope(scope));
      this.db.run('UPDATE sessions SET privacy_epoch=privacy_epoch+1,publication_revision=publication_revision+1 WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected_sessions)',...this.scope(scope));
      this.db.run('UPDATE channels SET privacy_revision=privacy_revision+1 WHERE channel_id=? AND run_id=?',...this.scope(scope));
      this.db.run('UPDATE domain_checkpoints SET body=NULL,revision=revision+1,privacy_epoch=(SELECT privacy_epoch FROM sessions s WHERE s.channel_id=domain_checkpoints.channel_id AND s.run_id=domain_checkpoints.run_id AND s.id=domain_checkpoints.session_id),updated_at_ms=? WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions)',this.now(),...this.scope(scope));
      for(const table of ['jobs','outbox'])this.db.run(`UPDATE ${table} SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions) AND state IN ('queued','running','failed','unknown_outcome')`,...this.scope(scope));
      this.db.run('UPDATE outbox SET frozen_body=NULL,frozen_hash=NULL WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions)',...this.scope(scope));
      this.db.run("UPDATE generation_jobs SET status='cancelled' WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions) AND status='registered'",...this.scope(scope));
      this.db.run("UPDATE publication_candidates SET body=NULL,status='invalid' WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions) AND status='pending'",...this.scope(scope));
      this.db.run('UPDATE publication_sync SET pending_privacy=1 WHERE channel_id=? AND run_id=?',...this.scope(scope));
      const session=this.getSession(scope,sessionId),affectedSessionIds=this.db.all('SELECT id FROM affected_sessions').map(row=>String(row.id));
      const receipt:InvalidationReceipt={revision:session.publicationRevision,privacyEpoch:session.privacyEpoch,hiddenEntityIds,rebuildStatus:'queued',publicSync:'pending',externalClipActions};
      this.insertWork('outbox',scope,{sessionId,kind:'retract',businessKey:`source-revision:${options.idempotencyKey}`,payload:{sessionId,revision:receipt.revision,privacyEpoch:receipt.privacyEpoch,affectedIds:hiddenEntityIds,affectedSessionIds},priority:1000});
      this.db.run('INSERT INTO privacy_receipts VALUES(?,?,?,?,?)',...this.scope(scope),options.idempotencyKey,requestHash,json(receipt));
      return receipt;
    });
  }
  invalidate(scope:Scope,target:PrivacyTarget,options:PrivacyOptions):InvalidationReceipt {
    if (!PrivacyTargetSchema.safeParse(target).success || !options.idempotencyKey || options.idempotencyKey.length>160) throw new StorageError('invalid_input','Privacy request does not match the shared contract.');
    const requestHash=digest({target,reason:options.reason});
    return this.db.transaction(()=>{
      const previous=this.db.get('SELECT * FROM privacy_receipts WHERE channel_id=? AND run_id=? AND idempotency_key=?',...this.scope(scope),options.idempotencyKey);
      if (previous) {
        if (previous.request_hash!==requestHash) throw new StorageError('conflict','Idempotency key was already used for a different request.');
        return JSON.parse(String(previous.receipt)) as InvalidationReceipt;
      }
      this.session(scope,target.sessionId);
      let where='',params:(string|number)[]=[],targetId:string|null=null,fromMs:number|null=null,toMs:number|null=null;
      switch(target.kind) {
        case 'source': where='id=?';params=[target.id];targetId=target.id;break;
        case 'message':where='external_message_id=?';params=[target.externalMessageId];targetId=target.externalMessageId;break;
        case 'user':where='actor_id=? AND start_ms<=?';params=[target.actorId,integer(target.throughMs)];targetId=target.actorId;toMs=target.throughMs;break;
        case 'interval':where='ranges_overlap(start_ms,end_ms,?,?)';params=[integer(target.fromMs),integer(target.toMs)];fromMs=target.fromMs;toMs=target.toMs;if(fromMs>toMs)throw new StorageError('invalid_input','Privacy interval is invalid.');break;
        case 'session':where='1=1';break;
        case 'term':where='0=1';targetId=normalizeBlockedTerm(target.term);break;
        case 'entity':where='0=1';targetId=target.id;break;
      }
      // Reasons are codes, never free-form source text. Receipts contain only IDs and statuses.
      if(target.kind==='term') this.db.run('INSERT INTO blocked_terms VALUES(?,?,?) ON CONFLICT DO NOTHING',...this.scope(scope),targetId);
      else this.db.run('INSERT INTO source_tombstones VALUES(?,?,?,?,?,?,?,?,?)',...this.scope(scope),randomUUID(),target.sessionId,target.kind,targetId,fromMs,toMs,'privacy');
      this.db.raw.exec('CREATE TEMP TABLE IF NOT EXISTS affected(id TEXT PRIMARY KEY); DELETE FROM affected;');
      this.db.run(`INSERT INTO affected SELECT id FROM sources WHERE channel_id=? AND run_id=? AND session_id=? AND (${where})`,...this.scope(scope),target.sessionId,...params);
      if(target.kind==='session') {
        this.db.run('INSERT OR IGNORE INTO affected SELECT id FROM entities WHERE channel_id=? AND run_id=? AND session_id=?',...this.scope(scope),target.sessionId);
        this.db.run('UPDATE events SET payload=NULL WHERE channel_id=? AND run_id=? AND session_id=?',...this.scope(scope),target.sessionId);
        this.db.run("UPDATE sessions SET title='',category='',metadata_end_ms=0 WHERE channel_id=? AND run_id=? AND id=?",...this.scope(scope),target.sessionId);
        this.db.run('UPDATE capture_leases SET epoch=epoch+1,expires_at_ms=0,actor_id=NULL WHERE channel_id=? AND run_id=? AND session_id=?',...this.scope(scope),target.sessionId);
      }
      if (target.kind==='entity') this.db.run('INSERT OR IGNORE INTO affected SELECT id FROM entities WHERE channel_id=? AND run_id=? AND session_id=? AND id=?',...this.scope(scope),target.sessionId,target.id);
      if (target.kind==='term') {
        for (const row of this.db.raw.prepare("SELECT id,body FROM entities WHERE channel_id=? AND run_id=? AND kind='lore' AND status='active'").iterate(...this.scope(scope))) {
          if (row.body && this.loreTerms(JSON.parse(String(row.body))).includes(targetId!)) {
            this.db.run('INSERT OR IGNORE INTO affected VALUES(?)',String(row.id));
            const body=JSON.parse(String(row.body)) as {term?:string;aliases?:string[];firstSeenMs?:number};
            const entity=this.getEntity(scope,String(row.id))!;
            this.controlPut(scope,`blocked-lore:${String(row.id)}`,{id:String(row.id),sessionId:entity.sessionId,revision:entity.revision+1,term:body.term ?? targetId,aliases:body.aliases ?? [],firstSeenMs:body.firstSeenMs ?? 0,status:'blocked'});
          }
        }
      }
      // Media can expose speech/chat independent of its caption; overlap is a separate root.
      this.db.run(`INSERT OR IGNORE INTO affected SELECT e.id FROM entities e WHERE e.channel_id=? AND e.run_id=? AND e.session_id=? AND e.kind='media'
        AND (EXISTS (SELECT 1 FROM sources s JOIN affected a ON a.id=s.id WHERE s.channel_id=e.channel_id AND s.run_id=e.run_id AND ranges_overlap(s.start_ms,s.end_ms,e.start_ms,e.end_ms))
        ${target.kind==='interval' ? 'OR ranges_overlap(e.start_ms,e.end_ms,?,?)' : ''})`,...this.scope(scope),target.sessionId,...(target.kind==='interval' ? [target.fromMs,target.toMs] : []));
      this.db.run(`INSERT OR IGNORE INTO affected WITH RECURSIVE descendants(id) AS (SELECT id FROM affected UNION SELECT d.child_id FROM dependencies d JOIN descendants a ON a.id=d.parent_id WHERE d.channel_id=? AND d.run_id=?) SELECT id FROM descendants`,...this.scope(scope));
      this.clearAffectedMetadata(scope);
      const hiddenEntityIds=this.db.all('SELECT id FROM entities WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)',...this.scope(scope)).map(row=>String(row.id));
      const externalClipActions:{clipId:string;manageUrl:string}[]=[];
      for (const row of this.db.all("SELECT body FROM entities WHERE channel_id=? AND run_id=? AND kind IN ('media','moment') AND id IN (SELECT id FROM affected)",...this.scope(scope))) {
        const body=row.body ? JSON.parse(String(row.body)) as {clipId?:unknown;manageUrl?:unknown} : null;
        if (typeof body?.clipId==='string') externalClipActions.push({clipId:body.clipId,manageUrl:'https://dashboard.twitch.tv/content/clips'});
      }
      this.db.run('UPDATE events SET payload=NULL WHERE channel_id=? AND run_id=? AND (id IN (SELECT id FROM affected) OR id IN (SELECT event_id FROM sources WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)))',...this.scope(scope),...this.scope(scope));
      this.db.run("UPDATE sources SET text=NULL,status='deleted',revision=revision+1 WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected) AND status<>'deleted'",...this.scope(scope));
      this.db.run("UPDATE entities SET body=NULL,status='hidden',revision=revision+1 WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)",...this.scope(scope));
      this.db.run("UPDATE publication_candidates SET body=NULL,status='invalid' WHERE channel_id=? AND run_id=? AND (id IN (SELECT id FROM affected) OR entity_id IN (SELECT id FROM affected))",...this.scope(scope));
      this.db.run('DELETE FROM public_pointers WHERE channel_id=? AND run_id=? AND (entity_id IN (SELECT id FROM affected) OR candidate_id IN (SELECT id FROM affected))',...this.scope(scope));
      this.db.raw.exec('CREATE TEMP TABLE IF NOT EXISTS affected_sessions(id TEXT PRIMARY KEY); DELETE FROM affected_sessions;');
      this.db.run('INSERT INTO affected_sessions VALUES(?)',target.sessionId);
      for (const table of ['entities','jobs','outbox','generation_jobs']) this.db.run(`INSERT OR IGNORE INTO affected_sessions SELECT session_id FROM ${table} WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected)`,...this.scope(scope));
      this.db.run('UPDATE sessions SET privacy_epoch=privacy_epoch+1,publication_revision=publication_revision+1 WHERE channel_id=? AND run_id=? AND id IN (SELECT id FROM affected_sessions)',...this.scope(scope));
      this.db.run('UPDATE domain_checkpoints SET body=NULL,revision=revision+1,privacy_epoch=(SELECT privacy_epoch FROM sessions s WHERE s.channel_id=domain_checkpoints.channel_id AND s.run_id=domain_checkpoints.run_id AND s.id=domain_checkpoints.session_id),updated_at_ms=? WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions)',this.now(),...this.scope(scope));
      // Old-epoch drafts cannot pass the publication fence; release their pending slots.
      // Already published unaffected content stays available through its independent pointer.
      this.db.run("UPDATE publication_candidates SET status='invalid',body=NULL WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions) AND status='pending'",...this.scope(scope));
      this.db.run('UPDATE channels SET privacy_revision=privacy_revision+1 WHERE channel_id=? AND run_id=?',...this.scope(scope));
      // Epoch cancellation conservatively clears all in-flight bodies in this session.
      for (const table of ['jobs','outbox'] as const) this.db.run(`UPDATE ${table} SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions) AND state IN ('queued','running','failed','unknown_outcome')`,...this.scope(scope));
      this.db.run('UPDATE outbox SET frozen_body=NULL,frozen_hash=NULL WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions)',...this.scope(scope));
      this.db.run("UPDATE generation_jobs SET status='cancelled' WHERE channel_id=? AND run_id=? AND session_id IN (SELECT id FROM affected_sessions) AND status='registered'",...this.scope(scope));
      this.db.run('UPDATE publication_sync SET pending_privacy=1 WHERE channel_id=? AND run_id=?',...this.scope(scope));
      const session=this.session(scope,target.sessionId);
      const receipt:InvalidationReceipt={revision:Number(session.publication_revision),privacyEpoch:Number(session.privacy_epoch),hiddenEntityIds,rebuildStatus:'queued',publicSync:'pending',externalClipActions};
      const affectedSessionIds=this.db.all('SELECT id FROM affected_sessions ORDER BY id').map(row=>String(row.id));
      this.insertWork('outbox',scope,{sessionId:target.sessionId,kind:'retract',businessKey:`privacy:${options.idempotencyKey}`,payload:{sessionId:target.sessionId,revision:receipt.revision,privacyEpoch:receipt.privacyEpoch,affectedIds:hiddenEntityIds,affectedSessionIds},priority:1000});
      this.db.run('INSERT INTO privacy_receipts VALUES(?,?,?,?,?)',...this.scope(scope),options.idempotencyKey,requestHash,json(receipt));
      return receipt;
    });
  }
  acquireCapture(scope:Scope,sessionId:string,actorId:string,takeover=false,ttlMs=12000) {
    return this.db.transaction(()=>{
      this.session(scope,sessionId);
      if(this.sessionForgotten(scope,sessionId)) throw new StorageError('conflict','The session was forgotten.');
      const current=this.db.get('SELECT * FROM capture_leases WHERE channel_id=? AND run_id=?',...this.scope(scope));
      if (current && Number(current.expires_at_ms)>this.now() && (current.actor_id!==actorId||current.session_id!==sessionId) && !takeover) throw new StorageError('conflict','Another browser is capturing audio.');
      const epoch=Number(current?.epoch ?? 0)+1,expiresAtMs=this.now()+Math.min(integer(ttlMs,1),30000);
      if (current) this.db.run("UPDATE jobs SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND kind='stt' AND state IN ('queued','running')",...this.scope(scope));
      this.db.run('INSERT INTO capture_leases VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id,run_id) DO UPDATE SET session_id=excluded.session_id,actor_id=excluded.actor_id,epoch=excluded.epoch,expires_at_ms=excluded.expires_at_ms',...this.scope(scope),sessionId,actorId,epoch,expiresAtMs);
      return {sessionId,actorId,epoch,expiresAtMs};
    });
  }
  renewCapture(scope:Scope,actorId:string,epoch:number,ttlMs=12000):boolean {
    return this.db.run('UPDATE capture_leases SET expires_at_ms=? WHERE channel_id=? AND run_id=? AND actor_id=? AND epoch=? AND expires_at_ms>?',this.now()+Math.min(integer(ttlMs,1),30000),...this.scope(scope),actorId,epoch,this.now()).changes===1;
  }
  pauseCapture(scope:Scope,actorId:string,epoch:number):boolean {
    return this.db.transaction(()=>{
      const changed=this.db.run('UPDATE capture_leases SET epoch=epoch+1,expires_at_ms=0,actor_id=NULL WHERE channel_id=? AND run_id=? AND actor_id=? AND epoch=?',...this.scope(scope),actorId,epoch).changes===1;
      if (changed) this.db.run("UPDATE jobs SET state='cancelled',payload=NULL,lease_token=NULL,lease_until_ms=NULL WHERE channel_id=? AND run_id=? AND kind='stt' AND state IN ('queued','running')",...this.scope(scope));
      return changed;
    });
  }
  validateCapture(scope:Scope,sessionId:string,actorId:string,epoch:number):boolean {
    return !!this.db.get('SELECT 1 FROM capture_leases WHERE channel_id=? AND run_id=? AND session_id=? AND actor_id=? AND epoch=? AND expires_at_ms>?',...this.scope(scope),sessionId,actorId,epoch,this.now());
  }
  acceptAudio(scope:Scope,input:AcceptedAudio):{jobId:string;sourceId:string;duplicate:boolean} {
    return this.db.transaction(()=>{
      const session=this.getSession(scope,input.sessionId);
      for(const value of [input.leaseEpoch,input.captureEpoch,input.sequence,input.startMs,input.endMs,input.receivedAtMs,input.privacyEpoch])integer(value);
      if(scope.runId!=='live' || input.captureEpoch!==input.leaseEpoch || session.privacyEpoch!==input.privacyEpoch || !this.validateCapture(scope,input.sessionId,input.actorId,input.leaseEpoch))throw new StorageError('conflict','Capture lease changed.');
      if(!/^[a-f0-9]{64}$/.test(input.sha256) || input.endMs<=input.startMs || input.endMs-input.startMs>30000 || input.sampleRate<8000 || input.sampleRate>96000 || input.rawPath.length>2048)throw new StorageError('invalid_input','Audio metadata is invalid.');
      if(session.status==='finalized' || (session.status==='closing' && (!session.endedAt || this.now()>Date.parse(session.endedAt)+90000 || input.endMs>Date.parse(session.endedAt)-Date.parse(session.startedAt)+2)))throw new StorageError('conflict','The session no longer accepts audio.');
      const existing=this.db.get('SELECT * FROM audio_chunks WHERE channel_id=? AND run_id=? AND session_id=? AND lease_epoch=? AND sequence=?',...this.scope(scope),input.sessionId,input.leaseEpoch,input.sequence);
      if(existing) {
        if(existing.sha256!==input.sha256 || existing.actor_id!==input.actorId || Number(existing.start_ms)!==input.startMs || Number(existing.end_ms)!==input.endMs)throw new StorageError('conflict','Audio sequence already has different content.');
        return {jobId:String(existing.job_id),sourceId:String(existing.source_id),duplicate:true};
      }
      const prior=this.db.get('SELECT sequence,end_ms FROM audio_chunks WHERE channel_id=? AND run_id=? AND session_id=? AND lease_epoch=? ORDER BY sequence DESC LIMIT 1',...this.scope(scope),input.sessionId,input.leaseEpoch);
      if(prior && (input.sequence<=Number(prior.sequence) || input.startMs<Number(prior.end_ms)-2))throw new StorageError('conflict','Audio sequence overlaps an accepted chunk.');
      const suffix=digest([scope,input.sessionId,input.leaseEpoch,input.sequence]).slice(0,40),sourceId=`audio_${suffix}`,jobId=`stt_${suffix}`;
      const placeholder:Source={...scope,id:sourceId,sessionId:input.sessionId,revision:1,kind:'speech',startMs:input.startMs,endMs:input.endMs,actorId:null,languageCodes:[],timePrecision:'chunk',text:null,status:'active',externalMessageId:null,moderation:'pending'};
      if(this.tombstoned(scope,placeholder))throw new StorageError('conflict','This audio interval was forgotten.');
      this.insertWork('jobs',scope,{id:jobId,sessionId:input.sessionId,kind:'stt',businessKey:`audio:${suffix}`,payload:{...input,sourceId},nextAtMs:this.now()});
      this.db.run('INSERT INTO audio_chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',...this.scope(scope),input.sessionId,input.leaseEpoch,input.sequence,input.sha256,jobId,sourceId,input.actorId,input.captureEpoch,input.privacyEpoch,input.startMs,input.endMs,input.sampleRate,input.rawPath,input.receivedAtMs);
      return {jobId,sourceId,duplicate:false};
    });
  }
  commitAudio(scope:Scope,job:WorkLease,source:Source):boolean {
    if(!SourceSchema.safeParse(source).success || source.channelId!==scope.channelId || source.runId!==scope.runId || source.kind!=='speech' || source.status!=='active' || !['allowed','redacted'].includes(source.moderation))return false;
    return this.db.transaction(()=>{
      const record=this.db.get(`SELECT j.state,j.lease_token,j.lease_until_ms,a.* FROM jobs j JOIN audio_chunks a ON a.channel_id=j.channel_id AND a.run_id=j.run_id AND a.job_id=j.id
        WHERE j.channel_id=? AND j.run_id=? AND j.id=? AND j.kind='stt'`,...this.scope(scope),job.id);
      if(!record || record.state!=='running' || record.lease_token!==job.leaseToken || Number(record.lease_until_ms)<=this.now())return false;
      const session=this.getSession(scope,String(record.session_id));
      const capture=this.db.get('SELECT actor_id,epoch,session_id FROM capture_leases WHERE channel_id=? AND run_id=?',...this.scope(scope));
      if(!capture || capture.actor_id!==record.actor_id || capture.session_id!==record.session_id || Number(capture.epoch)!==Number(record.capture_epoch) || session.privacyEpoch!==Number(record.privacy_epoch))return false;
      if(session.status==='finalized' || (session.status==='closing' && (!session.endedAt || this.now()>Date.parse(session.endedAt)+90000)))return false;
      if(source.sessionId!==session.id || source.id!==record.source_id || source.startMs!==Number(record.start_ms) || source.endMs!==Number(record.end_ms) || source.revision!==1 || this.tombstoned(scope,source))return false;
      const occurredAt=new Date(Date.parse(session.startedAt)+source.endMs).toISOString();
      const event:EventEnvelope<unknown>={...scope,schemaVersion:1,eventId:`speech_${digest([scope,job.id]).slice(0,40)}`,externalId:job.id,origin:'microphone',kind:'speech.transcribed',occurredAt,receivedAt:new Date(this.now()).toISOString(),sessionId:source.sessionId,sessionOffsetMs:source.endMs,payload:{source,captureEpoch:Number(record.capture_epoch)}};
      const accepted=this.ingest(event,{sources:[source]});
      if(!accepted.accepted)return false;
      this.finishJob(scope,job.id,job.leaseToken,'done');
      this.db.run('UPDATE audio_chunks SET raw_path=NULL WHERE channel_id=? AND run_id=? AND job_id=?',...this.scope(scope),job.id);
      return true;
    });
  }
  preparePublication(scope:Scope,input:WorkInput):{id:string;publishSeq:number} {
    return this.db.transaction(()=>{
      const existing=this.db.get('SELECT id,publish_seq FROM outbox WHERE channel_id=? AND run_id=? AND business_key=?',...this.scope(scope),input.businessKey);
      if (existing?.publish_seq != null) return {id:String(existing.id),publishSeq:Number(existing.publish_seq)};
      const id=this.insertWork('outbox',scope,input);
      const row=this.db.get('SELECT publish_seq FROM outbox WHERE channel_id=? AND run_id=? AND id=?',...this.scope(scope),id)!;
      return {id,publishSeq:row.publish_seq == null ? this.assignPublicationSequence(scope,id) : Number(row.publish_seq)};
    });
  }
  private assignPublicationSequence(scope:Scope,id:string):number {
    this.db.run('UPDATE channels SET publish_seq=publish_seq+1 WHERE channel_id=? AND run_id=?',...this.scope(scope));
    const row=this.db.get('SELECT publish_seq FROM channels WHERE channel_id=? AND run_id=?',...this.scope(scope))!;
    this.db.run('UPDATE outbox SET publish_seq=? WHERE channel_id=? AND run_id=? AND id=?',Number(row.publish_seq),...this.scope(scope),id);
    return Number(row.publish_seq);
  }
  acknowledgePublication(scope:Scope,publishSeq:number,bodyHash:string):boolean {
    return this.db.transaction(()=>{
      const row=this.db.get('SELECT publish_seq FROM channels WHERE channel_id=? AND run_id=?',...this.scope(scope));
      if (!row||publishSeq>Number(row.publish_seq)) return false;
      const previous=this.db.get('SELECT ack_seq,ack_hash FROM publication_sync WHERE channel_id=? AND run_id=?',...this.scope(scope));
      if(previous && Number(previous.ack_seq)===publishSeq && previous.ack_hash && previous.ack_hash!==bodyHash)return false;
      const frozen=this.db.get('SELECT frozen_hash FROM outbox WHERE channel_id=? AND run_id=? AND publish_seq=?',...this.scope(scope),publishSeq);
      if(frozen?.frozen_hash && frozen.frozen_hash!==bodyHash)return false;
      return this.db.run('UPDATE publication_sync SET ack_seq=?,ack_hash=?,last_synced_at_ms=?,pending_privacy=CASE WHEN ?=? THEN 0 ELSE pending_privacy END WHERE channel_id=? AND run_id=? AND ack_seq<=?',publishSeq,bodyHash,this.now(),publishSeq,Number(row.publish_seq),...this.scope(scope),publishSeq).changes===1;
    });
  }
  getPublicationState(scope:Scope) {
    const row=this.db.get('SELECT c.publish_seq,c.privacy_revision,s.ack_seq,s.ack_hash,s.last_synced_at_ms,s.pending_privacy FROM channels c JOIN publication_sync s ON s.channel_id=c.channel_id AND s.run_id=c.run_id WHERE c.channel_id=? AND c.run_id=?',...this.scope(scope));
    if(!row)throw new StorageError('inaccessible','Channel publication state is unavailable.');
    return {publishSeq:Number(row.publish_seq),privacyRevision:Number(row.privacy_revision),ackSeq:Number(row.ack_seq),ackHash:row.ack_hash===null ? null : String(row.ack_hash),lastSyncedAtMs:row.last_synced_at_ms===null ? null : Number(row.last_synced_at_ms),pendingPrivacy:Boolean(row.pending_privacy)};
  }
  freezePublication(scope:Scope,id:string,leaseToken:string,input:{body:string;bodyHash:string}):{body:string;bodyHash:string}|null {
    if(Buffer.byteLength(input.body)>3_500_000 || createHash('sha256').update(input.body).digest('hex')!==input.bodyHash)throw new StorageError('invalid_input','Publication body or hash is invalid.');
    return this.db.transaction(()=>{
      const row=this.db.get(`SELECT o.* FROM outbox o JOIN sessions s ON s.channel_id=o.channel_id AND s.run_id=o.run_id AND s.id=o.session_id
        WHERE o.channel_id=? AND o.run_id=? AND o.id=? AND o.lease_token=? AND o.state='running' AND o.lease_until_ms>? AND o.privacy_epoch=s.privacy_epoch AND o.kind IN ('publish','retract','export_manifest')`,...this.scope(scope),id,leaseToken,this.now());
      if(!row)return null;
      if(row.frozen_body!==null)return {body:String(row.frozen_body),bodyHash:String(row.frozen_hash)};
      this.db.run('UPDATE outbox SET frozen_body=?,frozen_hash=? WHERE channel_id=? AND run_id=? AND id=?',input.body,input.bodyHash,...this.scope(scope),id);
      return input;
    });
  }
  listPendingDomainEvents(scope:Scope,sessionId:string,limit=100):{event:EventEnvelope<unknown>;sources:Source[]}[] {
    this.session(scope,sessionId);
    const rows=this.db.all('SELECT * FROM events WHERE channel_id=? AND run_id=? AND session_id=? AND domain_processed=0 AND payload IS NOT NULL ORDER BY occurred_at,id LIMIT ?',...this.scope(scope),sessionId,Math.min(integer(limit,1),100));
    return rows.map(row=>({event:{...scope,schemaVersion:1,eventId:String(row.id),externalId:String(row.external_id),origin:String(row.origin) as EventEnvelope<unknown>['origin'],kind:String(row.kind),occurredAt:String(row.occurred_at),receivedAt:String(row.received_at),sessionId,sessionOffsetMs:row.offset_ms===null ? null : Number(row.offset_ms),payload:JSON.parse(String(row.payload))},sources:this.db.all('SELECT id FROM sources WHERE channel_id=? AND run_id=? AND event_id=? ORDER BY start_ms,id LIMIT 500',...this.scope(scope),String(row.id)).map(source=>this.getSource(scope,String(source.id))!)}));
  }
  /** Cleanup identity survives a late clip result, but never becomes publishable content. */
  recordRemoteArtifact(scope:Scope,outboxId:string,clipId:string):boolean {
    return this.db.run('UPDATE outbox SET outcome=? WHERE channel_id=? AND run_id=? AND id=?',json({clipId,manageUrl:'https://dashboard.twitch.tv/content/clips',cleanupOnly:true}),...this.scope(scope),outboxId).changes===1;
  }
}
