import { z } from 'zod';
import { DEFAULT_RECAP_LANGUAGE, isRecapLanguage, type RecapLanguage } from '../languages.js';

export const IdSchema = z.string().min(1).max(160);
export const IsoTimeSchema = z.string().datetime({ offset: true });
export const OffsetSchema = z.number().int().min(0).max(172_800_000);
export const RevisionSchema = z.number().int().min(0);
/** Any written language as a canonical BCP 47 tag (`en`, `es`, `pt-BR`, `zh-Hant`); see src/shared/languages.ts. */
export const LanguageSchema = z.string().min(2).max(35).refine(isRecapLanguage, { message: 'Use a canonical BCP 47 language tag such as en, es or pt-BR.' });
export type { RecapLanguage };
export const ScopeSchema = z.object({ channelId: IdSchema, runId: IdSchema }).strict();
export type Scope = z.infer<typeof ScopeSchema>;
export const VersionRefSchema = z.object({ id: IdSchema, revision: RevisionSchema }).strict();
export type VersionRef = z.infer<typeof VersionRefSchema>;
export const TimeRangeSchema = z.object({ startMs: OffsetSchema, endMs: OffsetSchema }).strict();
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const EventEnvelopeSchema = ScopeSchema.extend({
  schemaVersion: z.literal(1),
  eventId: IdSchema,
  externalId: IdSchema,
  origin: z.enum(['twitch', 'microphone', 'owner', 'replay', 'mock']),
  kind: z.string().min(1).max(80),
  occurredAt: IsoTimeSchema,
  receivedAt: IsoTimeSchema,
  sessionId: IdSchema.nullable(),
  sessionOffsetMs: OffsetSchema.nullable(),
  payload: z.unknown(),
}).strict();
export type EventEnvelope<T = unknown> = Omit<z.infer<typeof EventEnvelopeSchema>, 'payload'> & { payload: T };

export const SourceSchema = ScopeSchema.extend({
  id: IdSchema,
  sessionId: IdSchema,
  revision: RevisionSchema,
  kind: z.enum(['speech', 'chat', 'channel_metadata', 'owner_statement', 'stream_event']),
  startMs: OffsetSchema,
  endMs: OffsetSchema,
  actorId: IdSchema.nullable(),
  languageCodes: z.array(z.string().min(2).max(16)).max(8),
  timePrecision: z.enum(['chunk', 'event']),
  text: z.string().max(12000).nullable(),
  status: z.enum(['active', 'deleted', 'blocked', 'quarantined']),
  externalMessageId: IdSchema.nullable(),
  moderation: z.enum(['pending', 'allowed', 'redacted', 'unavailable']),
}).strict();
export type Source = z.infer<typeof SourceSchema>;

export const GroundedClaimSchema = z.object({
  id: IdSchema,
  text: z.string().min(1).max(600),
  role: z.enum(['goal', 'attempt', 'change', 'state', 'question', 'outcome', 'lore_origin']),
  support: z.array(VersionRefSchema).min(1).max(20),
  attribution: z.enum(['streamer', 'chat_report', 'owner']),
  epistemic: z.enum(['explicit', 'supported_inference']),
}).strict();
export type GroundedClaim = z.infer<typeof GroundedClaimSchema>;
export const StoryRelationSchema = z.object({
  from: IdSchema, to: IdSchema,
  kind: z.enum(['causes', 'changes', 'follows']),
  support: z.array(VersionRefSchema).min(1).max(20),
}).strict();
export type StoryRelation = z.infer<typeof StoryRelationSchema>;
export const StoryPatchSchema = z.object({
  sessionId: IdSchema,
  baseRevision: RevisionSchema,
  action: z.enum(['hold', 'update', 'new_chapter']),
  title: z.string().max(120).nullable(),
  claims: z.array(GroundedClaimSchema).max(24),
  relations: z.array(StoryRelationSchema).max(32),
  currentAttemptId: IdSchema.nullable(),
  language: z.string().min(2).max(16),
  missingContext: z.array(z.string().max(300)).max(8),
}).strict();
export type StoryPatch = z.infer<typeof StoryPatchSchema>;
export const GenerationTicketSchema = ScopeSchema.extend({
  jobId: IdSchema,
  sessionId: IdSchema,
  privacyEpoch: RevisionSchema,
  baseEntityRevision: RevisionSchema,
  inputRefs: z.array(VersionRefSchema).max(100),
  inputHash: z.string().min(1).max(128),
  schemaVersion: z.number().int().positive(),
  promptVersion: z.string().min(1).max(80),
  recapLanguage: LanguageSchema,
  eligibleAt: IsoTimeSchema,
  ownerEditRevision: RevisionSchema.optional(),
}).strict();
export type GenerationTicket = z.infer<typeof GenerationTicketSchema>;
export type GenerationReason = 'evidence' | 'topic_change' | 'metadata' | 'owner_edit' | 'language' | 'final' | 'lore';
export type CommitResult = { committed: boolean; reason?: string; candidateId?: string; revision?: number };

export const PrivacyTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), sessionId: IdSchema, id: IdSchema }).strict(),
  z.object({ kind: z.literal('message'), sessionId: IdSchema, externalMessageId: IdSchema }).strict(),
  z.object({ kind: z.literal('interval'), sessionId: IdSchema, fromMs: OffsetSchema, toMs: OffsetSchema }).strict(),
  z.object({ kind: z.literal('user'), sessionId: IdSchema, actorId: IdSchema, throughMs: OffsetSchema }).strict(),
  z.object({ kind: z.literal('entity'), sessionId: IdSchema, id: IdSchema }).strict(),
  z.object({ kind: z.literal('session'), sessionId: IdSchema }).strict(),
  z.object({ kind: z.literal('term'), sessionId: IdSchema, term: z.string().min(1).max(120) }).strict(),
]);
export type PrivacyTarget = z.infer<typeof PrivacyTargetSchema>;
export const InvalidationReceiptSchema = z.object({
  revision: RevisionSchema,
  privacyEpoch: RevisionSchema,
  hiddenEntityIds: z.array(IdSchema),
  rebuildStatus: z.enum(['none', 'queued']),
  publicSync: z.enum(['pending', 'synced']),
  externalClipActions: z.array(z.object({ clipId: IdSchema, manageUrl: z.string().url() }).strict()),
}).strict();
export type InvalidationReceipt = z.infer<typeof InvalidationReceiptSchema>;

export const RectSchema = z.object({ x: z.number().min(0).max(1920), y: z.number().min(0).max(1080), width: z.number().min(1).max(1920), height: z.number().min(1).max(1080) }).strict();
export type Rect = z.infer<typeof RectSchema>;
export const OverlayLayoutSchema = z.object({
  preset: z.enum(['left', 'right', 'lower', 'upper']),
  protectedRects: z.array(RectSchema).max(6),
}).strict();
export type OverlayLayout = z.infer<typeof OverlayLayoutSchema>;
export const SettingsSchema = z.object({
  revision: RevisionSchema,
  recapLanguage: LanguageSchema,
  publicationDelaySeconds: z.number().int().min(60).max(90),
  listeningPaused: z.boolean(),
  autoClips: z.boolean(),
  autoRaid: z.boolean(),
  narrationEnabled: z.boolean(),
  broadcastSoundEnabled: z.boolean(),
  volume: z.number().min(0).max(1),
  uiSoundEnabled: z.boolean(),
  layout: OverlayLayoutSchema,
  /** Longest recap length. Short, standard and full are 30, 60 and 120 s; 10–15 s are accepted from older settings. */
  recapDurationMs: z.union([z.literal(10000), z.literal(12000), z.literal(15000), z.literal(30000), z.literal(60000), z.literal(120000)]),
  hotkey: z.string().max(40),
  channelContext: z.string().max(500),
  earlyWelcomeClipId: IdSchema.nullable(),
}).strict();
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings: Settings = {
  revision: 0, recapLanguage: DEFAULT_RECAP_LANGUAGE, publicationDelaySeconds: 75,
  listeningPaused: true, autoClips: false, autoRaid: true,
  narrationEnabled: false, broadcastSoundEnabled: false, volume: 0.35, uiSoundEnabled: false,
  // A typical face cam in the top-right corner. Streamers add or move areas in scene settings.
  layout: { preset: 'lower', protectedRects: [{ x: 1376, y: 64, width: 480, height: 270 }] },
  recapDurationMs: 60000, hotkey: 'Alt+P', channelContext: '', earlyWelcomeClipId: null,
};
export const ChannelSchema = z.object({ id: IdSchema, login: z.string().regex(/^[a-z0-9_]{1,25}$/), displayName: z.string().min(1).max(64) }).strict();
export type Channel = z.infer<typeof ChannelSchema>;
export const SessionSchema = ScopeSchema.extend({
  id: IdSchema,
  twitchStreamId: IdSchema.nullable(),
  title: z.string().max(200), category: z.string().max(100),
  startedAt: IsoTimeSchema, endedAt: IsoTimeSchema.nullable(),
  status: z.enum(['live', 'closing', 'finalized']),
  privacyEpoch: RevisionSchema, publicationRevision: RevisionSchema,
  metadataMaxDependencyEndMs: OffsetSchema,
  finalizedAt: IsoTimeSchema.nullable(), finalSnapshotAckAt: IsoTimeSchema.nullable(),
}).strict();
export type Session = z.infer<typeof SessionSchema>;
export const SourceLabelSchema = z.object({ id: IdSchema, type: SourceSchema.shape.kind, atMs: OffsetSchema, label: z.string().max(120), quote: z.string().max(500).optional() }).strict();
export type SourceLabel = z.infer<typeof SourceLabelSchema>;
export const PublicChapterSchema = z.object({
  id: IdSchema, revision: RevisionSchema, title: z.string().max(120), summary: z.string().max(700),
  startMs: OffsetSchema, endMs: OffsetSchema, mood: z.string().max(40),
  claimIds: z.array(IdSchema).max(24), momentIds: z.array(IdSchema).max(12),
  pinned: z.boolean(), edited: z.boolean(), sourceLabels: z.array(SourceLabelSchema).max(12),
  maxDependencyEndMs: OffsetSchema,
}).strict();
export type PublicChapter = z.infer<typeof PublicChapterSchema>;
export const PublicLoreSchema = z.object({
  id: IdSchema, term: z.string().max(120), explanation: z.string().max(700),
  firstSeenMs: OffsetSchema, originMs: OffsetSchema.nullable(),
  originKind: z.enum(['spoken', 'owner_confirmed', 'unknown']),
  momentId: IdSchema.nullable(), maxDependencyEndMs: OffsetSchema,
}).strict();
export type PublicLore = z.infer<typeof PublicLoreSchema>;
export const ClipSchema = z.object({ id: IdSchema, url: z.string().url(), embedUrl: z.string().url() }).strict();
export const PublicMomentSchema = z.object({
  id: IdSchema, startMs: OffsetSchema, endMs: OffsetSchema, label: z.string().max(160),
  triggerReasons: z.array(z.string().max(80)).max(8), clip: ClipSchema.nullable(),
  mediaState: z.enum(['none', 'pending', 'ready', 'unavailable', 'revoked']), maxDependencyEndMs: OffsetSchema,
}).strict();
export type PublicMoment = z.infer<typeof PublicMomentSchema>;
export const CurrentStateSchema = z.object({
  goal: z.string().max(300).nullable(), change: z.string().max(300).nullable(), now: z.string().max(300).nullable(),
  sourceTimeMs: OffsetSchema, maxDependencyEndMs: OffsetSchema,
}).strict();
export type CurrentState = z.infer<typeof CurrentStateSchema>;
export const PublicSnapshotSchema = z.object({
  schemaVersion: z.literal(1), channel: ChannelSchema,
  session: SessionSchema.pick({ id: true, title: true, category: true, startedAt: true, endedAt: true, status: true, metadataMaxDependencyEndMs: true }),
  revision: RevisionSchema, privacyEpoch: RevisionSchema, language: LanguageSchema,
  asOf: IsoTimeSchema, publishedAt: IsoTimeSchema, liveLeaseUntil: IsoTimeSchema.nullable(),
  current: CurrentStateSchema.nullable(), chapters: z.array(PublicChapterSchema).max(300),
  lore: z.array(PublicLoreSchema).max(50), moments: z.array(PublicMomentSchema).max(200),
  gaps: z.array(TimeRangeSchema).max(100), lastSyncedAt: IsoTimeSchema.nullable(),
  vodUrl: z.string().url().nullable(),
}).strict();
export type PublicSnapshot = z.infer<typeof PublicSnapshotSchema>;

export const SafetySchema = z.object({
  moderation: z.enum(['pending', 'allowed', 'blocked', 'unavailable']),
  pii: z.enum(['pending', 'allowed', 'redacted', 'review']),
  checkedAt: IsoTimeSchema.nullable(), reason: z.string().max(240).nullable(),
}).strict();
export type Safety = z.infer<typeof SafetySchema>;
export const ChapterSchema = PublicChapterSchema.extend({
  sessionId: IdSchema, ownerEditRevision: RevisionSchema,
  publicationState: z.enum(['draft', 'held', 'published', 'deleted']),
  eligibleAt: IsoTimeSchema, safety: SafetySchema, dependencyRefs: z.array(VersionRefSchema).max(100),
}).strict();
export type Chapter = z.infer<typeof ChapterSchema>;
export const LoreSchema = PublicLoreSchema.extend({ sessionId: IdSchema, revision: RevisionSchema, status: z.enum(['observed', 'held', 'confirmed', 'published', 'blocked', 'deleted']), aliases: z.array(z.string().max(120)).max(16), dependencyRefs: z.array(VersionRefSchema).max(100), safety: SafetySchema }).strict();
export type Lore = z.infer<typeof LoreSchema>;
export const MomentSchema = PublicMomentSchema.extend({ sessionId: IdSchema, revision: RevisionSchema, count: z.number().int().min(0), distinctActors: z.number().int().min(0), baseline: z.number().min(0), mediaId: IdSchema.nullable(), dependencyRefs: z.array(VersionRefSchema).max(100) }).strict();
export type Moment = z.infer<typeof MomentSchema>;
export const PresentationSchema = z.object({ id: IdSchema, entityId: IdSchema, revision: RevisionSchema, language: LanguageSchema, title: z.string().max(120), summary: z.string().max(700), claimRefs: z.array(VersionRefSchema).max(24), safety: SafetySchema, eligibleAt: IsoTimeSchema }).strict();
export type Presentation = z.infer<typeof PresentationSchema>;
export const PublicationCandidateSchema = z.object({ id: IdSchema, entityId: IdSchema, revision: RevisionSchema, ownerEditRevision: RevisionSchema, privacyEpoch: RevisionSchema, inputRefs: z.array(VersionRefSchema).max(100), eligibleAt: IsoTimeSchema, status: z.enum(['pending', 'eligible', 'published', 'rejected']), presentation: PresentationSchema }).strict();
export type PublicationCandidate = z.infer<typeof PublicationCandidateSchema>;

/** What the broadcast scene shows, selected only from the published snapshot and its approved lineage. */
export const RecapSceneSchema = z.object({
  channelName: z.string().max(64),
  streamTitle: z.string().max(200).nullable(),
  chapters: z.array(z.object({ id: IdSchema, title: z.string().min(1).max(120), summary: z.string().max(700).optional(), startMs: OffsetSchema, mediaId: IdSchema.nullable() }).strict()).max(12),
  moment: z.object({
    id: IdSchema, chapterId: IdSchema.nullable(), startMs: OffsetSchema, windowSeconds: z.number().int().min(1).max(600),
    count: z.number().int().min(0), mediaId: IdSchema.nullable(), messages: z.array(z.string().min(1).max(40)).max(14),
    /** Stream offset where chat peaked (start of the busiest 2 s); the scene lands its reaction there. */
    burstMs: OffsetSchema.optional(),
  }).strict().nullable(),
  lore: z.object({ term: z.string().min(1).max(120), explanation: z.string().max(300), originMs: OffsetSchema }).strict().nullable(),
  now: z.object({ text: z.string().min(1).max(300), mediaId: IdSchema.nullable() }).strict().nullable(),
  command: z.literal('!previously').nullable(),
}).strict();
export type RecapScene = z.infer<typeof RecapSceneSchema>;

/** A moment clip's in-point sits this far before the moment's start when its capture allows; the scene reads the real offset from `media.inMs`. */
export const MOMENT_CLIP_LEAD_MS = 1000;
export const RecapPlanSchema = z.object({
  id: IdSchema, sessionId: IdSchema, revision: RevisionSchema, privacyEpoch: RevisionSchema,
  language: LanguageSchema, variant: z.enum(['full', 'compact', 'welcome']),
  durationMs: z.number().int().min(5000).max(120_000),
  dependencyRefs: z.array(VersionRefSchema).max(100), layout: OverlayLayoutSchema,
  arrivals: z.array(z.object({ triggerId: IdSchema, fromLogin: z.string().max(25), viewers: z.number().int().min(0) }).strict()).max(5),
  overflowArrivals: z.object({ channels: z.number().int().min(0), viewers: z.number().int().min(0) }).strict(),
  beats: z.array(z.object({ id: IdSchema, kind: z.enum(['context', 'attempt', 'change', 'origin', 'now']), text: z.string().max(300), atMs: OffsetSchema, untilMs: OffsetSchema, sourceRange: TimeRangeSchema, sourceIds: z.array(IdSchema).max(20), mediaId: IdSchema.nullable() }).strict()).max(4),
  media: z.array(z.object({ id: IdSchema, kind: z.enum(['video', 'image']), inMs: OffsetSchema, outMs: OffsetSchema, captureStartMs: OffsetSchema, captureEndMs: OffsetSchema, previousSession: z.boolean() }).strict()).max(12),
  audio: z.object({ id: IdSchema, startMs: OffsetSchema, durationMs: OffsetSchema }).strict().nullable(),
  soundEvents: z.array(z.object({ id: IdSchema, kind: z.string().max(40), atMs: OffsetSchema, gain: z.number().min(0).max(1) }).strict()).max(32),
  generatedAt: IsoTimeSchema,
  scene: RecapSceneSchema.optional(),
}).strict();
export type RecapPlan = z.infer<typeof RecapPlanSchema>;
export type RecapTrigger = { id: string; sessionId: string; reason: 'raid' | 'manual' | 'hotkey'; occurredAt: string; fromLogin?: string; viewers?: number };
/** `skipAt`: the owner skipped a playing recap; the scene goes straight to its outro and ends a moment later. */
export type PlaybackRef = { id: string; status: 'queued' | 'preparing' | 'playing' | 'ended' | 'cancelled' | 'skipped'; plan: RecapPlan | null; startAt: string | null; skipAt?: string | null };
export type CaptureLease = { token: string; epoch: number; captureEpoch: number; expiresAt: string; sessionId: string; anchorTime: string; anchorOffsetMs: number };
export type JobRef = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown_outcome' };
export type SourceStatus = { state: 'unconfigured' | 'disconnected' | 'connecting' | 'ready' | 'listening' | 'paused' | 'delayed' | 'error'; lastObservedAt: string | null; message: string | null; action: string | null };
export type SyncState = { state: 'unconfigured' | 'pending' | 'synced' | 'error'; revision: number; acknowledgedRevision: number | null; lastSyncedAt: string | null; pendingPrivacy: boolean };
export type OwnerSnapshot = {
  channel: Channel; session: Session | null; settings: Settings;
  status: Record<'mic' | 'chat' | 'transcription' | 'story' | 'moderation' | 'cloud' | 'overlay', SourceStatus>;
  published: PublicSnapshot | null; drafts: Chapter[]; held: (Chapter | Lore)[];
  lore: Lore[]; moments: Moment[]; playback: PlaybackRef[]; sync: SyncState;
  revision: number; serverNow: string;
  budget: { limitUsd: number; committedUsd: number; reservedUsd: number; paidCallsEnabled: boolean };
  /** Current integration problems with fixed owner-facing wording; empty when nothing needs attention. Absent in replay. */
  issues?: OwnerIssue[];
};
/** One active integration problem. `reason` says what is wrong, `recovery` what the owner can do; neither contains keys or raw provider text. */
export type OwnerIssue = { source: 'openai' | 'twitch'; component: 'transcription' | 'story' | 'moderation' | 'narration' | 'chat'; code: string; reason: string; recovery: string; since: string };
export type OwnerHistoryQuery = {sessionId: string; kind: 'chapter' | 'lore'; filter?: 'all' | 'published' | 'draft' | 'held'; limit: number; cursor?: string};
export type OwnerHistoryPage = {items: (Chapter | Lore)[]; nextCursor: string | null; privacyEpoch: number; language: RecapLanguage};
export type UpdateEvent = { id: number; event: 'snapshot.changed' | 'snapshot.reset' | 'privacy.invalidated' | 'source.status' | 'publication.synced' | 'playback.prepare' | 'playback.start' | 'playback.cancel'; data: { sessionId: string | null; revision: number; affectedIds?: string[] } };
/** `seek` takes either a milestone id or a recorded offset `atMs` (integer ms, clamped to the recording). A milestone wins when both are given. */
export type ReplayControl = { action: 'play' | 'pause' | 'reset' | 'seek'; speed?: 1 | 2 | 4; milestone?: string; atMs?: number };
export interface RecapClient {
  getSnapshot(): Promise<OwnerSnapshot>;
  subscribe(listener: (event: UpdateEvent) => void): () => void;
  editChapter(id: string, patch: { title: string; summary: string; baseRevision: number }): Promise<Chapter>;
  deleteChapter(id: string, baseRevision: number): Promise<InvalidationReceipt>;
  pinChapter(id: string, pinned: boolean, baseRevision: number): Promise<Chapter>;
  saveMoment(input: { sessionId: string; label?: string }): Promise<Moment>;
  privacy(target: PrivacyTarget, reason: string): Promise<InvalidationReceipt>;
  setSettings(patch: Partial<Settings> & { baseRevision: number }): Promise<Settings>;
  triggerRecap(sessionId: string): Promise<PlaybackRef>;
  previewRecap(sessionId: string): Promise<RecapPlan | null>;
  cancelRecap(id: string): Promise<void>;
  controlReplay(control: ReplayControl): Promise<void>;
}

export const ApiErrorSchema = z.object({ error: z.object({ code: z.string().max(80), message: z.string().max(500), retryable: z.boolean(), requestId: z.string().max(160), details: z.unknown().optional() }).strict() }).strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;
export interface Clock { now(): number; iso(): string }
export interface EvidencePacket { sessionId: string; sources: Source[]; memory: { id: string; text: string; refs: VersionRef[] }[]; chapters: PublicChapter[]; lore: Lore[]; constraints: string[]; recapLanguage: RecapLanguage }
export type ProviderUsage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; audioSeconds?: number; chargedMicroUsd: number | null };
export type ProviderResult<T> = { value: T; usage: ProviderUsage; requestId: string; model: string };
export interface StoryProvider { propose(packet: EvidencePacket, ticket: GenerationTicket, signal?: AbortSignal): Promise<ProviderResult<StoryPatch>> }
export interface ModerationProvider { check(text: string, signal?: AbortSignal): Promise<ProviderResult<Safety>> }
export interface TranscriptionProvider { transcribe(input: { bytes: Uint8Array; sampleRate: number; durationMs: number; languageHint?: string }, signal?: AbortSignal): Promise<ProviderResult<{ text: string; languageCodes: string[]; confidence: number | null }>> }
export interface NarrationProvider { synthesize(text: string, language: RecapLanguage, signal?: AbortSignal): Promise<ProviderResult<{ bytes: Uint8Array; mimeType: string; durationMs: number }>> }
export type SideEffectJob = { id: string; kind: 'chat' | 'clip' | 'marker' | 'publish' | 'playback'; scope: Scope; sessionId: string; privacyEpoch: number; dependencyRefs: VersionRef[]; payload: unknown };
export type DispatchResult = { status: 'sent' | 'dropped' | 'cancelled' | 'unknown_outcome' | 'simulated'; externalId?: string; reason?: string };
export interface EffectsSink { readonly mode: 'live' | 'simulation'; dispatch(job: SideEffectJob, signal?: AbortSignal): Promise<DispatchResult> }

export function safetyAllowsPublication(safety: Safety): boolean {
  return safety.moderation === 'allowed' && (safety.pii === 'allowed' || safety.pii === 'redacted');
}

export function filterSnapshotAt(snapshot: PublicSnapshot, untilMs: number): PublicSnapshot {
  const limit = Math.max(0, untilMs);
  const chapters = snapshot.chapters.filter(item => item.maxDependencyEndMs <= limit);
  const moments = snapshot.moments.filter(item => item.maxDependencyEndMs <= limit);
  const permittedMoments = new Set(moments.map(item => item.id));
  return {
    ...snapshot,
    session: snapshot.session.metadataMaxDependencyEndMs <= limit ? snapshot.session : { ...snapshot.session, title: '', category: '' },
    current: snapshot.current && snapshot.current.maxDependencyEndMs <= limit ? snapshot.current : null,
    chapters: chapters.map(item => ({ ...item, momentIds: item.momentIds.filter(id => permittedMoments.has(id)) })),
    lore: snapshot.lore.filter(item => item.maxDependencyEndMs <= limit).map(item => ({ ...item, momentId: item.momentId && permittedMoments.has(item.momentId) ? item.momentId : null })),
    moments,
    gaps: snapshot.gaps.filter(item => item.startMs <= limit).map(item => ({ ...item, endMs: Math.min(item.endMs, limit) })),
  };
}
