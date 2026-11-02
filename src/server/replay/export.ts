import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFoxlightBundle, FOXLIGHT_ID, FOXLIGHT_MEDIA } from '../../../fixtures/foxlight.js';
import { sha256 } from '../../cloud/signing.js';
import { canonical } from '../../core/index.js';
import type { PublicationService } from '../../cloud/service.js';
import { LIMITS, type ExportManifest, type ExportAsset } from '../../cloud/contracts.js';

/** The example recording served by default on /replay, the landing and the example public recap. */
export const DEFAULT_REPLAY_ID = FOXLIGHT_ID;
/** Authored recordings a local registry may serve. `authored-notes` stays readable in older registries. */
export const AUTHORED_REPLAY_IDS: readonly string[] = [FOXLIGHT_ID, 'authored-notes'];
export type AuthoredExportOptions = { mediaDirectory?: string };
/** Clip files are part of the product build (public/demo/foxlight); the export serves them behind the manifest gate. */
export const defaultMediaDirectory = () => resolve(process.cwd(), 'public', 'demo', 'foxlight');

export function buildAuthoredExport(revision = 1, options: AuthoredExportOptions = {}) {
  const bundle = createFoxlightBundle(); bundle.revision = revision;
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const root: ExportAsset = { id: 'bundle', hash: sha256(bytes), bytes: bytes.length, mime: 'application/json', kind: 'bundle' };
  const directory = options.mediaDirectory ?? defaultMediaDirectory();
  // A clip that is missing or too large is left out; the scene then keeps that card without video.
  const media = FOXLIGHT_MEDIA.flatMap(item => {
    const path = resolve(directory, `${item.assetId}.mp4`);
    if (!existsSync(path)) return [];
    const data = new Uint8Array(readFileSync(path));
    if (!data.length || data.length > LIMITS.asset) return [];
    return [{ asset: { id: item.assetId, hash: sha256(data), bytes: data.length, mime: 'video/mp4', kind: 'video' } satisfies ExportAsset, bytes: data }];
  });
  const assets = [{ asset: root, bytes }, ...media];
  const manifest: ExportManifest = { schemaVersion: 1, id: bundle.id, revision, origin: 'authored', sourceSessionId: bundle.initial.session.id, durationMs: bundle.durationMs, bundleHash: root.hash, assets: assets.map(a => a.asset), milestones: bundle.milestones, providerVersions: { model: 'authored-no-model', schema: '1', prompt: 'replay-v1' } };
  return { manifest, assets };
}

/** The next export to publish: null when the active export already has this exact content, or when it was withdrawn. */
export async function nextAuthoredExport(service: PublicationService, channelId: string, options: AuthoredExportOptions = {}) {
  const current = await service.getHead(channelId), existing = current?.head.exports.find(x => x.id === DEFAULT_REPLAY_ID);
  if (existing?.status === 'revoked') return { current, existing, next: null }; // Withdrawal survives restart and rebuilds.
  if (existing) {
    const same = buildAuthoredExport(existing.revision, options).manifest;
    const published = await service.readManifest(channelId, existing.id, existing.revision).then(value => value.manifest, () => null);
    if (published && canonical(published) === canonical(same)) return { current, existing, next: null };
  }
  return { current, existing, next: buildAuthoredExport((existing?.revision ?? 0) + 1, options) };
}

/** Explicit startup/deploy action only. Never replaces snapshots, sessions or privacy revision. */
export async function bootstrapAuthoredReplay(service: PublicationService, channelId: string, channelLogin: string, options: AuthoredExportOptions = {}) {
  const { current, existing, next } = await nextAuthoredExport(service, channelId, options);
  if (!next) return { created: false, revision: existing!.revision, status: existing!.status };
  const { manifest, assets } = next, base = { channelId, channelLogin, publishSeq: (current?.head.publishSeq ?? 0) + 1, privacyRevision: current?.head.privacyRevision ?? 0 };
  for (const { asset, bytes } of assets) await service.uploadAsset({ ...base, exportId: manifest.id, revision: manifest.revision, asset }, bytes);
  const op = { ...base, operation: 'export_manifest' as const, manifest }; await service.publish(op, sha256(new TextEncoder().encode(JSON.stringify(op))));
  return { created: true, revision: manifest.revision, status: 'active' as const };
}
