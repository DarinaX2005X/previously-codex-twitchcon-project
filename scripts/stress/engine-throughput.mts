import {mkdtempSync,rmSync,statSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir,cpus,totalmem} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import type {EventEnvelope} from '../../src/shared/contracts/index.js';
const batchSize=Number(process.argv[3]??1);if(!Number.isInteger(batchSize)||batchSize<1||batchSize>20)throw Error('Batch size must be 1..20.');
const dir=mkdtempSync(join(tmpdir(),'previously-engine-stress-')),path=join(dir,'state.sqlite'),scope={channelId:'stress',runId:'live'},start=Date.parse('2026-11-02T00:00:00Z');
let at=start;const clock={now:()=>at,iso:()=>new Date(at).toISOString()};
const store=createStorage({path,now:clock.now}),updates=new RevisionStream();
const engine=new StoryEngine({scope,channel:{id:'stress',login:'synthetic',displayName:'Synthetic'},storage:store,clock,updates,safety:new SafetyService({classify:async()=>({decision:'review',spans:[]})},{moderate:async()=> 'unavailable'}),story:{propose:async()=>{throw Error('No providers in synthetic throughput');}}});
store.repository.updateSettings(scope,0,{listeningPaused:false});store.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});
const samples:unknown[]=[],callTimes:number[]=[],wall=performance.now();let previous=wall,previousCount=0,nextSample=250;
try{
  for(let i=0;i<1000;i+=batchSize){
    const batch:EventEnvelope[]=[];
    for(let j=i;j<Math.min(i+batchSize,1000);j++){at=start+j*50;batch.push({...scope,schemaVersion:1,eventId:`chat-${j}`,externalId:`chat-${j}`,origin:'twitch',kind:'channel.chat.message',occurredAt:clock.iso(),receivedAt:clock.iso(),sessionId:'session',sessionOffsetMs:j*50,payload:{chatter_user_id:'same-actor',message_id:`message-${j}`,message:{text:j%17===0?'!previously':'Synthetic ordinary chat'},quotesReady:true}});}
    const callStart=performance.now();if(batchSize===1)await engine.ingest(batch[0]!);else await engine.ingestBatch(batch);callTimes.push(performance.now()-callStart);
    const processed=i+batch.length;
    if(processed>=nextSample||processed===1000){globalThis.gc?.();const now=performance.now(),memory=process.memoryUsage();const sample={processed,elapsedSeconds:(now-wall)/1000,segmentSeconds:(now-previous)/1000,segmentEventsPerSecond:(processed-previousCount)*1000/(now-previous),heapUsed:memory.heapUsed,rss:memory.rss,diskBytes:[path,`${path}-wal`,`${path}-shm`].reduce((sum,p)=>sum+(existsSync(p)?statSync(p).size:0),0),retainedSources:engine.state('session').sources.length};samples.push(sample);console.log(JSON.stringify(sample));previous=now;previousCount=processed;nextSample+=250;}
  }
  const sorted=callTimes.toSorted((a,b)=>a-b);const result={scope:batchSize===1?'Actual sequential StoryEngine.ingest + normalizer + SQLite transition/checkpoint/hydration; synthetic pending-safety chat, no provider/OBS/network. Throughput is measured service capacity, not real-time burst delivery.':'Actual StoryEngine.ingestBatch of already queued synthetic pending-safety chat, preserving per-event durable receipts and atomic batch commit. No providers/OBS/network, intentional batch-fill wait or real-time socket arrival; processing duration excludes time waiting in an intake queue.',batchSize,dispatchCalls:callTimes.length,callMilliseconds:{mean:callTimes.reduce((a,b)=>a+b,0)/callTimes.length,p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:Math.max(...callTimes)},hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemory:totalmem(),node:process.version},samples};
  mkdirSync('docs/testing/reliability',{recursive:true});writeFileSync(process.argv[2]??'docs/testing/reliability/engine-throughput.json',JSON.stringify(result,null,2)+'\n');
}finally{updates.close();store.close();if(!resolve(dir).startsWith(resolve(tmpdir())+sep))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}

