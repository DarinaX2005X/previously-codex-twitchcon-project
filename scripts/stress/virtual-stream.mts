/** Synthetic virtual time: reducer + durable ingress, deliberately not an OBS/live provider run. */
import {mkdtempSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir, cpus, totalmem, platform, release} from 'node:os';
import {join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createStorage} from '../../src/server/storage/index.js';
import {createDomainState, reduceDomain, buildEvidencePacket, evidencePacketBytes, type DomainEvent} from '../../src/core/index.js';
import {defaultSettings, type Source, type Safety, type StoryPatch} from '../../src/shared/contracts/index.js';

const durable=process.argv[4]!=='core',baselineRate=Number(process.argv[5]??20);
if(!Number.isInteger(baselineRate)||baselineRate<1||baselineRate>20)throw Error('Rate must be 1..20.');
const seconds=Number(process.argv[2]??28800),output=resolve(process.argv[3]??'docs/testing/reliability/virtual-stream.json');
if(!Number.isInteger(seconds)||seconds<1||seconds>28800)throw Error('Duration must be 1..28800 virtual seconds.');
const dir=mkdtempSync(join(tmpdir(),'previously-stress-')),path=join(dir,'stress.sqlite');
const epoch=Date.parse('2026-11-02T00:00:00Z'),scope={channelId:'stress-channel',runId:'stress'},sessionId='stress-session';
let at=0,count=0,commands=0,deletes=0,maxPacket=0,maxSources=0,maxWindows=0,maxActors=0,maxPhrases=0,maxCandidates=0,maxPending=0,providerFails=0;
const clock={now:()=>epoch+at,iso:()=>new Date(epoch+at).toISOString()};
const store=createStorage({path,now:clock.now});store.repository.ensureChannel(scope,'synthetic');store.repository.createSession(scope,{id:sessionId,startedAt:new Date(epoch).toISOString()});
let state=createDomainState({channel:{id:scope.channelId,login:'synthetic',displayName:'Synthetic stress'},session:store.repository.getSession(scope,sessionId),settings:{...defaultSettings,listeningPaused:false}});
const safe:Safety={moderation:'allowed',pii:'allowed',checkedAt:clock.iso(),reason:null};
const samples:unknown[]=[],wall=performance.now();
function send(event:DomainEvent){const result=reduceDomain(state,event,clock);state=result.state;maxSources=Math.max(maxSources,state.sources.length);maxWindows=Math.max(maxWindows,state.windows.length);maxActors=Math.max(maxActors,Object.keys(state.openWindow?.actors??{}).length);maxPhrases=Math.max(maxPhrases,state.phrases.length);maxCandidates=Math.max(maxCandidates,state.candidates.length);maxPending=Math.max(maxPending,Number(!!state.pendingGeneration));return result;}
function source(id:string,text:string,kind:Source['kind']='chat',actor='solo-spammer'):Source{return {...scope,sessionId,id,revision:1,kind,startMs:at,endMs:at,actorId:kind==='chat'?actor:null,languageCodes:['en'],timePrecision:'event',text,status:'active',externalMessageId:id,moderation:kind==='chat'?'pending':'allowed'};}
function persist(value:Source){if(!durable)return;store.repository.ingest({...scope,schemaVersion:1,eventId:`event:${value.id}`,externalId:value.id,origin:'replay',kind:'synthetic',occurredAt:clock.iso(),receivedAt:clock.iso(),sessionId,sessionOffsetMs:at,payload:null},{sources:[value]});}
function disk(){return [path,`${path}-wal`,`${path}-shm`].reduce((sum,file)=>sum+(existsSync(file)?statSync(file).size:0),0);}
function sample(second:number){globalThis.gc?.();const memory=process.memoryUsage();const entry={virtualSecond:second,processedMessages:count,elapsedSeconds:(performance.now()-wall)/1000,heapUsed:memory.heapUsed,rss:memory.rss,diskBytes:disk(),nodes:Object.keys(state.nodes).length,tombstones:state.tombstones.length,chapters:state.chapters.length,packetBytes:evidencePacketBytes(buildEvidencePacket(state))};samples.push(entry);console.log(JSON.stringify(entry));}
try{
  for(let second=0;second<seconds;second++){
    const sparse=second%3600>=3540,burst=second>=7200&&second<7260,rate=sparse?0:burst?200:baselineRate;
    for(let i=0;i<rate;i++){
      at=second*1000+Math.floor(i*1000/rate);const id=`msg-${String(count++).padStart(8,'0')}`,command=count%17===0;if(command)commands++;
      const value=source(id,command?'!previously':burst?'clip it':'clip it lol');
      persist(value);send({type:'source',source:value,signals:{clipIt:true,laughter:true},phrase:command?undefined:'same phrase'});
    }
    at=second*1000+999;
    if(second%300===0){
      const value=source(`speech-${second}`,`The next task is checking stage ${Math.floor(second/300)}.`,'speech');persist(value);send({type:'source',source:value});
      send({type:'metadata',title:`Synthetic stage ${Math.floor(second/300)}`,category:'Development',atMs:at,safety:safe});
    }
    // Slow provider accepts nothing for five minutes each hour; retry is represented by the actual reducer backoff.
    if(state.pendingGeneration&&at-state.pendingGeneration.requestedAtMs>=((second%3600<300)?60000:1000)){
      const request=state.pendingGeneration;maxPacket=Math.max(maxPacket,evidencePacketBytes(request.packet));
      if(second%3600<300){send({type:'generation.failed',jobId:request.ticket.jobId,reason:'synthetic_slow_provider'});providerFails++;}
      else {const src=request.packet.sources.find(s=>s.kind==='speech');if(src){const patch:StoryPatch={sessionId,baseRevision:request.ticket.baseEntityRevision,action:'update',title:'Synthetic development progress',claims:[{id:'progress',text:src.text!,role:'state',support:[{id:src.id,revision:src.revision}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};send({type:'generation.result',ticket:request.ticket,patch,safety:safe,grounding:{acceptedClaimIds:['progress'],acceptedRelationKeys:[]}});}else{send({type:'generation.failed',jobId:request.ticket.jobId,reason:'no_speech'});providerFails++;}}
    }
    if(second>0&&second%600===0){const target={kind:'message' as const,sessionId,externalMessageId:`msg-${String(Math.max(0,count-10)).padStart(8,'0')}`};send({type:'privacy',target});if(durable)store.repository.invalidate(scope,target,{idempotencyKey:`delete-${second}`,reason:'synthetic'});deletes++;}
    if(second%10===0)send({type:'tick'});
    if(second%1800===0)sample(second);
  }
  sample(seconds);
  let cursor:{startMs:number;id:string}|undefined,pages=0,rows=0;const paginationStart=performance.now();
  for(;;){const page=store.repository.listSources(scope,sessionId,{limit:500,cursor});rows+=page.length;pages++;if(page.length<500)break;const last=page.at(-1)!;cursor={startMs:last.startMs,id:last.id};}
  const result={scope:durable?'Synthetic reducer plus SQLite raw ingress; not StoryEngine throughput, actual capture, providers, cloud or a wall-clock eight-hour run.':'Synthetic pure reducer, no durable message writes; not StoryEngine throughput, actual capture, providers, cloud or a wall-clock eight-hour run.',durationSeconds:seconds,baselineRate,burstRate:200,burstSeconds:60,hardware:{platform:platform(),release:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemory:totalmem(),node:process.version},elapsedSeconds:(performance.now()-wall)/1000,messages:count,commands,deletes,providerFails,limits:{maxSources,maxWindows,maxActors,maxPhrases,maxCandidates,maxPending,maxPacket},singleActorFalseMoments:state.moments.length,pagination:{rows,pages,milliseconds:performance.now()-paginationStart,firstSourceRetained:store.repository.getSource(scope,'msg-00000000')!==null},samples};
  mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({done:true,output,elapsedSeconds:result.elapsedSeconds}));
}finally{store.close();const resolved=resolve(dir);if(!resolved.startsWith(resolve(tmpdir())+'\\')&&!resolved.startsWith(resolve(tmpdir())+'/'))throw Error('Unsafe cleanup');rmSync(resolved,{recursive:true,force:true});}


