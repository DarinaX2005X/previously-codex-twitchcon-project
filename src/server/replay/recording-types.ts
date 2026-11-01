import type {CaptureBundle,RecordedOutcome} from '../../replay/contracts.js';
import type {Scope,Source,VersionRef} from '../../shared/contracts/index.js';
import type {GenerationRequest} from '../../core/index.js';
import type {ExportManifest,ExportAsset} from '../../cloud/contracts.js';

export type RecordingStatus='armed'|'recording'|'stopped'|'interrupted'|'invalidated'|'failed'|'exported';
export type RecordingSummary={id:string;status:RecordingStatus;revision:number;sessionId:string|null;startedAt:string;stoppedAt:string|null;eventCount:number;providerCount:number;message:string|null;exportId:string|null};
export type SourceReview={id:string;revision:number;textHash:string};
export type ReviewReceipt={id:string;recordingId:string;captureRevision:number;digest:string;sourceReviews:SourceReview[];outputHashes:string[];reviewedBy:string;reviewedAt:string;privacyEpoch:number};
export type RecordingRecord={schemaVersion:1;id:string;scope:Scope;status:RecordingStatus;revision:number;sessionId:string|null;privacyEpoch:number;startedAt:string;stoppedAt:string|null;initial:CaptureBundle['initial']|null;events:CaptureBundle['events'];providers:RecordedOutcome[];pending:Record<string,{request:GenerationRequest;atMs:number}>;sources:Source[];safeSourceHashes:string[];milestones:CaptureBundle['milestones'];correction:CaptureBundle['correction']|null;message:string|null;receipt:ReviewReceipt|null;exportId:string|null};
export type RecordingReview={recording:RecordingSummary;digest:string;sources:(SourceReview&{kind:Source['kind'];startMs:number;endMs:number;text:string|null;safe:boolean})[];outputs:{hash:string;text:string}[];metadata:{channel:string;title:string;category:string};blockedReasons:string[];mediaPolicy:'excluded';};
export type ReviewedExport={recordingId:string;reviewReceiptId:string;scope:Scope;sourceSessionId:string;privacyEpoch:number;sourceRefs:VersionRef[];intervals:{startMs:number;endMs:number}[];manifest:ExportManifest;assets:{asset:ExportAsset;bytes:Uint8Array}[];bundle:CaptureBundle};
