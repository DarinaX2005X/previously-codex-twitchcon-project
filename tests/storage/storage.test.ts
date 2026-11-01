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
    for(let i=0;i<3;i++) storage.repository.enqueueJob(scope,{sessionId:'s1',kind:'stt',businessKey:`stt${i}`,payload:{}});
    expect(()=>storage.repository.enqueueJob(scope,{sessionId:'s1',kind:'stt',businessKey:'overflow',payload:{}})).toThrow(/full/);
    expect(storage.repository.claimJob(scope)).not.toBeNull();expect(storage.repository.claimJob(scope)).not.toBeNull();expect(storage.repository.claimJob(scope)).toBeNull();
    for(let i=3;i<5;i++) storage.repository.enqueueJob(scope,{sessionId:'s1',kind:'stt',businessKey:`stt${i}`,payload:{}});
    expect(()=>storage.repository.enqueueJob(scope,{sessionId:'s1',kind:'stt',businessKey:'overflow2',payload:{}})).toThrow(/full/);
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
    storage.repository.saveEntity(scope,{id:'ru',sessionId:'s1',kind:'presentation',body:{text:'private evidence'},refs:[{id:'chapter1',revision:3}]});
    storage.repository.saveEntity(scope,{id:'media1',sessionId:'s1',kind:'media',body:{clipId:'clip1',path:'private evidence'},refs:[],startMs:50,endMs:300});
    storage.repository.enqueueOutbox(scope,{sessionId:'s1',kind:'chat',businessKey:'pending-chat',payload:{text:'private evidence'},dependencyRefs:[{id:'chapter1',revision:3}]});
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
    expect(storage.budget.reserve('request3',1,'live')).toBe(false);storage.budget.settle('request2',2_000_000);
    expect(storage.budget.status()).toMatchObject({enabled:false,committedMicroUsd:5_000_000,reservedMicroUsd:0,usedMicroUsd:5_000_000});
    expect(()=>storage.budget.reserve('after-overrun',1,'live')).toThrow(/disabled/);
  });
  it('keeps publication sequences stable across retries and paginates evidence',()=>{
    const work={sessionId:'s1',kind:'publish',businessKey:'publish1',payload:{revision:1}};
    expect(storage.repository.preparePublication(scope,work)).toEqual(storage.repository.preparePublication(scope,work));
    expect(storage.repository.preparePublication(scope,{...work,businessKey:'publish2'}).publishSeq).toBe(2);
    for(let i=0;i<3;i++) storage.repository.ingest(event(`page${i}`),{sources:[{...source(`page-source${i}`),startMs:i*100,endMs:i*100+50}]});
    const first=storage.repository.listSources(scope,'s1',{limit:2});expect(first).toHaveLength(2);
    const last=first[1]!;expect(storage.repository.listSources(scope,'s1',{cursor:{startMs:last.startMs,id:last.id},limit:2})).toHaveLength(1);
  });
  it('invalidates derived memory and effects in a later session',()=>{
    seed();storage.repository.createSession(scope,{id:'s2',startedAt:'2026-11-02T02:00:00Z'});
    storage.repository.saveEntity(scope,{id:'later-lore',sessionId:'s2',kind:'lore',body:{text:'private evidence'},refs:[{id:'source1',revision:1}]});
    storage.repository.enqueueOutbox(scope,{sessionId:'s2',kind:'chat',businessKey:'later-chat',payload:{text:'private evidence'},dependencyRefs:[{id:'later-lore',revision:1}]});
    storage.repository.invalidate(scope,{kind:'source',sessionId:'s1',id:'source1'},{idempotencyKey:'cross-session',reason:'privacy'});
    expect(storage.repository.getEntity(scope,'later-lore')?.body).toBeNull();expect(storage.repository.getSession(scope,'s2').privacyEpoch).toBe(1);
    expect(storage.repository.claimOutbox(scope,{kinds:['chat']})).toBeNull();
  });
  it('owner edits invalidate cached presentations and require fresh safety before immediate publication',()=>{
    seed();storage.repository.saveEntity(scope,{id:'presentation',sessionId:'s1',kind:'presentation',body:{text:'old'},refs:[{id:'chapter1',revision:1}]});
    storage.repository.editEntity(scope,'chapter1',1,{title:'owner corrected'});
    expect(storage.repository.getEntity(scope,'presentation')?.body).toBeNull();
    const id=storage.repository.registerOwnerCandidate(scope,'chapter1',1,{title:'owner corrected'},[{id:'source1',revision:1}]);
    expect(storage.repository.publishEligible(scope,'chapter1')).toBeNull();
    storage.repository.markCandidateSafe(scope,id,{moderation:'allowed',pii:'allowed'});
    expect(storage.repository.publishEligible(scope,'chapter1')?.body).toEqual({title:'owner corrected'});
    const first=storage.repository.claimOutbox(scope)!;expect(first.kind).toBe('retract');expect(first.publishSeq).toBeGreaterThan(0);
    storage.repository.invalidate(scope,{kind:'source',sessionId:'s1',id:'source1'},{idempotencyKey:'erase-edited',reason:'privacy'});
    expect(storage.repository.getPublished(scope,'chapter1')).toBeNull();
  });
  it('does not automatically resend external clip work after a process interruption',()=>{
    storage.repository.enqueueOutbox(scope,{sessionId:'s1',kind:'clip',businessKey:'interrupted-clip',payload:{}});
    const lease=storage.repository.claimOutbox(scope)!;now+=30001;
    expect(storage.repository.claimOutbox(scope)).toBeNull();
    expect(storage.repository.recordRemoteArtifact(scope,lease.id,'known-clip')).toBe(true);
    const check=new DatabaseSync(path);const row=check.prepare('SELECT state,outcome FROM outbox WHERE id=?').get(lease.id)!;
    expect(row.state).toBe('unknown_outcome');expect(JSON.parse(String(row.outcome))).toMatchObject({cleanupOnly:true,clipId:'known-clip'});check.close();
  });
  it('blocks normalized lore terms without erasing speech or future chat mentions',()=>{
    storage.repository.ingest(event(),{sources:[source('source1','The Funny Café phrase appeared')]});
    storage.repository.saveEntity(scope,{id:'lore1',sessionId:'s1',kind:'lore',body:{term:'Funny Café',explanation:'private lore'},refs:[{id:'source1',revision:1}]});
    storage.repository.saveEntity(scope,{id:'lore-view',sessionId:'s1',kind:'presentation',body:{text:'private lore'},refs:[{id:'lore1',revision:1}]});
    const receipt=storage.repository.invalidate(scope,{kind:'term',sessionId:'s1',term:'  ＦＵＮＮＹ  Cafe\u0301  '},{idempotencyKey:'block-term',reason:'block'});
    expect(receipt.hiddenEntityIds).toEqual(expect.arrayContaining(['lore1','lore-view']));
    expect(storage.repository.getSource(scope,'source1')?.text).toBe('The Funny Café phrase appeared');
    expect(storage.repository.isTermBlocked(scope,'s1','FUNNY\nCAFÉ')).toBe(true);
    expect(storage.repository.listBlockedTerms(scope,'s1')).toEqual(['funny café']);
    storage.repository.ingest(event('future'),{sources:[source('future-source','Funny Café is mentioned again')]});
    expect(storage.repository.getSource(scope,'future-source')?.status).toBe('active');
    expect(()=>storage.repository.saveEntity(scope,{id:'revived-lore',sessionId:'s1',kind:'lore',body:{term:'Funny Café'},refs:[]})).toThrow(/blocked/);
    expect(storage.repository.isTermBlocked({...scope,runId:'replay'},'s1','Funny Café')).toBe(false);
  });
  it('updates session lifecycle monotonically and bounds entity queries',()=>{
    seed();storage.repository.updateSession(scope,'s1',{title:'Current title',category:'Development',metadataMaxDependencyEndMs:200,status:'closing',endedAt:'2026-11-02T03:00:00Z'});
    expect(()=>storage.repository.updateSession(scope,'s1',{status:'live'})).toThrow(/cannot be reopened/);
    storage.repository.updateSession(scope,'s1',{status:'finalized',finalizedAt:'2026-11-02T03:04:00Z'});
    expect(storage.repository.getSession(scope,'s1')).toMatchObject({status:'finalized',title:'Current title',category:'Development'});
    expect(storage.repository.listEntities(scope,'s1',{kind:'chapter',status:'active',limit:1})).toHaveLength(1);
    expect(storage.repository.listEntities(scope,'s1',{afterId:'chapter1',limit:1})).toHaveLength(0);
  });
  it('rejects generation registration and legacy commits whose entity belongs to another session',()=>{
    seed();storage.repository.createSession(scope,{id:'s2',startedAt:'2026-11-02T01:00:00Z'});
    storage.repository.saveEntity(scope,{id:'other-chapter',sessionId:'s2',kind:'chapter',body:{title:'s2 original'},refs:[]});
    const t=ticket('cross-session-ticket');
    expect(()=>storage.repository.registerGeneration(t,'other-chapter')).toThrow(/context changed/);
    // A legacy malformed ticket still cannot cross the commit fence.
    const check=new DatabaseSync(path);
    check.prepare("INSERT INTO generation_jobs VALUES(?,?,?,?,?,?,'registered')").run(scope.channelId,scope.runId,t.jobId,t.sessionId,'other-chapter',JSON.stringify(t));
    check.close();
    expect(storage.repository.commitStory(t,patch()).committed).toBe(false);
    expect(storage.repository.getEntity(scope,'other-chapter')?.body).toEqual({title:'s2 original'});
    expect(storage.repository.getEntity(scope,'other-chapter')?.revision).toBe(1);
    const verify=new DatabaseSync(path);expect(verify.prepare('SELECT COUNT(*) AS n FROM publication_candidates').get()?.n).toBe(0);verify.close();
  });
  it('forgets the whole session including unlinked media, raw events and title metadata',()=>{
    seed();storage.repository.updateSession(scope,'s1',{title:'private session title',category:'private session category',metadataMaxDependencyEndMs:200});
    storage.repository.ingest({...event('unlinked-event'),payload:{text:'private unlinked payload'}});
    for(const kind of ['media','presentation','provider_cache','export','playback'] as const) storage.repository.saveEntity(scope,{id:`unlinked-${kind}`,sessionId:'s1',kind,body:{text:`private ${kind}`},refs:[]});
    const lease=storage.repository.acquireCapture(scope,'s1','browser');
    const result=storage.repository.invalidate(scope,{kind:'session',sessionId:'s1'},{idempotencyKey:'whole-session',reason:'privacy'});
    expect(result.hiddenEntityIds).toEqual(expect.arrayContaining(['chapter1','unlinked-media','unlinked-presentation','unlinked-provider_cache','unlinked-export','unlinked-playback']));
    expect(storage.repository.getSession(scope,'s1')).toMatchObject({title:'',category:'',metadataMaxDependencyEndMs:0});
    expect(storage.repository.validateCapture(scope,'s1','browser',lease.epoch)).toBe(false);
    expect(storage.repository.getEntity(scope,'unlinked-media')).toMatchObject({body:null,status:'hidden'});
    expect(storage.repository.getSource(scope,'source1')?.text).toBeNull();
    storage.repository.ingest({...event('late-raw-event'),payload:{text:'late private payload'}});
    storage.repository.ingest(event('late-source-event'),{sources:[source('late-source','late private source')]});
    expect(storage.repository.getSource(scope,'late-source')?.text).toBeNull();
    expect(()=>storage.repository.saveEntity(scope,{id:'late-media',sessionId:'s1',kind:'media',body:{text:'private'},refs:[]})).toThrow(/forgotten/);
    expect(()=>storage.repository.updateSession(scope,'s1',{title:'restored title'})).toThrow(/cannot be restored/);
    const verify=new DatabaseSync(path);
    expect(verify.prepare('SELECT COUNT(*) AS n FROM events WHERE payload IS NOT NULL').get()?.n).toBe(0);
    expect(verify.prepare('SELECT COUNT(*) AS n FROM entities WHERE body IS NOT NULL').get()?.n).toBe(0);verify.close();
    expect(readFileSync(path).includes(Buffer.from('private unlinked payload'))).toBe(false);
    expect(readFileSync(path).includes(Buffer.from('private session title'))).toBe(false);
  });
  it('blocks a lore term across current and future sessions while retaining source mentions',()=>{
    seed();storage.repository.createSession(scope,{id:'s2',startedAt:'2026-11-02T01:00:00Z'});
    for(const sessionId of ['s1','s2']) storage.repository.saveEntity(scope,{id:`brick-${sessionId}`,sessionId,kind:'lore',body:{term:'BRICK'},refs:[]});
    storage.repository.saveEntity(scope,{id:'brick-presentation',sessionId:'s2',kind:'presentation',body:{text:'Brick lore'},refs:[{id:'brick-s2',revision:1}]});
    const result=storage.repository.invalidate(scope,{kind:'term',sessionId:'s1',term:' brick '},{idempotencyKey:'global-block',reason:'block'});
    expect(result.hiddenEntityIds).toEqual(expect.arrayContaining(['brick-s1','brick-s2','brick-presentation']));
    expect(storage.repository.isTermBlocked(scope,'s2','ＢＲＩＣＫ')).toBe(true);
    expect(storage.repository.listBlockedTerms(scope,'s2')).toEqual(['brick']);
    expect(storage.repository.getSource(scope,'source1')?.text).toBe('private evidence');
    storage.repository.createSession(scope,{id:'s3',startedAt:'2026-11-02T02:00:00Z'});
    expect(()=>storage.repository.saveEntity(scope,{id:'brick-s3',sessionId:'s3',kind:'lore',body:{term:'BRICK'},refs:[]})).toThrow(/blocked/);
    expect(storage.repository.isTermBlocked({...scope,runId:'demo'},'s1','brick')).toBe(false);
  });
  it('migrates earlier per-session blocked terms without losing or duplicating them',()=>{
    storage.repository.createSession(scope,{id:'s2',startedAt:'2026-11-02T01:00:00Z'});
    storage.repository.saveEntity(scope,{id:'legacy-s2-lore',sessionId:'s2',kind:'lore',body:{term:'BRICK'},refs:[]});
    storage.close();const previous=new DatabaseSync(path);
    previous.exec(`DROP TABLE blocked_terms; CREATE TABLE blocked_terms(channel_id TEXT,run_id TEXT,session_id TEXT,term TEXT,PRIMARY KEY(channel_id,run_id,session_id,term)); DELETE FROM schema_migrations WHERE version=3;`);
    previous.prepare('INSERT INTO blocked_terms VALUES(?,?,?,?)').run(scope.channelId,scope.runId,'s1','brick');
    previous.prepare('INSERT INTO blocked_terms VALUES(?,?,?,?)').run(scope.channelId,scope.runId,'s2','brick');previous.close();
    storage=createStorage({path,now:()=>now,encryptionKey:key});
    expect(storage.repository.isTermBlocked(scope,'future-session','BRICK')).toBe(true);
    expect(storage.repository.listBlockedTerms(scope,'s1')).toEqual(['brick']);
    expect(storage.repository.getEntity(scope,'legacy-s2-lore')).toMatchObject({body:null,status:'hidden'});
    storage.close();storage=createStorage({path,now:()=>now,encryptionKey:key});
    expect(storage.repository.listBlockedTerms(scope,'s1')).toEqual(['brick']);
  });
  it('pins with a revision fence and atomic publication work without locking model wording',()=>{
    seed();
    expect(storage.repository.pinEntity(scope,'chapter1',1,true)).toBe(true);
    expect(storage.repository.pinEntity(scope,'chapter1',1,false)).toBe(false);
    expect(storage.repository.getEntity(scope,'chapter1')).toMatchObject({revision:2,pinned:true,ownerLocked:false,ownerRevision:0});
    expect(storage.repository.getSession(scope,'s1').publicationRevision).toBe(1);
    const work=storage.repository.claimOutbox(scope)!;expect(work).toMatchObject({kind:'publish',publishSeq:1,payload:{entityId:'chapter1',revision:2,pinned:true}});
    const t=ticket('after-pin',2);storage.repository.registerGeneration(t,'chapter1');expect(storage.repository.commitStory(t,patch(2)).committed).toBe(true);
    expect(storage.repository.getEntity(scope,'chapter1')?.pinned).toBe(true);
    storage.repository.saveEntity(scope,{id:'rollback-pin',sessionId:'s1',kind:'chapter',body:{title:'unchanged'},refs:[]});
    const check=new DatabaseSync(path);check.exec("CREATE TRIGGER fail_pin BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected'); END");check.close();
    expect(()=>storage.repository.pinEntity(scope,'rollback-pin',1,true)).toThrow(/could not be saved/);
    expect(storage.repository.getEntity(scope,'rollback-pin')).toMatchObject({revision:1,pinned:false});
    expect(storage.repository.getSession(scope,'s1').publicationRevision).toBe(1);
  });
  it('commits and publishes previous chapter context while newer self-context drafts remain held',()=>{
    seed();
    const firstTicket={...ticket('self-context-first'),inputRefs:[{id:'source1',revision:1},{id:'chapter1',revision:1}]};
    storage.repository.registerGeneration(firstTicket,'chapter1');const first=storage.repository.commitStory(firstTicket,patch());
    expect(first.committed).toBe(true);storage.repository.markCandidateSafe(scope,first.candidateId!,{moderation:'allowed',pii:'allowed'});
    now+=45000;
    const secondTicket={...ticket('self-context-second',2),inputRefs:[{id:'source1',revision:1},{id:'chapter1',revision:2}]};
    storage.repository.registerGeneration(secondTicket,'chapter1');const second=storage.repository.commitStory(secondTicket,patch(2));
    expect(second.committed).toBe(true);storage.repository.markCandidateSafe(scope,second.candidateId!,{moderation:'allowed',pii:'allowed'});
    now+=30000;
    expect(storage.repository.publishEligible(scope,'chapter1')?.candidateId).toBe(first.candidateId);
    expect(storage.repository.getPublished(scope,'chapter1')).toMatchObject({title:'private evidence'});
    storage.repository.invalidate(scope,{kind:'source',sessionId:'s1',id:'source1'},{idempotencyKey:'self-context-forget',reason:'privacy'});
    expect(storage.repository.getPublished(scope,'chapter1')).toBeNull();
    const check=new DatabaseSync(path);
    expect(check.prepare("SELECT COUNT(*) AS n FROM entities WHERE id LIKE 'context:%' AND body IS NOT NULL").get()?.n).toBe(0);check.close();
  });
  it('reclaims obsolete-epoch candidate slots after an unrelated privacy event',()=>{
    seed();
    for(let i=1;i<=4;i++) {
      const t=ticket(`pending-${i}`,i);storage.repository.registerGeneration(t,'chapter1');expect(storage.repository.commitStory(t,patch(i)).committed).toBe(true);
    }
    storage.repository.invalidate(scope,{kind:'message',sessionId:'s1',externalMessageId:'unrelated-never-seen'},{idempotencyKey:'unrelated-privacy',reason:'privacy'});
    expect(storage.repository.getSource(scope,'source1')?.status).toBe('active');
    const fresh={...ticket('fresh-epoch',5),privacyEpoch:1};storage.repository.registerGeneration(fresh,'chapter1');
    const committed=storage.repository.commitStory(fresh,patch(5));expect(committed.committed).toBe(true);
    storage.repository.markCandidateSafe(scope,committed.candidateId!,{moderation:'allowed',pii:'allowed'});now+=75000;
    expect(storage.repository.publishEligible(scope,'chapter1')?.candidateId).toBe(committed.candidateId);
    const check=new DatabaseSync(path);
    expect(check.prepare("SELECT COUNT(*) AS n FROM publication_candidates WHERE privacy_epoch=0 AND status='pending'").get()?.n).toBe(0);check.close();
  });
});
