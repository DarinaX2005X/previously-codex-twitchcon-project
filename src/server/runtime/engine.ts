import { createHash, randomUUID } from 'node:crypto';
import {
  recoverDomainState, hydrateDomainState, reduceDomain, canonical, canDispatch,
  type DomainState, type DomainEvent, type DomainEffect, type GenerationRequest,
} from '../../core/index.js';
import { GroundedClaimSchema, safetyAllowsPublication, type Channel, type Clock, type EventEnvelope, type OwnerIssue, type OwnerSnapshot, type Scope, type Settings, type Source, type SourceStatus, type StoryProvider, type Safety, type StoryPatch, type RecapLanguage } from '../../shared/contracts/index.js';
import { eagerPresentationLanguages } from '../../shared/languages.js';
import { safeLorePresentation } from '../../core/lore-presentations.js';
import { createStorage, StorageError, type WorkLease } from '../storage/index.js';
import type { SafetyService } from '../providers/safety.js';
import type { OpenAIStoryProvider } from '../providers/story.js';
import type { TwitchStream } from '../twitch/helix.js';
import { ApiError } from './errors.js';
import type { JobResult } from './scheduler.js';
import { RevisionStream } from './updates.js';
import { normalizeInput } from './input.js';
import { enrichGenerationHistory, historyEventEntity, loadHistoryEntity } from './history.js';
import { newestSourceFirst } from '../../core/source-retention.js';

export type DispatchOptions = {
  envelope?: EventEnvelope; idempotencyKey?: string; requestBody?: unknown;
  expectedEntity?: {id: string; revision: number};
  settingsPatch?: {baseRevision: number; patch: Partial<Omit<Settings, 'revision'>>};
};
export type RuntimeStorage = ReturnType<typeof createStorage>;
export type CommittedTransition = {sessionId:string;event:DomainEvent;previous:DomainState;state:DomainState;effects:readonly DomainEffect[];atMs:number};
export type EngineOptions = {
  channel: Channel; scope: Scope; storage: RuntimeStorage; clock: Clock; updates: RevisionStream;
  safety: SafetyService; story: StoryProvider & Partial<Pick<OpenAIStoryProvider, 'review' | 'present' | 'proposeLore' | 'presentLore'>>;
  isOwnEcho?: (messageId: string) => boolean;
  onEffects?: (sessionId: string, effects: readonly DomainEffect[], state: DomainState) => void;
  /** Optional owner-armed private recorder. Receives normalized values only after durable commit. */
  onCommittedTransition?: (transition:CommittedTransition) => void;
};
const unavailable = (message: string): SourceStatus => ({state: 'unconfigured', lastObservedAt: null, message, action: null});
const held: Safety = {moderation: 'pending', pii: 'pending', checkedAt: null, reason: null};
export const CHAT_BATCH_LIMIT = 20;
type CommittedDispatch = {previous:DomainState;next:DomainState;input:DomainEvent;effects:readonly DomainEffect[];applied:boolean};

/** One coordinator serializes pure transitions; SQLite owns accepted work and all final fences. */
export class StoryEngine {
  readonly scope: Scope; readonly channel: Channel; readonly storage: RuntimeStorage;
  readonly repository: RuntimeStorage['repository']; readonly clock: Clock; readonly safety: SafetyService;
  private chain: Promise<unknown> = Promise.resolve();
  private safetyBusy = false;
  private nextSafetyAtMs = 0;
  private outputPrivacyBlocked = false;
  private readonly sourceStatus: OwnerSnapshot['status'] = {
    mic: {...unavailable('Choose a microphone to start listening.'), state: 'paused'},
    chat: unavailable('Connect Twitch to receive chat.'), transcription: unavailable('Speech processing is not enabled.'),
    story: unavailable('The story starts with supported stream material.'), moderation: unavailable('New text waits for its safety checks.'),
    cloud: unavailable('Connect the public recap.'), overlay: unavailable('Add the overlay link to OBS.'),
  };
  constructor(private readonly options: EngineOptions) {
    this.scope = options.scope; this.channel = options.channel; this.storage = options.storage;
    this.repository = options.storage.repository; this.clock = options.clock; this.safety = options.safety;
    this.repository.ensureChannel(this.scope, this.channel.login);
  }
  statuses(): OwnerSnapshot['status'] {
    const status = structuredClone(this.sourceStatus);
    if (this.outputPrivacyBlocked) {
      const blocked: SourceStatus = {state: 'error', lastObservedAt: this.clock.iso(), message: 'A received chat removal could not be applied. Recap output is paused until local storage recovers.', action: 'Check local storage'};
      status.story = {...blocked}; status.cloud = {...blocked};
    }
    return status;
  }
  private issueSource: (() => OwnerIssue[]) | null = null;
  /** Live composition supplies current integration problems; replay and tests have none. */
  setIssueSource(source: () => OwnerIssue[]): void {this.issueSource = source;}
  issues(): OwnerIssue[] {try {return this.issueSource?.() ?? [];} catch {return [];}}
  /** Tell owner streams to refetch after a non-status change such as a new integration problem. */
  notifyStatus(): void {let sessionId: string | null = null; try {sessionId = this.activeSessionId();} catch { /* Notification cannot depend on storage. */ } this.options.updates.publish({...this.scope, event: 'source.status', data: {sessionId, revision: 0}});}
  outputsBlocked(): boolean {return this.outputPrivacyBlocked;}
  /** Volatile fail-closed fence also works when SQLite cannot accept the privacy transaction. */
  setOutputsBlocked(blocked: boolean): void {
    if (this.outputPrivacyBlocked === blocked) return;
    this.outputPrivacyBlocked = blocked;
    let sessionId: string | null = null;
    try {sessionId = this.activeSessionId();} catch { /* Invalidation cannot depend on a healthy database. */ }
    this.options.updates.publish({...this.scope, event: blocked ? 'privacy.invalidated' : 'snapshot.changed', data: {sessionId, revision: 0}});
  }
  setStatus(key: keyof OwnerSnapshot['status'], value: SourceStatus): void {
    if (canonical(this.sourceStatus[key]) === canonical(value)) return;
    this.sourceStatus[key] = value;
    this.options.updates.publish({...this.scope, event: 'source.status', data: {sessionId: this.activeSessionId(), revision: 0}});
  }
  activeSessionId(): string | null {
    return this.repository.getActiveSession(this.scope)?.id ?? null;
  }
  state(sessionId: string): DomainState {
    const input = this.repository.getDomainHydration(this.scope, sessionId, {checkpointOnly: true});
    if (input.checkpoint) {
      try {
        const restored = hydrateDomainState(input.checkpoint, {privacyEpoch: input.privacyEpoch, blockedTerms: input.blockedTerms, bannedActors: input.bannedActors, tombstones: input.tombstones});
        restored.revision = input.revision; restored.session = {...input.session}; restored.settings = structuredClone(input.settings);
        restored.captureEpoch = input.captureEpoch; restored.chatClearThroughMs = input.chatClearThroughMs;
        return restored;
      } catch { /* Privacy controls can invalidate a checkpoint without a domain transition. */ }
      return recoverDomainState({...this.repository.getDomainHydration(this.scope, sessionId), channel: this.channel}, {resumePlayback: true});
    }
    return recoverDomainState({...input, channel: this.channel}, {resumePlayback: true});
  }
  entityState(sessionId: string, entityId: string): DomainState {
    return loadHistoryEntity(this.repository, this.repository.getSession(this.scope, sessionId), this.state(sessionId), entityId);
  }
  dispatch(sessionId: string, event: DomainEvent, options: DispatchOptions = {}): Promise<DomainState> {
    const operation = this.chain.then(() => {
      const committed=this.commit(sessionId,event,options,this.state(sessionId));
      this.notifyCommitted(sessionId,committed);
      return committed.next;
    });
    this.chain = operation.catch(() => {});
    return operation;
  }
  private commit(sessionId:string,event:DomainEvent,options:DispatchOptions,previous:DomainState):CommittedDispatch {
      const target = historyEventEntity(event) ?? options.expectedEntity?.id;
      const targetRow=target?this.repository.getEntity(this.scope,target):null;
      if (target && targetRow && ['chapter','lore'].includes(targetRow.kind) && (targetRow.status==='active'||event.type==='term.unblock')) {
        try{previous = loadHistoryEntity(this.repository, previous.session, previous, target);}
        catch(error){if(event.type!=='privacy'||!(error instanceof ApiError&&error.status===404||error instanceof StorageError&&error.code==='capacity'))throw error;}
      }
      const input: DomainEvent = options.settingsPatch ? {type: 'settings', baseRevision: options.settingsPatch.baseRevision, settings: {...previous.settings, ...options.settingsPatch.patch, revision: options.settingsPatch.baseRevision + 1}} : event;
      const transition = reduceDomain(previous, input, this.clock);
      enrichGenerationHistory(this.repository,transition,this.clock.now());
      if (options.settingsPatch && transition.state.settings.revision !== options.settingsPatch.baseRevision + 1) throw new ApiError(409, 'settings_not_ready', 'The requested setting is not ready. The previous setting is still active.');
      const result = this.repository.applyDomainTransition(this.scope, sessionId, {
        expectedRevision: previous.revision, expectedPrivacyEpoch: previous.session.privacyEpoch,
        transition, event: options.envelope ?? this.envelope(sessionId, input.type, {type: input.type}),
        ...(options.idempotencyKey ? {idempotencyKey: options.idempotencyKey} : {}),
        ...(options.requestBody !== undefined ? {requestBody: options.requestBody} : {}),
        ...(options.expectedEntity ? {expectedEntity: options.expectedEntity} : {}),
        ...(options.settingsPatch ? {settingsPatch: options.settingsPatch} : {}),
      });
      // Persistence returns the exact committed checkpoint, including settings,
      // publication and privacy adjustments. Do not reread its entire projection.
      // This is a per-transition value, never a cache of external repository writes.
      const next = result.checkpoint ?? this.state(sessionId);
      return {previous,next,input,effects:transition.effects,applied:result.applied};
  }
  private notifyCommitted(sessionId:string,{previous,next,input,effects,applied}:CommittedDispatch):void {
      if (!applied) return;
      this.options.onCommittedTransition?.({sessionId,event:input,previous,state:next,effects,atMs:Math.max(0,Math.floor(this.clock.now()-Date.parse(next.session.startedAt)))});
      if (next.revision !== previous.revision) this.options.updates.publish({...this.scope, event: 'snapshot.changed', data: {sessionId, revision: next.revision}});
      for (const effect of effects) {
        if (effect.type === 'privacy') this.options.updates.publish({...this.scope, event: 'privacy.invalidated', data: {sessionId, revision: next.revision, affectedIds: effect.receipt.hiddenEntityIds.slice(0, 100)}});
        if (effect.type === 'playback.prepare' || effect.type === 'playback.start' || effect.type === 'playback.cancel') this.options.updates.publish({...this.scope, event: effect.type, data: {sessionId, revision: next.revision, affectedIds: [effect.playback.id]}});
        if (effect.type === 'held') this.setStatus('story', {state: 'delayed', lastObservedAt: this.clock.iso(), message: 'The previous safe recap stays available while new material is checked.', action: null});
      }
      this.options.onEffects?.(sessionId, effects, next);
  }
  /** Only already-queued chat shares a commit. Privacy/owner/control events stay outside this boundary. */
  ingestBatch(envelopes:readonly EventEnvelope[]):Promise<void> {
    if(!envelopes.length)return Promise.resolve();
    const sessionId=envelopes[0]!.sessionId;
    if(envelopes.length>CHAT_BATCH_LIMIT || !sessionId || envelopes.some(event=>event.channelId!==this.scope.channelId || event.runId!==this.scope.runId || event.sessionId!==sessionId || event.kind!=='channel.chat.message')) {
      return Promise.reject(new ApiError(400,'invalid_chat_batch','A chat batch must contain at most 20 messages from the same stream.'));
    }
    const items=structuredClone(envelopes);
    const operation=this.chain.then(()=>{
      const committed=this.repository.runDomainBatch(()=>{
        let previous=this.state(sessionId);
        return items.map(envelope=>{
          const payload=envelope.payload as Record<string,unknown>|null;
          const normalized=normalizeInput(envelope,previous.session,{paused:previous.settings.listeningPaused,ownEcho:typeof payload?.message_id==='string'&&this.options.isOwnEcho?.(payload.message_id)});
          const result=this.commit(sessionId,normalized.domain??{type:'tick'},{envelope:normalized.event},previous);
          previous=result.next;return result;
        });
      });
      // Nothing observed outside this transaction can acknowledge a partial batch.
      for(const result of committed)this.notifyCommitted(sessionId,result);
    });
    this.chain=operation.catch(()=>{});
    return operation;
  }
  envelope(sessionId: string, kind: string, payload: unknown, id = randomUUID()): EventEnvelope {
    const session = this.repository.getSession(this.scope, sessionId);
    return {...this.scope, schemaVersion: 1, eventId: `local:${id}`, externalId: id, origin: this.scope.runId === 'live' ? 'owner' : 'replay', kind, occurredAt: this.clock.iso(), receivedAt: this.clock.iso(), sessionId, sessionOffsetMs: Math.max(0, this.clock.now() - Date.parse(session.startedAt)), payload};
  }
  async ingest(envelope: EventEnvelope): Promise<void> {
    if (envelope.channelId !== this.scope.channelId || envelope.runId !== this.scope.runId) throw new ApiError(403, 'wrong_scope', 'This event belongs to another stream.');
    if (!envelope.sessionId) {this.repository.ingest({...envelope, payload: null}); return;}
    const session = this.repository.getSession(this.scope, envelope.sessionId), settings = this.repository.getSettings(this.scope);
    const payload = envelope.payload as Record<string, unknown> | null;
    const normalized = normalizeInput(envelope, session, {paused: settings.listeningPaused, ownEcho: typeof payload?.message_id === 'string' && this.options.isOwnEcho?.(payload.message_id)});
    if (envelope.kind === 'channel.update') {
      const title = typeof payload?.title === 'string' ? payload.title.slice(0, 200) : '';
      const category = typeof payload?.category_name === 'string' ? payload.category_name.slice(0, 100) : '';
      await this.reviewMetadata(session.id, title, category, envelope);
      return;
    }
    await this.dispatch(session.id, normalized.domain ?? {type: 'tick'}, {envelope: normalized.event});
  }
  async drain(sessionId: string): Promise<void> {
    for (const {event} of this.repository.listPendingDomainEvents(this.scope, sessionId, 100)) await this.ingest(event);
  }
  async observeStream(stream: TwitchStream | null, occurredAt: string, streamId?: string): Promise<void> {
    if (stream) {
      const id = `stream_${stream.id}`;
      this.repository.createSession(this.scope, {id, startedAt: stream.started_at, twitchStreamId: stream.id});
      await this.drain(id);
      if (stream.title || stream.game_name) await this.reviewMetadata(id, stream.title, stream.game_name);
      return;
    }
    const id = streamId ? `stream_${streamId}` : this.activeSessionId();
    if (!id) return;
    const session = this.repository.getSession(this.scope, id);
    if (session.status !== 'live' || Date.parse(occurredAt) < Date.parse(session.startedAt)) return;
    await this.dispatch(id, {type: 'closing', endedAt: occurredAt});
  }
  resolveSession(occurredAt: string, streamId?: string): {id: string; startedAt: string} | null {
    const at = Date.parse(occurredAt);
    const matches = (session: ReturnType<RuntimeStorage['repository']['getSession']>) => streamId ? session.twitchStreamId === streamId : Date.parse(session.startedAt) <= at && (!session.endedAt || at <= Date.parse(session.endedAt));
    const open = this.repository.listOpenSessions(this.scope).find(matches);
    if (open) return {id: open.id, startedAt: open.startedAt};
    let cursor: {startedAt: string; id: string} | undefined;
    for (;;) {
      const page = this.repository.listSessions(this.scope, {limit: 50, cursor});
      const selected = page.find(matches);
      if (selected) return {id: selected.id, startedAt: selected.startedAt};
      if (page.length < 50) return null;
      cursor = {id: page.at(-1)!.id, startedAt: page.at(-1)!.startedAt};
    }
  }
  private async reviewMetadata(sessionId: string, title: string, category: string, envelope?: EventEnvelope): Promise<void> {
    const values = await this.safety.inspectBatch([{id: 'title', text: title}, {id: 'category', text: category}]);
    const safeTitle = values.find(value => value.id === 'title'), safeCategory = values.find(value => value.id === 'category');
    const safety = safeTitle && safeCategory && safetyAllowsPublication(safeTitle.safety) && safetyAllowsPublication(safeCategory.safety) ? safeTitle.safety : held;
    const session = this.repository.getSession(this.scope, sessionId);
    const observedAt = envelope ? Date.parse(envelope.occurredAt) : this.clock.now();
    await this.dispatch(sessionId, {type: 'metadata', title: safeTitle?.text ?? '', category: safeCategory?.text ?? '', atMs: Math.max(0, observedAt - Date.parse(session.startedAt)), safety}, envelope ? {envelope: {...envelope, payload: {type: 'metadata'}}} : {});
  }
  allowed(input: {sessionId: string; privacyEpoch: number; dependencyRefs: {id: string; revision: number}[]}): boolean {
    if (this.outputPrivacyBlocked) return false;
    try {return canDispatch(this.state(input.sessionId), input);} catch {return false;}
  }
  async tick(): Promise<void> {
    for (const session of this.repository.listOpenSessions(this.scope)) {
      await this.drain(session.id);
      if (session.status === 'closing' && session.endedAt && this.clock.now() >= Date.parse(session.endedAt) + 90_000 && !this.repository.pendingJobCount(this.scope, session.id, ['stt'])) {
        await this.dispatch(session.id, {type: 'tail.drained'});
      }
      await this.dispatch(session.id, {type: 'tick'});
    }
  }
  /** A cold process cancels unfinished output before any overlay can subscribe. */
  async recoverPlayback(): Promise<void> {
    for (const session of this.repository.listOpenSessions(this.scope)) {
      for (const playback of this.state(session.id).playbacks) {
        if (['queued', 'preparing', 'playing'].includes(playback.status)) await this.dispatch(session.id, {type: 'playback', id: playback.id, action: 'cancel'});
      }
    }
  }
  async checkPendingSources(): Promise<void> {
    if (this.safetyBusy || this.clock.now() < this.nextSafetyAtMs) return;
    this.safetyBusy = true;
    try {
      for (const session of this.repository.listOpenSessions(this.scope)) {
        const state = this.state(session.id);
        if (state.settings.listeningPaused) continue;
        const selected: Source[] = []; let length = 0;
        // Review fresh spoken/metadata context before a chat flood consumes the bounded batch.
        // Owner statements retain their dedicated title/summary review and revision fence.
        const pending = state.sources.slice().sort((a,b)=>Number(a.kind==='chat')-Number(b.kind==='chat')||newestSourceFirst(a,b));
        for (const source of pending) {
          // Owner reviews cover their title and summary together, with their own revision fence.
          if (source.kind === 'owner_statement' || source.status === 'deleted' || !['pending', 'unavailable'].includes(source.moderation) || !source.text) continue;
          const size = Buffer.byteLength(JSON.stringify(source.text));
          if (selected.length >= 30 || length + size > 3500) continue;
          selected.push(source); length += size;
        }
        if (!selected.length) continue;
        const checked = await this.safety.inspectBatch(selected.map(source => ({id: source.id, text: source.text!})));
        for (const result of checked) {
          const source = selected.find(source => source.id === result.id);
          if (source) await this.dispatch(session.id, {type: 'source.safety', id: source.id, baseRevision: source.revision, text: result.text, safety: result.safety});
        }
      }
    } finally {this.safetyBusy = false; this.nextSafetyAtMs = this.clock.now() + 30_000;}
  }
  async executeStory(job: WorkLease, signal: AbortSignal): Promise<JobResult> {
    const request = (job.payload as {request?: GenerationRequest})?.request;
    if (!request || !this.allowed({sessionId: job.sessionId, privacyEpoch: job.privacyEpoch, dependencyRefs: request.ticket.inputRefs})) return {state: 'failed'};
    try {
      const prepared = await this.safety.prepareEvidence(request.packet, signal);
      if (canonical(prepared) !== canonical(request.packet)) throw new Error('Evidence requires a new reviewed revision.');
      const response = await this.options.story.propose(prepared, request.ticket, signal);
      const patch = response.value;
      const checked = await this.safety.inspectBatch([{id: 'title', text: patch.title ?? ''}, ...patch.claims.map(claim => ({id: `claim:${claim.id}`, text: claim.text}))], signal);
      if (checked.some(result => !safetyAllowsPublication(result.safety))) throw new Error('Story held for safety review.');
      const cleaned = {...patch, title: checked.find(result => result.id === 'title')?.text ?? null, claims: patch.claims.map(claim => ({...claim, text: checked.find(result => result.id === `claim:${claim.id}`)?.text ?? claim.text}))};
      const grounding = this.options.story.review ? (await this.options.story.review(prepared, request.ticket, cleaned, signal)).value : undefined;
      signal.throwIfAborted();
      const state = await this.dispatch(job.sessionId, {type: 'generation.result', ticket: request.ticket, patch: cleaned, safety: checked[0]?.safety ?? held, ...(grounding ? {grounding} : {})});
      const chapter = state.chapters.find(chapter => chapter.id === request.entityId);
      if (chapter && chapter.revision === request.ticket.baseEntityRevision + 1 && chapter.ownerEditRevision === request.ticket.ownerEditRevision && this.options.story.present && this.allowed({sessionId: job.sessionId, privacyEpoch: job.privacyEpoch, dependencyRefs: request.ticket.inputRefs})) {
        // The reducer namespaces accepted claim IDs. Translate the committed claims, not provider-local IDs.
        const committedClaims = chapter.claimIds.map(id => GroundedClaimSchema.parse(state.nodes[id]?.body));
        const claimRefs = chapter.claimIds.map(id => ({id, revision: state.nodes[id]!.revision}));
        // The chosen language and English are presented right away; any other language is prepared when the owner switches to it.
        const languages = eagerPresentationLanguages(request.ticket.recapLanguage);
        const presentations = await this.options.story.present(committedClaims, {entityId: chapter.id, revision: chapter.revision, eligibleAt: chapter.eligibleAt, claimRefs}, this.safety, signal, languages);
        for (const language of languages) {
          const value = presentations[language];
          if (!value) continue;
          await this.dispatch(job.sessionId, {type: 'presentation', entityId: chapter.id, baseRevision: chapter.revision, ownerRevision: chapter.ownerEditRevision, language, title: value.title, summary: value.summary, safety: value.safety, inputRefs: chapter.dependencyRefs, current: {...value.current, sourceTimeMs: chapter.maxDependencyEndMs, maxDependencyEndMs: chapter.maxDependencyEndMs}});
        }
      }
      if (this.options.story.proposeLore && this.allowed({sessionId: job.sessionId, privacyEpoch: job.privacyEpoch, dependencyRefs: request.ticket.inputRefs})) {
        const registered = new Set(request.ticket.inputRefs.map(ref => `${ref.id}:${ref.revision}`));
        const phrases = state.phrases.filter(phrase => phrase.actors.length >= 2 && phrase.refs.every(ref => registered.has(`${ref.id}:${ref.revision}`)) && !state.lore.some(lore => lore.term === phrase.term && lore.originKind !== 'unknown')).slice(-5).map(phrase => ({
          id: `lore:${createHash('sha256').update(job.sessionId).update(':').update(phrase.term).digest('hex').slice(0, 32)}`, term: phrase.term, aliases: phrase.aliases,
        }));
        if (phrases.length) {
          // Lore failure does not delay an already accepted chapter or a raid.
          try {
            const proposals = await this.options.story.proposeLore(prepared, phrases, this.safety, signal);
            if (this.allowed({sessionId: job.sessionId, privacyEpoch: job.privacyEpoch, dependencyRefs: request.ticket.inputRefs})) for (const proposal of proposals.value.candidates) {
              await this.dispatch(job.sessionId, {type: 'lore.propose', ...proposal, exposureRefs: request.ticket.inputRefs, language: request.ticket.recapLanguage});
              try {await this.presentOwnerLore(job.sessionId, proposal.id, signal);} catch {signal.throwIfAborted();}
            }
            for (const observation of proposals.value.observations) {
              const phrase = phrases.find(value => value.id === observation.id && value.term === observation.term);
              if (!phrase || !observation.evidenceRefs.length || !safetyAllowsPublication(observation.safety)
                || !observation.evidenceRefs.every(ref => registered.has(`${ref.id}:${ref.revision}`))
                || !this.allowed({sessionId: job.sessionId, privacyEpoch: job.privacyEpoch, dependencyRefs: request.ticket.inputRefs})
                || this.state(job.sessionId).lore.some(lore => lore.id === observation.id)) continue;
              await this.dispatch(job.sessionId, {type: 'lore.propose', ...phrase, explanation: '', originRefs: [],
                exposureRefs: request.ticket.inputRefs, language: request.ticket.recapLanguage,
                safety: {...observation.safety, reason: 'origin_needs_confirmation'},
              });
            }
          } catch {signal.throwIfAborted(); /* Rejected terms and provider outages remain observations only. */}
        }
      }
      this.setStatus('story', {state: 'ready', lastObservedAt: this.clock.iso(), message: null, action: null});
      return {state: 'done'};
    } catch {
      if (!signal.aborted) await this.dispatch(job.sessionId, {type: 'generation.failed', jobId: request.ticket.jobId, reason: 'provider_unavailable_or_held'});
      return {state: 'failed'};
    }
  }
  async presentOwnerChapter(sessionId: string, entityId: string): Promise<void> {
    if (!this.options.story.present) return;
    const state = this.entityState(sessionId, entityId), chapter = state.chapters.find(value => value.id === entityId);
    if (!chapter || !chapter.edited || !safetyAllowsPublication(chapter.safety)) return;
    const source = chapter.dependencyRefs.map(ref => state.sources.find(value => value.id === ref.id && value.revision === ref.revision)).find(value => value?.kind === 'owner_statement');
    if (!source?.text || source.status !== 'active') return;
    const ref = {id: source.id, revision: source.revision};
    const languages = eagerPresentationLanguages(state.settings.recapLanguage).filter(language => language !== state.settings.recapLanguage);
    if (!languages.length) return;
    const presentations = await this.options.story.present([{id: source.id, text: source.text, role: 'state', support: [ref], attribution: 'owner', epistemic: 'explicit'}], {entityId: chapter.id, revision: chapter.revision, eligibleAt: chapter.eligibleAt, claimRefs: [ref]}, this.safety, undefined, languages);
    for (const language of languages) {
      const value = presentations[language];
      if (!value) continue;
      await this.dispatch(sessionId, {type: 'presentation', entityId, baseRevision: chapter.revision, ownerRevision: chapter.ownerEditRevision, language, title: value.title, summary: value.summary, safety: value.safety, inputRefs: chapter.dependencyRefs, current: {...value.current, sourceTimeMs: chapter.maxDependencyEndMs, maxDependencyEndMs: chapter.maxDependencyEndMs}});
    }
  }
  async presentOwnerLore(sessionId: string, entityId: string, signal?: AbortSignal): Promise<void> {
    if (!this.options.story.presentLore) return;
    const state = this.entityState(sessionId, entityId), lore = state.lore.find(value => value.id === entityId);
    if (!lore || !['confirmed', 'published'].includes(lore.status) || !safetyAllowsPublication(lore.safety)) return;
    const originRefs = state.nodes[entityId]?.supports ?? [];
    const languages = eagerPresentationLanguages(state.settings.recapLanguage);
    const presentations = await this.options.story.presentLore({term: lore.term, explanation: lore.explanation, originRefs}, this.safety, signal, languages);
    for (const language of languages) {
      const value = presentations[language];
      if (!value) continue;
      await this.dispatch(sessionId, {type: 'lore.presentation', id: entityId, baseRevision: lore.revision, privacyEpoch: state.session.privacyEpoch, language, term: value.term, explanation: value.explanation, safety: value.safety, inputRefs: [{id: entityId, revision: lore.revision}, ...lore.dependencyRefs]});
    }
  }
  /**
   * Before a language switch: presents every published chapter and lore entry that has no checked wording in
   * `language` yet, from the same committed claims. The switch itself stays a domain decision; anything that
   * cannot be prepared keeps the switch held, as before.
   */
  async prepareLanguage(sessionId: string, language: RecapLanguage, signal?: AbortSignal): Promise<void> {
    const state = this.state(sessionId), published = state.published;
    if (!published || language === state.settings.recapLanguage) return;
    const active = (refs: readonly {id: string; revision: number}[]) => this.allowed({sessionId, privacyEpoch: state.session.privacyEpoch, dependencyRefs: [...refs]});
    const present = this.options.story.present?.bind(this.options.story);
    const jobs = present ? published.chapters.flatMap(visible => {
      const ready = state.candidates.some(c => c.entityId === visible.id && c.revision === visible.revision && c.language === language && safetyAllowsPublication(c.safety) && (c.status === 'published' || c.privacyEpoch === state.session.privacyEpoch));
      const base = state.candidates.find(c => c.entityId === visible.id && c.revision === visible.revision && c.status === 'published' && c.language === state.settings.recapLanguage);
      const chapter = state.chapters.find(c => c.id === visible.id);
      return ready || !base || !chapter || !active(base.chapter.dependencyRefs) ? [] : [{visible, base, ownerRevision: chapter.ownerEditRevision}];
    }) : [];
    // A few chapters at a time: each one is a generation, a safety check and a faithfulness review.
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const {visible, base, ownerRevision} = job;
        try {
          const owner = base.chapter.edited ? base.chapter.dependencyRefs.map(ref => state.sources.find(value => value.id === ref.id && value.revision === ref.revision)).find(value => value?.kind === 'owner_statement') : undefined;
          const ownerClaim = owner?.text && owner.status === 'active' ? owner : undefined;
          const claims: StoryPatch['claims'] = ownerClaim ? [{id: ownerClaim.id, text: ownerClaim.text!, role: 'state', support: [{id: ownerClaim.id, revision: ownerClaim.revision}], attribution: 'owner', epistemic: 'explicit'}] : base.chapter.claimIds.map(id => GroundedClaimSchema.parse(state.nodes[id]?.body));
          const claimRefs = ownerClaim ? [{id: ownerClaim.id, revision: ownerClaim.revision}] : base.chapter.claimIds.map(id => ({id, revision: state.nodes[id]!.revision}));
          const value = (await present!(claims, {entityId: visible.id, revision: visible.revision, eligibleAt: base.chapter.eligibleAt, claimRefs}, this.safety, signal, [language]))[language];
          if (value) await this.dispatch(sessionId, {type: 'presentation', entityId: visible.id, baseRevision: visible.revision, ownerRevision, language, title: value.title, summary: value.summary, safety: value.safety, inputRefs: base.chapter.dependencyRefs, current: {...value.current, sourceTimeMs: base.chapter.maxDependencyEndMs, maxDependencyEndMs: base.chapter.maxDependencyEndMs}});
        } catch {signal?.throwIfAborted(); /* This chapter stays unready; the switch is refused with a clear reason. */}
      }
    };
    await Promise.all(Array.from({length: Math.min(3, jobs.length)}, worker));
    if (this.options.story.presentLore) for (const visible of published.lore) {
      const fresh = this.state(sessionId), lore = fresh.lore.find(item => item.id === visible.id);
      // Same gate as presentOwnerLore: only publishable, privacy-current lore is sent for a new language.
      if (!lore || !['confirmed', 'published'].includes(lore.status) || !safetyAllowsPublication(lore.safety)
        || !this.allowed({sessionId, privacyEpoch: fresh.session.privacyEpoch, dependencyRefs: lore.dependencyRefs})
        || safeLorePresentation(fresh, lore, language)) continue;
      try {
        const originRefs = fresh.nodes[lore.id]?.supports ?? [];
        const value = (await this.options.story.presentLore({term: lore.term, explanation: lore.explanation, originRefs}, this.safety, signal, [language]))[language];
        if (value) await this.dispatch(sessionId, {type: 'lore.presentation', id: lore.id, baseRevision: lore.revision, privacyEpoch: fresh.session.privacyEpoch, language, term: value.term, explanation: value.explanation, safety: value.safety, inputRefs: [{id: lore.id, revision: lore.revision}, ...lore.dependencyRefs]});
      } catch {signal?.throwIfAborted();}
    }
  }
  async idle(): Promise<void> {await this.chain;}
}
