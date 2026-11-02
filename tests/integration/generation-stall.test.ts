import {afterEach,describe,it,expect} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {BoundedScheduler} from '../../src/server/runtime/scheduler.js';
import type {Source} from '../../src/shared/contracts/index.js';

// AUTHORED DEVELOPMENT FIXTURE. The story provider never answers; only the pending ticket's lifecycle is under test.
const start=Date.parse('2026-11-02T00:00:00Z');
const resources:{close():void}[]=[];
afterEach(()=>{for(const resource of resources.splice(0).reverse())resource.close();});
function harness(propose:(signal:AbortSignal)=>Promise<never>=async()=>{throw new Error('provider down');}){
  let at=10_000;
  const clock={now:()=>start+at,iso:()=>new Date(start+at).toISOString()},scope={channelId:'channel',runId:'live'};
  const storage=createStorage({path:':memory:',now:clock.now});resources.push(storage);
  const safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=>'allowed'},clock.now);
  const engine=new StoryEngine({scope,channel:{id:'channel',login:'fixture',displayName:'Authored fixture'},storage,clock,updates:new RevisionStream(),safety,story:{propose:async(_packet,_ticket,signal)=>propose(signal!)}});
  storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});storage.repository.updateSettings(scope,0,{listeningPaused:false});
  const source=(id:string,ms:number):Source=>({...scope,id,sessionId:'session',revision:1,kind:'speech',startMs:ms-1000,endMs:ms,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:`Spoken context ${id}`,status:'active',externalMessageId:null,moderation:'allowed'});
  return {scope,storage,engine,source,advance(ms:number){at+=ms;},get at(){return at;}};
}

describe('pending story generation',()=>{
  it('releases the ticket when the job ends at its early output fence, so new speech starts a new story',async()=>{
    const h=harness();await h.engine.dispatch('session',{type:'source',source:h.source('a',9000)});
    const first=h.engine.state('session').pendingGeneration!.ticket.jobId;
    const job=h.storage.repository.claimJob(h.scope,{kinds:['story'],leaseMs:30_000})!;
    h.engine.setOutputsBlocked(true);
    const result=await h.engine.executeStory(job,new AbortController().signal);h.storage.repository.finishJob(h.scope,job.id,job.leaseToken,result.state);
    h.engine.setOutputsBlocked(false);
    for(let i=0;i<3;i++){h.advance(60_000);await h.engine.dispatch('session',{type:'source',source:h.source(`n${i}`,h.at-1000)});await h.engine.tick();}
    const pending=h.engine.state('session').pendingGeneration;
    expect(pending?.ticket.jobId).toBeDefined();expect(pending!.ticket.jobId).not.toBe(first);
    expect(h.storage.repository.pendingJobCount(h.scope,'session',['story'])).toBe(1);
  });
  it('recovers a ticket whose job a graceful shutdown left in an unknown outcome',async()=>{
    let started!:()=>void;const calling=new Promise<void>(resolve=>started=resolve);
    const h=harness(signal=>new Promise<never>((_resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
    await h.engine.dispatch('session',{type:'source',source:h.source('a',9000)});
    const first=h.engine.state('session').pendingGeneration!.ticket.jobId;
    const scheduler=new BoundedScheduler(h.storage.repository,[{scope:h.scope,kinds:['story'],concurrency:1,execute:(job,signal)=>h.engine.executeStory(job,signal)}]);
    scheduler.tick();await calling;await scheduler.stop(0);
    expect(h.storage.repository.pendingJobCount(h.scope,'session',['story'])).toBe(0);
    expect(h.engine.state('session').pendingGeneration?.ticket.jobId).toBe(first);
    // After the restart, the next ticks release the ended ticket and the 45 s backoff starts a new generation.
    await h.engine.tick();expect(h.engine.state('session').pendingGeneration).toBeNull();
    h.advance(60_000);await h.engine.dispatch('session',{type:'source',source:h.source('b',h.at-1000)});await h.engine.tick();
    expect(h.engine.state('session').pendingGeneration?.ticket.jobId).not.toBe(first);
    expect(h.storage.repository.pendingJobCount(h.scope,'session',['story'])).toBe(1);
  });
});
