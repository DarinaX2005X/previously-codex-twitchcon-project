import { createAuthoredBundle } from '../../../fixtures/authored-notes.js';
import { sha256 } from '../../cloud/signing.js';
import type { PublicationService } from '../../cloud/service.js';
import type { ExportManifest, ExportAsset } from '../../cloud/contracts.js';

export function buildAuthoredExport(revision=1){
  const bundle=createAuthoredBundle();bundle.revision=revision;
  const bytes=new TextEncoder().encode(JSON.stringify(bundle));
  const asset:ExportAsset={id:'bundle',hash:sha256(bytes),bytes:bytes.length,mime:'application/json',kind:'bundle'};
  const manifest:ExportManifest={schemaVersion:1,id:bundle.id,revision,origin:'authored',sourceSessionId:bundle.initial.session.id,durationMs:bundle.durationMs,bundleHash:asset.hash,assets:[asset],milestones:bundle.milestones,providerVersions:{model:'authored-no-model',schema:'1',prompt:'replay-v1'}};
  return {manifest,assets:[{asset,bytes}]};
}
/** Explicit startup/deploy action only. Never replaces snapshots, sessions or privacy revision. */
export async function bootstrapAuthoredReplay(service:PublicationService,channelId:string,channelLogin:string){
  const current=await service.getHead(channelId),existing=current?.head.exports.find(x=>x.id==='authored-notes');
  if(existing)return {created:false,revision:existing.revision,status:existing.status}; // Revocation survives restart.
  const {manifest,assets}=buildAuthoredExport(),base={channelId,channelLogin,publishSeq:(current?.head.publishSeq??0)+1,privacyRevision:current?.head.privacyRevision??0};
  for(const {asset,bytes}of assets)await service.uploadAsset({...base,exportId:manifest.id,revision:manifest.revision,asset},bytes);
  const op={...base,operation:'export_manifest' as const,manifest};await service.publish(op,sha256(new TextEncoder().encode(JSON.stringify(op))));
  return {created:true,revision:manifest.revision,status:'active'};
}
