import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuthoredBundle} from '../../fixtures/authored-notes.js';
import {ManifestSchema} from '../../src/cloud/contracts.js';
import {validateBundle} from '../../src/replay/contracts.js';
import {ReplayGate} from '../../src/replay/gate.js';
import {packageRecordingBundle,unpackRecordingBundle} from '../../src/server/replay/recording-package.js';
import {downloadCurrentReplay,replayOffline} from '../../src/server/replay/offline.js';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(large=true){
  const bundle=createAuthoredBundle();
  if(large){
    bundle.durationMs=40*60*1000;bundle.tickMode='recorded';
    const source=bundle.events[0]!.event;if(source.type!=='source')throw new Error('fixture');
    // Synthetic capacity evidence, not captured stream or provider output.
    bundle.events=Array.from({length:310},(_,i)=>({atMs:i*7000,event:{type:'source',source:{...source.source,id:`synthetic-${i}`,text:'e'.repeat(11000),startMs:i*7000,endMs:i*7000}}}));
    bundle.providers=Array.from({length:310},(_,i)=>({...bundle.providers[0]!,invocationId:`synthetic-${i}`,input:{text:'p'.repeat(11000)},output:null,error:'authored-capacity-fixture'}));
  }
  const packaged=packageRecordingBundle(bundle),manifest=ManifestSchema.parse({schemaVersion:1,id:bundle.id,revision:bundle.revision,origin:bundle.origin,sourceSessionId:bundle.initial.session.id,durationMs:bundle.durationMs,bundleHash:packaged.bundleHash,assets:packaged.assets.map(a=>a.asset),milestones:bundle.milestones,providerVersions:{model:'authored-capacity-no-model'}});
  return {bundle,packaged,manifest};
}
function transport(value:ReturnType<typeof fixture>){return vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input),'https://replay.test');
  if(!url.pathname.includes('/assets/'))return Response.json(value.manifest);
  const id=decodeURIComponent(url.pathname.split('/').at(-1)!);expect(url.searchParams.get('revision')).toBe(String(value.manifest.revision));
  const asset=value.packaged.assets.find(a=>a.asset.id===id);return asset?new Response(Buffer.from(asset.bytes)):new Response(null,{status:404});
});}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

describe('bounded recording packages',()=>{
  it('round-trips a synthetic forty-minute bundle larger than 3 MB through bounded event and provider chunks',()=>{
    const value=fixture();expect(Buffer.byteLength(JSON.stringify(value.bundle))).toBeGreaterThan(6_000_000);
    expect(value.packaged.assets.filter(a=>a.asset.kind==='events').length).toBeGreaterThan(1);expect(value.packaged.assets.filter(a=>a.asset.kind==='providers').length).toBeGreaterThan(1);
    for(const {asset,bytes}of value.packaged.assets){expect(bytes.length).toBeLessThanOrEqual(3_000_000);expect(hash(bytes)).toBe(asset.hash);}
    const result=unpackRecordingBundle(value.manifest,asset=>value.packaged.assets.find(a=>a.asset.id===asset.id)!.bytes);
    expect(result).toEqual(validateBundle(value.bundle));
  });
  it('retains the legacy single asset and reads it through both loaders',async()=>{
    const value=fixture(false);expect(value.packaged.assets.map(a=>a.asset.kind)).toEqual(['bundle']);
    const local=unpackRecordingBundle(value.manifest,()=>value.packaged.assets[0]!.bytes),gate=new ReplayGate('/replay',vi.fn(),transport(value));
    try{expect(await gate.load()).toEqual(local);}finally{gate.dispose();}
  });
  it('assembles checked chunks in the public gate and writes complete offline JSON',async()=>{
    const value=fixture(),fetcher=transport(value),directory=await mkdtemp(join(tmpdir(),'previously-package-'));
    vi.stubGlobal('fetch',fetcher);
    try{await downloadCurrentReplay('https://replay.test/replay',join(directory,'offline.json'));const downloaded=JSON.parse(await readFile(join(directory,'offline.json'),'utf8'));expect(downloaded.format).toBeUndefined();expect(validateBundle(downloaded)).toEqual(validateBundle(value.bundle));expect(fetcher.mock.calls.filter(([url])=>String(url).includes('/assets/'))).toHaveLength(value.packaged.assets.length);}finally{await rm(directory,{recursive:true,force:true});}
  });
  it('rejects tampered chunks and index order despite valid individual chunk hashes',async()=>{
    const value=fixture(),fetcher=transport(value),chunk=value.packaged.assets.find(a=>a.asset.kind==='providers')!;
    const gate=new ReplayGate('/replay',vi.fn(),async(input,init)=>String(input).includes(`/assets/${chunk.asset.id}?`)?new Response(Buffer.from(chunk.bytes).fill(32,10,11)):fetcher(input));
    await expect(gate.load()).rejects.toThrow('recording_integrity_failed');
    const root=value.packaged.assets[0]!,index=JSON.parse(new TextDecoder().decode(root.bytes));index.chunks.reverse();const changed=new TextEncoder().encode(JSON.stringify(index));root.bytes=changed;root.asset.bytes=changed.length;root.asset.hash=hash(changed);value.manifest.assets[0]=root.asset;value.manifest.bundleHash=root.asset.hash;
    expect(()=>unpackRecordingBundle(value.manifest,asset=>value.packaged.assets.find(a=>a.asset.id===asset.id)!.bytes)).toThrow();
  });
  it('rejects declared aggregate overflow before downloading and rejects duplicate chunk references',async()=>{
    const value=fixture(false);for(let i=0;i<11;i++)value.manifest.assets.push({id:`large-${i}`,kind:'video',mime:'video/mp4',bytes:3_000_000,hash:'0'.repeat(64)});
    const fetcher=transport(value),gate=new ReplayGate('/replay',vi.fn(),fetcher);await expect(gate.load()).rejects.toThrow('recording_package_too_large');expect(fetcher).toHaveBeenCalledOnce();
    const chunked=fixture(),root=chunked.packaged.assets[0]!,index=JSON.parse(new TextDecoder().decode(root.bytes));index.chunks.push(index.chunks[0]);root.bytes=new TextEncoder().encode(JSON.stringify(index));root.asset.bytes=root.bytes.length;root.asset.hash=hash(root.bytes);chunked.manifest.assets[0]=root.asset;chunked.manifest.bundleHash=root.asset.hash;
    expect(()=>unpackRecordingBundle(chunked.manifest,asset=>chunked.packaged.assets.find(a=>a.asset.id===asset.id)!.bytes)).toThrow('recording_chunk_invalid');
  });
  it('stops a multi-chunk load immediately when a later asset is revoked',async()=>{
    const value=fixture(),fetcher=transport(value),invalidated=vi.fn(),revoked=value.packaged.assets[2]!.asset.id;
    const gate=new ReplayGate('/replay',invalidated,async input=>String(input).includes(`/assets/${revoked}?`)?new Response(null,{status:410}):fetcher(input));
    await expect(gate.load()).rejects.toThrow('recording_revoked');expect(invalidated).toHaveBeenCalledOnce();expect(fetcher.mock.calls.filter(([url])=>String(url).includes('/assets/'))).toHaveLength(2);
  });
  it('renews the manifest lease throughout a chunk download lasting longer than six seconds',async()=>{
    vi.useFakeTimers();const value=fixture(),fetcher=transport(value),invalidated=vi.fn();let next=0;
    const starts=Array.from({length:value.packaged.assets.length-1},()=>{let announce!:()=>void;const promise=new Promise<void>(resolve=>{announce=resolve;});return {promise,announce};});
    const gate=new ReplayGate('/replay',invalidated,async input=>{
      if(/\/assets\/(events|providers)-/.test(String(input))){starts[next++]!.announce();await new Promise(resolve=>setTimeout(resolve,2100));}
      return fetcher(input);
    });
    const loaded=gate.load();
    // Advance one bounded asset at a time so native digest promises can settle between chunks.
    for(const started of starts){await started.promise;await vi.advanceTimersByTimeAsync(2100);}
    try{expect(await loaded).toEqual(validateBundle(value.bundle));expect(invalidated).not.toHaveBeenCalled();expect(fetcher.mock.calls.filter(([url])=>!String(url).includes('/assets/')).length).toBeGreaterThanOrEqual(5);}finally{gate.dispose();}
  });
  it('rejects a single oversized normalized record instead of silently truncating it',()=>{
    const bundle=createAuthoredBundle();bundle.providers[0]!.input={text:'x'.repeat(3_000_000)};expect(()=>packageRecordingBundle(bundle)).toThrow('recording_item_too_large');
  });
  it('rejects oversized offline files before reading or parsing their body',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'previously-offline-bound-')),path=join(directory,'large.json');
    try{const file=await open(path,'wx');try{await file.truncate(32_000_001);}finally{await file.close();}await expect(replayOffline(path)).rejects.toThrow('recording_bundle_too_large');}finally{await rm(directory,{recursive:true,force:true});}
  });
});
