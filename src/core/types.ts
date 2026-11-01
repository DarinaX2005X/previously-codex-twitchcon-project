import type { Channel, Session, Settings, Source, VersionRef, GroundedClaim, StoryPatch, GenerationTicket, EvidencePacket, Safety, Chapter, Lore, Moment, PublicSnapshot, RecapPlan, RecapTrigger, PlaybackRef, PrivacyTarget, InvalidationReceipt, CurrentState, RecapLanguage } from '../shared/contracts/index.js';

export const DOMAIN_LIMITS = { sources: 500, memory: 64, chapters: 300, packetChapters: 6, lore: 50, moments: 200, candidates: 4, windows: 30, actorsPerWindow: 100, phraseCandidates: 100, seenTriggers: 1000, packetBytes: 4000 } as const;
export type NodeKind = 'claim'|'relation'|'chapter'|'current_state'|'presentation'|'lore'|'moment'|'media'|'playback'|'provider_cache'|'export';
export type DerivedNode = { id: string; revision: number; kind: NodeKind; supports: VersionRef[]; exposedTo: VersionRef[]; startMs: number; endMs: number; active: boolean; body: unknown };
export type MemoryFact = { id: string; text: string; refs: VersionRef[]; role: GroundedClaim['role']; firstAtMs: number; lastAtMs: number };
export type GroundingReview = { acceptedClaimIds: string[]; acceptedRelationKeys: string[]; issues?: string[] };
export type StoryCandidate = { id: string; entityId: string; revision: number; ownerRevision: number; privacyEpoch: number; inputRefs: VersionRef[]; eligibleAtMs: number; chapter: Chapter; current: CurrentState|null; currentNodeId?: string; safety: Safety; language: RecapLanguage; status: 'pending'|'published'|'rejected'; };
export type GenerationRequest = { ticket: GenerationTicket; entityId: string; reason: 'current'|'chapter'|'metadata'|'topic'|'final'; packet: EvidencePacket; requestedAtMs: number; sourceRevision: number };
export type ReactionWindow = { startMs: number; actors: Record<string, number>; count: number; emotes: number; laughter: number; clipIt: number; refs: VersionRef[] };
export type PhraseObservation = { term: string; aliases: string[]; firstMs: number; lastMs: number; actors: string[]; refs: VersionRef[] };
export type DomainMedia = { id: string; revision: number; momentId: string|null; refs: VersionRef[]; captureStartMs: number; captureEndMs: number; durationMs: number; state: 'pending'|'ready'|'unavailable'|'revoked'; kind: 'video'|'image'|'audio'; previousSession: boolean; ownerApproved: boolean; clipId?: string; manageUrl?: string; clip?:{id:string;url:string;embedUrl:string} };
export type DomainState = {
  version: 1; revision: number; channel: Channel; session: Session; settings: Settings;
  metadataReviewed: boolean;
  sources: Source[]; nodes: Record<string, DerivedNode>; memory: MemoryFact[]; chapters: Chapter[];
  lore: Lore[]; moments: Moment[]; media: DomainMedia[]; candidates: StoryCandidate[];
  published: PublicSnapshot|null; current: CurrentState|null; activeChapterId: string|null;
  ownerRevisions: Record<string, number>; ownerLocks: string[]; suppressedIds: string[];
  editorialExcludedRefs: VersionRef[];
  tombstones: PrivacyTarget[]; bannedActors: string[]; blockedTerms: string[]; captureEpoch: number;
  chatClearThroughMs: number|null;
  sourceRevision: number; processedSourceRevision: number; lastCurrentAtMs: number|null; lastChapterAtMs: number|null;
  pendingGeneration: GenerationRequest|null; boundary: 'metadata'|'topic'|null; sequence: number;
  windows: ReactionWindow[]; openWindow: ReactionWindow|null; lastAutoMomentAtMs: number|null; pendingClipId: string|null;
  phrases: PhraseObservation[]; playbacks: PlaybackRef[]; seenTriggers: string[]; lastRecapRevision: number|null;
  playbackTiming: Record<string,{prepareAtMs:number|null;startAtMs:number|null}>;
  closing: { endedAtMs: number; intakeUntilMs: number; deadlineMs: number; tailDrained: boolean; finalProcessedRevision: number; failed: boolean }|null;
  nextGenerationAfterMs: number;
  gaps: {startMs:number;endMs:number}[]; lastReceipt: InvalidationReceipt|null;
};
export type DomainEvent =
  | { type: 'source'; source: Source; captureEpoch?: number; botOutput?: boolean; signals?: {emote?:boolean;laughter?:boolean;clipIt?:boolean}; phrase?: string }
  | { type: 'source.safety'; id: string; baseRevision: number; text: string|null; safety: Safety }
  | { type: 'tick' }
  | { type: 'metadata'; title: string; category: string; atMs: number; safety: Safety }
  | { type: 'topic'; sourceRefs: VersionRef[] }
  | { type: 'generation.result'; ticket: GenerationTicket; patch: StoryPatch; safety: Safety; grounding?: GroundingReview }
  | { type: 'generation.failed'; jobId: string; reason: string }
  | { type: 'privacy'; target: PrivacyTarget; reason?: string }
  | { type: 'ban'; actorId: string; throughMs: number }
  | { type: 'unban'; actorId: string }
  | { type: 'pause'; paused: boolean }
  | { type: 'settings'; settings: Settings; baseRevision: number }
  | { type: 'chat.clear'; throughMs: number }
  | { type: 'owner.edit'; entityId: string; baseRevision: number; source: Source; title: string; summary: string; safety: Safety; language?: RecapLanguage; pinned?: boolean }
  | { type: 'owner.review'; entityId: string; ownerRevision: number; sourceId: string; sourceRevision: number; title: string; summary: string; safety: Safety; language?: RecapLanguage; current?: CurrentState }
  | { type: 'owner.pin'; entityId: string; baseRevision: number; pinned: boolean }
  | { type: 'candidate.safety'; candidateId: string; safety: Safety }
  | { type: 'presentation'; entityId: string; baseRevision: number; ownerRevision: number; language: RecapLanguage; title: string; summary: string; safety: Safety; inputRefs: VersionRef[]; current?: CurrentState }
  | { type: 'language'; language: RecapLanguage }
  | { type: 'lore.propose'; id: string; term: string; aliases?: string[]; explanation: string; originRefs: VersionRef[]; safety: Safety; grounding?: GroundingReview }
  | { type: 'lore.confirm'; id: string; baseRevision: number; source: Source; explanation: string; safety: Safety }
  | { type: 'lore.edit'; id: string; baseRevision: number; source: Source; term?: string; explanation: string; aliases?: string[]; originMs?: number|null }
  | { type: 'lore.review'; id: string; baseRevision: number; sourceId: string; sourceRevision: number; term?: string; explanation: string; aliases?: string[]; originMs?: number|null; safety: Safety }
  | { type: 'term.unblock'; term: string }
  | { type: 'moment.save'; id?: string; atMs: number; label?: string; sourceRefs?: VersionRef[] }
  | { type: 'media'; media: DomainMedia; privacyEpoch: number }
  | { type: 'recap.trigger'; trigger: RecapTrigger }
  | { type: 'playback'; id: string; action: 'prepared'|'start'|'end'|'cancel'|'error' }
  | { type: 'closing'; endedAt: string }
  | { type: 'tail.drained' }
  | { type: 'cloud.ack'; revision: number; at: string }
  | { type: 'gap'; startMs: number; endMs: number };
export type DomainEffect =
  | { type: 'generation.request'; request: GenerationRequest }
  | { type: 'source.persist'; source: Source }
  | { type: 'entity.upsert'; node: DerivedNode }
  | { type: 'candidate.save'; candidate: StoryCandidate }
  | { type: 'publication'; snapshot: PublicSnapshot; final: boolean; priority: boolean }
  | { type: 'privacy'; target: PrivacyTarget; receipt: InvalidationReceipt }
  | { type: 'cancel'; ids: string[] }
  | { type: 'clip.request'; moment: Moment; privacyEpoch: number }
  | { type: 'clip.cleanup'; clipId: string; manageUrl: string }
  | { type: 'playback.prepare'|'playback.start'|'playback.cancel'; playback: PlaybackRef }
  | { type: 'held'; reason: string; entityId?: string };
export type DomainTransition = { state: DomainState; effects: DomainEffect[] };
