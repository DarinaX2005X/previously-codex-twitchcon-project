/** Authored, isolated browser fixture. No production authentication or live adapters are changed.
 * Prepare only: npx tsx scripts/verify/owner-browser-fixture.mts --prepare
 * Start explicitly: npx tsx scripts/verify/owner-browser-fixture.mts --serve
 * All writes remain under .data/browser-fixture. Each invocation gets a fresh authored database.
 */
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {Router} from 'express';
import {createApp} from '../../src/server/app.js';
import {loadConfig,type RuntimeConfig} from '../../src/server/runtime/config.js';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {createOwnerService} from '../../src/server/runtime/owner-service.js';
import {createOwnerRouter} from '../../src/server/runtime/owner-routes.js';
import {createPublicReadRouter} from '../../src/server/runtime/public-routes.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import type {Principal} from '../../src/server/runtime/security.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {RecordingController} from '../../src/server/replay/recording-controller.js';
import {RecordingExportRegistry} from '../../src/server/replay/recording-registry.js';
import {createRecordingRouter} from '../../src/server/replay/recording-router.js';
import {createLocalReplayHandler} from '../../src/server/replay/local.js';
import type {Source,Safety,StoryPatch} from '../../src/shared/contracts/index.js';
import type {DomainMedia} from '../../src/core/types.js';
import type {MediaRecord} from '../../src/server/media/cache.js';

const mode=process.argv[2]??'--prepare';
if(!['--prepare','--serve'].includes(mode)||process.argv.length>3)throw new Error('Use --prepare or --serve only.');
const root=resolve('.data/browser-fixture'),directory=join(root,randomUUID()),origin='http://127.0.0.1:4320';
if(!directory.startsWith(root+sep))throw new Error('Unexpected fixture directory');
mkdirSync(directory,{recursive:true});
// Deliberately does not read .env, provider credentials, live storage, or a production session.
globalThis.fetch=async()=>{throw new Error('Authored fixture: external requests are disabled');};
const config={...loadConfig({SESSION_SECRET:randomBytes(32).toString('hex'),DATA_DIR:directory,OPENAI_PAID_CALLS_ENABLED:'false'}),port:4320,host:'127.0.0.1',origin} as RuntimeConfig;
const start=Date.now()-2*60*60*1000;let now=start,wallStarted:number|null=null;
const clock={now:()=>now+(wallStarted===null?0:Date.now()-wallStarted),iso:()=>new Date(clock.now()).toISOString()},set=(offset:number)=>{now=start+offset;};
const scope={channelId:'authored-browser-fixture',runId:'live'},sessionId='authored-browser-session',channel={id:scope.channelId,login:'authored_browser_fixture',displayName:'Authored fixture — no live stream'};
const allowed:Safety={moderation:'allowed',pii:'allowed',checkedAt:new Date(start).toISOString(),reason:null};
const storage=createStorage({path:join(directory,'fixture.sqlite'),now:clock.now}),updates=new RevisionStream(1000,clock.now);
storage.budget.setPaidEnabled(false);
let recording:RecordingController;
const safety=new SafetyService({classify:async()=>{throw new Error('Authored fixture: no live safety checks');}},{moderate:async()=>{throw new Error('Authored fixture: no paid moderation');}},clock.now);
const engine=new StoryEngine({channel,scope,storage,clock,updates,safety,story:{propose:async()=>{throw new Error('Authored fixture: no live provider');}},onCommittedTransition:value=>recording?.onCommittedTransition(value)});
storage.repository.updateSettings(scope,0,{listeningPaused:false});
storage.repository.createSession(scope,{id:sessionId,startedAt:new Date(start).toISOString(),twitchStreamId:null});
const mediaFiles=new Map<string,{record:MediaRecord;path:string}>();
const registry=new RecordingExportRegistry({repository:storage.repository,scope,dataDir:directory,channelLogin:channel.login,outputsBlocked:()=>engine.outputsBlocked()});
recording=new RecordingController({scope,dataDir:directory,clock,state:id=>engine.state(id),source:id=>storage.repository.getSource(scope,id),providerModel:'authored-browser-no-model',registerExport:registry.register,resolveMedia:async id=>{const item=mediaFiles.get(id);if(!item)throw new Error('Authored media unavailable');return item;},outputsBlocked:()=>engine.outputsBlocked()});
const principal:Principal={...scope,role:'owner',actorId:'authored-fixture-owner',sessionId:'authored-fixture-browser',expiresAtMs:Date.now()+8*60*60*1000};
const owner=createOwnerService(engine);
const source=(text:string):Source=>({...scope,id:'fixture-speech-1',sessionId,revision:1,kind:'speech',startMs:0,endMs:1000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text,status:'active',externalMessageId:null,moderation:'allowed'});

async function seedRecording(){
  const draft=recording.start(principal,{sessionId});
  set(1000);const first=await engine.dispatch(sessionId,{type:'source',source:source('Authored example: the note is saved, but its preview is missing.')}),ticket=first.pendingGeneration!.ticket;
  const patch:StoryPatch={sessionId,baseRevision:ticket.baseEntityRevision,action:'new_chapter',title:'A saved note with an empty preview',claims:[{id:'state',text:'The note is saved, but its preview is missing.',role:'state',support:[{id:'fixture-speech-1',revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
  set(1600);await engine.dispatch(sessionId,{type:'generation.result',ticket,patch,safety:allowed,grounding:{acceptedClaimIds:['state'],acceptedRelationKeys:[]}});
  set(76000);await engine.dispatch(sessionId,{type:'tick'});
  let chapter=engine.state(sessionId).chapters[0]!;
  const correction:Source={...source('Authored correction: the saved note is intact. Only its preview is missing.'),id:'fixture-owner-correction',kind:'owner_statement',actorId:principal.actorId,startMs:76001,endMs:76001,moderation:'pending'};
  set(76001);await engine.dispatch(sessionId,{type:'owner.edit',entityId:chapter.id,baseRevision:chapter.revision,source:correction,title:'Only the preview is missing',summary:correction.text!,safety:{moderation:'pending',pii:'pending',checkedAt:null,reason:null}});
  chapter=engine.state(sessionId).chapters[0]!;set(76100);await engine.dispatch(sessionId,{type:'owner.review',entityId:chapter.id,ownerRevision:chapter.ownerEditRevision,sourceId:correction.id,sourceRevision:1,privacyEpoch:0,title:chapter.title,summary:chapter.summary,safety:allowed});
  chapter=engine.state(sessionId).chapters[0]!;
  for(const language of ['en','ru'] as const){set(language==='en'?76200:76300);await engine.dispatch(sessionId,{type:'presentation',entityId:chapter.id,baseRevision:chapter.revision,ownerRevision:chapter.ownerEditRevision,language,title:language==='en'?chapter.title:'Пропало только превью',summary:language==='en'?chapter.summary:'Учебный пример: заметка сохранена. Пропало только превью.',safety:allowed,inputRefs:chapter.dependencyRefs});}
  const wav=Buffer.alloc(16044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
  const path=join(directory,'authored-one-second-silence.wav');writeFileSync(path,wav);
  const media:DomainMedia={id:'authored-one-second-silence',revision:1,momentId:null,refs:[{id:'fixture-speech-1',revision:1}],captureStartMs:0,captureEndMs:1000,durationMs:1000,state:'ready',kind:'audio',previousSession:false,ownerApproved:true};
  mediaFiles.set(media.id,{path,record:{id:media.id,kind:'audio',sessionId,privacyEpoch:0,dependencyRefs:media.refs,captureStartMs:0,captureEndMs:1000,file:'authored-one-second-silence.wav',size:wav.length,durationMs:1000,mimeType:'audio/wav',lastUsedAt:start,state:'ready'}});
  set(80000);await engine.dispatch(sessionId,{type:'media',media,privacyEpoch:0});
  set(82000);await engine.dispatch(sessionId,{type:'recap.trigger',trigger:{id:'authored-raid-event',sessionId,reason:'raid',occurredAt:clock.iso(),fromLogin:'authored_arrival',viewers:2}});
  const playback=engine.state(sessionId).playbacks[0]!;set(82100);await engine.dispatch(sessionId,{type:'playback',id:playback.id,action:'prepared'});set(82400);await engine.dispatch(sessionId,{type:'playback',id:playback.id,action:'start'});
  set(100000);await engine.dispatch(sessionId,{type:'tick'});recording.stop(principal,draft.id);await recording.attachMedia(principal,draft.id,media.id);
  const review=recording.review(principal,draft.id);if(review.blockedReasons.length)throw new Error('Authored recording is not reviewable: '+review.blockedReasons.join('; '));
  return draft.id;
}

const historyTitles=['Opening the test note','Reproducing the empty preview','Checking stored text','Reading the preview renderer','Comparing the two views','Inspecting the saved value','Following the render call','Checking a blank heading','Trying a short paragraph','Reviewing the parser output','Comparing line breaks','Checking an empty document','Following the update event','Confirming the stored revision','Trying an ordinary heading','Checking a second paragraph','Comparing two saved notes','Reviewing the active selection','Testing a clean reload','Keeping the saved text visible','Checking the render boundary','Reading the latest update','Looking at an older note','Trying a longer document','Reviewing the final paragraph','Checking the corrected preview','Comparing before and after','Saving the example notes','Reviewing the authored session'];
async function seedHistory(){
  for(const [i,title]of historyTitles.entries()){
    const atMs=180000*(i+1);set(atMs);
    const state=await engine.dispatch(sessionId,{type:'metadata',title:`Authored fixture: ${title}`,category:'Authored software example',atMs,safety:allowed});
    const request=state.pendingGeneration,metadata=state.sources.findLast(s=>s.kind==='channel_metadata');if(!request||!metadata)throw new Error('Authored history generation was not scheduled');
    const patch:StoryPatch={sessionId,baseRevision:request.ticket.baseEntityRevision,action:'new_chapter',title,claims:[{id:'state',text:`Authored fixture: ${title.toLowerCase()}.`,role:'state',support:[{id:metadata.id,revision:metadata.revision}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
    set(atMs+100);await engine.dispatch(sessionId,{type:'generation.result',ticket:request.ticket,patch,safety:allowed,grounding:{acceptedClaimIds:['state'],acceptedRelationKeys:[]}});
    set(atMs+76000);await engine.dispatch(sessionId,{type:'tick'});
  }
}

try{
  const recordingId=await seedRecording();await seedHistory();
  const settings=storage.repository.getSettings(scope);await owner.setSettings({principal,idempotencyKey:'fixture-pause-listening',baseRevision:settings.revision},{listeningPaused:true});
  engine.setStatus('mic',{state:'paused',lastObservedAt:clock.iso(),message:'Authored fixture. Microphone capture is disabled.',action:null});
  engine.setStatus('story',{state:'ready',lastObservedAt:clock.iso(),message:'Authored fixture. No model or live stream was used.',action:null});
  const first=await owner.listHistory(principal,{sessionId,kind:'chapter',filter:'published',limit:20});
  const second=first.nextCursor?await owner.listHistory(principal,{sessionId,kind:'chapter',filter:'published',limit:20,cursor:first.nextCursor}):null;
  if(first.items.length!==20||second?.items.length!==10)throw new Error(`Expected two pages of 20 + 10 chapters, got ${first.items.length} + ${second?.items.length??0}`);
  const authored=await createLocalReplayHandler(directory),router=Router();router.use(createRecordingRouter(recording,registry));router.use(createOwnerRouter(owner));
  const app=createApp({config,status:{phase:'ready',storage:'ready',mode:'local'},staticDirectory:resolve('dist'),updates,now:clock.now,
    auth:{authenticate:(request,role)=>role==='owner'&&['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress??'')?principal:null},
    authorizeStream:value=>value.sessionId===principal.sessionId&&value.channelId===scope.channelId,
    setupStatus:()=>({auth:{available:false,authenticated:true},fixture:'Authored fixture: no live stream, provider calls, microphone capture, or external publication.'}),
    routers:{owner:router,public:createPublicReadRouter({authored})}});
  const result={identity:'Authored fixture — no live stream',directory,url:origin+'/dock',recordingId,chapters:30,historyPages:[first.items.length,second.items.length],media:'One second of authored silence',paidCalls:false,externalRequests:false,mode};
  writeFileSync(join(directory,'fixture.json'),JSON.stringify(result,null,2));writeFileSync(join(root,'latest.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  if(mode==='--prepare'){updates.close();storage.close();console.log('Prepared and verified only. No server was started.');}
  else{
    if(!existsSync(resolve('dist/index.html')))throw new Error('Build the local client before serving the fixture.');
    wallStarted=Date.now();const server=createServer(app);
    const close=()=>{updates.close();server.close(()=>{storage.close();process.exit(0);});};process.once('SIGINT',close);process.once('SIGTERM',close);
    await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(4320,'127.0.0.1',done);});console.log(`Authored fixture listening only at ${origin}/dock`);
  }
}catch(error){updates.close();storage.close();throw error;}
