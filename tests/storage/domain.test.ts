import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createStorage,type DomainCommitInput} from '../../src/server/storage/index.js';
import {recoverDomainState,reduceDomain,type DomainEvent,type DomainState} from '../../src/core/index.js';
import type {EventEnvelope,Scope,Source,StoryPatch,Safety} from '../../src/shared/contracts/index.js';

const scope:Scope={channelId:'channel',runId:'live'},start=Date.parse('2026-11-02T00:00:00Z');
let directory:string,path:string,now:number,store:ReturnType<typeof createStorage>,sequence:number;
const clock={now:()=>now,iso:()=>new Date(now).toISOString()};
const safe:Safety={moderation:'allowed',pii:'allowed',checkedAt:'2026-11-02T00:01:00Z',reason:null};
const source=(id='speech1',startMs=1000,endMs=2000):Source=>({...scope,id,sessionId:'s1',revision:1,kind:'speech',startMs,endMs,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'The application now uses a smaller cache.',status:'active',externalMessageId:null,moderation:'allowed'});
const envelope=(event:DomainEvent,id:string):EventEnvelope<DomainEvent>=>({...scope,schemaVersion:1,eventId:`event:${id}`,externalId:id,origin:'owner',kind:event.type,occurredAt:clock.iso(),receivedAt:clock.iso(),sessionId:'s1',sessionOffsetMs:now-start,payload:event});
function state():DomainState{return recoverDomainState(store.repository.getDomainHydration(scope,'s1'),{resumePlayback:true});}
function dispatch(event:DomainEvent,options:Partial<DomainCommitInput>={},id=`step-${++sequence}`){
  const previous=state(),transition=reduceDomain(previous,event,clock);
  return store.repository.applyDomainTransition(scope,'s1',{expectedRevision:previous.revision,expectedPrivacyEpoch:previous.session.privacyEpoch,transition,event:envelope(event,id),...options});
}
function commitGenerated(){
  const pending=state().pendingGeneration!;
  const patch:StoryPatch={sessionId:'s1',baseRevision:pending.ticket.baseEntityRevision,action:'new_chapter',title:'A smaller cache',claims:[{id:'claim1',text:source().text!,role:'change',support:[{id:'speech1',revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
  dispatch({type:'generation.result',ticket:pending.ticket,patch,safety:safe});
}
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'previously-domain-storage-'));path=join(directory,'db.sqlite');now=start+60000;sequence=0;
  store=createStorage({path,now:()=>now});store.repository.ensureChannel(scope,'fixture');store.repository.createSession(scope,{id:'s1',startedAt:new Date(start).toISOString()});store.repository.updateSettings(scope,0,{listeningPaused:false});
});
afterEach(()=>{store.close();rmSync(directory,{recursive:true,force:true});});

describe('atomic domain persistence with the real reducer',()=>{
  it('commits event, source, checkpoint and generation request together and deduplicates retry',()=>{
    const event:DomainEvent={type:'source',source:source()};const first=dispatch(event,{},'same-input');
    expect(first.applied).toBe(true);expect(store.repository.getSource(scope,'speech1')?.text).toBe(source().text);
    expect(store.repository.pendingJobCount(scope,'s1',['story'])).toBe(1);expect(state().pendingGeneration?.ticket.baseEntityRevision).toBe(0);
    const previousRevision=state().revision;const second=dispatch(event,{},'same-input');expect(second.duplicate).toBe(true);expect(state().revision).toBe(previousRevision);
    expect(store.repository.listPendingDomainEvents(scope,'s1')).toHaveLength(0);
    store.close();store=createStorage({path,now:()=>now});expect(state().pendingGeneration).not.toBeNull();
    const job=store.repository.claimJob(scope,{kinds:['story']})!;expect(job.payload).toMatchObject({request:{ticket:{sessionId:'s1'}}});
  });
  it('rolls back the whole transition if an effect cannot be persisted',()=>{
    const check=new DatabaseSync(path);check.exec("CREATE TRIGGER fail_domain_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'injected'); END");check.close();
    expect(()=>dispatch({type:'source',source:source()})).toThrow(/could not be saved/);
    expect(store.repository.getSource(scope,'speech1')).toBeNull();expect(store.repository.getDomainCheckpoint(scope,'s1').checkpoint).toBeNull();
    const verify=new DatabaseSync(path);expect(verify.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(0);verify.close();
  });
  it('persists canonical candidates, publishes after hold, and clears raw result events on Forget',()=>{
    dispatch({type:'source',source:source()});commitGenerated();expect(state().candidates).toHaveLength(1);
    now=start+78000;dispatch({type:'tick'});expect(state().published?.chapters[0]?.title).toBe('A smaller cache');
    const publication=store.repository.claimOutbox(scope,{kinds:['publish']})!;expect(publication.payload).toMatchObject({snapshot:{chapters:[{title:'A smaller cache'}]}});
    dispatch({type:'privacy',target:{kind:'source',sessionId:'s1',id:'speech1'}});
    expect(state().published?.chapters).toHaveLength(0);expect(state().sources[0]?.text).toBeNull();
    expect(store.repository.getDomainCheckpoint(scope,'s1').checkpoint?.lastReceipt?.privacyEpoch).toBe(1);
    const verify=new DatabaseSync(path);expect(verify.prepare("SELECT payload FROM events WHERE kind='generation.result'").get()?.payload).toBeNull();
    expect(verify.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='retract' AND state='queued'").get()?.n).toBe(1);verify.close();
    expect(readFileSync(path).includes(Buffer.from(source().text!))).toBe(false);
  });
  it('applies interval Forget at adjacent boundaries and tombstones only the overlapping range',()=>{
    dispatch({type:'source',source:{...source('left',0,10000),text:'Left chunk remains.',moderation:'pending'}});
    dispatch({type:'source',source:{...source('target',10000,20000),text:'Forget this chunk.',moderation:'pending'}});
    store.repository.saveEntity(scope,{id:'left-media',sessionId:'s1',kind:'media',body:{clipId:'left'},refs:[],startMs:0,endMs:10000});
    store.repository.saveEntity(scope,{id:'target-media',sessionId:'s1',kind:'media',body:{clipId:'target'},refs:[],startMs:10000,endMs:20000});
    expect(()=>dispatch({type:'privacy',target:{kind:'interval',sessionId:'s1',fromMs:10000,toMs:20000}})).not.toThrow();
    expect(store.repository.getSource(scope,'left')?.text).toBe('Left chunk remains.');expect(store.repository.getSource(scope,'target')?.text).toBeNull();
    expect(store.repository.getEntity(scope,'left-media')?.status).toBe('active');expect(store.repository.getEntity(scope,'target-media')?.status).toBe('hidden');
    const late:Source={...source('late-adjacent',0,10000),moderation:'pending'};dispatch({type:'source',source:late});expect(store.repository.getSource(scope,late.id)?.status).toBe('active');
    const erased={...source('late-overlap',11000,19000),text:null,status:'deleted' as const,moderation:'pending' as const};
    store.repository.ingest({...envelope({type:'tick'},'late-overlap-event'),payload:{}},{sources:[erased]});expect(store.repository.getSource(scope,erased.id)?.text).toBeNull();
    expect(store.repository.sourcePolicy(scope,source('point',10000,10000))).toBe('deleted');
  });
  it('fences stale pure transitions and looks up idempotency before editorial revision checks',()=>{
    const previous=state(),event:DomainEvent={type:'source',source:source()},transition=reduceDomain(previous,event,clock);
    store.repository.applyDomainTransition(scope,'s1',{expectedRevision:0,expectedPrivacyEpoch:0,transition,event:envelope(event,'idempotent'),idempotencyKey:'source-request',requestBody:{operation:'source',id:'speech1'}});
    const same=store.repository.applyDomainTransition(scope,'s1',{expectedRevision:0,expectedPrivacyEpoch:0,expectedEntity:{id:'missing',revision:99},transition,event:envelope(event,'idempotent'),idempotencyKey:'source-request',requestBody:{operation:'source',id:'speech1'}});
    expect(same.duplicate).toBe(true);
    expect(()=>store.repository.applyDomainTransition(scope,'s1',{expectedRevision:0,expectedPrivacyEpoch:0,transition,event:envelope(event,'different')})).toThrow(/checkpoint changed/);
    expect(()=>store.repository.getDomainMutation(scope,'source-request',{operation:'source',id:'different'})).toThrow(/different request/);
  });
  it('recovers adapter-ingested events once after interruption before the domain callback',()=>{
    const speech=source(),event:EventEnvelope<unknown>={...envelope({type:'source',source:speech},'accepted-before-domain'),kind:'speech.transcribed',origin:'microphone',payload:{source:speech,captureEpoch:0}};
    store.repository.ingest(event,{sources:[speech]});expect(store.repository.listPendingDomainEvents(scope,'s1')[0]?.sources[0]?.id).toBe(speech.id);
    store.close();store=createStorage({path,now:()=>now});const previous=state(),transition=reduceDomain(previous,{type:'source',source:speech},clock);
    const applied=store.repository.applyDomainTransition(scope,'s1',{expectedRevision:previous.revision,expectedPrivacyEpoch:previous.session.privacyEpoch,transition,event});
    expect(applied.applied).toBe(true);expect(store.repository.listPendingDomainEvents(scope,'s1')).toHaveLength(0);expect(state().sources).toHaveLength(1);
  });
  it('discards raw late provider text after Forget instead of restoring it in the event audit',()=>{
    dispatch({type:'source',source:source()});const ticket=state().pendingGeneration!.ticket;
    dispatch({type:'privacy',target:{kind:'source',sessionId:'s1',id:'speech1'}});
    const patch:StoryPatch={sessionId:'s1',baseRevision:0,action:'new_chapter',title:'Discarded private title',claims:[{id:'late-claim',text:source().text!,role:'change',support:[{id:'speech1',revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
    dispatch({type:'generation.result',ticket,patch,safety:safe});
    expect(state().chapters).toHaveLength(0);const check=new DatabaseSync(path);
    const retained=check.prepare("SELECT payload FROM events WHERE kind='generation.result'").get()?.payload;check.close();expect(retained).toBeNull();
    expect(readFileSync(path).includes(Buffer.from('Discarded private title'))).toBe(false);expect(readFileSync(path).includes(Buffer.from(source().text!))).toBe(false);
  });
  it('corrects a source atomically without a delete tombstone or old public text',()=>{
    dispatch({type:'source',source:source()});commitGenerated();now=start+78000;dispatch({type:'tick'});
    dispatch({type:'source',source:{...source(),revision:2,text:'The revised note describes an independent cache limit.'}});
    expect(store.repository.getSession(scope,'s1').privacyEpoch).toBe(1);
    expect(store.repository.getSource(scope,'speech1')).toMatchObject({revision:2,status:'active',text:'The revised note describes an independent cache limit.'});
    expect(store.repository.getDomainHydration(scope,'s1').tombstones).toHaveLength(0);
    expect(state().published?.chapters).toHaveLength(0);now+=45000;dispatch({type:'tick'});expect(state().pendingGeneration?.ticket.privacyEpoch).toBe(1);
    expect(readFileSync(path).includes(Buffer.from(source().text!))).toBe(false);
  });
  it('durably queues owner review with the edit and restores it after reopening',()=>{
    dispatch({type:'source',source:source()});commitGenerated();now=start+78000;dispatch({type:'tick'});
    const chapter=state().chapters[0]!,ownerSource:Source={...source('owner-source',now-start,now-start),kind:'owner_statement',moderation:'pending',text:'Owner correction waiting for review.'};
    const pending:Safety={moderation:'pending',pii:'pending',checkedAt:null,reason:null};
    dispatch({type:'owner.edit',entityId:chapter.id,baseRevision:chapter.revision,source:ownerSource,title:'Owner correction',summary:ownerSource.text!,safety:pending});
    expect(store.repository.pendingJobCount(scope,'s1',['owner.review'])).toBe(1);
    store.close();store=createStorage({path,now:()=>now});
    const job=store.repository.claimJob(scope,{kinds:['owner.review']})!;
    expect(job.payload).toMatchObject({kind:'chapter',entityId:chapter.id,sourceId:ownerSource.id,sourceRevision:1,privacyEpoch:0});
    expect(JSON.stringify(job.payload)).not.toContain('Owner correction');
    expect(state().chapters[0]?.summary).toBe(ownerSource.text);
  });
  it('quarantines chat.clear context without erasing speech or allowing late old chat',()=>{
    dispatch({type:'source',source:{...source('chat',500,500),kind:'chat',actorId:'viewer',externalMessageId:'chat-message',moderation:'pending',text:'Old chat'}});
    dispatch({type:'source',source:{...source('speech',600,700),moderation:'pending'}});
    dispatch({type:'chat.clear',throughMs:1000});
    expect(store.repository.getSource(scope,'chat')).toMatchObject({status:'quarantined',text:'Old chat'});expect(store.repository.getSource(scope,'speech')?.status).toBe('active');
    expect(store.repository.getDomainHydration(scope,'s1').chatClearThroughMs).toBe(1000);
    dispatch({type:'source',source:{...source('late-chat',800,800),kind:'chat',externalMessageId:'late-chat-message',moderation:'pending'}});
    expect(store.repository.getSource(scope,'late-chat')?.status).toBe('quarantined');
  });
  it('freezes exact publication bytes, fences Forget, and exposes durable sync state',()=>{
    const pending=store.repository.preparePublication(scope,{sessionId:'s1',kind:'publish',businessKey:'wire1',payload:{}}),lease=store.repository.claimOutbox(scope)!;
    const body='{"value":"original"}',bodyHash=createHash('sha256').update(body).digest('hex');
    expect(store.repository.freezePublication(scope,lease.id,lease.leaseToken,{body,bodyHash})).toEqual({body,bodyHash});
    const changed='{"value":"changed"}';expect(store.repository.freezePublication(scope,lease.id,lease.leaseToken,{body:changed,bodyHash:createHash('sha256').update(changed).digest('hex')})).toEqual({body,bodyHash});
    expect(store.repository.acknowledgePublication(scope,pending.publishSeq,bodyHash)).toBe(true);expect(store.repository.getPublicationState(scope)).toMatchObject({ackSeq:pending.publishSeq,ackHash:bodyHash});
    store.repository.invalidate(scope,{kind:'message',sessionId:'s1',externalMessageId:'unseen'},{idempotencyKey:'revoke-wire',reason:'privacy'});
    expect(store.repository.freezePublication(scope,lease.id,lease.leaseToken,{body,bodyHash})).toBeNull();expect(store.repository.getPublicationState(scope).pendingPrivacy).toBe(true);
    const check=new DatabaseSync(path);expect(check.prepare('SELECT frozen_body FROM outbox WHERE id=?').get(lease.id)?.frozen_body).toBeNull();check.close();
  });
  it('keeps control take/claim, settings idempotency and open-session lookup durable',()=>{
    expect(store.repository.controlClaim(scope,'oauth:hash',{returnTo:'/dock'},now+1000)).toBe(true);expect(store.repository.controlClaim(scope,'oauth:hash',{},now+1000)).toBe(false);
    expect(store.repository.controlTake(scope,'oauth:hash')).toEqual({returnTo:'/dock'});expect(store.repository.controlTake(scope,'oauth:hash')).toBeNull();
    expect(()=>store.repository.controlPut(scope,'bad',{accessToken:'credential'})).toThrow(/token vault/);
    const next=store.repository.updateSettings(scope,1,{volume:0.1},{idempotencyKey:'settings-retry',requestBody:{volume:0.1}});
    expect(store.repository.updateSettings(scope,1,{volume:0.1},{idempotencyKey:'settings-retry',requestBody:{volume:0.1}})).toEqual(next);
    expect(()=>store.repository.updateSettings(scope,1,{volume:0.9},{idempotencyKey:'settings-retry',requestBody:{volume:0.9}})).toThrow(/different request/);
    for(let i=0;i<55;i++){const id=`archive-${i}`;store.repository.createSession(scope,{id,startedAt:new Date(start-i*86400000).toISOString()});store.repository.updateSession(scope,id,{status:'finalized',endedAt:clock.iso(),finalizedAt:clock.iso()});}
    expect(store.repository.getActiveSession(scope)?.id).toBe('s1');expect(store.repository.listOpenSessions(scope).map(session=>session.id)).toEqual(['s1']);
  });
});
