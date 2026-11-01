import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStorage } from '../../src/server/storage/index.js';
import type { Scope, Source, EventEnvelope, GenerationTicket, StoryPatch } from '../../src/shared/contracts/index.js';

const scope:Scope={channelId:'123',runId:'live'};
let directory:string,path:string,now:number,storage:ReturnType<typeof createStorage>;
const key=Buffer.alloc(32,7);
function source(id='source1',text='private evidence'):Source {
  return {...scope,id,sessionId:'s1',revision:1,kind:'chat',startMs:100,endMs:200,actorId:'actor1',languageCodes:['en'],timePrecision:'event',text,status:'active',externalMessageId:`msg-${id}`,moderation:'allowed'};
}
function event(id='event1',sessionId='s1'):EventEnvelope<unknown> {
  return {...scope,schemaVersion:1,eventId:id,externalId:`external-${id}`,origin:'twitch',kind:'chat.message',occurredAt:'2026-11-02T00:00:00.000Z',receivedAt:'2026-11-02T00:00:00.010Z',sessionId,sessionOffsetMs:200,payload:{text:'private evidence'}};
}
function seed() {
  storage.repository.ingest(event(),{sources:[source()]});
  storage.repository.saveEntity(scope,{id:'chapter1',sessionId:'s1',kind:'chapter',body:{title:'draft'},refs:[]});
}
function ticket(jobId='generation1',revision=1):GenerationTicket {
  return {...scope,jobId,sessionId:'s1',privacyEpoch:0,baseEntityRevision:revision,inputRefs:[{id:'source1',revision:1}],inputHash:'hash',schemaVersion:1,promptVersion:'1',recapLanguage:'en',eligibleAt:new Date(now+75000).toISOString()};
}
function patch(revision=1):StoryPatch {
  return {sessionId:'s1',baseRevision:revision,action:'update',title:'private evidence',claims:[{id:'claim1',text:'private evidence',role:'goal',support:[{id:'source1',revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
}
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'previously-storage-'));path=join(directory,'test.sqlite');now=1_000_000;
  storage=createStorage({path,now:()=>now,encryptionKey:key});
  storage.repository.ensureChannel(scope,'channel');storage.repository.createSession(scope,{id:'s1',startedAt:'2026-11-02T00:00:00Z',twitchStreamId:'stream1'});
});
afterEach(()=>{storage.close();rmSync(directory,{recursive:true,force:true});});

describe('real SQLite storage boundaries',()=>{
  it('deduplicates event and effects atomically and isolates scopes',()=>{
    const effects={sources:[source()],outbox:[{sessionId:'s1',kind:'clip',businessKey:'clip-event1',payload:{sourceId:'source1'}}]};
    expect(storage.repository.ingest(event(),effects).accepted).toBe(true);
    expect(storage.repository.ingest(event(),effects).accepted).toBe(false);
    expect(storage.repository.claimOutbox(scope)?.kind).toBe('clip');
    expect(storage.repository.claimOutbox(scope)).toBeNull();
    expect(storage.repository.getSource({...scope,runId:'demo1'},'source1')).toBeNull();
    expect(()=>storage.repository.listSources({...scope,channelId:'other'},'s1')).toThrow(/unavailable/);
    expect(storage.repository.createSession(scope,{id:'duplicate',startedAt:'2026-11-02T00:00:00Z',twitchStreamId:'stream1'})).toEqual({id:'s1',created:false});
  });
  it('rolls back ingestion when an effect dependency is unknown',()=>{
    expect(()=>storage.repository.ingest(event(),{sources:[source()],jobs:[{sessionId:'s1',kind:'story',businessKey:'story1',payload:{},dependencyRefs:[{id:'missing',revision:1}]}]})).toThrow();
    expect(storage.repository.getSource(scope,'source1')).toBeNull();
    expect(storage.repository.ingest(event(),{sources:[source()]}).accepted).toBe(true);
  });
  it('retains tombstones for delete-before-create and clears original event body',()=>{
    storage.repository.invalidate(scope,{kind:'message',sessionId:'s1',externalMessageId:'msg-source1'},{idempotencyKey:'forget1',reason:'private'});
    storage.repository.ingest(event(),{sources:[source()],outbox:[{sessionId:'s1',kind:'clip',businessKey:'late',payload:{text:'private evidence'}}]});
    expect(storage.repository.getSource(scope,'source1')).toMatchObject({status:'deleted',text:null});
    const check=new DatabaseSync(path);expect(check.prepare('SELECT payload FROM events').get()?.payload).toBeNull();
    expect(check.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='clip'").get()?.n).toBe(0);check.close();
  });
  it('respects user cutoff while future messages remain active',()=>{
    storage.repository.invalidate(scope,{kind:'user',sessionId:'s1',actorId:'actor1',throughMs:250},{idempotencyKey:'cutoff',reason:'private'});
    storage.repository.ingest(event(),{sources:[source()]});
    storage.repository.ingest(event('event2'),{sources:[{...source('source2'),startMs:300,endMs:400}]});
    expect(storage.repository.getSource(scope,'source1')?.status).toBe('deleted');
    expect(storage.repository.getSource(scope,'source2')?.status).toBe('active');
  });
  it('recovers expired leases after reopen and fences the old worker',()=>{
    storage.repository.enqueueJob(scope,{sessionId:'s1',kind:'story',businessKey:'one',payload:{value:1}});
    const first=storage.repository.claimJob(scope)!;expect(storage.repository.claimJob(scope)).toBeNull();
    storage.close();now+=30001;storage=createStorage({path,now:()=>now,encryptionKey:key});
    const second=storage.repository.claimJob(scope)!;expect(second.id).toBe(first.id);expect(second.attempts).toBe(2);
    expect(storage.repository.finishJob(scope,first.id,first.leaseToken,'done')).toBe(false);
    expect(storage.repository.renewJob(scope,second.id,second.leaseToken)).toBe(true);
    expect(storage.repository.finishJob(scope,second.id,second.leaseToken,'done')).toBe(true);
  });
  it('limits STT concurrency and disallows automatic ambiguous-effect retry',()=>{
    for(let i=0;i<5;i++) storage.repository.enqueueJob(scope,{sessionId:'s1',kind:'stt',businessKey:`stt${i}`,payload:{}});
    expect(()=>storage.repository.enqueueJob(scope,{sessionId:'s1',kind:'stt',businessKey:'overflow',payload:{}})).toThrow(/full/);
    expect(storage.repository.claimJob(scope)).not.toBeNull();expect(storage.repository.claimJob(scope)).not.toBeNull();expect(storage.repository.claimJob(scope)).toBeNull();
    storage.repository.enqueueOutbox(scope,{sessionId:'s1',kind:'chat',businessKey:'chat',payload:{}});
    const job=storage.repository.claimOutbox(scope)!;
    expect(()=>storage.repository.finishOutbox(scope,job.id,job.leaseToken,'unknown_outcome',now+1000)).toThrow(/automatically retried/);
    expect(storage.repository.finishOutbox(scope,job.id,job.leaseToken,'unknown_outcome')).toBe(true);
    now+=60000;expect(storage.repository.claimOutbox(scope)).toBeNull();
  });
  it('rejects late generation after privacy epoch changes and idempotently returns receipt',()=>{
    seed();const t=ticket();storage.repository.registerGeneration(t,'chapter1');
    const target={kind:'source' as const,sessionId:'s1',id:'source1'},options={idempotencyKey:'privacy1',reason:'private'};
    const receipt=storage.repository.invalidate(scope,target,options);
    expect(receipt.privacyEpoch).toBe(1);expect(storage.repository.commitStory(t,patch()).committed).toBe(false);
    expect(storage.repository.invalidate(scope,target,options)).toEqual(receipt);
    expect(()=>storage.repository.invalidate(scope,{...target,id:'different'},options)).toThrow(/different request/);
    expect(storage.repository.getSession(scope,'s1').privacyEpoch).toBe(1);
  });
  it('publishes a mature safe candidate even when a newer draft is held',()=>{
    seed();const t=ticket();storage.repository.registerGeneration(t,'chapter1');const old=storage.repository.commitStory(t,patch());
    storage.repository.markCandidateSafe(scope,old.candidateId!,{moderation:'allowed',pii:'allowed'});
    now+=45000;const later=ticket('generation2',2);storage.repository.registerGeneration(later,'chapter1');const fresh=storage.repository.commitStory(later,patch(2));
    storage.repository.markCandidateSafe(scope,fresh.candidateId!,{moderation:'allowed',pii:'allowed'});
    expect(storage.repository.publishEligible(scope,'chapter1')).toBeNull();now+=30000;
    expect(storage.repository.publishEligible(scope,'chapter1')?.candidateId).toBe(old.candidateId);
    expect(storage.repository.getPublished(scope,'chapter1')).toMatchObject({title:'private evidence'});
  });
  it('blocks unknown support, unsafe candidate and stale model owner overwrite',()=>{
    seed();const t=ticket();storage.repository.registerGeneration(t,'chapter1');
    const bad=patch();bad.claims[0]!.support=[{id:'not-an-input',revision:1}];expect(storage.repository.commitStory(t,bad)).toMatchObject({committed:false,reason:'unsupported_claim'});
    storage.repository.editEntity(scope,'chapter1',1,{title:'owner text'});
    expect(storage.repository.commitStory(t,patch()).committed).toBe(false);
    expect(storage.repository.getEntity(scope,'chapter1')?.body).toEqual({title:'owner text'});
  });
  it('forgets exposed context, pinned bodies, presentations, media and pending outbox atomically',()=>{
    seed();const t=ticket();storage.repository.registerGeneration(t,'chapter1');const result=storage.repository.commitStory(t,patch());
    storage.repository.markCandidateSafe(scope,result.candidateId!,{moderation:'allowed',pii:'allowed'});now+=75000;storage.repository.publishEligible(scope,'chapter1');
    storage.repository.pinEntity(scope,'chapter1',2,true);
    storage.repository.saveEntity(scope,{id:'ru',sessionId:'s1',kind:'presentation',body:{text:'private evidence'},refs:[{id:'chapter1',revision:2}]});
    storage.repository.saveEntity(scope,{id:'media1',sessionId:'s1',kind:'media',body:{clipId:'clip1',path:'private evidence'},refs:[],startMs:50,endMs:300});
    storage.repository.enqueueOutbox(scope,{sessionId:'s1',kind:'chat',businessKey:'pending-chat',payload:{text:'private evidence'},dependencyRefs:[{id:'chapter1',revision:2}]});
    const receipt=storage.repository.invalidate(scope,{kind:'interval',sessionId:'s1',fromMs:100,toMs:200},{idempotencyKey:'forget',reason:'private evidence'});
    expect(receipt.hiddenEntityIds).toEqual(expect.arrayContaining(['chapter1','ru','media1']));
    expect(receipt.externalClipActions[0]?.clipId).toBe('clip1');expect(storage.repository.getPublished(scope,'chapter1')).toBeNull();
    expect(storage.repository.getEntity(scope,'ru')?.body).toBeNull();expect(storage.repository.pinEntity(scope,'chapter1',3,true)).toBe(false);
    const next=storage.repository.claimOutbox(scope)!;expect(next.kind).toBe('retract');expect(JSON.stringify(next)).not.toContain('private evidence');
    const check=new DatabaseSync(path);
    expect(check.prepare("SELECT payload FROM outbox WHERE business_key='pending-chat'").get()?.payload).toBeNull();
    expect(check.prepare('SELECT body FROM publication_candidates').get()?.body).toBeNull();check.close();
    expect(readFileSync(path).includes(Buffer.from('private evidence'))).toBe(false);
  });
  it('rolls back a failed privacy transaction without leaving tombstones',()=>{
    seed();const check=new DatabaseSync(path);
    check.exec("CREATE TRIGGER fail_privacy BEFORE UPDATE OF privacy_epoch ON sessions BEGIN SELECT RAISE(ABORT,'injected'); END");check.close();
    expect(()=>storage.repository.invalidate(scope,{kind:'source',sessionId:'s1',id:'source1'},{idempotencyKey:'failed',reason:'private'})).toThrow(/could not be saved/);
    expect(storage.repository.getSource(scope,'source1')?.text).toBe('private evidence');
    const inspect=new DatabaseSync(path);expect(inspect.prepare('SELECT COUNT(*) AS n FROM source_tombstones').get()?.n).toBe(0);inspect.close();
  });
  it('revokes old mic epochs on takeover and pause',()=>{
    const first=storage.repository.acquireCapture(scope,'s1','browser1');
    expect(()=>storage.repository.acquireCapture(scope,'s1','browser2')).toThrow(/Another browser/);
    const second=storage.repository.acquireCapture(scope,'s1','browser2',true);
    expect(storage.repository.validateCapture(scope,'s1','browser1',first.epoch)).toBe(false);
    expect(storage.repository.pauseCapture(scope,'browser1',first.epoch)).toBe(false);
    expect(storage.repository.pauseCapture(scope,'browser2',second.epoch)).toBe(true);
    expect(storage.repository.validateCapture(scope,'s1','browser2',second.epoch)).toBe(false);
  });
  it('encrypts token bytes, hashes sessions, preserves OBS on owner logout, rejects wrong key',()=>{
    const secret='a-token-that-must-never-be-plaintext';storage.tokenVault!.put(scope,'twitch',{accessToken:secret});
    expect(storage.tokenVault!.get(scope,'twitch')).toEqual({accessToken:secret});
    const owner=storage.sessions.issue(scope,'actor1','owner'),overlay=storage.sessions.issue(scope,'actor1','overlay');
    expect(storage.sessions.verify(scope,owner,'owner')).not.toBeNull();
    expect(storage.sessions.verify({...scope,runId:'demo'},owner,'owner')).toBeNull();
    storage.sessions.logout(scope,owner);expect(storage.sessions.verify(scope,owner,'owner')).toBeNull();expect(storage.sessions.verify(scope,overlay,'overlay')).not.toBeNull();
    expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);expect(readFileSync(path).includes(Buffer.from(overlay))).toBe(false);
    expect(()=>createStorage({path,encryptionKey:Buffer.alloc(32,8)})).toThrow(/cannot be decrypted/);
    now+=7*86400000;expect(storage.sessions.verify(scope,overlay,'overlay')).toBeNull();
    const fresh=storage.sessions.issue(scope,'actor1','owner');storage.tokenVault!.disconnect(scope);expect(storage.sessions.verify(scope,fresh,'owner')).toBeNull();expect(storage.tokenVault!.get(scope,'twitch')).toBeNull();
  });
  it('persists paid-work reservations and prevents replay or budget overspend',()=>{
    expect(()=>storage.budget.reserve('request1',100,'live')).toThrow(/disabled/);
    storage.budget.setPaidEnabled(true);expect(()=>storage.budget.reserve('demo',100,'demo')).toThrow(/Replay/);
    expect(storage.budget.reserve('request1',4_000_000,'live')).toBe(true);expect(storage.budget.reserve('request1',4_000_000,'live')).toBe(true);
    expect(storage.budget.reserve('request2',600_000,'live')).toBe(false);
    storage.close();storage=createStorage({path,now:()=>now,encryptionKey:key});expect(storage.budget.status().usedMicroUsd).toBe(4_000_000);
    storage.budget.settle('request1',3_000_000);expect(storage.budget.reserve('request2',1_500_000,'live')).toBe(true);
    expect(storage.budget.reserve('request3',1,'live')).toBe(false);expect(()=>storage.budget.settle('request2',2_000_000)).toThrow(/upper bound/);
  });
  it('keeps publication sequences stable across retries and paginates evidence',()=>{
    const work={sessionId:'s1',kind:'publish',businessKey:'publish1',payload:{revision:1}};
    expect(storage.repository.preparePublication(scope,work)).toEqual(storage.repository.preparePublication(scope,work));
    expect(storage.repository.preparePublication(scope,{...work,businessKey:'publish2'}).publishSeq).toBe(2);
    for(let i=0;i<3;i++) storage.repository.ingest(event(`page${i}`),{sources:[{...source(`page-source${i}`),startMs:i*100,endMs:i*100+50}]});
    const first=storage.repository.listSources(scope,'s1',{limit:2});expect(first).toHaveLength(2);
    const last=first[1]!;expect(storage.repository.listSources(scope,'s1',{cursor:{startMs:last.startMs,id:last.id},limit:2})).toHaveLength(1);
  });
});
