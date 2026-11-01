import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine,type EngineOptions} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import type {EventEnvelope,Source} from '../../src/shared/contracts/index.js';

const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();});
function fixture(onCommittedTransition?:EngineOptions['onCommittedTransition']){
  const directory=mkdtempSync(join(tmpdir(),'previously-hydration-')),path=join(directory,'state.sqlite');
  cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
  const start=Date.parse('2026-11-02T00:00:00Z'),clock={now:()=>start+10000,iso:()=>new Date(start+10000).toISOString()};
  const scope={channelId:'channel',runId:'live'},storage=createStorage({path,now:clock.now}),updates=new RevisionStream();
  cleanups.push(()=>storage.close(),()=>updates.close());
  const engine=new StoryEngine({scope,channel:{id:'channel',login:'fixture',displayName:'Fixture'},storage,clock,updates,
    safety:new SafetyService({classify:async()=>({decision:'review',spans:[]})},{moderate:async()=> 'unavailable'}),
    story:{propose:async()=>{throw new Error('No provider calls in hydration tests.');}},
    onCommittedTransition,
  });
  storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});
  storage.repository.updateSettings(scope,0,{listeningPaused:false});
  const source=(id:string):Source=>({...scope,id,sessionId:'session',revision:1,kind:'speech',startMs:1000,endMs:2000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:`Authored source ${id}`,status:'active',externalMessageId:null,moderation:'pending'});
  const event=(id:string,payload:unknown,kind='speech.transcribed'):EventEnvelope=>({...scope,schemaVersion:1,eventId:`event:${id}`,externalId:id,origin:'microphone',kind,occurredAt:clock.iso(),receivedAt:clock.iso(),sessionId:'session',sessionOffsetMs:2000,payload});
  const sql=(statement:string,...params:(string|number)[])=>{const db=new DatabaseSync(path);try{db.prepare(statement).run(...params);}finally{db.close();}};
  return {engine,repository:storage.repository,scope,source,event,sql};
}

describe('checkpoint hot path keeps authoritative storage fences',()=>{
  it('observes external settings, session metadata and capture lease changes without retaining mutable caller state',async()=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('initial')});
    const first=f.engine.state('session');first.sources[0]!.text='Caller mutation';
    f.repository.updateSettings(f.scope,1,{listeningPaused:true});
    f.repository.updateSession(f.scope,'session',{title:'Reviewed elsewhere',metadataMaxDependencyEndMs:3000});
    const lease=f.repository.acquireCapture(f.scope,'session','browser');
    const current=f.engine.state('session');
    expect(current.sources[0]?.text).toBe('Authored source initial');expect(current.settings.listeningPaused).toBe(true);
    expect(current.session.title).toBe('Reviewed elsewhere');expect(current.captureEpoch).toBe(lease.epoch);
    f.repository.pauseCapture(f.scope,'browser',lease.epoch);expect(f.engine.state('session').captureEpoch).toBe(lease.epoch+1);
    await f.engine.ingest(f.event('paused-chat',{chatter_user_id:'viewer',message_id:'paused',message:{text:'Must not be accepted'}},'channel.chat.message'));
    expect(f.engine.state('session').sources.map(source=>source.id)).toEqual(['initial']);
  });
  it('drains audio accepted outside the engine exactly once after a checkpoint already exists',async()=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('initial')});
    const speech=f.source('adapter-audio');f.repository.ingest(f.event('audio',{source:speech,captureEpoch:0}),{sources:[speech]});
    await f.engine.drain('session');await f.engine.drain('session');
    expect(f.engine.state('session').sources.map(source=>source.id)).toEqual(['initial','adapter-audio']);
    expect(f.repository.listPendingDomainEvents(f.scope,'session')).toEqual([]);
  });
  it('recovers surviving authoritative sources when checkpoint validation fails',async()=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('survivor')});
    f.sql("UPDATE domain_checkpoints SET body=json_set(body,'$.version',2)");
    expect(f.engine.state('session').sources).toEqual([f.source('survivor')]);
    await f.engine.dispatch('session',{type:'tick'});expect(f.repository.getDomainCheckpoint(f.scope,'session').checkpoint?.version).toBe(1);
  });
  it('honors a standalone privacy transaction and cannot restore its tombstoned interval',async()=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('private')});
    f.repository.invalidate(f.scope,{kind:'interval',sessionId:'session',fromMs:1000,toMs:2000},{idempotencyKey:'outside-forget',reason:'Authored privacy test'});
    const restored=f.engine.state('session');expect(restored.session.privacyEpoch).toBe(1);
    expect(JSON.stringify(restored)).not.toContain('Authored source private');
    await f.engine.dispatch('session',{type:'source',source:f.source('late-audio')});
    expect(f.engine.state('session').sources.some(source=>source.id==='late-audio'&&source.text)).toBe(false);
  });
  it('keeps a single privacy target bounded across repeated recoveries and transitions',async()=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('forgotten')});
    await f.engine.dispatch('session',{type:'privacy',target:{kind:'interval',sessionId:'session',fromMs:1000,toMs:2000}});
    for(let i=0;i<20;i++)await f.engine.dispatch('session',{type:'tick'});
    const current=f.engine.state('session');
    expect(current.tombstones).toEqual([{kind:'interval',sessionId:'session',fromMs:1000,toMs:2000}]);
    expect(JSON.stringify(current)).not.toContain('Authored source forgotten');
  });
  it.each(['text','revision','status'] as const)('rejects a stale checkpoint if the authoritative source %s changed independently',async field=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('source')});
    const value=field==='revision'?2:field==='status'?'deleted':'Corrected external text';
    f.sql(`UPDATE sources SET ${field}=? WHERE id='source'`,value);
    await expect(f.engine.dispatch('session',{type:'tick'})).rejects.toThrow('Checkpoint contains stale source content');
  });
  it('returns committed capture and privacy fences without a postcommit reload',async()=>{
    const f=fixture();await f.engine.dispatch('session',{type:'source',source:f.source('source')});
    const lease=f.repository.acquireCapture(f.scope,'session','browser');
    const paused=await f.engine.dispatch('session',{type:'tick'},{settingsPatch:{baseRevision:1,patch:{listeningPaused:true}}});
    expect(paused.captureEpoch).toBe(lease.epoch+1);expect(paused.captureEpoch).toBe(f.engine.state('session').captureEpoch);
    const forgotten=await f.engine.dispatch('session',{type:'privacy',target:{kind:'session',sessionId:'session'}});
    expect(forgotten.captureEpoch).toBe(f.engine.state('session').captureEpoch);
    expect(forgotten.session).toEqual(f.engine.state('session').session);expect(forgotten.lastReceipt).toEqual(f.engine.state('session').lastReceipt);
  });
});

describe('bounded durable chat intake batches',()=>{
  const payload=(id:string)=>({chatter_user_id:'viewer',message_id:id,message:{text:`Authored chat ${id}`}});
  it('keeps per-message identity and publishes callbacks only after the whole batch commits',async()=>{
    const observed:{visible:number;before:number;after:number}[]=[];
    const f=fixture(transition=>observed.push({visible:f.repository.listSources(f.scope,'session').length,before:transition.previous.sources.length,after:transition.state.sources.length}));
    const a=f.event('batch-a',payload('a'),'channel.chat.message'),b=f.event('batch-b',payload('b'),'channel.chat.message');
    await f.engine.ingestBatch([a,b,a]);
    expect(f.engine.state('session').sources.map(source=>source.id)).toEqual(['chat:a','chat:b']);
    expect(observed).toEqual([{visible:2,before:0,after:1},{visible:2,before:1,after:2}]);
    expect(f.repository.listPendingDomainEvents(f.scope,'session')).toEqual([]);
  });
  it('rolls back every message and emits no callback if any source cannot commit',async()=>{
    let observed=0;const f=fixture(()=>{observed++;});
    f.sql("CREATE TRIGGER reject_batch BEFORE INSERT ON sources WHEN NEW.id='chat:b' BEGIN SELECT RAISE(ABORT,'authored batch failure'); END");
    const events=['a','b'].map(id=>f.event(`batch-${id}`,payload(id),'channel.chat.message'));
    await expect(f.engine.ingestBatch(events)).rejects.toThrow('could not be saved');
    expect(f.repository.getSource(f.scope,'chat:a')).toBeNull();expect(f.repository.getDomainCheckpoint(f.scope,'session').checkpoint).toBeNull();expect(observed).toBe(0);
    f.sql('DROP TRIGGER reject_batch');await f.engine.ingestBatch(events);
    expect(f.engine.state('session').sources).toHaveLength(2);expect(observed).toBe(2);
  });
  it('observes a preceding pause before normalizing queued chat',async()=>{
    const f=fixture();
    const pause=f.engine.dispatch('session',{type:'tick'},{settingsPatch:{baseRevision:1,patch:{listeningPaused:true}}});
    const chat=f.engine.ingestBatch([f.event('after-pause',payload('after-pause'),'channel.chat.message')]);
    await Promise.all([pause,chat]);expect(f.engine.state('session').sources).toEqual([]);
  });
  it('retains prior privacy tombstones and refuses to mix privacy or different sessions into chat batches',async()=>{
    const f=fixture();
    await f.engine.dispatch('session',{type:'privacy',target:{kind:'message',sessionId:'session',externalMessageId:'deleted'}});
    await f.engine.ingestBatch(['deleted','allowed'].map(id=>f.event(id,payload(id),'channel.chat.message')));
    expect(f.engine.state('session').sources.map(source=>source.id)).toEqual(['chat:allowed']);
    const valid=f.event('valid',payload('valid'),'channel.chat.message');
    await expect(f.engine.ingestBatch([valid,f.event('privacy',{message_id:'allowed'},'channel.chat.message_delete')])).rejects.toMatchObject({code:'invalid_chat_batch'});
    await expect(f.engine.ingestBatch([valid,{...valid,sessionId:'other'}])).rejects.toMatchObject({code:'invalid_chat_batch'});
    await expect(f.engine.ingestBatch(Array.from({length:21},()=>valid))).rejects.toMatchObject({code:'invalid_chat_batch'});
    expect(f.engine.state('session').sources.map(source=>source.id)).toEqual(['chat:allowed']);
  });
});
