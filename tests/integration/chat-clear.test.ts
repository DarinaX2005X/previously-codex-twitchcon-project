import {afterEach,describe,expect,it,vi} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {createDomainState,reduceDomain,buildEvidencePacket,type DomainEvent,type DomainState} from '../../src/core/index.js';
import {defaultSettings,type Clock,type Safety,type Source} from '../../src/shared/contracts/index.js';

// AUTHORED DEVELOPMENT FIXTURE. Twitch "clear chat" during a stream; no real chat or model call.
// A smaller raw source window keeps the pruning fixture fast; every bound is read from the same constant.
vi.mock('../../src/core/types.js',async original=>{const actual=await original<typeof import('../../src/core/types.js')>();return {...actual,DOMAIN_LIMITS:{...actual.DOMAIN_LIMITS,sources:40}};});
const start=Date.parse('2026-11-02T00:00:00Z'),scope={channelId:'channel',runId:'live'};
const allowed:Safety={moderation:'allowed',pii:'allowed',checkedAt:new Date(start).toISOString(),reason:null};
const resources:{close():void}[]=[];
afterEach(()=>{for(const resource of resources.splice(0).reverse())resource.close();});
const chat=(id:string,text:string,ms:number,extra:Partial<Source>={}):Source=>({...scope,id,sessionId:'session',revision:1,kind:'chat',startMs:ms,endMs:ms,actorId:`viewer-${id}`,languageCodes:[],timePrecision:'event',text,status:'active',externalMessageId:id,moderation:'allowed',...extra});
const speech=(id:string,text:string,ms:number):Source=>({...scope,id,sessionId:'session',revision:1,kind:'speech',startMs:ms-1000,endMs:ms,actorId:null,languageCodes:['en'],timePrecision:'chunk',text,status:'active',externalMessageId:null,moderation:'allowed'});
function reducer(){
  let at=0,state:DomainState=createDomainState({channel:{id:'channel',login:'fixture',displayName:'Authored fixture'},session:{...scope,id:'session',twitchStreamId:null,title:'',category:'',startedAt:new Date(start).toISOString(),endedAt:null,status:'live',privacyEpoch:0,publicationRevision:0,metadataMaxDependencyEndMs:0,finalizedAt:null,finalSnapshotAckAt:null},settings:{...defaultSettings,listeningPaused:false}});
  const clock:Clock={now:()=>start+at,iso:()=>new Date(start+at).toISOString()};
  return {get state(){return state;},set(ms:number){at=ms;},send(event:DomainEvent){state=reduceDomain(state,event,clock).state;return state;}};
}
function engineHarness(sent:string[]=[]){
  let at=10_000;const clock={now:()=>start+at,iso:()=>new Date(start+at).toISOString()};
  const storage=createStorage({path:':memory:',now:clock.now});resources.push(storage);
  const classifier={classify:async()=>({decision:'allow' as const,spans:[]}),classifyMany:async(texts:string[])=>{sent.push(...texts);return texts.map(()=>({decision:'allow' as const,spans:[]}));}};
  const moderation={moderate:async()=>'allowed' as const,moderateMany:async(texts:string[])=>texts.map(()=>'allowed' as const)};
  const engine=new StoryEngine({scope,channel:{id:'channel',login:'fixture',displayName:'Authored fixture'},storage,clock,updates:new RevisionStream(),safety:new SafetyService(classifier,moderation,clock.now),story:{propose:async()=>{throw new Error('No provider calls');}}});
  storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});storage.repository.updateSettings(scope,0,{listeningPaused:false});
  return {storage,engine,sent,set(ms:number){at=ms;},get at(){return at;}};
}
/** A published chapter that depends on one chat line, which later lines push out of the raw source window. */
async function prunedChatChapter(h:ReturnType<typeof engineHarness>){
  h.set(2000);let state=await h.engine.dispatch('session',{type:'source',source:speech('sp1','I am fighting the boss now.',2000)});
  await h.engine.dispatch('session',{type:'generation.failed',jobId:state.pendingGeneration!.ticket.jobId,reason:'fixture'});
  h.set(3000);await h.engine.dispatch('session',{type:'source',source:chat('chat-old','The boss is at 10 percent health',3000)});
  h.set(50_000);state=await h.engine.dispatch('session',{type:'tick'});
  const ticket=state.pendingGeneration!.ticket;expect(ticket.inputRefs.map(ref=>ref.id)).toContain('chat-old');
  await h.engine.dispatch('session',{type:'generation.result',ticket,patch:{sessionId:'session',baseRevision:0,action:'new_chapter',title:'Boss fight',claims:[{id:'c',text:'I am fighting the boss now.',role:'state',support:[{id:'sp1',revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]},safety:allowed,grounding:{acceptedClaimIds:['c'],acceptedRelationKeys:[]}});
  h.set(130_000);state=await h.engine.dispatch('session',{type:'tick'});expect(state.published?.chapters).toHaveLength(1);
  for(let i=0;i<60;i++){h.set(130_000+i*100);await h.engine.dispatch('session',{type:'source',source:chat(`n${i}`,`gg ${i}`,130_000+i*100)});}
  state=h.engine.state('session');expect(state.sources.some(source=>source.id==='chat-old')).toBe(false);expect(state.nodes['chat-old']?.active).toBe(true);
  return state.published!.chapters[0]!.id;
}

describe('Twitch clear chat',()=>{
  it('keeps cleared, not yet moderated chat out of evidence when a late safety result arrives',()=>{
    const h=reducer();h.set(5000);
    h.send({type:'source',source:chat('m1','my secret address is 12 Elm',5000,{moderation:'pending'})});
    h.set(6000);h.send({type:'chat.clear',throughMs:6000});
    const cleared=h.state.sources.find(source=>source.id==='m1')!;
    h.send({type:'source.safety',id:'m1',baseRevision:cleared.revision,text:cleared.text,safety:allowed});
    expect(h.state.sources.find(source=>source.id==='m1')).toMatchObject({status:'quarantined'});
    // A late message from before the cutoff stays quarantined as well.
    h.send({type:'source',source:chat('m2','late private chat',5500,{moderation:'pending'})});
    h.send({type:'source.safety',id:'m2',baseRevision:1,text:'late private chat',safety:allowed});
    expect(h.state.sources.find(source=>source.id==='m2')).toMatchObject({status:'quarantined'});
    h.set(60_000);h.send({type:'source',source:speech('sp','Talking about the game',60_000)});
    expect(buildEvidencePacket(h.state).sources.map(source=>source.id)).toEqual(['sp']);
  });
  it('does not send cleared chat to the safety provider again',async()=>{
    const h=engineHarness();
    await h.engine.dispatch('session',{type:'source',source:chat('m1','my address is 12 Elm',5000,{moderation:'pending'})});
    await h.engine.dispatch('session',{type:'chat.clear',throughMs:6000});
    for(let i=0;i<3;i++){h.set(h.at+31_000);await h.engine.checkPendingSources();}
    expect(h.sent).toEqual([]);
    expect(h.storage.repository.getSource(scope,'m1')).toMatchObject({status:'quarantined'});
  });
  it('withdraws a published chapter that depends on chat older than the source window',async()=>{
    const h=engineHarness(),chapterId=await prunedChatChapter(h);
    h.set(191_000);const state=await h.engine.dispatch('session',{type:'chat.clear',throughMs:191_000});
    expect(state.published?.chapters.map(chapter=>chapter.id)).not.toContain(chapterId);
    expect(h.engine.state('session').nodes['chat-old']?.active).not.toBe(true);
    expect(h.storage.repository.getEntity(scope,chapterId)?.status).toBe('hidden');
    expect(h.storage.repository.getSource(scope,'chat-old')?.status).toBe('quarantined');
  });
  it('forgets a source that only survives as leaf metadata',async()=>{
    const h=engineHarness(),chapterId=await prunedChatChapter(h);
    h.set(191_000);const state=await h.engine.dispatch('session',{type:'privacy',target:{kind:'source',sessionId:'session',id:'chat-old'}});
    expect(state.published?.chapters.map(chapter=>chapter.id)).not.toContain(chapterId);
    expect(h.storage.repository.getSource(scope,'chat-old')).toMatchObject({status:'deleted',text:null});
  });
});
