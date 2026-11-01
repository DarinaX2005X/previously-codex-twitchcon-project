import { randomUUID } from 'node:crypto';
import {
  recoverDomainState, reduceDomain, canonical, canDispatch,
  type DomainState, type DomainEvent, type DomainEffect, type GenerationRequest,
} from '../../core/index.js';
import { safetyAllowsPublication, type Channel, type Clock, type EventEnvelope, type OwnerSnapshot, type Scope, type Settings, type Source, type SourceStatus, type StoryProvider, type Safety } from '../../shared/contracts/index.js';
import { createStorage, type WorkLease } from '../storage/index.js';
import type { SafetyService } from '../providers/safety.js';
import type { OpenAIStoryProvider } from '../providers/story.js';
import type { TwitchStream } from '../twitch/helix.js';
import { ApiError } from './errors.js';
import type { JobResult } from './scheduler.js';
import { RevisionStream } from './updates.js';
import { normalizeInput } from './input.js';

export type DispatchOptions = {
  envelope?: EventEnvelope; idempotencyKey?: string; requestBody?: unknown;
  expectedEntity?: {id: string; revision: number};
  settingsPatch?: {baseRevision: number; patch: Partial<Omit<Settings, 'revision'>>};
};
export type RuntimeStorage = ReturnType<typeof createStorage>;
export type EngineOptions = {
  channel: Channel; scope: Scope; storage: RuntimeStorage; clock: Clock; updates: RevisionStream;
  safety: SafetyService; story: StoryProvider & Partial<Pick<OpenAIStoryProvider, 'review' | 'present'>>;
  isOwnEcho?: (messageId: string) => boolean;
  onEffects?: (sessionId: string, effects: readonly DomainEffect[], state: DomainState) => void;
};
const unavailable = (message: string): SourceStatus => ({state: 'unconfigured', lastObservedAt: null, message, action: null});
const held: Safety = {moderation: 'pending', pii: 'pending', checkedAt: null, reason: null};

/** One coordinator serializes pure transitions; SQLite owns accepted work and all final fences. */
export class StoryEngine {
  readonly scope: Scope; readonly channel: Channel; readonly storage: RuntimeStorage;
  readonly repository: RuntimeStorage['repository']; readonly clock: Clock; readonly safety: SafetyService;
  private chain: Promise<unknown> = Promise.resolve();
  private safetyBusy = false;
  private nextSafetyAtMs = 0;
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
  statuses(): OwnerSnapshot['status'] {return structuredClone(this.sourceStatus);}
  setStatus(key: keyof OwnerSnapshot['status'], value: SourceStatus): void {
    if (canonical(this.sourceStatus[key]) === canonical(value)) return;
    this.sourceStatus[key] = value;
    this.options.updates.publish({...this.scope, event: 'source.status', data: {sessionId: this.activeSessionId(), revision: 0}});
  }
  activeSessionId(): string | null {
    return this.repository.getActiveSession(this.scope)?.id ?? null;
  }
  state(sessionId: string): DomainState {
    return recoverDomainState({...this.repository.getDomainHydration(this.scope, sessionId), channel: this.channel}, {resumePlayback: true});
  }
  dispatch(sessionId: string, event: DomainEvent, options: DispatchOptions = {}): Promise<DomainState> {
    const operation = this.chain.then(() => {
      const previous = this.state(sessionId);
      const input: DomainEvent = options.settingsPatch ? {type: 'settings', baseRevision: options.settingsPatch.baseRevision, settings: {...previous.settings, ...options.settingsPatch.patch, revision: options.settingsPatch.baseRevision + 1}} : event;
      const transition = reduceDomain(previous, input, this.clock);
      if (options.settingsPatch && transition.state.settings.revision !== options.settingsPatch.baseRevision + 1) throw new ApiError(409, 'settings_not_ready', 'The requested setting is not ready. The previous setting is still active.');
      const result = this.repository.applyDomainTransition(this.scope, sessionId, {
        expectedRevision: previous.revision, expectedPrivacyEpoch: previous.session.privacyEpoch,
        transition, event: options.envelope ?? this.envelope(sessionId, input.type, {type: input.type}),
        ...(options.idempotencyKey ? {idempotencyKey: options.idempotencyKey} : {}),
        ...(options.requestBody !== undefined ? {requestBody: options.requestBody} : {}),
        ...(options.expectedEntity ? {expectedEntity: options.expectedEntity} : {}),
        ...(options.settingsPatch ? {settingsPatch: options.settingsPatch} : {}),
      });
      const next = this.state(sessionId);
      if (!result.applied) return next;
      if (next.revision !== previous.revision) this.options.updates.publish({...this.scope, event: 'snapshot.changed', data: {sessionId, revision: next.revision}});
      for (const effect of transition.effects) {
        if (effect.type === 'privacy') this.options.updates.publish({...this.scope, event: 'privacy.invalidated', data: {sessionId, revision: next.revision, affectedIds: effect.receipt.hiddenEntityIds.slice(0, 100)}});
        if (effect.type === 'playback.prepare' || effect.type === 'playback.start' || effect.type === 'playback.cancel') this.options.updates.publish({...this.scope, event: effect.type, data: {sessionId, revision: next.revision, affectedIds: [effect.playback.id]}});
        if (effect.type === 'held') this.setStatus('story', {state: 'delayed', lastObservedAt: this.clock.iso(), message: 'The previous safe recap stays available while new material is checked.', action: null});
      }
      this.options.onEffects?.(sessionId, transition.effects, next);
      return next;
    });
    this.chain = operation.catch(() => {});
    return operation;
  }
  envelope(sessionId: string, kind: string, payload: unknown, id = randomUUID()): EventEnvelope {
    const session = this.repository.getSession(this.scope, sessionId);
    return {...this.scope, schemaVersion: 1, eventId: `local:${id}`, externalId: id, origin: this.scope.runId === 'live' ? 'owner' : 'replay', kind, occurredAt: this.clock.iso(), receivedAt: this.clock.iso(), sessionId, sessionOffsetMs: Math.max(0, this.clock.now() - Date.parse(session.startedAt)), payload};
  }
  async ingest(envelope: EventEnvelope): Promise<void> {
    if (envelope.channelId !== this.scope.channelId || envelope.runId !== this.scope.runId) throw new ApiError(403, 'wrong_scope', 'This event belongs to another stream.');
    if (!envelope.sessionId) {this.repository.ingest({...envelope, payload: null}); return;}
    const state = this.state(envelope.sessionId);
    const payload = envelope.payload as Record<string, unknown> | null;
    const normalized = normalizeInput(envelope, state.session, {paused: state.settings.listeningPaused, ownEcho: typeof payload?.message_id === 'string' && this.options.isOwnEcho?.(payload.message_id)});
    if (envelope.kind === 'channel.update') {
      const title = typeof payload?.title === 'string' ? payload.title.slice(0, 200) : '';
      const category = typeof payload?.category_name === 'string' ? payload.category_name.slice(0, 100) : '';
      await this.reviewMetadata(state.session.id, title, category, envelope);
      return;
    }
    await this.dispatch(state.session.id, normalized.domain ?? {type: 'tick'}, {envelope: normalized.event});
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
    const sessions = this.repository.listSessions(this.scope, {limit: 50});
    const at = Date.parse(occurredAt);
    const selected = streamId ? sessions.find(session => session.twitchStreamId === streamId) : sessions.find(session => Date.parse(session.startedAt) <= at && (!session.endedAt || at <= Date.parse(session.endedAt)));
    return selected ? {id: selected.id, startedAt: selected.startedAt} : null;
  }
  private async reviewMetadata(sessionId: string, title: string, category: string, envelope?: EventEnvelope): Promise<void> {
    const values = await this.safety.inspectBatch([{id: 'title', text: title}, {id: 'category', text: category}]);
    const safeTitle = values.find(value => value.id === 'title'), safeCategory = values.find(value => value.id === 'category');
    const safety = safeTitle && safeCategory && safetyAllowsPublication(safeTitle.safety) && safetyAllowsPublication(safeCategory.safety) ? safeTitle.safety : held;
    const session = this.repository.getSession(this.scope, sessionId);
    await this.dispatch(sessionId, {type: 'metadata', title: safeTitle?.text ?? '', category: safeCategory?.text ?? '', atMs: Math.max(0, this.clock.now() - Date.parse(session.startedAt)), safety}, envelope ? {envelope} : {});
  }
  allowed(input: {sessionId: string; privacyEpoch: number; dependencyRefs: {id: string; revision: number}[]}): boolean {
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
        for (const source of state.sources.slice().reverse()) {
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
      if (chapter && this.options.story.present && this.allowed({sessionId: job.sessionId, privacyEpoch: job.privacyEpoch, dependencyRefs: request.ticket.inputRefs})) {
        const claimRefs = cleaned.claims.map(claim => ({id: claim.id, revision: state.nodes[claim.id]?.revision ?? 0}));
        const presentations = await this.options.story.present(cleaned.claims, {entityId: chapter.id, revision: chapter.revision, eligibleAt: chapter.eligibleAt, claimRefs}, this.safety, signal);
        for (const language of ['en', 'ru'] as const) {
          const value = presentations[language];
          await this.dispatch(job.sessionId, {type: 'presentation', entityId: chapter.id, baseRevision: chapter.revision, ownerRevision: chapter.ownerEditRevision, language, title: value.title, summary: value.summary, safety: value.safety, inputRefs: chapter.dependencyRefs, current: {...value.current, sourceTimeMs: chapter.maxDependencyEndMs, maxDependencyEndMs: chapter.maxDependencyEndMs}});
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
    const state = this.state(sessionId), chapter = state.chapters.find(value => value.id === entityId);
    if (!chapter || !chapter.edited || !safetyAllowsPublication(chapter.safety)) return;
    const source = chapter.dependencyRefs.map(ref => state.sources.find(value => value.id === ref.id && value.revision === ref.revision)).find(value => value?.kind === 'owner_statement');
    if (!source?.text || source.status !== 'active') return;
    const ref = {id: source.id, revision: source.revision};
    const presentations = await this.options.story.present([{id: source.id, text: source.text, role: 'state', support: [ref], attribution: 'owner', epistemic: 'explicit'}], {entityId: chapter.id, revision: chapter.revision, eligibleAt: chapter.eligibleAt, claimRefs: [ref]}, this.safety);
    for (const language of ['en', 'ru'] as const) {
      if (language === state.settings.recapLanguage) continue;
      const value = presentations[language];
      await this.dispatch(sessionId, {type: 'presentation', entityId, baseRevision: chapter.revision, ownerRevision: chapter.ownerEditRevision, language, title: value.title, summary: value.summary, safety: value.safety, inputRefs: chapter.dependencyRefs, current: {...value.current, sourceTimeMs: chapter.maxDependencyEndMs, maxDependencyEndMs: chapter.maxDependencyEndMs}});
    }
  }
  async idle(): Promise<void> {await this.chain;}
}
