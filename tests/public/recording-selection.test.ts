import {describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import {createServer} from 'node:http';
import {createAuthoredBundle} from '../../fixtures/authored-notes.js';
import {PublicationService} from '../../src/cloud/service.js';
import {createCloudHandler} from '../../src/cloud/http.js';
import {sha256} from '../../src/cloud/signing.js';
import {ReplayGate} from '../../src/replay/gate.js';
import {createLocalReplayHandler} from '../../src/server/replay/local.js';
import {packageRecordingBundle} from '../../src/server/replay/recording-package.js';
import {MemoryBlobStore} from '../publication/helpers.js';
import {createPublicReadRouter} from '../../src/server/runtime/public-routes.js';
import {apiErrorHandler} from '../../src/server/runtime/errors.js';

function harness(){
  const store=new MemoryBlobStore(),service=new PublicationService({store,channelLogin:'authored_selection'}),handler=createCloudHandler({service,channelLogin:'authored_selection',secret:'fixture-secret'.repeat(3)});
  const base={channelId:'authored-selection',channelLogin:'authored_selection'};let sequence=0,privacyRevision=0;
  async function publish(id:string,origin:'authored'|'own-stream'){
    const bundle=createAuthoredBundle();bundle.id=id;bundle.origin=origin;const packaged=packageRecordingBundle(bundle),publishSeq=++sequence;
    for(const value of packaged.assets)await service.uploadAsset({...base,publishSeq,privacyRevision,exportId:id,revision:bundle.revision,asset:value.asset},value.bytes);
    const operation={...base,publishSeq,privacyRevision,operation:'export_manifest',manifest:{schemaVersion:1,id,revision:bundle.revision,origin,sourceSessionId:bundle.initial.session.id,durationMs:bundle.durationMs,bundleHash:packaged.bundleHash,assets:packaged.assets.map(a=>a.asset),milestones:bundle.milestones,providerVersions:{model:'authored-no-model'}}};
    await service.publish(operation,sha256(new TextEncoder().encode(JSON.stringify(operation))));return bundle;
  }
  async function revoke(ids:string[]){const operation={...base,publishSeq:++sequence,privacyRevision:++privacyRevision,operation:'retract',exportIds:ids,sessionIds:[],snapshots:[]};await service.publish(operation,sha256(new TextEncoder().encode(JSON.stringify(operation))));}
  const get=(path='/api/public/replays')=>handler(new Request('https://authored.test'+path));
  return {store,service,handler,publish,revoke,get};
}

describe('public recording discovery',()=>{
  it('selects the latest active own-stream publication ahead of newer authored examples and returns only its stable ID',async()=>{
    const h=harness();await h.publish('authored-first','authored');await h.publish('own-first','own-stream');await h.publish('own-latest','own-stream');await h.publish('authored-newer','authored');
    const response=await h.get();expect(response.status).toBe(200);expect(await response.json()).toEqual({id:'own-latest'});expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('filters withdrawn recordings, falls back to the latest authored example, and returns 410 when none remain',async()=>{
    const h=harness();await h.publish('authored-first','authored');await h.publish('authored-latest','authored');await h.publish('own-withdrawn','own-stream');await h.revoke(['own-withdrawn']);
    expect(await(await h.get()).json()).toEqual({id:'authored-latest'});await h.revoke(['authored-latest']);expect(await(await h.get()).json()).toEqual({id:'authored-first'});
    await h.revoke(['authored-first']);const unavailable=await h.get();expect(unavailable.status).toBe(410);expect(await unavailable.json()).toMatchObject({error:{code:'recording_unavailable'}});
  });
  it('keeps selected links behind the real manifest and asset revocation gates',async()=>{
    const h=harness();await h.publish('selected-own','own-stream');const selected=await(await h.get()).json() as {id:string},invalidated=vi.fn();
    const fetcher=vi.fn((input:RequestInfo|URL)=>h.handler(new Request(new URL(String(input),'https://authored.test')))),manifestPath=`/api/public/replays/${selected.id}`,gate=new ReplayGate(manifestPath,invalidated,fetcher);
    try{expect((await gate.load()).id).toBe(selected.id);expect(fetcher.mock.calls.filter(([url])=>String(url)===manifestPath)).toHaveLength(2);await h.revoke([selected.id]);await gate.revalidate();expect(invalidated).toHaveBeenCalledOnce();expect((await h.get(manifestPath+'/assets/bundle?revision=1')).status).toBe(410);}finally{gate.dispose();}
  });
  it('does not serve a discovered recording withdrawn before its manifest is opened',async()=>{
    const h=harness();await h.publish('selected-own','own-stream');const selected=await(await h.get()).json() as {id:string};await h.revoke([selected.id]);
    const gate=new ReplayGate(`/api/public/replays/${selected.id}`,vi.fn(),input=>h.handler(new Request(new URL(String(input),'https://authored.test'))));
    await expect(gate.load()).rejects.toThrow('recording_revoked');
  });
  it('exposes the same discovery route from the isolated local authored registry',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'previously-local-selection-'));
    try{const handler=await createLocalReplayHandler(directory),response=await handler(new Request('https://localhost/api/public/replays'));expect(response.status).toBe(200);expect(await response.json()).toEqual({id:'foxlight'});expect((await handler(new Request('https://localhost/api/public/replays/foxlight'))).status).toBe(200);}finally{await rm(directory,{recursive:true,force:true});}
  });
  it('forwards the local discovery route and falls back only for absent cloud indexes',async()=>{
    const h=harness();await h.publish('cloud-own','own-stream');let failure=0;
    const authored=vi.fn(async()=>Response.json({id:'authored-notes'})),cloud=vi.fn(async(input:RequestInfo|URL)=>failure?new Response(null,{status:failure}):h.handler(new Request(input)));
    const app=express();app.use('/api/public',createPublicReadRouter({cloudOrigin:'https://authored.test',authored,fetch:cloud}));app.use(apiErrorHandler);const server=createServer(app);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture_address');
    const url=`http://127.0.0.1:${address.port}/api/public/replays`;
    try{
      expect(await(await fetch(url)).json()).toEqual({id:'cloud-own'});expect(authored).not.toHaveBeenCalled();
      for(const status of [404,410]){failure=status;expect(await(await fetch(url)).json()).toEqual({id:'authored-notes'});}
      expect(authored).toHaveBeenCalledTimes(2);failure=503;expect((await fetch(url)).status).toBe(503);expect(authored).toHaveBeenCalledTimes(2);
      failure=410;expect((await fetch(url+'/cloud-own')).status).toBe(410);expect(authored).toHaveBeenCalledTimes(2);
      expect(cloud.mock.calls.map(([input])=>new URL(String(input)).pathname)).toContain('/api/public/replays');
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
});
