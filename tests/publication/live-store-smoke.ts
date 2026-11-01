import { strict as assert } from 'node:assert';
import { type BlobStore, CasConflict } from '../../src/cloud/blob-store.js';
import { createPublicationService } from '../../src/cloud/service.js';
import { sha256 } from '../../src/cloud/signing.js';
import type { PublicationOperation,ExportManifest } from '../../src/cloud/contracts.js';
import { snapshot } from './helpers.js';

/** Explicit orchestration hook. Never reads credentials or executes automatically in the test suite.
 * Caller must use an isolated, authorized test login/channel. Returned results are IDs/counts only. */
export async function runBlobSmoke(options:{store:BlobStore;channelLogin:string;channelId:string;now?:()=>number}){
  const clock=options.now??Date.now,service=createPublicationService({...options,now:clock}),prior=await service.getHead(options.channelId);
  let seq=prior?.head.publishSeq??0,privacy=prior?.head.privacyRevision??0;const sessionId=`probe_${clock()}`,exportId=`export_${clock()}`;
  const common=()=>({channelId:options.channelId,channelLogin:options.channelLogin,publishSeq:++seq,privacyRevision:privacy});
  const post=(op:PublicationOperation)=>service.publish(op,sha256(JSON.stringify(op)));
  const fixture=snapshot(sessionId,1);fixture.channel={id:options.channelId,login:options.channelLogin,displayName:'Authorized authored smoke'};fixture.liveLeaseUntil=new Date(clock()+30_000).toISOString();fixture.asOf=new Date(clock()-75_000).toISOString();fixture.publishedAt=new Date(clock()).toISOString();
  await post({...common(),operation:'snapshot',snapshots:[fixture],activeSessionId:sessionId,liveLeaseUntil:fixture.liveLeaseUntil});assert.equal((await service.readSnapshot(options.channelId,sessionId)).revision,1);
  // Distinct bodies are necessary: identical content can retain its ETag.
  const casPath=`channels/${options.channelId}/objects/${seq}/cas-probe-${clock()}.json`,created=await options.store.put(casPath,new TextEncoder().encode('initial'),{contentType:'application/json'});
  const race=await Promise.allSettled(['one','two'].map(value=>options.store.put(casPath,new TextEncoder().encode(value),{ifMatch:created.etag,contentType:'application/json'})));
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert(race.some(r=>r.status==='rejected'&&r.reason instanceof CasConflict));
  const bytes=new TextEncoder().encode(JSON.stringify({origin:'authored',events:[]})),hash=sha256(bytes),asset={id:'bundle',hash,bytes:bytes.length,mime:'application/json' as const,kind:'bundle' as const};
  const exportBase=common();await service.uploadAsset({...exportBase,exportId,revision:1,asset},bytes);
  await assert.rejects(service.readAsset(options.channelId,exportId,1,'bundle'));
  const manifest:ExportManifest={schemaVersion:1,id:exportId,revision:1,origin:'authored',sourceSessionId:sessionId,durationMs:1000,bundleHash:hash,assets:[asset],milestones:[],providerVersions:{}};
  const exportOp:PublicationOperation={...exportBase,operation:'export_manifest',manifest};await post(exportOp);assert.equal((await service.readAsset(options.channelId,exportId,1,'bundle')).bytes.length,bytes.length);
  privacy++;await post({...common(),operation:'retract',sessionIds:[],exportIds:[exportId],snapshots:[]});await assert.rejects(service.readAsset(options.channelId,exportId,1,'bundle'),{status:410});await assert.rejects(post(exportOp),{code:'stale_sequence'});
  const expired=createPublicationService({...options,now:()=>clock()+60_000});await assert.rejects(expired.readSnapshot(options.channelId,sessionId),{code:'live_recap_unavailable'});
  const final={...fixture,revision:2,session:{...fixture.session,status:'finalized' as const,endedAt:new Date(clock()).toISOString()},liveLeaseUntil:null};
  await post({...common(),operation:'snapshot',snapshots:[final],activeSessionId:null,liveLeaseUntil:null});assert.equal((await expired.readSnapshot(options.channelId,sessionId)).session.status,'finalized');
  const beforeCleanup=(await service.getHead(options.channelId))!.head;
  privacy++;await post({...common(),operation:'retract',sessionIds:beforeCleanup.episodePointers.map(p=>p.sessionId),exportIds:beforeCleanup.exports.map(p=>p.id),snapshots:[]});await assert.rejects(service.readSnapshot(options.channelId,sessionId),{status:410});
  let cleaned=0;
  if(options.store.list){
    // Caller explicitly supplies an isolated test identity. Remove prior failed probe orphans too.
    let cursor:string|undefined;const paths:string[]=[];
    for(let page=0;page<10;page++){const result=await options.store.list(`channels/${options.channelId}/objects/`,cursor);paths.push(...result.paths);cursor=result.cursor;if(!cursor)break;}
    for(let start=0;start<paths.length;start+=100)cleaned+=(await service.maintenance(options.channelId,paths.slice(start,start+100))).deleted.length;
  }else cleaned=(await service.maintenance(options.channelId,[casPath])).deleted.length;
  return {passed:['private initial publish/read','CAS conflict','uncached current head','asset gate','asset revoke 410','stale retry','expired live lease','finalized after shutdown'],sessionId,exportId,publishSeq:seq,cleaned};
}
