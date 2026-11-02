import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {buildEvidencePacket,evidencePacketBytes,DOMAIN_LIMITS,type GenerationRequest} from '../../src/core/index.js';
import {retainRecentSources} from '../../src/core/source-retention.js';
import type {EventEnvelope,Source,StoryPatch,EvidencePacket,GenerationTicket} from '../../src/shared/contracts/index.js';

const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();});
function fixture(options:{memory?:boolean}={}){
  const directory=mkdtempSync(join(tmpdir(),'previously-starvation-')),path=options.memory?':memory:':join(directory,'state.sqlite');
  cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
  const start=Date.parse('2026-11-02T00:00:00Z');let at=0,outage=true;
  const clock={now:()=>start+at,iso:()=>new Date(start+at).toISOString()},scope={channelId:'channel',runId:'live'};
  let storage=createStorage({path,now:clock.now});const updates=new RevisionStream();cleanups.push(()=>storage.close(),()=>updates.close());
  const safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'},clock.now);
  const inspect=vi.spyOn(safety,'inspectBatch');
  const propose=vi.fn(async(packet:EvidencePacket,ticket:GenerationTicket)=>{
    if(outage)throw new Error('deterministic outage');
    const source=packet.sources.find(value=>value.kind==='speech'&&value.text);if(!source)throw new Error('no fresh speech');
    const value:StoryPatch={sessionId:'session',baseRevision:ticket.baseEntityRevision,action:'update',title:'Authored progress',claims:[{id:'state',text:source.text!,role:'state',support:[{id:source.id,revision:source.revision}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
    return {value,usage:{chargedMicroUsd:0},requestId:'local',model:'deterministic'};
  });
  const makeEngine=()=>new StoryEngine({scope,channel:{id:'channel',login:'fixture',displayName:'Fixture'},storage,clock,updates,safety,story:{propose}});
  let engine=makeEngine();storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});storage.repository.updateSettings(scope,0,{listeningPaused:false});
  const source=(id:string,moderation:Source['moderation']='allowed',kind:Source['kind']='speech'):Source=>({...scope,id,sessionId:'session',revision:1,kind,startMs:at,endMs:at,actorId:null,languageCodes:['en'],timePrecision:'event',text:`Authored source ${id}`,status:'active',externalMessageId:null,moderation});
  const event=(id:string,payload:unknown,kind='speech.transcribed'):EventEnvelope=>({...scope,schemaVersion:1,eventId:`event:${id}`,externalId:id,origin:'microphone',kind,occurredAt:clock.iso(),receivedAt:clock.iso(),sessionId:'session',sessionOffsetMs:at,payload});
  return {get engine(){return engine;},get repository(){return storage.repository;},scope,source,event,inspect,propose,set(ms:number){at=ms;},restoreProvider(){outage=false;},restart(invalidate=false){storage.close();if(invalidate){const db=new DatabaseSync(path);db.prepare("UPDATE domain_checkpoints SET body=json_set(body,'$.version',2)").run();db.close();}storage=createStorage({path,now:clock.now});engine=makeEngine();},async execute(){const job=storage.repository.claimJob(scope,{kinds:['story'],leaseMs:120000,sessionId:'session'});expect(job).not.toBeNull();const result=await engine.executeStory(job!,new AbortController().signal);storage.repository.finishJob(scope,job!.id,job!.leaseToken,result.state);return result;},async flood(from:number,count:number){for(let i=0;i<count;i+=20){at=from+i*50;await engine.ingestBatch(Array.from({length:Math.min(20,count-i)},(_,offset)=>{const id=`chat-${from}-${i+offset}`;return event(id,{chatter_user_id:'viewer',message_id:id,message:{text:'Authored chat'}},'channel.chat.message');}));}}};
}

describe('real SQLite/runtime speech progress under chat load',()=>{
  it.each(['ascii','unicode'] as const)('keeps equal-time %s source selection, packet order and safety order across full recovery',async alphabet=>{
    const f=fixture({memory:true}),ids=Array.from({length:70},(_,i)=>`speech-${String(69-i).padStart(3,'0')}`);
    if(alphabet==='unicode')ids.splice(0,6,'speech-A','speech-a','speech-é','speech-e\u0301','speech-\ue000','speech-😀');
    const values=[...ids.map(id=>({...f.source(id,'pending'),startMs:1000,endMs:1000})),...Array.from({length:500},(_,i)=>({...f.source(`chat-${String(i).padStart(3,'0')}`,'pending','chat'),startMs:2000+i,endMs:2000+i}))];
    for(const source of values)f.repository.ingest(f.event(source.id,{source}),{sources:[source]});
    const hot=retainRecentSources(values),restored=f.engine.state('session');
    expect(hot).toHaveLength(500);expect(restored.sources).toHaveLength(500);
    expect(new Set(hot.map(source=>source.id))).toEqual(new Set(restored.sources.map(source=>source.id)));
    const allowed=(sources:Source[])=>sources.map(source=>({...source,moderation:'allowed' as const}));
    expect(buildEvidencePacket({...restored,sources:allowed(hot)}).sources).toEqual(buildEvidencePacket({...restored,sources:allowed(restored.sources)}).sources);
    f.inspect.mockResolvedValue([]);
    vi.spyOn(f.engine,'state').mockReturnValueOnce({...restored,sources:hot});await f.engine.checkPendingSources();
    f.set(30000);await f.engine.checkPendingSources();
    expect(f.inspect.mock.calls[0]![0]).toEqual(f.inspect.mock.calls[1]![0]);
  });
  it('reviews pending speech and metadata before a newer chat tail within existing safety caps',async()=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('speech','pending')});
    await f.engine.dispatch('session',{type:'source',source:f.source('metadata','pending','channel_metadata')});
    await f.flood(1000,40);f.set(30000);await f.engine.checkPendingSources();
    const batch=f.inspect.mock.calls[0]![0];expect(batch.map(item=>item.id)).toEqual(expect.arrayContaining(['speech','metadata']));
    expect(batch.length).toBeLessThanOrEqual(30);expect(batch.reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item.text)),0)).toBeLessThanOrEqual(3500);
    expect(f.repository.getSource(f.scope,'speech')?.moderation).toBe('allowed');
  });
  it.each(['revision','erasure','ban'] as const)('keeps the %s fence when a prioritized safety result returns late',async change=>{
    const f=fixture(),speech={...f.source('speech','pending'),actorId:'speaker'};
    await f.engine.dispatch('session',{type:'source',source:speech});await f.flood(1000,40);
    let complete!:(value:Awaited<ReturnType<SafetyService['inspectBatch']>>)=>void;
    f.inspect.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const checking=f.engine.checkPendingSources();
    const batch=f.inspect.mock.calls[0]![0];expect(batch.some(item=>item.id==='speech')).toBe(true);
    if(change==='revision')await f.engine.dispatch('session',{type:'source.safety',id:speech.id,baseRevision:1,text:'Corrected authored text',safety:{moderation:'allowed',pii:'allowed',checkedAt:'2026-11-02T00:00:02Z',reason:null}});
    else if(change==='erasure')await f.engine.dispatch('session',{type:'privacy',target:{kind:'source',sessionId:'session',id:'speech'}});
    else await f.engine.dispatch('session',{type:'ban',actorId:'speaker',throughMs:30000});
    complete(batch.map(item=>({...item,safety:{moderation:'allowed',pii:'allowed',checkedAt:'2026-11-02T00:00:02Z',reason:null}})));await checking;
    const saved=f.repository.getSource(f.scope,'speech')!;
    if(change==='revision'){expect(saved.revision).toBe(2);expect(saved.text).toBe('Corrected authored text');expect(saved.moderation).toBe('allowed');}
    else {expect(saved.text).toBeNull();expect(saved.status).toBe('deleted');}
    f.restart(true);expect(JSON.stringify(f.engine.state('session'))).not.toContain('Authored source speech');
  });
  it('recovers from an outage at an offset retry after chat floods, publishes and survives both restart paths',async()=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('old')});
    // A slow failed request during the five-minute outage sets the real 45-second backoff.
    f.set(281950);expect((await f.execute()).state).toBe('failed');
    f.set(300000);f.restoreProvider();await f.engine.dispatch('session',{type:'source',source:f.source('fresh')});
    await f.flood(300050,540);f.set(326950);await f.engine.tick();
    const state=f.engine.state('session'),request=state.pendingGeneration as GenerationRequest;
    expect(state.sources).toHaveLength(500);expect(request.packet.sources.some(source=>source.id==='fresh')).toBe(true);
    expect(evidencePacketBytes(request.packet)).toBeLessThanOrEqual(DOMAIN_LIMITS.packetBytes);
    expect((await f.execute()).state).toBe('done');f.set(375000);await f.engine.tick();
    expect(f.engine.state('session').published?.current?.now).toBe('Authored source fresh');
    f.restart();expect(f.engine.state('session').sources.some(source=>source.id==='fresh')).toBe(true);
    f.restart(true);const restored=f.engine.state('session');expect(restored.sources).toHaveLength(500);expect(buildEvidencePacket(restored).sources.some(source=>source.id==='fresh')).toBe(true);
    await f.engine.dispatch('session',{type:'privacy',target:{kind:'source',sessionId:'session',id:'fresh'}});
    f.restart(true);expect(JSON.stringify(f.engine.state('session'))).not.toContain('Authored source fresh');
  },30000);
});
