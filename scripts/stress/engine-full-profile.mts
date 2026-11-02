import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {cpus,totalmem,tmpdir,platform,release,setPriority,constants} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {createStorage,type WorkLease} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {evidencePacketBytes,DOMAIN_LIMITS,type DomainState,type GenerationRequest} from '../../src/core/index.js';
import type {EventEnvelope,Source,StoryPatch,PublicSnapshot} from '../../src/shared/contracts/index.js';

// Virtual arrival timestamps are accelerated; this does not model a socket queue or an eight-hour wall-clock soak.
const durationSeconds=Number(process.argv[2]??28800),output=resolve(process.argv[3]??'docs/testing/reliability/engine-full-profile.json');
if(!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>28800)throw Error('Duration must be 1..28800 virtual seconds.');
if(existsSync(output)||existsSync(output+'.progress.jsonl'))throw Error('Choose a new output path; existing evidence is never overwritten.');
setPriority(0,constants.priority.PRIORITY_BELOW_NORMAL);
const dir=mkdtempSync(join(tmpdir(),'previously-engine-full-')),path=join(dir,'state.sqlite');
const scope={channelId:'stress',runId:'live'},sessionId='session',start=Date.parse('2026-11-02T00:00:00Z');
let at=start,second=0,messages=0,commands=0,speeches=0,metadata=0,deletes=0,duplicates=0,providerCalls=0,providerFailures=0,providerDone=0,staleLeases=0,sinkConsumed=0,dispatchCalls=0;
const clock={now:()=>at,iso:()=>new Date(at).toISOString()},wall=performance.now();
const store=createStorage({path,now:clock.now}),updates=new RevisionStream();
let current!:DomainState;let active:{job:WorkLease;due:number;fail:boolean}|null=null,failProvider=false;
const maxima={sources:0,windows:0,actors:0,phrases:0,chapters:0,pendingCandidatesPerEntity:0,packetBytes:0,pendingStoryJobs:0,moments:0};
const samples:unknown[]=[],violations=new Set<string>(),callBuckets=new Uint32Array(1001);
let callTotalMs=0,maxCallMs=0,lastSampleWall=wall,lastSampleMessages=0;
const freshnessBoundSeconds=240;
type SpeechProgress={id:string;text:string;sourceEndMs:number;suppliedAtMs:number;deadlineAtMs:number;eligible:boolean;providerReturnedAtMs:number|null;publishedAtMs:number|null;sinkObservedAtMs:number|null;chapterId:string|null;sinkSnapshotRevision:number|null;chapterSourceEndMs:number|null;currentSourceTimeMs:number|null};
const speechProgress:SpeechProgress[]=[];
let lastProviderSpeechId:string|null=null,lastProviderSpeechEndMs:number|null=null,providerNoSpeechFailures=0;
let lastSinkPublication:{revision:number;publishedAt:string;chapterSourceEndMs:number;currentSourceTimeMs:number|null}|null=null;
// This is a deterministic harness recovery bound, not a product live-latency SLO.
// 60s cadence allowance + 10s job + 75s publication hold + 20s service rounding
// leaves 75s for a previously held/outage job and privacy retry. At 300s speech
// spacing, each deadline precedes the next speech; 600s deletions target chat.
const freshnessContract={boundSeconds:freshnessBoundSeconds,eligible:'Supplied speech outside the first 300 seconds of each virtual hour.',success:'One snapshot contains the supplied speech verbatim in a grounded chapter summary and current.now, with the speech source label and sufficiently recent dependency/source times; that snapshot is consumed by the local sink by the deadline.',scope:'Deterministic harness recovery bound, not product live latency; near-end obligations without a reached deadline remain pending.'};
const sourceFiles=['src/server/runtime/engine.ts','src/server/runtime/input.ts','src/server/runtime/history.ts','src/server/storage/repository.ts','src/server/storage/domain.ts','src/server/storage/database.ts','src/server/storage/migrations.ts','src/server/storage/history.ts','src/server/providers/safety.ts','src/core/reducer.ts','src/core/source-retention.ts','src/core/recovery.ts','src/core/evidence.ts','src/core/types.ts','src/core/privacy.ts','src/core/epoch.ts','src/core/recap.ts','src/shared/contracts/index.ts','scripts/stress/engine-full-profile.mts'];
const hashes=Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const description='Actual StoryEngine.ingestBatch/ingest/executeStory with file-backed SQLite durable receipts, transitions and checkpoints. Accelerated virtual timestamps at 20 chat/s baseline, 200/s for virtual seconds 7200..7259, final 60 seconds of every hour quiet. Already-queued batches of up to 20; no socket arrival, queue latency, real capture, paid provider, OBS or cloud measurement. Chat remains pending safety; supplied speech is synthetic pre-reviewed text. Deterministic local metadata-safety/story stubs; delayed job execution and failures use virtual time. Publication outbox is consumed by a bounded local sink without external publication.';
function assert(condition:unknown,name:string){if(!condition){violations.add(name);throw Error(name);}}
function observePublished(snapshot:PublicSnapshot|null,delivered=false){
  if(!snapshot)return;
  if(delivered)lastSinkPublication={revision:snapshot.revision,publishedAt:snapshot.publishedAt,chapterSourceEndMs:Math.max(0,...snapshot.chapters.map(chapter=>chapter.maxDependencyEndMs)),currentSourceTimeMs:snapshot.current?.sourceTimeMs??null};
  for(const speech of speechProgress){
    if(speech.sinkObservedAtMs!==null)continue;
    const chapter=snapshot.chapters.find(value=>value.summary.includes(speech.text)&&value.maxDependencyEndMs>=speech.sourceEndMs&&value.sourceLabels.some(label=>label.id===speech.id&&label.type==='speech'));
    const currentState=snapshot.current,publishedAtMs=Date.parse(snapshot.publishedAt);
    if(!chapter || !currentState?.now?.includes(speech.text) || currentState.sourceTimeMs<speech.sourceEndMs || currentState.maxDependencyEndMs<speech.sourceEndMs || publishedAtMs<speech.suppliedAtMs)continue;
    speech.publishedAtMs??=publishedAtMs;speech.chapterId=chapter.id;
    if(delivered){speech.sinkObservedAtMs=at;speech.sinkSnapshotRevision=snapshot.revision;speech.chapterSourceEndMs=chapter.maxDependencyEndMs;speech.currentSourceTimeMs=currentState.sourceTimeMs;}
  }
}
function freshnessSummary(){
  const eligible=speechProgress.filter(speech=>speech.eligible),fulfilled=eligible.filter(speech=>speech.sinkObservedAtMs!==null&&speech.sinkObservedAtMs<=speech.deadlineAtMs),pending=eligible.filter(speech=>speech.sinkObservedAtMs===null);
  const published=eligible.filter(speech=>speech.publishedAtMs!==null),snapshot=current?.published;
  return {boundSeconds:freshnessBoundSeconds,supplied:speechProgress.length,eligible:eligible.length,fulfilled:fulfilled.length,pending:pending.length,due:eligible.filter(speech=>speech.deadlineAtMs<=at).length,overdueIds:eligible.filter(speech=>speech.deadlineAtMs<=at&&(speech.sinkObservedAtMs===null||speech.sinkObservedAtMs>speech.deadlineAtMs)).map(speech=>speech.id),nextDeadlineVirtualSecond:pending.length?(Math.min(...pending.map(speech=>speech.deadlineAtMs))-start)/1000:null,maxObservedSourceToPublishedSeconds:published.length?Math.max(...published.map(speech=>(speech.publishedAtMs!-start-speech.sourceEndMs)/1000)):null,maxObservedSupplyToSinkSeconds:fulfilled.length?Math.max(...fulfilled.map(speech=>(speech.sinkObservedAtMs!-speech.suppliedAtMs)/1000)):null,lastProviderSpeechId,lastProviderSpeechEndMs,providerNoSpeechFailures,lastPublishedAt:snapshot?.publishedAt??null,lastPublishedChapterSourceEndMs:Math.max(0,...snapshot?.chapters.map(chapter=>chapter.maxDependencyEndMs)??[]),lastPublishedCurrentSourceTimeMs:snapshot?.current?.sourceTimeMs??null,lastDomainCurrentSourceTimeMs:current?.current?.sourceTimeMs??null,lastSinkPublication};
}
function checkFreshness(){
  observePublished(current.published);
  for(const speech of speechProgress)if(speech.eligible&&speech.deadlineAtMs<=at)assert(speech.providerReturnedAtMs!==null&&speech.sinkObservedAtMs!==null&&speech.sinkObservedAtMs<=speech.deadlineAtMs,`story_freshness_deadline:${speech.id}`);
}
function observe(state:DomainState){
  current=state;
  maxima.sources=Math.max(maxima.sources,state.sources.length);maxima.windows=Math.max(maxima.windows,state.windows.length);
  maxima.actors=Math.max(maxima.actors,Object.keys(state.openWindow?.actors??{}).length);maxima.phrases=Math.max(maxima.phrases,state.phrases.length);maxima.chapters=Math.max(maxima.chapters,state.chapters.length);maxima.moments=Math.max(maxima.moments,state.moments.length);
  assert(state.sources.length<=DOMAIN_LIMITS.sources,'source_cap');assert(state.windows.length<=DOMAIN_LIMITS.windows,'window_cap');assert(maxima.actors<=DOMAIN_LIMITS.actorsPerWindow,'actor_cap');assert(state.phrases.length<=DOMAIN_LIMITS.phraseCandidates,'phrase_cap');assert(state.chapters.length<=DOMAIN_LIMITS.chapters,'chapter_cap');assert(state.moments.length===0,'single_actor_false_moment');
}
const safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'},clock.now);
const engine=new StoryEngine({scope,channel:{id:scope.channelId,login:'synthetic',displayName:'Synthetic'},storage:store,clock,updates,safety,
  onCommittedTransition:transition=>observe(transition.state),
  story:{propose:async(packet,ticket)=>{
    providerCalls++;maxima.packetBytes=Math.max(maxima.packetBytes,evidencePacketBytes(packet));assert(maxima.packetBytes<=DOMAIN_LIMITS.packetBytes,'packet_cap');
    if(failProvider){providerFailures++;throw Error('deterministic_provider_outage');}
    const source=packet.sources.find(value=>value.kind==='speech'&&value.text);if(!source){providerFailures++;providerNoSpeechFailures++;throw Error('synthetic_no_speech');}
    lastProviderSpeechId=source.id;lastProviderSpeechEndMs=source.endMs;
    const supplied=speechProgress.find(speech=>speech.id===source.id);if(supplied)supplied.providerReturnedAtMs??=at;
    const patch:StoryPatch={sessionId,baseRevision:ticket.baseEntityRevision,action:'update',title:'Synthetic progress',claims:[{id:'progress',text:source.text!,role:'state',support:[{id:source.id,revision:source.revision}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
    return {value:patch,usage:{chargedMicroUsd:0},requestId:'synthetic',model:'deterministic-local'};
  }}
});
store.repository.updateSettings(scope,0,{listeningPaused:false});store.repository.createSession(scope,{id:sessionId,startedAt:new Date(start).toISOString()});observe(engine.state(sessionId));
mkdirSync(dirname(output),{recursive:true});
const header={scope:description,startedAt:new Date().toISOString(),pid:process.pid,databasePath:path,durationSeconds,baselineRate:20,burstRate:200,burstSeconds:60,batchSize:20,priority:'BelowNormal',freshnessContract,hardware:{platform:platform(),release:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemory:totalmem(),node:process.version},sourceHashes:hashes};
writeFileSync(output+'.progress.jsonl',JSON.stringify(header)+'\n');console.log(JSON.stringify(header));
function envelope(id:string,kind:string,payload:unknown):EventEnvelope{return {...scope,schemaVersion:1,eventId:`event:${id}`,externalId:id,origin:'twitch',kind,occurredAt:clock.iso(),receivedAt:clock.iso(),sessionId,sessionOffsetMs:at-start,payload};}
function disk(){return [path,`${path}-wal`,`${path}-shm`,`${path}-journal`].reduce((sum,file)=>sum+(existsSync(file)?statSync(file).size:0),0);}
function sample(virtualSecond:number){
  globalThis.gc?.();const now=performance.now(),memory=process.memoryUsage();
  const entry={virtualSecond,messages,elapsedSeconds:(now-wall)/1000,segmentEventsPerSecond:(messages-lastSampleMessages)*1000/(now-lastSampleWall),heapUsed:memory.heapUsed,rss:memory.rss,diskBytes:disk(),retainedSources:current.sources.length,chapters:current.chapters.length,nodes:Object.keys(current.nodes).length,providerCalls,providerFailures,providerDone,staleLeases,sinkConsumed,duplicates,deletes,freshness:freshnessSummary()};
  samples.push(entry);appendFileSync(output+'.progress.jsonl',JSON.stringify(entry)+'\n');console.log(JSON.stringify(entry));lastSampleWall=now;lastSampleMessages=messages;
}
async function serviceJobs(){
  if(active&&second>=active.due){
    const selected=active;active=null;failProvider=selected.fail;
    const result=await engine.executeStory(selected.job,new AbortController().signal);
    if(!store.repository.finishJob(scope,selected.job.id,selected.job.leaseToken,result.state))staleLeases++;
    if(result.state==='done')providerDone++;
  }
  if(!active){const job=store.repository.claimJob(scope,{kinds:['story'],leaseMs:120000,sessionId});if(job){const fail=second%3600<300;active={job,due:second+(fail?60:10),fail};const request=(job.payload as {request:GenerationRequest}).request;maxima.packetBytes=Math.max(maxima.packetBytes,evidencePacketBytes(request.packet));}}
  // Consume at most 32 outputs per service tick; no external services or credentials are touched.
  for(let i=0;i<32;i++){const work=store.repository.claimOutbox(scope,{kinds:['publish','retract'],sessionId});if(!work)break;assert(store.repository.finishOutbox(scope,work.id,work.leaseToken,'done'),'sink_lease');sinkConsumed++;observePublished((work.payload as {snapshot:PublicSnapshot}).snapshot,true);}
  maxima.pendingStoryJobs=Math.max(maxima.pendingStoryJobs,store.repository.pendingJobCount(scope,sessionId,['story']));
  const counts=new Map<string,number>();for(const candidate of current.candidates)if(candidate.status==='pending')counts.set(candidate.entityId,(counts.get(candidate.entityId)??0)+1);
  maxima.pendingCandidatesPerEntity=Math.max(maxima.pendingCandidatesPerEntity,0,...counts.values());assert(maxima.pendingCandidatesPerEntity<=DOMAIN_LIMITS.candidates,'candidate_cap');assert(maxima.pendingStoryJobs<=1,'story_job_cap');
}
let succeeded=false;
try{
  for(second=0;second<durationSeconds;second++){
    const rate=second%3600>=3540?0:second>=7200&&second<7260?200:20;
    for(let offset=0;offset<rate;offset+=20){
      const batch:EventEnvelope[]=[];
      for(let i=offset;i<Math.min(rate,offset+20);i++){
        at=start+second*1000+Math.floor(i*1000/rate);const id=`message-${String(messages++).padStart(8,'0')}`,command=messages%17===0;if(command)commands++;
        batch.push(envelope(`chat:${id}`,'channel.chat.message',{chatter_user_id:'single-spammer',message_id:id,message:{text:command?'!previously':'clip it lol'},quotesReady:true}));
      }
      const before=performance.now();await engine.ingestBatch(batch);const ms=performance.now()-before;dispatchCalls++;callTotalMs+=ms;maxCallMs=Math.max(maxCallMs,ms);callBuckets[Math.min(1000,Math.floor(ms))]++;
      if(offset===0&&second%300===0){const revision=current.revision;await engine.ingest(batch[0]!);duplicates++;assert(engine.state(sessionId).revision===revision,'duplicate_changed_revision');}
    }
    at=start+second*1000+999;
    if(second%300===0){
      const id=`speech-${second}`,source:Source={...scope,sessionId,id,revision:1,kind:'speech',startMs:second*1000,endMs:second*1000+900,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:`The next task is checking stage ${Math.floor(second/300)}.`,status:'active',externalMessageId:null,moderation:'allowed'};
      speechProgress.push({id,text:source.text!,sourceEndMs:source.endMs,suppliedAtMs:at,deadlineAtMs:at+freshnessBoundSeconds*1000,eligible:second%3600>=300,providerReturnedAtMs:null,publishedAtMs:null,sinkObservedAtMs:null,chapterId:null,sinkSnapshotRevision:null,chapterSourceEndMs:null,currentSourceTimeMs:null});
      await engine.ingest(envelope(id,'speech.transcribed',{source}));speeches++;
      await engine.ingest(envelope(`metadata-${second}`,'channel.update',{title:`Synthetic stage ${Math.floor(second/300)}`,category_name:'Development'}));metadata++;
    }
    if(second>0&&second%600===0){const id=`message-${String(messages-10).padStart(8,'0')}`;await engine.ingest(envelope(`delete-${second}`,'channel.chat.message_delete',{message_id:id}));deletes++;const source=store.repository.getSource(scope,`chat:${id}`);assert(source?.status==='deleted'&&source.text===null,'delete_not_scrubbed');}
    if(second%10===0){await engine.tick();await serviceJobs();checkFreshness();}
    if(second%300===0||performance.now()-lastSampleWall>=30000)sample(second);
  }
  checkFreshness();sample(durationSeconds);
  const check=new DatabaseSync(path,{readOnly:true});
  const receiptCount=Number(check.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='channel.chat.message'").get()!.n);
  const sourceCount=Number(check.prepare("SELECT COUNT(*) AS n FROM sources WHERE kind='chat'").get()!.n);
  const integrity=check.prepare('PRAGMA quick_check').get();check.close();
  assert(receiptCount===messages,'chat_receipt_count');assert(sourceCount===messages,'chat_source_count');assert(Object.values(integrity??{})[0]==='ok','sqlite_integrity');if(durationSeconds===28800)assert(messages===577200,'full_profile_chat_count');
  let cursor:{startMs:number;id:string}|undefined,rows=0,pages=0;const paginationStart=performance.now();
  for(;;){const page=store.repository.listSources(scope,sessionId,{limit:500,cursor});rows+=page.length;pages++;if(page.length<500)break;const last=page.at(-1)!;cursor={startMs:last.startMs,id:last.id};}
  assert(rows===messages+speeches+metadata,'source_pagination_count');
  let p95=0,seen=0;for(;p95<callBuckets.length;p95++){seen+=callBuckets[p95]!;if(seen>=dispatchCalls*.95)break;}
  const result={...header,completedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-wall)/1000,messages,commands,speeches,metadata,deletes,duplicates,providerCalls,providerFailures,providerDone,staleLeases,sinkConsumed,dispatchCalls,batchCallMilliseconds:{mean:callTotalMs/dispatchCalls,p95BucketLowerBound:p95,max:maxCallMs},maxima,violations:[...violations],freshness:{...freshnessSummary(),speechProgress},durability:{receiptCount,sourceCount,integrity},pagination:{rows,pages,milliseconds:performance.now()-paginationStart,oldestSourceRetained:store.repository.getSource(scope,'chat:message-00000000')!==null},pendingAtEnd:{heldStory:!!active,storyJobs:store.repository.pendingJobCount(scope,sessionId,['story'])},samples};
  writeFileSync(output,JSON.stringify(result,null,2)+'\n');succeeded=true;console.log(JSON.stringify({done:true,output,elapsedSeconds:result.elapsedSeconds,databasePath:path}));
}catch(error){const failure={failedAt:new Date().toISOString(),virtualSecond:second,messages,elapsedSeconds:(performance.now()-wall)/1000,error:error instanceof Error?error.message:String(error),violations:[...violations],databasePath:path,sourceHashes:hashes,freshnessContract,freshness:{...freshnessSummary(),speechProgress}};writeFileSync(output+'.failure.json',JSON.stringify(failure,null,2)+'\n');throw error;}
finally{updates.close();store.close();console.log(JSON.stringify({closed:true,succeeded,databaseRetained:path}));}
