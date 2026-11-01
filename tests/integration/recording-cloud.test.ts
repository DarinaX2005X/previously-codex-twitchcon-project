import {afterEach,describe,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {createCloudRuntime,type CloudRuntime} from '../../src/server/runtime/cloud-runtime.js';
import {createLiveRuntime} from '../../src/server/runtime/live.js';
import {loadConfig} from '../../src/server/runtime/config.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {RecordingExportRegistry} from '../../src/server/replay/recording-registry.js';
import type {ReviewedExport} from '../../src/server/replay/recording-types.js';
import type {Principal} from '../../src/server/runtime/security.js';
import {encodeWav} from '../../src/server/audio/wav.js';
import {validateBundle} from '../../src/replay/contracts.js';
import {ManifestSchema} from '../../src/cloud/contracts.js';
import {createCloudHandler} from '../../src/cloud/http.js';
import {createPublicationService} from '../../src/cloud/service.js';
import {MemoryBlobStore} from '../publication/helpers.js';
import type {Source} from '../../src/shared/contracts/index.js';

const START=Date.parse('2026-11-02T12:00:00Z'),secret='authored-cloud-secret-'.repeat(3);
const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.restoreAllMocks();});
function directory(){const dir=mkdtempSync(join(tmpdir(),'previously-recording-cloud-'));cleanups.push(()=>{if(!resolve(dir).startsWith(resolve(tmpdir())+sep))throw new Error('Unexpected test directory');rmSync(dir,{recursive:true,force:true});});return dir;}
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function harness(intercept?:(request:Request,handler:(request:Request)=>Promise<Response>)=>Promise<Response>){
  const dataDir=directory(),clock={now:()=>START+1000,iso:()=>new Date(START+1000).toISOString()},scope={channelId:'authored_channel',runId:'live'},channel={id:scope.channelId,login:'authored_fixture',displayName:'Authored fixture'};
  const storage=createStorage({path:':memory:',now:clock.now});cleanups.push(()=>storage.close());const updates=new RevisionStream();cleanups.push(()=>updates.close());
  const safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'},clock.now);let bridge:CloudRuntime|undefined;
  const engine=new StoryEngine({scope,channel,storage,clock,updates,safety,story:{propose:async()=>{throw new Error('No providers in recording cloud tests');}},onEffects:(...args)=>bridge?.onEffects(...args)});
  storage.repository.updateSettings(scope,0,{listeningPaused:false});storage.repository.createSession(scope,{id:'session',startedAt:new Date(START).toISOString()});
  const source:Source={...scope,id:'speech',sessionId:'session',revision:1,kind:'speech',startMs:0,endMs:1000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'The dough is resting.',status:'active',externalMessageId:null,moderation:'allowed'};
  await engine.dispatch('session',{type:'source',source});
  const registryOptions={repository:storage.repository,scope,dataDir,channelLogin:channel.login,outputsBlocked:()=>engine.outputsBlocked()};
  const registry=new RecordingExportRegistry(registryOptions),store=new MemoryBlobStore(),service=createPublicationService({store,channelLogin:channel.login,now:clock.now}),handler=createCloudHandler({service,secret,channelLogin:channel.login,now:clock.now});
  const requests:Request[]=[];
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const request=new Request(input,init);requests.push(request.clone());return intercept?intercept(request,handler):handler(request);});
  bridge=createCloudRuntime({scope,channel,storage,engine,clock,updates,publicOrigin:'https://authored-cloud.test',sharedSecret:secret,recordingExports:registry,fetch:fetcher});cleanups.push(()=>bridge!.close());
  const id='recording-'+randomUUID(),refs=[{id:source.id,revision:source.revision}];
  const bundle=validateBundle({schemaVersion:1,origin:'authored',id,revision:1,durationMs:1000,tickMode:'recorded',initial:{channel,session:engine.state('session').session,settings:engine.state('session').settings},events:[{atMs:1000,event:{type:'source',source}}],providers:[],media:[{id:'authored-audio',assetId:'audio',sourceRefs:refs,startMs:0,endMs:1000}],milestones:[],correction:{title:'',summary:''},assertions:[]});
  const bundleBytes=new TextEncoder().encode(JSON.stringify(bundle)),audioBytes=encodeWav(new Float32Array(8000),8000);
  const assets:ReviewedExport['assets']=[{asset:{id:'bundle',kind:'bundle',mime:'application/json',bytes:bundleBytes.length,hash:sha256(bundleBytes)},bytes:bundleBytes},{asset:{id:'audio',kind:'audio',mime:'audio/wav',bytes:audioBytes.length,hash:sha256(audioBytes)},bytes:audioBytes}];
  const manifest=ManifestSchema.parse({schemaVersion:1,id,revision:1,origin:'authored',sourceSessionId:'session',durationMs:1000,bundleHash:sha256(bundleBytes),assets:assets.map(item=>item.asset),milestones:[],providerVersions:{model:'authored-no-model'}});
  const reviewed:ReviewedExport={recordingId:'authored-recording',reviewReceiptId:'authored-complete-review',scope,sourceSessionId:'session',privacyEpoch:0,sourceRefs:refs,intervals:[{startMs:0,endMs:1000}],manifest,assets,bundle};
  expect(registry.register(reviewed)).toEqual({exportId:id,status:'staged'});
  return {dataDir,scope,storage,engine,registry,bridge,service,handler,requests,fetcher,id,manifest,bundleBytes,audioBytes};
}

describe('explicit recording export through the real cloud bridge, authored bytes only',()=>{
  it('does not upload staged recordings, then signs both binary assets before publishing a readable manifest',async()=>{
    const h=await harness();expect(await h.bridge.tick()).toBe('idle');expect(h.fetcher).not.toHaveBeenCalled();expect(h.storage.repository.claimOutbox(h.scope,{kinds:['export_manifest']})).toBeNull();
    const queued=h.registry.queue(h.id);expect(await h.bridge.tick()).toBe('acknowledged');
    expect(h.requests.map(request=>new URL(request.url).pathname)).toEqual(['/api/publish/export-assets','/api/publish/export-assets','/api/publish']);
    for(const [index,request]of h.requests.slice(0,2).entries()){
      expect(request.headers.get('content-type')).toBe('application/octet-stream');const frame=new Uint8Array(await request.arrayBuffer()),newline=frame.indexOf(10),metadata=JSON.parse(new TextDecoder().decode(frame.subarray(0,newline)));
      expect(metadata).toMatchObject({exportId:h.id,publishSeq:queued.publishSeq,privacyRevision:0,asset:{id:index===0?'bundle':'audio'}});expect(frame.subarray(newline+1)).toEqual(index===0?h.bundleBytes:h.audioBytes);
    }
    expect((await h.service.readManifest(h.scope.channelId,h.id,1)).manifest).toEqual(h.manifest);
    const manifestResponse=await h.handler(new Request(`https://authored-cloud.test/api/public/replays/${h.id}`));expect(manifestResponse.status).toBe(200);expect(await manifestResponse.json()).toMatchObject({id:h.id,visibilityLeaseMs:6000});
    const assetResponse=await h.handler(new Request(`https://authored-cloud.test/api/public/replays/${h.id}/assets/audio?revision=1`,{headers:{Range:'bytes=0-43'}}));expect(assetResponse.status).toBe(206);expect(new Uint8Array(await assetResponse.arrayBuffer())).toEqual(h.audioBytes.subarray(0,44));
    expect(h.storage.repository.getPublicationState(h.scope).ackSeq).toBe(queued.publishSeq);expect(h.engine.statuses().cloud.state).toBe('ready');
  });
  it('cancels the export lineage when privacy changes during asset upload and never sends its manifest',async()=>{
    let started!:()=>void,release!:()=>void;const sent=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const h=await harness(async(request,handler)=>{if(new URL(request.url).pathname==='/api/publish/export-assets'){started();await gate;}return handler(request);});
    h.registry.queue(h.id);const attempt=h.bridge.tick();await sent;
    await h.engine.dispatch('session',{type:'privacy',target:{kind:'source',sessionId:'session',id:'speech'}});release();await attempt;
    expect(h.requests).toHaveLength(1);expect(new URL(h.requests[0].url).pathname).toBe('/api/publish/export-assets');
    expect(h.storage.repository.getEntity(h.scope,h.id)?.status).toBe('hidden');expect(()=>h.registry.read(h.id)).toThrow('export_revoked');expect(()=>h.registry.queue(h.id)).toThrow('export_source_changed');
    expect(h.storage.repository.claimOutbox(h.scope,{kinds:['export_manifest']})).toBeNull();await expect(h.service.readManifest(h.scope.channelId,h.id,1)).rejects.toMatchObject({status:410});
    expect(await h.bridge.tick()).toBe('acknowledged');const retraction=await h.requests.at(-1)!.json();expect(retraction.operation).toBe('retract');expect(retraction.exportIds).toContain(h.id);
    await expect(h.service.readAsset(h.scope.channelId,h.id,1,'bundle')).rejects.toMatchObject({status:410});h.registry.purgeInvalidated();expect(readdirSync(join(h.dataDir,'exports','reviewed-recordings'))).toEqual([]);
  });
  it('withdraws only the explicit recording after exact cloud acknowledgement and preserves its source session',async()=>{
    const h=await harness(),before=h.storage.repository.getSession(h.scope,'session');
    h.registry.queue(h.id);expect(await h.bridge.tick()).toBe('acknowledged');expect(h.registry.status(h.id).state).toBe('published');
    expect(h.registry.readArchive(h.id).mime).toBe('application/zip');
    h.registry.revoke(h.id);expect(h.registry.status(h.id)).toMatchObject({state:'revoked',revocationPending:true,removalAllowed:false});
    expect(()=>h.registry.read(h.id)).toThrow('export_revoked');expect(()=>h.registry.readArchive(h.id)).toThrow('export_revoked');
    expect(await h.bridge.tick()).toBe('acknowledged');
    expect(await h.requests.at(-1)!.json()).toMatchObject({operation:'retract',sessionIds:[],snapshots:[],exportIds:[h.id]});
    expect(h.registry.status(h.id)).toMatchObject({state:'revoked',revocationPending:false,removalAllowed:true});
    for(const suffix of ['', '/assets/audio?revision=1','/assets/bundle?revision=1'])expect((await h.handler(new Request(`https://authored-cloud.test/api/public/replays/${h.id}${suffix}`))).status).toBe(410);
    expect(h.storage.repository.getSource(h.scope,'speech')).toMatchObject({status:'active',revision:1,text:'The dough is resting.'});
    expect(h.storage.repository.getSession(h.scope,'session').privacyEpoch).toBe(before.privacyEpoch);
    expect(h.engine.state('session').sources.find(source=>source.id==='speech')?.text).toBe('The dough is resting.');
  });
  it('aborts an upload and blocks subsequent output while an engine privacy control is pending',async()=>{
    let started!:()=>void,observed:AbortSignal|undefined;const sent=new Promise<void>(resolve=>started=resolve);
    const h=await harness(request=>new Promise<Response>((_resolve,reject)=>{observed=request.signal;request.signal.addEventListener('abort',()=>reject(new Error('Authored privacy suspension')),{once:true});started();}));
    h.registry.queue(h.id);const attempt=h.bridge.tick();await sent;
    // This is the same pair used by the live runtime's pending-privacy callback.
    h.engine.setOutputsBlocked(true);h.bridge.suspend();await attempt;
    expect(observed?.aborted).toBe(true);expect(await h.bridge.tick()).toBe('idle');expect(h.requests).toHaveLength(1);expect(h.storage.repository.getPublicationState(h.scope).ackSeq).toBe(0);
    await expect(h.service.readManifest(h.scope.channelId,h.id,1)).rejects.toMatchObject({status:410});expect(h.requests.some(request=>new URL(request.url).pathname==='/api/publish')).toBe(false);
  });
  it('creates no recordings and captures no committed events by default in the live composition',async()=>{
    const dataDir=directory(),clock={now:()=>START,iso:()=>new Date(START).toISOString()},storage=createStorage({path:join(dataDir,'state.sqlite'),encryptionKey:Buffer.alloc(32,7),now:clock.now}),updates=new RevisionStream();
    cleanups.push(()=>storage.close());cleanups.push(()=>updates.close());const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No external requests allowed'));
    const config=loadConfig({DATA_DIR:dataDir,SESSION_SECRET:'s'.repeat(32),TWITCH_CLIENT_ID:'authored',TWITCH_CLIENT_SECRET:'authored',TWITCH_CHANNEL_LOGIN:'authored_fixture',OPENAI_PAID_CALLS_ENABLED:'false'},dataDir);
    const live=await createLiveRuntime({config,storage,updates,clock,channel:{id:'123456',login:'authored_fixture',displayName:'Authored fixture'}});expect(live).not.toBeNull();cleanups.push(()=>live!.close());
    const principal:Principal={...live!.scope,role:'owner',actorId:'owner',sessionId:'authored-browser',expiresAtMs:START+60000};
    await live!.start();expect(live!.recorder.list(principal)).toMatchObject({items:[],activeId:null});expect(live!.engine.statuses().mic.state).toBe('paused');
    storage.repository.createSession(live!.scope,{id:'session',startedAt:clock.iso()});
    await live!.engine.dispatch('session',{type:'source',source:{...live!.scope,id:'authored-owner-note',sessionId:'session',revision:1,kind:'owner_statement',startMs:0,endMs:0,actorId:'owner',languageCodes:['en'],timePrecision:'event',text:'An authored cooking note.',status:'active',externalMessageId:null,moderation:'allowed'}});
    expect(live!.engine.state('session').sources).toHaveLength(1);
    expect(live!.recorder.list(principal)).toMatchObject({items:[],activeId:null});expect(readdirSync(join(dataDir,'exports','private-recordings')).filter(file=>file.endsWith('.json'))).toEqual([]);expect(fetcher).not.toHaveBeenCalled();expect(storage.budget.status().usedMicroUsd).toBe(0);
  });
});
