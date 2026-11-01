import { describe,it,expect,vi } from 'vitest';
import { LocalPublisher,heartbeatOperation,type PublicationLease,type PublicationRepository } from '../../src/server/publication/index.js';
import { sha256 } from '../../src/cloud/signing.js';
import { NOW,snapshot } from './helpers.js';
const scope={channelId:'channel123',runId:'live'},secret='s'.repeat(64);
function setup(){
  const lease:PublicationLease={id:'outbox1',sessionId:'episode1',kind:'publish',payload:{reference:'domain'},privacyEpoch:0,leaseToken:'lease1',leaseUntilMs:NOW+30_000,attempts:1,publishSeq:7};
  let queued=true;
  const repository:PublicationRepository={claimOutbox:()=>queued?structuredClone(lease):null,freezePublication:(_s,_id,_token,frozen)=>{lease.frozenPublication??=frozen;return lease.frozenPublication;},renewOutbox:()=>true,finishOutbox:(_s,_id,_token,_status,next)=>{queued=next!==undefined;return true;},acknowledgePublication:vi.fn(()=>true)};
  const operation={operation:'snapshot' as const,channelId:scope.channelId,channelLogin:'authored_channel',publishSeq:7,privacyRevision:0,snapshots:[snapshot()],activeSessionId:'episode1',liveLeaseUntil:new Date(NOW+30_000).toISOString()};
  return {lease,repository,operation};
}
describe('local durable publisher',()=>{
  it('freezes once and resends identical seq and body after ambiguous HTTP failure',async()=>{
    const {repository,operation}=setup(),bodies:string[]=[];let calls=0;
    const buildOperation=vi.fn(()=>structuredClone(operation)),transport=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(String(init?.body));if(++calls===1)throw new Error('lost ACK');return new Response(JSON.stringify({publishSeq:7,headEtag:'etag',publicRevision:1,lastSyncedAt:new Date(NOW).toISOString()}));});
    const publisher=new LocalPublisher({repository,scope,secret,publicOrigin:'https://example.test',now:()=>NOW,buildOperation,validate:()=>true,fetch:transport as typeof fetch});
    expect(await publisher.tick()).toBe('retry');operation.snapshots[0].current!.now='New content must not replace retry body';
    expect(await publisher.tick()).toBe('acknowledged');expect(buildOperation).toHaveBeenCalledTimes(1);expect(bodies[0]).toBe(bodies[1]);expect(repository.acknowledgePublication).toHaveBeenCalledWith(scope,7,sha256(bodies[0]));
  });
  it('privacy fence cancels a frozen old body before network',async()=>{
    const {repository,operation,lease}=setup(),body=JSON.stringify(operation);lease.frozenPublication={body,bodyHash:sha256(body)};const transport=vi.fn();
    const publisher=new LocalPublisher({repository,scope,secret,publicOrigin:'https://example.test',buildOperation:()=>operation,validate:()=>false,fetch:transport});
    expect(await publisher.tick()).toBe('cancelled');expect(transport).not.toHaveBeenCalled();expect(repository.acknowledgePublication).not.toHaveBeenCalled();
  });
  it('does not report synced if privacy invalidates while waiting for cloud ACK',async()=>{
    const {repository,operation}=setup();let valid=true;
    const publisher=new LocalPublisher({repository,scope,secret,publicOrigin:'https://example.test',now:()=>NOW,buildOperation:()=>operation,validate:()=>valid,fetch:(async()=>{valid=false;return new Response(JSON.stringify({publishSeq:7,headEtag:'etag',publicRevision:1,lastSyncedAt:new Date(NOW).toISOString()}));}) as typeof fetch});
    expect(await publisher.tick()).toBe('cancelled');expect(repository.acknowledgePublication).not.toHaveBeenCalled();
  });
  it('heartbeat includes no content to accidentally refresh source timestamps',()=>{
    const heartbeat=heartbeatOperation({channelId:scope.channelId,channelLogin:'authored_channel',publishSeq:8,privacyRevision:1,activeSessionId:'episode1',now:NOW});
    expect(heartbeat).toMatchObject({snapshots:[],liveLeaseUntil:new Date(NOW+30_000).toISOString()});expect(heartbeat).not.toHaveProperty('asOf');
  });
});
