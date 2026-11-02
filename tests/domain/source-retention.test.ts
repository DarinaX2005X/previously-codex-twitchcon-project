import {describe,expect,it} from 'vitest';
import {createDomainState,reduceDomain,buildEvidencePacket,hydrateDomainState,recoverDomainState,evidencePacketBytes,DOMAIN_LIMITS} from '../../src/core/index.js';
import {defaultSettings,type Source,type Safety,type StoryPatch} from '../../src/shared/contracts/index.js';
import {NON_CHAT_SOURCE_RESERVE,retainRecentSources,compareSourceIds} from '../../src/core/source-retention.js';

const start=Date.parse('2026-11-02T00:00:00Z');
const clock={now:()=>start+330000,iso:()=>new Date(start+330000).toISOString()};
const safe:Safety={moderation:'allowed',pii:'allowed',checkedAt:clock.iso(),reason:null};
function fixture(){return createDomainState({channel:{id:'c',login:'fixture',displayName:'Fixture'},session:{channelId:'c',runId:'r',id:'s',twitchStreamId:null,title:'',category:'',startedAt:new Date(start).toISOString(),endedAt:null,status:'live',privacyEpoch:0,publicationRevision:0,metadataMaxDependencyEndMs:0,finalizedAt:null,finalSnapshotAckAt:null},settings:{...defaultSettings,listeningPaused:false}});}
function source(id:string,endMs:number,kind:Source['kind']='speech'):Source{return {channelId:'c',runId:'r',sessionId:'s',id,revision:1,kind,startMs:endMs,endMs,actorId:kind==='chat'?'viewer':null,languageCodes:['en'],timePrecision:'event',text:kind==='chat'?'Authored chat':`Authored speech ${id}`,status:'active',externalMessageId:null,moderation:kind==='chat'?'pending':'allowed'};}
const flood=()=>Array.from({length:600},(_,i)=>source(`chat-${i}`,300050+i*50,'chat'));

describe('traffic-independent bounded evidence',()=>{
  it('orders source IDs by UTF-8 binary values, including distinct accents and astral/BMP characters',()=>{
    expect(['speech-😀','speech-é','speech-\ue000','speech-a','speech-e\u0301','speech-A'].sort(compareSourceIds))
      .toEqual(['speech-A','speech-a','speech-e\u0301','speech-é','speech-\ue000','speech-😀']);
  });
  it('retains fresh speech through 20 chats/s beyond the old 25-second tail',()=>{
    let state=fixture();state.nextGenerationAfterMs=start+400000;
    for(const value of [source('fresh',300000),...flood()])state=reduceDomain(state,{type:'source',source:value},clock).state;
    expect(state.sources).toHaveLength(500);
    expect(buildEvidencePacket(state).sources.some(value=>value.id==='fresh')).toBe(true);
    expect(evidencePacketBytes(buildEvidencePacket(state))).toBeLessThanOrEqual(DOMAIN_LIMITS.packetBytes);
    state=reduceDomain(state,{type:'source',source:source('later-chat',390001,'chat')},{now:()=>start+390001,iso:()=>new Date(start+390001).toISOString()}).state;
    expect(buildEvidencePacket(state).sources.some(value=>value.id==='fresh')).toBe(false);
  });
  it('applies the same selection during checkpoint and full authoritative recovery',()=>{
    const state=fixture();state.sources=[source('fresh',300000),...flood()];
    const checkpoint=hydrateDomainState(state,{privacyEpoch:0});
    const recovered=recoverDomainState({channel:state.channel,session:state.session,settings:state.settings,revision:1,privacyEpoch:0,checkpoint:null,sources:state.sources,entities:[],candidates:[],published:null,tombstones:[],blockedTerms:[],bannedActors:[],captureEpoch:0,chatClearThroughMs:null});
    for(const value of [checkpoint,recovered]){expect(value.sources).toHaveLength(500);expect(value.sources.some(item=>item.id==='fresh')).toBe(true);}
  });
  it('reserves only 64 recent non-chat slots, including held evidence, inside the total cap',()=>{
    const nonChat=Array.from({length:80},(_,i)=>({...source(`speech-${i}`,300000+i),moderation:i%2?'unavailable' as const:'pending' as const,status:i%2?'quarantined' as const:'active' as const}));
    const retained=retainRecentSources([...nonChat,...flood()]);
    expect(retained).toHaveLength(500);expect(retained.filter(value=>value.kind!=='chat')).toHaveLength(NON_CHAT_SOURCE_RESERVE);
    expect(retained.filter(value=>value.kind==='chat')).toHaveLength(500-NON_CHAT_SOURCE_RESERVE);
    expect(retained.some(value=>value.id==='speech-0')).toBe(false);expect(retained.some(value=>value.id==='speech-79')).toBe(true);
    const state=fixture();state.sources=retained;expect(buildEvidencePacket(state).sources).toEqual([]);
  });
  it('does not reserve deleted, blocked or out-of-horizon non-chat text',()=>{
    const retained=retainRecentSources([{...source('deleted',300000),text:null,status:'deleted'}, {...source('blocked',300000),status:'blocked'},source('expired',239999),...flood()]);
    expect(retained).toHaveLength(500);expect(retained.every(value=>value.kind==='chat')).toBe(true);
  });
  it.each(['update','hold'] as const)('preserves metadata arriving after an older %s request',action=>{
    let state=reduceDomain(fixture(),{type:'source',source:source('old',300000)},clock).state;
    const request=state.pendingGeneration!;
    state=reduceDomain(state,{type:'metadata',title:'A later topic',category:'Authored',atMs:330000,safety:safe},clock).state;
    const patch:StoryPatch={sessionId:'s',baseRevision:0,action,title:'Old topic',claims:action==='hold'?[]:[{id:'claim',text:'Authored speech old',role:'state',support:[{id:'old',revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
    state=reduceDomain(state,{type:'generation.result',ticket:request.ticket,patch,safety:safe},clock).state;
    expect(state.pendingGeneration?.reason).toBe('metadata');
    expect(state.pendingGeneration?.entityId).not.toBe(request.entityId);
  });
  it('distinguishes repeated equal-timestamp metadata, survives checkpoint serialization and consumes only the matching boundary',()=>{
    let state=reduceDomain(fixture(),{type:'metadata',title:'First topic',category:'Authored',atMs:330000,safety:safe},clock).state;
    const request=state.pendingGeneration!;
    for(const title of ['Second topic','First topic'])state=reduceDomain(state,{type:'metadata',title,category:'Authored',atMs:330000,safety:safe},clock).state;
    state=hydrateDomainState(JSON.parse(JSON.stringify(state)),{privacyEpoch:0});
    expect(state.boundaryRevision).toBeGreaterThan(request.boundaryRevision!);
    const hold=(ticket:typeof request.ticket):StoryPatch=>({sessionId:'s',baseRevision:ticket.baseEntityRevision,action:'hold',title:null,claims:[],relations:[],currentAttemptId:null,language:'en',missingContext:[]});
    state=reduceDomain(state,{type:'generation.result',ticket:request.ticket,patch:hold(request.ticket),safety:safe},clock).state;
    const latest=state.pendingGeneration!;expect(latest.reason).toBe('metadata');expect(latest.boundaryRevision).toBe(state.boundaryRevision);
    state=reduceDomain(state,{type:'generation.result',ticket:latest.ticket,patch:hold(latest.ticket),safety:safe},clock).state;
    expect(state.boundary).toBeNull();expect(state.pendingGeneration).toBeNull();
  });
  it('preserves a new boundary after a legacy request, and rejects older metadata timestamps',()=>{
    let state=reduceDomain(fixture(),{type:'metadata',title:'First topic',category:'Authored',atMs:330000,safety:safe},clock).state;
    delete state.boundaryRevision;delete state.pendingGeneration!.boundaryRevision;
    state=hydrateDomainState(JSON.parse(JSON.stringify(state)),{privacyEpoch:0});const request=state.pendingGeneration!;
    state=reduceDomain(state,{type:'metadata',title:'Later topic',category:'Authored',atMs:330000,safety:safe},clock).state;
    const revision=state.boundaryRevision;
    state=reduceDomain(state,{type:'metadata',title:'Stale topic',category:'Authored',atMs:329999,safety:safe},clock).state;
    expect(state.boundaryRevision).toBe(revision);expect(state.session.title).toBe('Later topic');
    state=reduceDomain(state,{type:'generation.result',ticket:request.ticket,patch:{sessionId:'s',baseRevision:0,action:'hold',title:null,claims:[],relations:[],currentAttemptId:null,language:'en',missingContext:[]},safety:safe},clock).state;
    expect(state.pendingGeneration?.reason).toBe('metadata');expect(state.pendingGeneration?.boundaryRevision).toBe(revision);
  });
  it('does not let a pre-erasure result consume the replacement metadata boundary',()=>{
    let state=reduceDomain(fixture(),{type:'source',source:source('private',300000)},clock).state;
    const request=state.pendingGeneration!;
    state=reduceDomain(state,{type:'privacy',target:{kind:'source',sessionId:'s',id:'private'}},clock).state;
    state=reduceDomain(state,{type:'metadata',title:'Safe later topic',category:'Authored',atMs:330000,safety:safe},clock).state;
    const latest=state.pendingGeneration!;
    state=reduceDomain(state,{type:'generation.result',ticket:request.ticket,patch:{sessionId:'s',baseRevision:0,action:'hold',title:null,claims:[],relations:[],currentAttemptId:null,language:'en',missingContext:[]},safety:safe},clock).state;
    expect(state.pendingGeneration?.ticket.jobId).toBe(latest.ticket.jobId);expect(state.boundaryRevision).toBe(latest.boundaryRevision);
    expect(JSON.stringify(state)).not.toContain('Authored speech private');
  });
});
