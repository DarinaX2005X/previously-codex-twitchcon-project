import { describe,it,expect } from 'vitest';
import { createPublicationService } from '../../src/cloud/service.js';
import { sha256 } from '../../src/cloud/signing.js';
import { LIMITS, type PublicationOperation, type ExportManifest } from '../../src/cloud/contracts.js';
import { MemoryBlobStore,NOW,snapshot } from './helpers.js';

// AUTHORED DEVELOPMENT FIXTURE. In-memory Blob store; no Vercel calls.
const login='authored_channel',channelId='channel123';
const base=(seq:number,privacyRevision=0)=>({channelId,channelLogin:login,publishSeq:seq,privacyRevision});
function setup(){const store=new MemoryBlobStore();const service=createPublicationService({store,channelLogin:login,now:()=>NOW});let seq=0;
  const publish=(op:(seq:number)=>PublicationOperation)=>{const value=op(++seq);return service.publish(value,sha256(JSON.stringify(value)));};
  const paths=(part:string)=>[...store.data.keys()].filter(path=>path.includes(part));
  const contains=(text:string)=>[...store.data.values()].some(blob=>new TextDecoder().decode(blob.bytes).includes(text));
  async function exportRecording(id:string,privacyRevision=0,sourceSessionId='episode1'){
    const bytes=new TextEncoder().encode(`{"recording":"${id}"}`),asset={id:'bundle',hash:sha256(bytes),bytes:bytes.length,mime:'application/json' as const,kind:'bundle' as const};
    await service.uploadAsset({...base(seq+1,privacyRevision),exportId:id,revision:1,asset},bytes);
    const manifest:ExportManifest={schemaVersion:1,id,revision:1,origin:'authored',sourceSessionId,durationMs:1000,bundleHash:asset.hash,assets:[asset],milestones:[],providerVersions:{}};
    return publish(s=>({...base(s,privacyRevision),operation:'export_manifest',manifest}));
  }
  return {store,service,publish,paths,contains,exportRecording,get seq(){return seq;}};
}
const finalized=(id:string)=>(seq:number):PublicationOperation=>({...base(seq),operation:'snapshot',snapshots:[{...snapshot(id,1,'finalized'),session:{...snapshot(id,1,'finalized').session,startedAt:new Date(NOW-1_000_000+seq*1000).toISOString()},chapters:[{...snapshot(id).chapters[0]!,summary:`Summary of ${id}`}]}],activeSessionId:null,liveLeaseUntil:null});

describe('cloud retention',()=>{
  it('publishes the 101st episode by evicting the oldest finalized one and deletes its stored object',async()=>{
    const h=setup();
    for(let i=1;i<=LIMITS.episodes+1;i++)await h.publish(finalized(`ep${i}`));
    await expect(h.service.readSnapshot(channelId,`ep${LIMITS.episodes+1}`)).resolves.toMatchObject({session:{id:`ep${LIMITS.episodes+1}`}});
    await expect(h.service.readSnapshot(channelId,'ep1')).rejects.toMatchObject({status:410});
    await expect(h.service.readSnapshot(channelId,'ep2')).resolves.toBeDefined();
    expect(h.paths('/snapshots/')).toHaveLength(LIMITS.episodes);expect(h.contains('Summary of ep1"')).toBe(false);
  });
  it('removes the stored objects of a retracted episode and of a replaced snapshot',async()=>{
    const h=setup();await h.publish(finalized('ep1'));await h.publish(finalized('ep2'));
    await h.publish(s=>({...base(s),operation:'snapshot',snapshots:[{...snapshot('ep2',2,'finalized'),chapters:[{...snapshot('ep2').chapters[0]!,summary:'Second wording'}]}],activeSessionId:null,liveLeaseUntil:null}));
    expect(h.paths('/snapshots/')).toHaveLength(2);
    await h.publish(s=>({...base(s,1),operation:'retract',sessionIds:['ep1'],exportIds:[],snapshots:[]}));
    expect(h.paths('/snapshots/')).toHaveLength(1);expect(h.contains('Summary of ep1"')).toBe(false);
    await expect(h.service.readSnapshot(channelId,'ep1')).rejects.toMatchObject({status:410});
  });
  it('lets an 11th export publish: revoked exports no longer count and the oldest active one is retired',async()=>{
    const h=setup();
    for(let i=1;i<=LIMITS.exports;i++)await h.exportRecording(`replay${i}`);
    await h.publish(s=>({...base(s,1),operation:'retract',sessionIds:[],exportIds:['replay1'],snapshots:[]}));
    expect(h.paths('/exports/replay1/')).toEqual([]);expect(h.paths('/manifests/replay1-')).toEqual([]);
    await h.exportRecording('replay11',1);
    await expect(h.service.readManifest(channelId,'replay11',1)).resolves.toBeDefined();
    await h.exportRecording('replay12',1);
    await expect(h.service.readManifest(channelId,'replay12',1)).resolves.toBeDefined();
    await expect(h.service.readManifest(channelId,'replay2',1)).rejects.toMatchObject({status:410});
    expect(h.paths('/exports/replay2/')).toEqual([]);
    const head=(await h.service.getHead(channelId))!.head;expect(head.exports.filter(p=>p.status==='active')).toHaveLength(LIMITS.exports);
    // A withdrawn export revision still cannot be published again.
    expect(head.exports.find(p=>p.id==='replay1')?.status).toBe('revoked');
  });
});
