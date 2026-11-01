import {afterEach,describe,it,expect,vi} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {OpenAIStoryProvider,ProviderTransport,SafetyService} from '../../src/server/providers/index.js';
import type {Source,StoryPatch} from '../../src/shared/contracts/index.js';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function run(mode:'outage'|'ordinary'|'unknown'|'known'){
  const start=Date.parse('2026-11-02T00:00:00Z');let now=start+1000;
  const clock={now:()=>now,iso:()=>new Date(now).toISOString()},scope={channelId:'channel',runId:'live'},channel={id:'channel',login:'authored',displayName:'Authored'};
  const storage=createStorage({path:':memory:',now:clock.now});cleanup.push(()=>storage.close());const updates=new RevisionStream();cleanup.push(()=>updates.close());
  const safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'},clock.now);
  let phraseId='';const evidenceRefs=[{id:'speech',revision:1}];
  const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
    if(mode==='outage')throw new Error('Authored unavailable');
    const request=JSON.parse(init!.body as string),data=JSON.parse(request.input[1].content);let value:unknown;
    if(request.text.format.name==='lore_proposals'){
      phraseId=data.phrases[0].id;
      value=mode==='known'?{candidates:[{id:phraseId,term:'moon toast',explanation:'The streamer says the name came from a crater-shaped toast burn.',originRefs:evidenceRefs}],heldIds:[]}:{candidates:[],heldIds:[phraseId]};
    }else if(request.text.format.name==='lore_observation_review')value={channelSpecific:mode==='unknown',unambiguous:true,notInstructions:true,evidenceRefs:mode==='unknown'?evidenceRefs:[],issues:[]};
    else if(request.text.format.name==='lore_origin_review')value={channelSpecific:true,explicitOrigin:true,unambiguous:true,notInstructions:true,faithful:true,issues:[]};
    else throw new Error('Unexpected authored provider request');
    return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]}));
  });
  const provider=new OpenAIStoryProvider(new ProviderTransport({apiKey:'authored',runId:'live',externalCallsEnabled:true,budget:{status:()=>({enabled:true}),reserve:()=>true,settle:()=>{}},fetch:fetcher}));
  const engine=new StoryEngine({scope,channel,storage,clock,updates,safety,story:{
    propose:async(_packet,ticket)=>({value:{sessionId:'session',baseRevision:ticket.baseEntityRevision,action:'hold',title:null,claims:[],relations:[],currentAttemptId:null,language:'en',missingContext:[]} satisfies StoryPatch,model:'authored',requestId:'hold',usage:{chargedMicroUsd:0}}),
    proposeLore:provider.proposeLore.bind(provider),
  }});
  storage.repository.updateSettings(scope,0,{listeningPaused:false});storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});
  const term=mode==='ordinary'?'dough':'moon toast';
  const source=(id:string,kind:Source['kind'],text:string,actorId:string|null):Source=>({...scope,id,kind,text,actorId,sessionId:'session',revision:1,startMs:0,endMs:1000,languageCodes:['en'],timePrecision:kind==='chat'?'event':'chunk',status:'active',externalMessageId:null,moderation:'allowed'});
  await engine.dispatch('session',{type:'source',source:source('chat-a','chat',term,'a'),phrase:term});
  await engine.dispatch('session',{type:'source',source:source('chat-b','chat',term,'b'),phrase:term});
  const speech=mode==='ordinary'?'The dough is resting.':mode==='known'?'We call it moon toast because the burn looked like a crater.':'Here moon toast means our heavily toasted breakfast. I do not know who coined that name.';
  await engine.dispatch('session',{type:'source',source:source('speech','speech',speech,null)});
  const first=storage.repository.claimJob(scope,{kinds:['story']})!;expect(first).not.toBeNull();await engine.dispatch('session',{type:'generation.failed',jobId:engine.state('session').pendingGeneration!.ticket.jobId,reason:'Authored packet assembly'});storage.repository.finishJob(scope,first.id,first.leaseToken,'failed');
  now+=45000;await engine.tick();const job=storage.repository.claimJob(scope,{kinds:['story']})!;expect(job).not.toBeNull();
  expect(await engine.executeStory(job,new AbortController().signal)).toEqual({state:'done'});storage.repository.finishJob(scope,job.id,job.leaseToken,'done');
  return {state:engine.state('session'),fetcher,phraseId};
}
describe('authored live lore path preserves absence and uncertain origin honestly',()=>{
  it.each(['outage','ordinary'] as const)('creates no placeholder lore for %s',async mode=>{const {state,fetcher}=await run(mode);expect(fetcher).toHaveBeenCalled();expect(state.phrases).toHaveLength(1);expect(state.lore).toEqual([]);expect(state.published?.lore??[]).toEqual([]);});
  it('keeps verified local meaning with unknown origin held and explanation empty',async()=>{const {state,phraseId}=await run('unknown');expect(state.lore).toHaveLength(1);expect(state.lore[0]).toMatchObject({id:phraseId,term:'moon toast',status:'held',originKind:'unknown',originMs:null,explanation:'',safety:{reason:'origin_needs_confirmation'}});expect(state.lore[0].dependencyRefs).toContainEqual({id:'speech',revision:1});expect(state.published?.lore??[]).toEqual([]);});
  it('preserves the independently verified known-origin candidate path',async()=>{const {state}=await run('known');expect(state.lore).toHaveLength(1);expect(state.lore[0]).toMatchObject({term:'moon toast',originKind:'spoken',status:'confirmed',explanation:'The streamer says the name came from a crater-shaped toast burn.'});});
});
