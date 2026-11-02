import {afterEach,describe,it,expect} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {createCloudRuntime,type CloudRuntime} from '../../src/server/runtime/cloud-runtime.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {createCloudHandler} from '../../src/cloud/http.js';
import {createPublicationService} from '../../src/cloud/service.js';
import {MemoryBlobStore} from '../publication/helpers.js';
import type {Safety,Source} from '../../src/shared/contracts/index.js';

// AUTHORED DEVELOPMENT FIXTURE. A real cloud handler on an in-memory Blob store; one retract POST fails transiently.
const START=Date.parse('2026-11-02T12:00:00.000Z'),secret='fixture-secret-'.repeat(5);
const resources:{close():void}[]=[];
afterEach(()=>{for(const resource of resources.splice(0).reverse())resource.close();});
function harness(){
  let now=START+10_000,bridge:CloudRuntime|undefined,failNext:((body:{operation:string;snapshots?:unknown[]})=>boolean)|null=null;
  const clock={now:()=>now,iso:()=>new Date(now).toISOString()},scope={channelId:'fixture_channel',runId:'live'},channel={id:scope.channelId,login:'authored_fixture',displayName:'Authored fixture'};
  const storage=createStorage({path:':memory:',now:clock.now});resources.push(storage);
  const safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=>'allowed'},clock.now);
  const engine=new StoryEngine({scope,channel,storage,clock,updates:new RevisionStream(),safety,story:{propose:async()=>{throw new Error('No provider calls in this fixture');}},onEffects:(...args)=>bridge?.onEffects(...args)});
  storage.repository.updateSettings(scope,0,{listeningPaused:false});
  const service=createPublicationService({store:new MemoryBlobStore(),channelLogin:channel.login,now:clock.now}),handler=createCloudHandler({service,secret,channelLogin:channel.login,now:clock.now});
  const log:string[]=[];
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init),body=JSON.parse(await request.clone().text()) as {operation:string;publishSeq:number;snapshots?:unknown[]};
    if(failNext?.(body)){failNext=null;log.push(`${body.publishSeq} ${body.operation} 503`);return new Response('{}',{status:503});}
    const response=await handler(request),code=response.ok?'':(await response.clone().json() as {error:{code:string}}).error.code;
    log.push(`${body.publishSeq} ${body.operation} ${response.status}${code?` ${code}`:''}`);return response;
  };
  bridge=createCloudRuntime({scope,channel,engine,storage,clock,publicOrigin:'https://fixture-cloud.test',sharedSecret:secret,fetch:fetcher as typeof fetch});resources.push(bridge);
  const allowed:Safety={moderation:'allowed',pii:'allowed',checkedAt:clock.iso(),reason:null};
  const flush=async()=>{for(let i=0;i<20;i++)if(await bridge!.tick()==='idle')return;};
  return {scope,storage,engine,service,log,allowed,bridge:()=>bridge!,flush,failNextRetract(){failNext=body=>body.operation==='retract';},failNextHeartbeat(){failNext=body=>body.operation==='snapshot'&&!body.snapshots?.length;},set now(value:number){now=value;},get now(){return now;},
    async seed(session:string,startMs:number,text:string){
      storage.repository.createSession(scope,{id:session,startedAt:new Date(startMs).toISOString()});now=startMs+10_000;
      const source:Source={...scope,id:`speech-${session}`,sessionId:session,revision:1,kind:'speech',startMs:9000,endMs:10000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text,status:'active',externalMessageId:null,moderation:'allowed'};
      const state=await engine.dispatch(session,{type:'source',source}),ticket=state.pendingGeneration!.ticket;
      await engine.dispatch(session,{type:'generation.result',ticket,patch:{sessionId:session,baseRevision:0,action:'new_chapter',title:`Title ${session}`,claims:[{id:'goal',text,role:'goal',support:[{id:source.id,revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]},safety:allowed,grounding:{acceptedClaimIds:['goal'],acceptedRelationKeys:[]}});
      now=startMs+85_000;await engine.dispatch(session,{type:'tick'});
    }};
}

describe('owed privacy retractions',()=>{
  it('keeps a failed cross-session retract owed after a newer owner edit and withdraws the forgotten text',async()=>{
    const h=harness(),secret='I will tell you my home address later.';
    await h.seed('X',START,secret);await h.flush();
    h.now=START+100_000;await h.engine.dispatch('X',{type:'closing',endedAt:new Date(START+95_000).toISOString()});
    h.now=START+340_000;await h.engine.dispatch('X',{type:'tail.drained'});await h.engine.dispatch('X',{type:'tick'});await h.flush();
    expect((await h.service.readSnapshot(h.scope.channelId,'X')).chapters.map(c=>c.summary)).toEqual([secret]);
    await h.seed('Y',START+86_400_000,'Building the parser today.');await h.flush();
    // Forget in yesterday's stream; its first retract POST fails transiently.
    h.failNextRetract();await h.engine.dispatch('X',{type:'privacy',target:{kind:'source',sessionId:'X',id:'speech-X'}});await h.bridge().tick();
    expect(h.log.at(-1)).toMatch(/retract 503$/);
    // Before the retry, an owner edit in today's stream bumps the privacy revision with a retract scoped to Y only.
    const chapter=h.engine.state('Y').chapters[0]!;
    await h.engine.dispatch('Y',{type:'owner.edit',entityId:chapter.id,baseRevision:chapter.revision,source:{...h.scope,id:'owner:1',sessionId:'Y',revision:1,kind:'owner_statement',startMs:90000,endMs:90000,actorId:'owner',languageCodes:['en'],timePrecision:'event',text:'Parser work',status:'active',externalMessageId:null,moderation:'allowed'},title:'Parser',summary:'Parser work',safety:h.allowed});
    expect(h.storage.repository.getPublicationState(h.scope).pendingPrivacy).toBe(true);
    for(let i=0;i<12;i++){h.now+=10_000;await h.flush();}
    expect((await h.service.readSnapshot(h.scope.channelId,'X')).chapters.map(c=>c.summary)).not.toContain(secret);
    expect(h.storage.repository.listOwedRetractions(h.scope)).toEqual([]);
    const sync=h.storage.repository.getPublicationState(h.scope);expect(sync.pendingPrivacy).toBe(false);expect(sync.ackSeq).toBe(sync.publishSeq);
  });
  it('sends the owed retraction before newer snapshots, so a same-session publication never loops on retraction_required',async()=>{
    const h=harness();await h.seed('session',START,'I am testing note persistence.');await h.flush();
    h.failNextRetract();await h.engine.dispatch('session',{type:'privacy',target:{kind:'message',sessionId:'session',externalMessageId:'unrelated'}});await h.bridge().tick();
    const chapter=h.engine.state('session').chapters[0]!;
    await h.engine.dispatch('session',{type:'owner.pin',entityId:chapter.id,baseRevision:chapter.revision,pinned:true});
    for(let i=0;i<12;i++){h.now+=10_000;await h.flush();}
    expect(h.log.filter(line=>line.includes('retraction_required'))).toEqual([]);
    expect(h.log.some(line=>/retract 200$/.test(line))).toBe(true);
    const sync=h.storage.repository.getPublicationState(h.scope);expect(sync.pendingPrivacy).toBe(false);expect(sync.ackSeq).toBe(sync.publishSeq);
    const visible=await h.service.readSnapshot(h.scope.channelId);expect(visible.chapters).toHaveLength(1);expect(visible.chapters[0]!.pinned).toBe(true);
  });
  it('clears pending privacy only when the retract that covers the obligation is acknowledged',async()=>{
    const h=harness();await h.seed('session',START,'I am testing note persistence.');await h.flush();
    h.failNextRetract();await h.engine.dispatch('session',{type:'privacy',target:{kind:'message',sessionId:'session',externalMessageId:'unrelated'}});await h.bridge().tick();
    // The latest sequence is acknowledged, but it is not the retraction: the obligation stays pending.
    const chapter=h.engine.state('session').chapters[0]!;
    await h.engine.dispatch('session',{type:'owner.pin',entityId:chapter.id,baseRevision:chapter.revision,pinned:true});
    const latest=h.storage.repository.getPublicationState(h.scope).publishSeq;
    expect(h.storage.repository.acknowledgePublication(h.scope,latest,'0'.repeat(64))).toBe(true);
    expect(h.storage.repository.getPublicationState(h.scope)).toMatchObject({ackSeq:latest,pendingPrivacy:true});
  });
});

describe('publication lease lifecycle',()=>{
  it('finishes a heartbeat whose stream is no longer the live one instead of retrying it forever',async()=>{
    const h=harness();await h.seed('A',START,'I am testing note persistence.');await h.flush();
    // A heartbeat left queued by a previous process, never built before a newer stream became the live one.
    const left=h.storage.repository.preparePublication(h.scope,{sessionId:'A',kind:'publish',businessKey:'cloud-heartbeat:A:left',payload:{heartbeat:true},priority:-100});
    await h.seed('B',START+200_000,'A second stream starts.');
    for(let i=0;i<4;i++){h.now+=61_000;await h.flush();}
    expect(h.storage.repository.getPublicationWork(h.scope,left.id)?.state).toBe('failed');
    h.now+=61_000;expect(h.storage.repository.claimOutbox(h.scope,{kinds:['publish']})).toBeNull();
  });
  it('keeps a queued recording publication when an owner edit supersedes the session projection',async()=>{
    const h=harness();await h.seed('session',START,'I am testing note persistence.');await h.flush();
    const work=h.storage.repository.preparePublication(h.scope,{sessionId:'session',kind:'export_manifest',businessKey:'recording-publish:fixture:1',payload:{recordingExportId:'fixture'}});
    const chapter=h.engine.state('session').chapters[0]!;
    await h.engine.dispatch('session',{type:'owner.edit',entityId:chapter.id,baseRevision:chapter.revision,source:{...h.scope,id:'owner:1',sessionId:'session',revision:1,kind:'owner_statement',startMs:90000,endMs:90000,actorId:'owner',languageCodes:['en'],timePrecision:'event',text:'Note persistence work',status:'active',externalMessageId:null,moderation:'allowed'},title:'Persistence',summary:'Note persistence work',safety:h.allowed});
    expect(h.storage.repository.getPublicationWork(h.scope,work.id)?.state).toBe('queued');
  });
});
