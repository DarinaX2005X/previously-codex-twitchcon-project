import {afterEach,describe,it,expect,vi} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {createCloudRuntime,type CloudRuntime} from '../../src/server/runtime/cloud-runtime.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {createCloudHandler} from '../../src/cloud/http.js';
import {createPublicationService} from '../../src/cloud/service.js';
import {MemoryBlobStore} from '../publication/helpers.js';
import type {Safety,Source,StoryPatch} from '../../src/shared/contracts/index.js';

const START=Date.parse('2026-11-02T12:00:00.000Z'),secret='fixture-secret-'.repeat(5);
const resources:{close():void}[]=[];
afterEach(()=>{for(const resource of resources.splice(0).reverse())resource.close();});
function harness(input:{configured?:boolean;runId?:string;transport?:(request:Request,handle:(request:Request)=>Promise<Response>)=>Promise<Response>}={}){
  let now=START+10_000,bridge:CloudRuntime|undefined;
  const clock={now:()=>now,iso:()=>new Date(now).toISOString()},scope={channelId:'fixture_channel',runId:input.runId??'live'},channel={id:scope.channelId,login:'authored_fixture',displayName:'Authored fixture'};
  const storage=createStorage({path:':memory:',now:clock.now});resources.push(storage);
  const updates=new RevisionStream(),safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=>'allowed'},clock.now);
  const engine=new StoryEngine({scope,channel,storage,clock,updates,safety,story:{propose:async()=>{throw new Error('No provider calls in cloud integration fixtures');}},onEffects:(...args)=>bridge?.onEffects(...args)});
  storage.repository.updateSettings(scope,0,{listeningPaused:false});storage.repository.createSession(scope,{id:'session',startedAt:new Date(START).toISOString()});
  const service=createPublicationService({store:new MemoryBlobStore(),channelLogin:channel.login,now:clock.now}),handler=createCloudHandler({service,secret,channelLogin:channel.login,now:clock.now});
  const requests:Request[]=[];
  const transport=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const request=new Request(input,init);requests.push(request.clone());return inputTransport(request);});
  const inputTransport=(request:Request)=>input.transport?input.transport(request,handler):handler(request);
  const create=()=>createCloudRuntime({scope,channel,engine,storage,clock,updates,publicOrigin:input.configured===false?undefined:'https://fixture-cloud.test',sharedSecret:input.configured===false?undefined:secret,fetch:transport});
  bridge=create();resources.push(bridge);
  const allowed:Safety={moderation:'allowed',pii:'allowed',checkedAt:clock.iso(),reason:null};
  return {scope,channel,storage,engine,clock,service,handler,requests,transport,get bridge(){return bridge!;},setTime(ms:number){now=START+ms;},restart(){bridge!.close();bridge=create();resources.push(bridge);},async flush(){for(let i=0;i<16;i++){const result=await bridge!.tick();if(result==='idle'||result==='retry')return result;}throw new Error('Fixture publication queue did not settle');},async seed(){
    const source:Source={...scope,id:'speech',sessionId:'session',revision:1,kind:'speech',startMs:9000,endMs:10000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'I am testing note persistence.',status:'active',externalMessageId:null,moderation:'allowed'};
    const state=await engine.dispatch('session',{type:'source',source}),ticket=state.pendingGeneration!.ticket;
    const patch:StoryPatch={sessionId:'session',baseRevision:ticket.baseEntityRevision,action:'new_chapter',title:'Testing persistence',claims:[{id:'goal',text:source.text!,role:'goal',support:[{id:source.id,revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
    await engine.dispatch('session',{type:'generation.result',ticket,patch,safety:allowed,grounding:{acceptedClaimIds:['goal'],acceptedRelationKeys:[]}});
    now=START+85_000;return engine.dispatch('session',{type:'tick'});
  }};
}
describe('local cloud runtime bridge',()=>{
  it('stops renewing the live lease while a received privacy control cannot be applied',async()=>{
    const h=harness();await h.seed();await h.flush();const sent=h.requests.length;
    h.engine.setOutputsBlocked(true);h.bridge.suspend();h.setTime(120_000);
    expect(await h.bridge.tick()).toBe('idle');expect(h.requests).toHaveLength(sent);
    await expect(h.service.readSnapshot(h.scope.channelId)).rejects.toMatchObject({code:'live_recap_unavailable'});
    h.bridge.resume();h.engine.setOutputsBlocked(false);await h.flush();
    expect((await h.service.readSnapshot(h.scope.channelId)).chapters).toHaveLength(1);
  });
  it('aborts an in-flight publication and does not accept its acknowledgement during privacy recovery',async()=>{
    let started!:()=>void;const sent=new Promise<void>(resolve=>started=resolve);
    const h=harness({transport:request=>new Promise<Response>((_resolve,reject)=>{started();request.signal.addEventListener('abort',()=>reject(new Error('Publication suspended')),{once:true});})});
    await h.seed();const attempt=h.bridge.tick();await sent;
    h.engine.setOutputsBlocked(true);h.bridge.suspend();await attempt;
    expect(h.storage.repository.getPublicationState(h.scope).ackSeq).toBe(0);
    expect(await h.bridge.tick()).toBe('idle');expect(h.requests).toHaveLength(1);
  });
  it('uses the already persisted outbox and shows pending until real handler ACK',async()=>{
    const h=harness(),state=await h.seed(),before=h.storage.repository.getPublicationState(h.scope);
    expect(state.published?.chapters).toHaveLength(1);expect(before.publishSeq).toBeGreaterThan(0);expect(before.ackSeq).toBe(0);expect(h.engine.statuses().cloud.state).toBe('delayed');
    h.bridge.onEffects('session',[{type:'publication',snapshot:state.published!,final:false,priority:false}],state);
    expect(h.storage.repository.getPublicationState(h.scope).publishSeq).toBe(before.publishSeq);
    await h.flush();const after=h.storage.repository.getPublicationState(h.scope);expect(after.ackSeq).toBe(after.publishSeq);expect(h.engine.statuses().cloud.state).toBe('ready');expect((await h.service.readSnapshot(h.scope.channelId)).chapters).toHaveLength(1);
  });
  it('renews every ten seconds without changing source asOf or duplicating heartbeat jobs',async()=>{
    const h=harness();await h.seed();await h.flush();const before=await h.service.readSnapshot(h.scope.channelId),sequence=h.storage.repository.getPublicationState(h.scope).publishSeq;
    h.setTime(94_999);expect(await h.bridge.tick()).toBe('idle');expect(h.storage.repository.getPublicationState(h.scope).publishSeq).toBe(sequence);
    h.setTime(95_000);expect(await h.bridge.tick()).toBe('acknowledged');const heartbeat=await h.requests.at(-1)!.json();expect(heartbeat.snapshots).toEqual([]);expect((await h.service.readSnapshot(h.scope.channelId)).asOf).toBe(before.asOf);
    expect(await h.bridge.tick()).toBe('idle');expect(h.storage.repository.getPublicationState(h.scope).publishSeq).toBe(sequence+1);
  });
  it('revalidates an expired persisted live lease on startup before showing ready',async()=>{
    const h=harness();await h.seed();await h.flush();h.setTime(200_000);h.restart();
    expect(h.engine.statuses().cloud.state).toBe('delayed');expect(h.storage.repository.getPublicationState(h.scope).publishSeq).toBeGreaterThan(h.storage.repository.getPublicationState(h.scope).ackSeq);
    await h.flush();expect(h.engine.statuses().cloud.state).toBe('ready');
  });
  it('retains frozen body across runtime restart and a lost cloud ACK',async()=>{
    let first=true;const h=harness({transport:async(request,handler)=>{const response=await handler(request);if(first){first=false;throw new Error('ACK lost');}return response;}});
    await h.seed();expect(await h.bridge.tick()).toBe('retry');expect(h.engine.statuses().cloud.state).toBe('error');const firstBody=await h.requests[0].text();h.restart();h.setTime(88_000);await h.flush();
    const matching=await Promise.all(h.requests.slice(1).map(r=>r.text()));expect(matching).toContain(firstBody);expect(h.engine.statuses().cloud.state).toBe('ready');
  });
  it('recovers an old frozen initial publication with a separate fresh heartbeat before reporting ready',async()=>{
    let offline=true;const h=harness({transport:async(request,handler)=>{if(offline)throw new Error('Offline before first publish');return handler(request);}});
    await h.seed();expect(await h.bridge.tick()).toBe('retry');const original=await h.requests[0].text();h.setTime(185_000);offline=false;
    expect(await h.bridge.tick()).toBe('acknowledged');expect(await h.requests[1].text()).toBe(original);expect(h.engine.statuses().cloud.state).toBe('delayed');
    await expect(h.service.readSnapshot(h.scope.channelId)).rejects.toMatchObject({code:'live_recap_unavailable'});
    expect(await h.bridge.tick()).toBe('acknowledged');expect((await h.requests[2].json()).snapshots).toEqual([]);expect(h.engine.statuses().cloud.state).toBe('ready');expect((await h.service.readSnapshot(h.scope.channelId)).chapters).toHaveLength(1);
  });
  it('does not accept an in-flight stale ACK after Forget and retracts its cloud body next',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let started!:()=>void;const sent=new Promise<void>(resolve=>started=resolve);let first=true;
    const h=harness({transport:async(request,handler)=>{if(first){first=false;started();await gate;}return handler(request);}});await h.seed();const attempt=h.bridge.tick();await sent;
    await h.engine.dispatch('session',{type:'privacy',target:{kind:'session',sessionId:'session'},reason:'Authored test Forget'});release();expect(await attempt).toBe('cancelled');expect(h.storage.repository.getPublicationState(h.scope).pendingPrivacy).toBe(true);
    await h.flush();expect(h.storage.repository.getPublicationState(h.scope).pendingPrivacy).toBe(false);await expect(h.service.readSnapshot(h.scope.channelId,'session')).rejects.toMatchObject({status:410});
    const stale=await h.handler(h.requests[0].clone());expect(stale.status).toBe(409);
  });
  it('sets final readiness only for acknowledged finalized snapshot and stops heartbeats afterward',async()=>{
    const h=harness();await h.seed();await h.flush();h.setTime(90_000);await h.engine.dispatch('session',{type:'closing',endedAt:h.clock.iso()});
    let finalized=await h.engine.dispatch('session',{type:'tail.drained'});
    if(finalized.pendingGeneration){const ticket=finalized.pendingGeneration.ticket;finalized=await h.engine.dispatch('session',{type:'generation.result',ticket,patch:{sessionId:'session',baseRevision:ticket.baseEntityRevision,action:'hold',title:null,claims:[],relations:[],currentAttemptId:null,language:'en',missingContext:[]},safety:{moderation:'allowed',pii:'allowed',checkedAt:h.clock.iso(),reason:null}});}
    expect(finalized.session.status).toBe('finalized');expect(finalized.session.finalSnapshotAckAt).toBeNull();
    await h.flush();expect(h.engine.state('session').session.finalSnapshotAckAt).not.toBeNull();expect((await h.service.readSnapshot(h.scope.channelId,'session')).session.status).toBe('finalized');
    const count=h.requests.length;h.setTime(300_000);expect(await h.bridge.tick()).toBe('idle');expect(h.requests).toHaveLength(count);expect((await h.service.readSnapshot(h.scope.channelId,'session')).session.status).toBe('finalized');
  });
  it('replaces an expired failed heartbeat with a new empty-body lease update, without resequencing its old body',async()=>{
    let offline=false;const h=harness({transport:async(request,handler)=>{if(offline)throw new Error('Network offline');return handler(request);}});await h.seed();await h.flush();
    offline=true;h.setTime(95_000);expect(await h.bridge.tick()).toBe('retry');const oldSequence=h.storage.repository.getPublicationState(h.scope).publishSeq;
    h.setTime(130_000);offline=false;expect(await h.bridge.tick()).toBe('cancelled');expect(await h.bridge.tick()).toBe('acknowledged');expect(h.storage.repository.getPublicationState(h.scope).publishSeq).toBe(oldSequence+1);
    const newest=await h.requests.at(-1)!.json();expect(newest.snapshots).toEqual([]);expect(newest.publishSeq).toBe(oldSequence+1);expect(h.engine.statuses().cloud.state).toBe('ready');
  });
  it('does not dispatch unconfigured or replay publication jobs',async()=>{
    const missing=harness({configured:false});await missing.seed();expect(await missing.bridge.tick()).toBe('idle');expect(missing.engine.statuses().cloud.state).toBe('unconfigured');expect(missing.transport).not.toHaveBeenCalled();
    const replay=harness({runId:'replay-fixture'});await replay.seed();expect(await replay.bridge.tick()).toBe('idle');expect(replay.transport).not.toHaveBeenCalled();expect(replay.engine.statuses().cloud.message).toContain('Replay stays local');
  });
});
