import { z } from 'zod';
import { PublicSnapshotSchema } from '../shared/contracts/index.js';

export const LIMITS = { snapshot: 1_000_000, head: 128_000, asset: 3_000_000, request: 3_500_000, episodes: 100, exports: 10 } as const;
export const Key = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AssetSchema = z.object({ id: Key, hash: Hash, bytes: z.number().int().min(1).max(LIMITS.asset), mime: z.enum(['application/json','application/octet-stream','video/mp4','audio/mpeg','audio/wav','image/webp','image/png','image/jpeg']), kind: z.enum(['bundle','events','providers','video','audio','image']) }).strict();
export const ManifestSchema = z.object({ schemaVersion: z.literal(1), id: Key, revision: Revision, origin: z.enum(['own-stream','authored']), sourceSessionId: Key, durationMs: z.number().int().nonnegative().max(28_800_000), bundleHash: Hash, assets: z.array(AssetSchema).min(1).max(100), milestones: z.array(z.object({id:Key,label:z.string().max(120),atMs:z.number().int().nonnegative()}).strict()).max(100), providerVersions: z.record(z.string().max(80),z.string().max(120)).refine(v=>Object.keys(v).length<=20) }).strict();
export type ExportManifest = z.infer<typeof ManifestSchema>;
export type ExportAsset = z.infer<typeof AssetSchema>;
const Base = { channelId: Key, channelLogin: z.string().regex(/^[a-z0-9_]{1,25}$/), publishSeq: Revision.min(1), privacyRevision: Revision };
export const OperationSchema = z.discriminatedUnion('operation',[
  z.object({...Base,operation:z.literal('snapshot'),snapshots:z.array(PublicSnapshotSchema).max(100),activeSessionId:Key.nullable(),liveLeaseUntil:z.iso.datetime().nullable()}).strict(),
  z.object({...Base,operation:z.literal('retract'),sessionIds:z.array(Key).max(100),exportIds:z.array(Key).max(10),snapshots:z.array(PublicSnapshotSchema).max(100)}).strict(),
  z.object({...Base,operation:z.literal('export_manifest'),manifest:ManifestSchema}).strict(),
]);
export type PublicationOperation = z.infer<typeof OperationSchema>;
export const UploadSchema=z.object({...Base,exportId:Key,revision:Revision,asset:AssetSchema}).strict();
export type AssetUpload = z.infer<typeof UploadSchema>;
export type EpisodePointer={sessionId:string;publicationRevision:number;privacyEpoch:number;snapshotPath:string;hash:string;status:'live'|'closing'|'finalized';updatedAt:string;startedAt?:string};
export type ExportPointer={id:string;revision:number;manifestPath:string;manifestHash:string;publishSeq:number;status:'active'|'revoked'};
export type ChannelHead={schemaVersion:1;channelId:string;channelLogin:string;publishSeq:number;bodyHash:string;privacyRevision:number;activeSessionId:string|null;liveLeaseUntil:string|null;lastSyncedAt:string;episodePointers:EpisodePointer[];exports:ExportPointer[]};
export type PublicationAck={publishSeq:number;headEtag:string;publicRevision:number;lastSyncedAt:string};
export class PublicationError extends Error { constructor(public status:number,public code:string,message=code){super(message);} }
