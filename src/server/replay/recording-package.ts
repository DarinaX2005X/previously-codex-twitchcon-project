import {createHash} from 'node:crypto';
import {LIMITS,type ExportAsset,type ExportManifest} from '../../cloud/contracts.js';
import {MAX_BUNDLE_BYTES,validateBundle,type CaptureBundle} from '../../replay/contracts.js';
import {BUNDLE_INDEX_FORMAT,assembleBundle,assertBundleIdentity,assertPackageBounds,readBundleIndex,type BundleIndex} from '../../replay/package.js';

type PackagedAsset={asset:ExportAsset;bytes:Uint8Array};
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function asset(id:string,kind:ExportAsset['kind'],bytes:Uint8Array):PackagedAsset{
  if(!bytes.length||bytes.length>LIMITS.asset)throw new Error('recording_item_too_large');
  return {asset:{id,kind,hash:hash(bytes),bytes:bytes.length,mime:'application/json'},bytes};
}

/** Each uploaded object is independently bounded; the root commits chunk order and full content. */
export function packageRecordingBundle(input:CaptureBundle):{bundleHash:string;assets:PackagedAsset[]}{
  const bundle=validateBundle(input),bytes=encode(bundle);
  if(bytes.length<=LIMITS.asset){const root=asset('bundle','bundle',bytes);return {bundleHash:root.asset.hash,assets:[root]};}
  const {events,providers,...base}=bundle,assets:PackagedAsset[]=[],chunks:BundleIndex['chunks']=[];
  for(const [kind,records]of [['events',events],['providers',providers]] as const){
    let parts:string[]=[],size=2,sequence=0;
    const flush=()=>{if(!parts.length)return;const id=`${kind}-${String(sequence++).padStart(3,'0')}`;assets.push(asset(id,kind,new TextEncoder().encode('['+parts.join(',')+']')));chunks.push({assetId:id,kind,count:parts.length});parts=[];size=2;};
    for(const record of records){const text=JSON.stringify(record),length=Buffer.byteLength(text);if(length+2>LIMITS.asset)throw new Error('recording_item_too_large');if(size+length+(parts.length?1:0)>LIMITS.asset)flush();size+=length+(parts.length?1:0);parts.push(text);}
    flush();
  }
  const index:BundleIndex={format:BUNDLE_INDEX_FORMAT,schemaVersion:1,bundleHash:hash(bytes),bundleBytes:bytes.length,base,chunks};
  const root=asset('bundle','bundle',encode(index));
  if(assets.length+1>100||assets.reduce((sum,a)=>sum+a.bytes.length,root.bytes.length)>MAX_BUNDLE_BYTES)throw new Error('recording_package_too_large');
  return {bundleHash:root.asset.hash,assets:[root,...assets]};
}

/** Local download reconstructs ordinary CaptureBundle JSON, never an index with missing files. */
export function unpackRecordingBundle(manifest:ExportManifest,read:(asset:ExportAsset)=>Uint8Array):CaptureBundle{
  assertPackageBounds(manifest);
  const checked=(descriptor:ExportAsset)=>{const bytes=read(descriptor);if(bytes.length!==descriptor.bytes||hash(bytes)!==descriptor.hash)throw new Error('recording_integrity_failed');return JSON.parse(new TextDecoder().decode(bytes)) as unknown;};
  const root=manifest.assets.find(a=>a.kind==='bundle')!;
  if(root.hash!==manifest.bundleHash)throw new Error('recording_integrity_failed');
  const value=checked(root),index=readBundleIndex(manifest,value);
  const bundle=index?assembleBundle(index,index.chunks.map(chunk=>checked(manifest.assets.find(a=>a.id===chunk.assetId)!))):validateBundle(value);
  if(index){const bytes=encode(bundle);if(bytes.length!==index.bundleBytes||hash(bytes)!==index.bundleHash)throw new Error('recording_integrity_failed');}
  assertBundleIdentity(bundle,manifest);return bundle;
}
