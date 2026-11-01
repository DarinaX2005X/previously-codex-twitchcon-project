import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuthoredBundle} from '../../fixtures/authored-notes.js';
import {ManifestSchema} from '../../src/cloud/contracts.js';
import {ReplayDriver} from '../../src/replay/driver.js';
import {packageRecordingBundle} from '../../src/server/replay/recording-package.js';
import {createOfflineArchive,loadOfflineArchive,MAX_OFFLINE_ARCHIVE_BYTES} from '../../src/server/replay/offline-archive.js';
import {replayOffline} from '../../src/server/replay/offline.js';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(chunked=false){
  const bundle=createAuthoredBundle();bundle.origin='own-stream';
  // Synthetic bytes establish archive fidelity, not playable or reviewed human media.
  const mediaBytes=Buffer.from([0,0,0,24,102,116,121,112,109,112,52,50,0,255,128,42]);
  bundle.media=[{id:'clip-selected',assetId:'selected-video',sourceRefs:[],startMs:0,endMs:1000}];
  if(chunked)bundle.providers.push(...Array.from({length:4},(_,i)=>({...bundle.providers[0]!,invocationId:`capacity-${i}`,input:{text:'x'.repeat(900_000)},output:null,error:'synthetic-capacity-only'})));
  const packaged=packageRecordingBundle(bundle),asset={id:'selected-video',kind:'video' as const,mime:'video/mp4' as const,bytes:mediaBytes.length,hash:hash(mediaBytes)};
  const manifest=ManifestSchema.parse({schemaVersion:1,id:bundle.id,revision:bundle.revision,origin:bundle.origin,sourceSessionId:bundle.initial.session.id,durationMs:bundle.durationMs,bundleHash:packaged.bundleHash,assets:[...packaged.assets.map(a=>a.asset),asset],milestones:bundle.milestones,providerVersions:{model:'authored-no-model'}});
  return {bundle,manifest,mediaBytes,bytes:createOfflineArchive(manifest,bundle,()=>mediaBytes)};
}
// Mutate a member and repair ZIP CRC to prove SHA commitments are checked independently.
function changeMember(input:Uint8Array,name:string,change:(bytes:Buffer)=>void){
  const bytes=Buffer.from(input),end=bytes.length-22;let cursor=bytes.readUInt32LE(end+16);
  while(cursor<end){const length=bytes.readUInt16LE(cursor+28),member=bytes.subarray(cursor+46,cursor+46+length).toString();
    if(member===name){const local=bytes.readUInt32LE(cursor+42),size=bytes.readUInt32LE(cursor+20),body=bytes.subarray(local+30+length,local+30+length+size);change(body);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;bytes.writeUInt32LE(crc,cursor+16);bytes.writeUInt32LE(crc,local+14);return bytes;}cursor+=46+length;
  }throw new Error('member not found');
}
afterEach(()=>vi.unstubAllGlobals());

describe('bounded offline recording ZIP',()=>{
  it('round trips exact selected media and deterministic recorded state without network access',()=>{
    const value=fixture(),fetcher=vi.fn(()=>{throw new Error('offline');});vi.stubGlobal('fetch',fetcher);
    expect(createOfflineArchive(value.manifest,value.bundle,()=>value.mediaBytes)).toEqual(value.bytes);
    expect(Buffer.from(value.bytes).readUInt32LE(0)).toBe(0x04034b50);
    const loaded=loadOfflineArchive(value.bytes),expected=new ReplayDriver(value.bundle,'offline-run');
    loaded.driver.advanceTo(loaded.bundle.durationMs);expected.advanceTo(value.bundle.durationMs);
    expect(loaded.driver.normalizedHash()).toBe(expected.normalizedHash());expect(loaded.manifest).toEqual(value.manifest);
    expect(loaded.resolveMedia('clip-selected')).toEqual({bytes:new Uint8Array(value.mediaBytes),mime:'video/mp4'});
    expect(loaded.resolveMedia(loaded.driver.ids.map('clip-selected','runtime'))?.bytes).toEqual(new Uint8Array(value.mediaBytes));
    expect(loaded.resolveMedia('unknown')).toBeNull();loaded.resolveMedia('clip-selected')!.bytes.fill(0);
    expect(hash(loaded.resolveMedia('clip-selected')!.bytes)).toBe(value.manifest.assets.at(-1)!.hash);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('verifies and reconstructs an assembled bundle committed through a multi-asset manifest',()=>{
    const value=fixture(true);expect(value.manifest.assets.some(a=>a.kind==='providers')).toBe(true);
    expect(loadOfflineArchive(value.bytes).bundle).toEqual(value.bundle);
  });
  it('rejects media byte corruption, even when its ZIP CRC is repaired',()=>{
    const value=fixture(),changed=changeMember(value.bytes,'media/selected-video',body=>{body[0]^=1;});
    expect(()=>loadOfflineArchive(changed)).toThrow('recording_integrity_failed');
    expect(()=>createOfflineArchive(value.manifest,value.bundle,()=>Buffer.alloc(value.mediaBytes.length))).toThrow('recording_integrity_failed');
  });
  it('rejects changed assembled bundle contents despite repaired ZIP CRC',()=>{
    const value=fixture(),changed=changeMember(value.bytes,'bundle.json',body=>{const at=body.indexOf(value.bundle.correction!.title);body[at]=body[at]===65?66:65;});
    expect(()=>loadOfflineArchive(changed)).toThrow('recording_integrity_failed');
    const changedBundle=structuredClone(value.bundle);changedBundle.correction!.title+=' changed';
    expect(()=>createOfflineArchive(value.manifest,changedBundle,()=>value.mediaBytes)).toThrow('recording_integrity_failed');
  });
  it('rejects path traversal, duplicate members, compression, trailing data and truncation',()=>{
    const value=fixture(),raw=Buffer.from(value.bytes);
    const traversal=Buffer.from(raw);const bad=Buffer.from('media/../unsafe-file');
    for(let at=traversal.indexOf('media/selected-video');at!==-1;at=traversal.indexOf('media/selected-video',at+1))bad.copy(traversal,at);
    expect(()=>loadOfflineArchive(traversal)).toThrow('recording_archive_invalid');
    const other={...value.bundle.media[0]!,id:'clip-other',assetId:'selected-other'},twoBundle={...value.bundle,media:[...value.bundle.media,other]},twoPack=packageRecordingBundle(twoBundle),twoManifest={...value.manifest,bundleHash:twoPack.bundleHash,assets:[...twoPack.assets.map(a=>a.asset),value.manifest.assets.at(-1)!,{...value.manifest.assets.at(-1)!,id:'selected-other'}]};
    const duplicate=Buffer.from(createOfflineArchive(twoManifest,twoBundle,()=>value.mediaBytes));
    for(let at=duplicate.indexOf('media/selected-other');at!==-1;at=duplicate.indexOf('media/selected-other',at+1))Buffer.from('media/selected-video').copy(duplicate,at);
    expect(()=>loadOfflineArchive(duplicate)).toThrow('recording_archive_invalid');
    const compressed=Buffer.from(raw),central=compressed.readUInt32LE(compressed.length-6);compressed.writeUInt16LE(8,central+10);
    expect(()=>loadOfflineArchive(compressed)).toThrow('recording_archive_invalid');
    expect(()=>loadOfflineArchive(Buffer.concat([raw,Buffer.from([0])]))).toThrow('recording_archive_invalid');
    expect(()=>loadOfflineArchive(raw.subarray(0,raw.length-10))).toThrow();
  });
  it('rejects missing/unlisted media and the whole-file bound',()=>{
    const value=fixture(),manifest=structuredClone(value.manifest);manifest.assets.pop();
    expect(()=>createOfflineArchive(manifest,value.bundle,()=>value.mediaBytes)).toThrow('recording_media_missing');
    expect(()=>loadOfflineArchive(new Uint8Array(MAX_OFFLINE_ARCHIVE_BYTES+1))).toThrow('recording_archive_too_large');
    expect(()=>createOfflineArchive(value.manifest,{...value.bundle,media:[]},()=>value.mediaBytes)).toThrow();
  });
  it('counts ZIP headers and the reviewed manifest in the 32 MB archive limit',()=>{
    const value=fixture(),bundle={...value.bundle,media:Array.from({length:11},(_,i)=>({...value.bundle.media[0]!,id:`clip-${i}`,assetId:`media-${i}`}))},packaged=packageRecordingBundle(bundle);
    let remaining=MAX_OFFLINE_ARCHIVE_BYTES-packaged.assets.reduce((sum,item)=>sum+item.bytes.length,0);
    const payloads=new Map<string,Buffer>();
    const media=bundle.media.map(item=>{const bytes=Buffer.alloc(Math.min(3_000_000,remaining));remaining-=bytes.length;payloads.set(item.assetId,bytes);return {id:item.assetId,kind:'video' as const,mime:'video/mp4' as const,bytes:bytes.length,hash:hash(bytes)};});
    const manifest={...value.manifest,bundleHash:packaged.bundleHash,assets:[...packaged.assets.map(item=>item.asset),...media]};
    expect(manifest.assets.reduce((sum,asset)=>sum+asset.bytes,0)).toBe(MAX_OFFLINE_ARCHIVE_BYTES);
    expect(()=>createOfflineArchive(manifest,bundle,asset=>payloads.get(asset.id)!)).toThrow('recording_archive_too_large');
  });
  it('loads ZIP files and retains ordinary JSON compatibility through replayOffline',async()=>{
    const value=fixture(),directory=await mkdtemp(join(tmpdir(),'previously-offline-zip-'));
    try{
      const archive=join(directory,'capture.zip'),legacy=join(directory,'capture.json');await writeFile(archive,value.bytes);await writeFile(legacy,JSON.stringify(value.bundle));
      const loaded=await replayOffline(archive),old=await replayOffline(legacy);expect(loaded.hash).toBe(old.hash);expect(loaded.resolveMedia('clip-selected')?.bytes).toEqual(new Uint8Array(value.mediaBytes));expect(old.resolveMedia('clip-selected')).toBeNull();
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});
