import {mkdtempSync,rmSync,statSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir,cpus,totalmem} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
const dir=mkdtempSync(join(tmpdir(),'previously-engine-stress-')),path=join(dir,'state.sqlite'),scope={channelId:'stress',runId:'live'},start=Date.parse('2026-11-02T00:00:00Z');
let at=start;const clock={now:()=>at,iso:()=>new Date(at).toISOString()};
const store=createStorage({path,now:clock.now}),updates=new RevisionStream();
const engine=new StoryEngine({scope,channel:{id:'stress',login:'synthetic',displayName:'Synthetic'},storage:store,clock,updates,safety:new SafetyService({classify:async()=>({decision:'review',spans:[]})},{moderate:async()=> 'unavailable'}),story:{propose:async()=>{throw Error('No providers in synthetic throughput');}}});
store.repository.updateSettings(scope,0,{listeningPaused:false});store.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});
const samples:unknown[]=[],wall=performance.now();let previous=wall;
try{
  for(let i=0;i<1000;i++){
    at=start+i*50;
    await engine.ingest({...scope,schemaVersion:1,eventId:`chat-${i}`,externalId:`chat-${i}`,origin:'twitch',kind:'channel.chat.message',occurredAt:clock.iso(),receivedAt:clock.iso(),sessionId:'session',sessionOffsetMs:i*50,payload:{chatter_user_id:'same-actor',message_id:`message-${i}`,message:{text:i%17===0?'!previously':'Synthetic ordinary chat'},quotesReady:true}});
    if((i+1)%250===0){globalThis.gc?.();const now=performance.now(),memory=process.memoryUsage();const sample={processed:i+1,elapsedSeconds:(now-wall)/1000,segmentSeconds:(now-previous)/1000,segmentEventsPerSecond:250000/(now-previous),heapUsed:memory.heapUsed,rss:memory.rss,diskBytes:[path,`${path}-wal`,`${path}-shm`].reduce((sum,p)=>sum+(existsSync(p)?statSync(p).size:0),0),retainedSources:engine.state('session').sources.length};samples.push(sample);console.log(JSON.stringify(sample));previous=now;}
  }
  const result={scope:'Actual sequential StoryEngine.ingest + normalizer + SQLite transition/checkpoint/hydration; synthetic pending-safety chat, no provider/OBS/network. Throughput is measured service capacity, not real-time burst delivery.',hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemory:totalmem(),node:process.version},samples};
  mkdirSync('docs/testing/reliability',{recursive:true});writeFileSync(process.argv[2]??'docs/testing/reliability/engine-throughput.json',JSON.stringify(result,null,2)+'\n');
}finally{updates.close();store.close();if(!resolve(dir).startsWith(resolve(tmpdir())+sep))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}

