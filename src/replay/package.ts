import {z} from 'zod';
import {Hash,Key,LIMITS,type ExportManifest} from '../cloud/contracts.js';
import {MAX_BUNDLE_BYTES,validateBundle,type CaptureBundle} from './contracts.js';

export const BUNDLE_INDEX_FORMAT='previously-chunked-bundle';
const IndexSchema=z.object({
  format:z.literal(BUNDLE_INDEX_FORMAT),schemaVersion:z.literal(1),
  bundleHash:Hash,bundleBytes:z.number().int().positive().max(MAX_BUNDLE_BYTES),
  base:z.record(z.string(),z.unknown()),
  chunks:z.array(z.object({assetId:Key,kind:z.enum(['events','providers']),count:z.number().int().positive().max(10000)}).strict()).min(1).max(99),
}).strict();
export type BundleIndex=z.infer<typeof IndexSchema>;

/** Bound the entire declared package before any asset request or allocation. */
export function assertPackageBounds(manifest:ExportManifest){
  if(manifest.assets.length>100||manifest.assets.filter(a=>a.kind==='bundle').length!==1||new Set(manifest.assets.map(a=>a.id)).size!==manifest.assets.length)throw new Error('recording_package_invalid');
  if(manifest.assets.some(a=>a.bytes<1||a.bytes>LIMITS.asset)||manifest.assets.reduce((sum,a)=>sum+a.bytes,0)>MAX_BUNDLE_BYTES)throw new Error('recording_package_too_large');
}

export function readBundleIndex(manifest:ExportManifest,value:unknown):BundleIndex|null{
  assertPackageBounds(manifest);
  if(!value||typeof value!=='object'||!('format' in value)){
    if(manifest.assets.some(a=>a.kind==='events'||a.kind==='providers'))throw new Error('recording_chunk_invalid');
    return null;
  }
  const index=IndexSchema.parse(value);
  if('events' in index.base||'providers' in index.base)throw new Error('recording_package_invalid');
  const ids=new Set<string>(),counts={events:0,providers:0};
  for(const chunk of index.chunks){
    const asset=manifest.assets.find(a=>a.id===chunk.assetId);
    if(ids.has(chunk.assetId)||!asset||asset.kind!==chunk.kind||asset.mime!=='application/json')throw new Error('recording_chunk_invalid');
    ids.add(chunk.assetId);counts[chunk.kind]+=chunk.count;
    if(counts[chunk.kind]>10000)throw new Error('recording_package_too_large');
  }
  if(manifest.assets.some(a=>(a.kind==='events'||a.kind==='providers')&&!ids.has(a.id)))throw new Error('recording_chunk_invalid');
  return index;
}

export function assembleBundle(index:BundleIndex,chunks:unknown[]):CaptureBundle{
  if(chunks.length!==index.chunks.length)throw new Error('recording_chunk_missing');
  const events:unknown[]=[],providers:unknown[]=[];
  chunks.forEach((value,i)=>{
    const descriptor=index.chunks[i]!;
    if(!Array.isArray(value)||value.length!==descriptor.count)throw new Error('recording_chunk_invalid');
    const destination=descriptor.kind==='events'?events:providers;
    for(const entry of value)destination.push(entry);
  });
  return validateBundle({...index.base,events,providers});
}

export function assertBundleIdentity(bundle:CaptureBundle,manifest:ExportManifest){
  if(bundle.id!==manifest.id||bundle.revision!==manifest.revision||bundle.origin!==manifest.origin||bundle.durationMs!==manifest.durationMs||bundle.initial.session.id!==manifest.sourceSessionId)throw new Error('recording_identity_mismatch');
}
