import type {CaptureBundle,RecordedOutcome} from '../../replay/contracts.js';
import type {Scope,Source,VersionRef} from '../../shared/contracts/index.js';
import type {GenerationRequest} from '../../core/index.js';
import type {ExportManifest,ExportAsset} from '../../cloud/contracts.js';
import type {DomainMedia} from '../../core/types.js';

export type RecordingMedia={id:string;assetId:string;atMs:number;media:DomainMedia;hash:string;bytes:number;mime:'video/mp4'|'audio/wav'|'audio/mpeg'};
export type MediaReview={id:string;hash:string;visualReviewed:true;audioReviewed:true};

export type RecordingStatus='armed'|'recording'|'stopped'|'interrupted'|'invalidated'|'failed'|'exported';
export type RecordingPublication={state:'staged'|'queued'|'published'|'revoked'|'error';replayUrl?:string;revocationPending?:boolean;removalAllowed?:boolean;message?:string};
export type RecordingStartEligibility={sessionId:string|null;canStartCurrent:boolean;canArmNext:boolean;reason:'ready'|'no_session'|'context_started'|'recording_active'|'session_unavailable'|'retention_limit'};
export type RecordingSummary={id:string;status:RecordingStatus;revision:number;sessionId:string|null;startedAt:string;stoppedAt:string|null;eventCount:number;providerCount:number;message:string|null;exportId:string|null;publication?:RecordingPublication};
export type SourceReview={id:string;revision:number;textHash:string};
export type ReviewReceipt={id:string;recordingId:string;captureRevision:number;digest:string;sourceReviews:SourceReview[];outputHashes:string[];mediaReviews?:MediaReview[];reviewedBy:string;reviewedAt:string;privacyEpoch:number};
export type RecordingRecord={schemaVersion:1;id:string;scope:Scope;status:RecordingStatus;revision:number;sessionId:string|null;privacyEpoch:number;startedAt:string;stoppedAt:string|null;initial:CaptureBundle['initial']|null;events:CaptureBundle['events'];providers:RecordedOutcome[];pending:Record<string,{request:GenerationRequest;atMs:number}>;sources:Source[];safeSourceHashes:string[];milestones:CaptureBundle['milestones'];correction:CaptureBundle['correction']|null;message:string|null;receipt:ReviewReceipt|null;exportId:string|null;mediaEvents?:{atMs:number;media:DomainMedia}[];selectedMedia?:RecordingMedia[];pendingMediaPurge?:string[]};
export type RecordingReview={recording:RecordingSummary;digest:string;sources:(SourceReview&{kind:Source['kind'];startMs:number;endMs:number;text:string|null;safe:boolean})[];outputs:{hash:string;text:string}[];metadata:{channel:string;title:string;category:string};blockedReasons:string[];mediaPolicy:'owner-selected';mediaCandidates:{id:string;kind:string;startMs:number;endMs:number}[];media:{id:string;kind:string;hash:string;bytes:number;mime:string;startMs:number;endMs:number;sourceRefs:VersionRef[];previewUrl:string}[];};
export type ReviewedExport={recordingId:string;reviewReceiptId:string;scope:Scope;sourceSessionId:string;privacyEpoch:number;sourceRefs:VersionRef[];mediaRefs?:VersionRef[];intervals:{startMs:number;endMs:number}[];manifest:ExportManifest;assets:{asset:ExportAsset;bytes:Uint8Array}[];bundle:CaptureBundle};
