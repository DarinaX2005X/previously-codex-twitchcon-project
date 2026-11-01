import { describe,it,expect } from 'vitest';
import { createPublicationService } from '../../src/cloud/service.js';
import { createCloudHandler,encodeAssetUpload } from '../../src/cloud/http.js';
import { sha256,signedHeaders } from '../../src/cloud/signing.js';
import { type PublicationOperation, type ExportManifest, type AssetUpload } from '../../src/cloud/contracts.js';
import { MemoryBlobStore,NOW,snapshot } from './helpers.js';
const secret='a'.repeat(64),login='authored_channel',channelId='channel123';
const base=(seq:number,privacyRevision=0)=>({channelId,channelLogin:login,publishSeq:seq,privacyRevision});
function publication(seq=1,s=snapshot()):Extract<PublicationOperation,{operation:'snapshot'}>{return {...base(seq),operation:'snapshot',snapshots:[s],activeSessionId:s.session.status==='finalized'?null:s.session.id,liveLeaseUntil:s.liveLeaseUntil};}
function setup(){const store=new MemoryBlobStore();let now=NOW;const service=createPublicationService({store,channelLogin:login,now:()=>now});const handler=createCloudHandler({service,secret,channelLogin:login,now:()=>now});return {store,service,handler,time:(v:number)=>{now=v;}};}
async function publish(service:ReturnType<typeof createPublicationService>,op:PublicationOperation){return service.publish(op,sha256(JSON.stringify(op)));}
describe('private publication CAS and read policy',()=>{
  it('initial create, exact retry ACK, conflicting same sequence, stale delete retry',async()=>{
    const {service}=setup(),op=publication();const ack=await publish(service,op);expect((await publish(service,op)).headEtag).toBe(ack.headEtag);
    await expect(publish(service,publication(1,snapshot('episode1',2)))).rejects.toMatchObject({code:'sequence_body_conflict'});
    await publish(service,{...base(2,1),operation:'retract',sessionIds:['episode1'],exportIds:[],snapshots:[]});
    await expect(publish(service,op)).rejects.toMatchObject({code:'stale_sequence'});
    await expect(publish(service,{...publication(3),privacyRevision:0})).rejects.toMatchObject({code:'stale_privacy'});
    await expect(service.readSnapshot(channelId,'episode1')).rejects.toMatchObject({status:410});
  });
  it('concurrent conditional writes cannot lose the greater accepted sequence',async()=>{
    const {service,store}=setup();await publish(service,publication());let waiting=0;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    store.beforePut=async path=>{if(!path.endsWith('/head.json'))return;if(++waiting===2)release();if(waiting<=2)await gate;};
    const results=await Promise.allSettled([publish(service,publication(2,snapshot('episode1',2))),publish(service,publication(3,snapshot('episode1',3)))]);
    expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect((await service.getHead(channelId))?.head.publishSeq).toBe(3);expect(store.conflicts).toBeGreaterThan(0);
  });
  it('rejects private properties and non-Twitch public media',async()=>{
    const {service}=setup();await expect(publish(service,publication(1,{...snapshot(),transcript:'private'} as never))).rejects.toBeDefined();
    const s=snapshot();s.moments[0].clip={id:'clip',url:'https://evil.invalid/a',embedUrl:'https://evil.invalid/a'};await expect(publish(service,publication(2,s))).rejects.toMatchObject({code:'unapproved_public_media'});
  });
  it('binds the configured login to one channel identity',async()=>{
    const {service}=setup();await publish(service,publication());const op=publication(2);op.channelId='other';await expect(publish(service,op)).rejects.toMatchObject({code:'channel_identity_changed'});
  });
  it('atomically retracts multiple episodes and retains finalized episodes after shutdown',async()=>{
    const {service,time}=setup();await publish(service,{...publication(),snapshots:[snapshot('one',1,'finalized'),snapshot('two',1,'finalized')],activeSessionId:null,liveLeaseUntil:null});
    time(NOW+100_000);expect((await service.readSnapshot(channelId,'one')).session.status).toBe('finalized');
    await publish(service,{...base(2,1),operation:'retract',sessionIds:['one','two'],exportIds:[],snapshots:[]});
    await expect(service.readSnapshot(channelId,'one')).rejects.toMatchObject({status:410});await expect(service.readSnapshot(channelId,'two')).rejects.toMatchObject({status:410});
  });
  it('editing an older completed episode does not change the channel default episode',async()=>{
    const {service}=setup(),older=snapshot('older',1,'finalized'),newer=snapshot('newer',1,'finalized');older.session.startedAt=new Date(NOW-86_400_000).toISOString();
    await publish(service,{...publication(),snapshots:[older,newer],activeSessionId:null,liveLeaseUntil:null});
    older.revision=2;await publish(service,{...publication(2,older),activeSessionId:null,liveLeaseUntil:null});expect((await service.readSnapshot(channelId)).session.id).toBe('newer');
  });
  it('heartbeat does not rewrite source asOf and expiry hides live content',async()=>{
    const {service,time}=setup();const s=snapshot();await publish(service,publication(1,s));time(NOW+10_000);
    await publish(service,{...base(2),operation:'snapshot',snapshots:[],activeSessionId:'episode1',liveLeaseUntil:new Date(NOW+40_000).toISOString()});
    expect((await service.readSnapshot(channelId)).asOf).toBe(s.asOf);time(NOW+40_000);await expect(service.readSnapshot(channelId)).rejects.toMatchObject({code:'live_recap_unavailable'});
  });
  it('privacy replacement keeps the active safe episode visible under its existing lease',async()=>{
    const {service}=setup();await publish(service,publication());const safe=snapshot('episode1',2);safe.privacyEpoch=1;safe.chapters=[];
    await publish(service,{...base(2,1),operation:'retract',sessionIds:['episode1'],exportIds:[],snapshots:[safe]});
    expect((await service.readSnapshot(channelId)).chapters).toHaveLength(0);expect((await service.getHead(channelId))?.head.activeSessionId).toBe('episode1');
  });
  it('cutoff gates complete dependency ranges, metadata, current, lore and media',async()=>{
    const {service}=setup();await publish(service,publication());const value=await service.readSnapshot(channelId,undefined,85);
    expect(value.chapters).toHaveLength(0);expect(value.current).toBeNull();expect(value.moments).toHaveLength(0);expect(value.lore[0].momentId).toBeNull();
    expect((await service.readSnapshot(channelId,undefined,0)).session.title).toBe('');
  });
  it('maintenance preserves current refs and cannot target future or arbitrary objects',async()=>{
    const {service,store}=setup();await publish(service,publication());const old=(await service.getHead(channelId))!.head.episodePointers[0].snapshotPath;
    await publish(service,publication(2,snapshot('episode1',2)));const current=(await service.getHead(channelId))!.head.episodePointers[0].snapshotPath;
    const receipt=await service.maintenance(channelId,[old,current,`channels/${channelId}/head.json`,'identities/authored_channel.json']);expect(receipt.deleted).toEqual([old]);expect(store.data.has(current)).toBe(true);
  });
  it('rechecks head after loading an immutable body',async()=>{
    const {service,store}=setup();await publish(service,publication());let once=false;
    store.beforeGet=async path=>{if(!once&&path.includes('/snapshots/')){once=true;await publish(service,{...base(2,1),operation:'retract',sessionIds:['episode1'],exportIds:[],snapshots:[]});}};
    await expect(service.readSnapshot(channelId)).rejects.toMatchObject({code:'revalidate'});
  });
});
describe('signed HTTP and revocable replay assets',()=>{
  async function request(handler:ReturnType<typeof createCloudHandler>,path:string,value:unknown,signatureNow=NOW){const body=JSON.stringify(value);return handler(new Request(`https://example.test${path}`,{method:'POST',headers:signedHeaders(secret,'POST',path,channelId,(value as {publishSeq:number}).publishSeq,body,signatureNow),body}));}
  it('checks HMAC over exact body, timestamp, method and path and returns no-store',async()=>{
    const {handler}=setup();expect((await request(handler,'/api/publish',publication(),NOW-60_001)).status).toBe(401);
    const body=JSON.stringify(publication()),headers=signedHeaders(secret,'POST','/api/publish',channelId,1,body,NOW);
    expect((await handler(new Request('https://e.test/api/publish',{method:'POST',headers,body:body+' '}))).status).toBe(401);
    const response=await request(handler,'/api/publish',publication());expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await handler(new Request('https://e.test/api/public/channels/authored_channel'))).status).toBe(200);
  });
  it('asset upload is gated before commit, supports ranges, then old URL is 410 after revoke',async()=>{
    const {handler,service}=setup();const bytes=new TextEncoder().encode('{"sanitized":true}'),asset={id:'bundle',hash:sha256(bytes),bytes:bytes.length,mime:'application/json' as const,kind:'bundle' as const};
    const metadata:AssetUpload={...base(1),exportId:'replay1',revision:1,asset},raw=encodeAssetUpload(metadata,bytes),path='/api/publish/export-assets';
    const response=await handler(new Request('https://e.test'+path,{method:'POST',headers:signedHeaders(secret,'POST',path,channelId,1,raw,NOW),body:raw}));expect(response.status).toBe(200);
    const url='https://e.test/api/public/replays/replay1/assets/bundle?revision=1';expect((await handler(new Request(url))).status).toBe(410);
    const manifest:ExportManifest={schemaVersion:1,id:'replay1',revision:1,origin:'authored',sourceSessionId:'episode1',durationMs:1000,bundleHash:asset.hash,assets:[asset],milestones:[],providerVersions:{}};
    expect((await request(handler,'/api/publish',{...base(1),operation:'export_manifest',manifest})).status).toBe(200);
    const ranged=await handler(new Request(url,{headers:{range:'bytes=0-3'}}));expect(ranged.status).toBe(206);expect(await ranged.text()).toBe('{"sa');
    expect((await handler(new Request(url,{headers:{range:'bytes=0-999999'}}))).status).toBe(416);
    await publish(service,{...base(2,1),operation:'retract',sessionIds:[],exportIds:['replay1'],snapshots:[]});expect((await handler(new Request(url))).status).toBe(410);
    expect((await handler(new Request('https://e.test/api/public/replays/replay1'))).status).toBe(410);
  });
  it('enforces asset cap, snapshot cap and export revision fence',async()=>{
    const {service}=setup();const bytes=new Uint8Array(3_000_001),asset={id:'bundle',hash:sha256(bytes),bytes:bytes.length,mime:'application/json',kind:'bundle'};
    await expect(service.uploadAsset({...base(1),exportId:'replay',revision:1,asset},bytes)).rejects.toBeDefined();
  });
});
