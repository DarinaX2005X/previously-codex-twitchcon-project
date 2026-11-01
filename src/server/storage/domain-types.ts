import type { DomainState, DomainTransition, DerivedNode, StoryCandidate } from '../../core/types.js';
import type { Channel, EventEnvelope, InvalidationReceipt, Lore, PrivacyTarget, PublicSnapshot, Session, Settings, Source } from '../../shared/contracts/index.js';

export type DomainCheckpoint={revision:number;privacyEpoch:number;checkpoint:DomainState|null};
export type DomainEntity=DerivedNode & {ownerRevision:number;ownerLocked:boolean;pinned:boolean};
export type DomainHydration={
  channel:Channel;session:Session;settings:Settings;revision:number;privacyEpoch:number;checkpoint:DomainState|null;
  sources:Source[];entities:DomainEntity[];candidates:StoryCandidate[];published:PublicSnapshot|null;
  tombstones:PrivacyTarget[];blockedTerms:string[];bannedActors:string[];captureEpoch:number;chatClearThroughMs:number|null;
  blockedLore:Lore[];
};
export type DomainCommitInput={
  expectedRevision:number;expectedPrivacyEpoch:number;transition:DomainTransition;event?:EventEnvelope<unknown>;
  idempotencyKey?:string;requestBody?:unknown;
  settingsPatch?:{baseRevision:number;patch:Partial<Omit<Settings,'revision'>>};
  expectedEntity?:{id:string;revision:number};
};
export type DomainCommitResult={applied:boolean;duplicate:boolean;revision:number;privacyEpoch:number;receipt?:InvalidationReceipt;checkpoint?:DomainState};
export type MutationReceipt={kind:'domain'|'settings';sessionId:string|null;revision:number;privacyEpoch?:number;receipt?:InvalidationReceipt};
