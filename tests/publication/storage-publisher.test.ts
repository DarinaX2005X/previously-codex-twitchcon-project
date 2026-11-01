import {describe,it,expect} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {LocalPublisher} from '../../src/server/publication/index.js';
import {createPublicationService} from '../../src/cloud/service.js';
import {createCloudHandler} from '../../src/cloud/http.js';
import {MemoryBlobStore,NOW,snapshot} from './helpers.js';
import type {PublicationOperation} from '../../src/cloud/contracts.js';
describe('SQLite outbox to cloud service integration',()=>{
  it('persists exact retry body and clears pending only after actual handler ACK',async()=>{
    let now=NOW;const storage=createStorage({path:':memory:',now:()=>now}),repository=storage.repository,scope={channelId:'channel123',runId:'live'};
    try{
      repository.ensureChannel(scope,'authored_channel');repository.createSession(scope,{id:'episode1',startedAt:new Date(NOW-100_000).toISOString()});
      repository.enqueueOutbox(scope,{sessionId:'episode1',kind:'publish',businessKey:'snapshot:1',payload:{revision:1}});
      const secret='x'.repeat(64),service=createPublicationService({store:new MemoryBlobStore(),channelLogin:'authored_channel',now:()=>now}),handler=createCloudHandler({service,secret,channelLogin:'authored_channel',now:()=>now});
      let attempts=0,builds=0;const bodies:string[]=[];
      const publisher=new LocalPublisher({repository,scope,secret,publicOrigin:'https://cloud.test',now:()=>now,buildOperation:lease=>{builds++;return {operation:'snapshot',channelId:scope.channelId,channelLogin:'authored_channel',publishSeq:lease.publishSeq!,privacyRevision:repository.getPublicationState(scope).privacyRevision,snapshots:[snapshot()],activeSessionId:'episode1',liveLeaseUntil:new Date(NOW+30_000).toISOString()};},validate:(_lease,operation)=>operation.privacyRevision===repository.getPublicationState(scope).privacyRevision,fetch:(async(url,init)=>{bodies.push(String(init?.body));const response=await handler(new Request(url,init));if(++attempts===1)throw new Error('ACK lost after commit');return response;}) as typeof fetch});
      expect(await publisher.tick()).toBe('retry');expect(repository.getPublicationState(scope).ackSeq).toBe(0);
      now+=3000;expect(await publisher.tick()).toBe('acknowledged');expect(builds).toBe(1);expect(bodies[0]).toBe(bodies[1]);expect(repository.getPublicationState(scope).ackSeq).toBe(1);
      repository.invalidate(scope,{kind:'session',sessionId:'episode1'},{idempotencyKey:'forget1',reason:'test'});
      const retractPublisher=new LocalPublisher({repository,scope,secret,publicOrigin:'https://cloud.test',now:()=>now,buildOperation:lease=>({operation:'retract',channelId:scope.channelId,channelLogin:'authored_channel',publishSeq:lease.publishSeq!,privacyRevision:repository.getPublicationState(scope).privacyRevision,sessionIds:['episode1'],exportIds:[],snapshots:[]}) satisfies PublicationOperation,validate:(_lease,operation)=>operation.privacyRevision===repository.getPublicationState(scope).privacyRevision,fetch:(async(url,init)=>handler(new Request(url,init))) as typeof fetch});
      expect(repository.getPublicationState(scope).pendingPrivacy).toBe(true);expect(await retractPublisher.tick()).toBe('acknowledged');expect(repository.getPublicationState(scope).pendingPrivacy).toBe(false);await expect(service.readSnapshot(scope.channelId,'episode1')).rejects.toMatchObject({status:410});
    }finally{storage.close();}
  });
});
