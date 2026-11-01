import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createStorage} from '../../src/server/storage/index.js';
import type {Source} from '../../src/shared/contracts/index.js';
const scope={channelId:'channel',runId:'live'},at=Date.parse('2026-11-02T00:00:00Z');
const fixtures:{dir:string;store:ReturnType<typeof createStorage>}[]=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.close();if(!resolve(f.dir).startsWith(resolve(tmpdir())+sep))throw Error('Unsafe cleanup');rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'previously-export-work-')),path=join(dir,'state.sqlite'),store=createStorage({path,now:()=>at});fixtures.push({dir,store});const r=store.repository;r.ensureChannel(scope,'synthetic');r.createSession(scope,{id:'session',startedAt:new Date(at).toISOString()});const source:Source={...scope,id:'source',sessionId:'session',revision:1,kind:'speech',startMs:0,endMs:100,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'Original source stays available after withdrawing its reviewed export.',status:'active',externalMessageId:null,moderation:'allowed'};r.ingest({...scope,schemaVersion:1,eventId:'source-event',externalId:'source-event',origin:'owner',kind:'speech',occurredAt:new Date(at).toISOString(),receivedAt:new Date(at).toISOString(),sessionId:'session',sessionOffsetMs:100,payload:null},{sources:[source]});for(const id of ['chapter','export-a','export-b'])r.saveEntity(scope,{id,sessionId:'session',kind:id==='chapter'?'chapter':'export',body:{title:id},refs:[{id:'source',revision:1}]});return {r,path};}
function queue(f:ReturnType<typeof fixture>,id='export-a'){return f.r.preparePublication(scope,{id:`publish-${id}`,sessionId:'session',kind:'export_manifest',businessKey:`recording-publish:${id}:1`,payload:{recordingExportId:id,manifest:{id}},dependencyRefs:[{id:'source',revision:1}]});}
function freeze(f:ReturnType<typeof fixture>,lease:NonNullable<ReturnType<ReturnType<typeof createStorage>['repository']['claimOutbox']>>){const body=JSON.stringify({manifest:{id:'export-a'},privacyRevision:0}),bodyHash=createHash('sha256').update(body).digest('hex');f.r.freezePublication(scope,lease.id,lease.leaseToken,{body,bodyHash});return bodyHash;}

describe('managed export publication identity and withdrawal',()=>{
  it('does not report an unpublished manifest acknowledged merely because a later unrelated operation was acknowledged',()=>{
    const f=fixture(),pending=queue(f);const other=f.r.preparePublication(scope,{sessionId:'session',kind:'publish',businessKey:'other-story',payload:{}}),lease=f.r.claimOutbox(scope,{kinds:['publish']})!;const hash=freeze(f,lease);f.r.finishOutbox(scope,lease.id,lease.leaseToken,'done');f.r.acknowledgePublication(scope,other.publishSeq,hash);
    expect(f.r.getPublicationState(scope).ackSeq).toBeGreaterThan(pending.publishSeq);expect(f.r.getPublicationWork(scope,pending.id)).toMatchObject({state:'queued',publishSeq:pending.publishSeq,acknowledged:false,frozenHash:null});expect(f.r.getPublicationWork(scope,other.id)).toMatchObject({state:'done',publishSeq:other.publishSeq,acknowledged:true,frozenHash:hash});expect(f.r.getPublicationWork({...scope,runId:'replay'},other.id)).toBeNull();
  });
  it('withdraws one export atomically while preserving source/chapter content, session epoch and unrelated jobs',()=>{
    const f=fixture(),first=queue(f),second=queue(f,'export-b');f.r.enqueueJob(scope,{sessionId:'session',kind:'story',businessKey:'story-job',payload:{text:'Pending supported story'},dependencyRefs:[{id:'source',revision:1}]});
    const lease=f.r.claimOutbox(scope,{kinds:['export_manifest']})!;expect(lease.id).toBe(first.id);freeze(f,lease);
    const receipt=f.r.revokeExport(scope,'export-a','withdraw-1',{publicationId:first.id});expect(receipt.publishSeq).toBeGreaterThan(second.publishSeq);
    expect(f.r.getEntity(scope,'export-a')).toMatchObject({status:'hidden',body:null});expect(f.r.getEntity(scope,'export-b')?.status).toBe('active');expect(f.r.getEntity(scope,'chapter')?.body).toEqual({title:'chapter'});expect(f.r.getSource(scope,'source')?.text).toContain('Original source stays');expect(f.r.getSession(scope,'session').privacyEpoch).toBe(0);expect(f.r.pendingJobCount(scope,'session',['story'])).toBe(1);
    expect(f.r.getPublicationWork(scope,first.id)).toMatchObject({state:'cancelled',frozenHash:null,acknowledged:false});expect(f.r.getPublicationWork(scope,second.id)?.state).toBe('queued');expect(f.r.finishOutbox(scope,lease.id,lease.leaseToken,'done')).toBe(false);
    const retract=f.r.claimOutbox(scope)!;expect(retract.id).toBe(receipt.id);expect(retract.payload).toEqual({exportOnly:true,affectedIds:['export-a'],affectedSessionIds:[]});expect(f.r.getPublicationState(scope)).toMatchObject({privacyRevision:1,pendingPrivacy:true});
    expect(f.r.revokeExport(scope,'export-a','withdraw-1',{publicationId:first.id})).toEqual(receipt);expect(f.r.revokeExport(scope,'export-a','withdraw-retry-pending',{publicationId:first.id})).toEqual(receipt);expect(f.r.getPublicationState(scope).privacyRevision).toBe(1);
  });
  it('rejects a publication belonging to a different export without partially hiding or cancelling either',()=>{
    const f=fixture(),first=queue(f),second=queue(f,'export-b');expect(()=>f.r.revokeExport(scope,'export-a','wrong-work',{publicationId:second.id})).toThrow(/does not belong/);expect(f.r.getEntity(scope,'export-a')?.status).toBe('active');expect(f.r.getPublicationWork(scope,first.id)?.state).toBe('queued');expect(f.r.getPublicationState(scope).privacyRevision).toBe(0);
  });
  it('rolls back the hide and privacy state when the priority retract cannot be saved',()=>{
    const f=fixture(),first=queue(f);const db=new DatabaseSync(f.path);try{db.exec("CREATE TRIGGER fail_export_retract BEFORE INSERT ON outbox WHEN NEW.kind='retract' BEGIN SELECT RAISE(ABORT,'injected'); END;");}finally{db.close();}
    expect(()=>f.r.revokeExport(scope,'export-a','disk-failure',{publicationId:first.id})).toThrow();expect(f.r.getEntity(scope,'export-a')?.status).toBe('active');expect(f.r.getPublicationWork(scope,first.id)?.state).toBe('queued');expect(f.r.getPublicationState(scope)).toMatchObject({privacyRevision:0,pendingPrivacy:false});
  });
  it('allows an explicit fresh retry after terminal failure or a later privacy epoch while preserving same-key idempotency',()=>{
    const f=fixture(),publication=queue(f),first=f.r.revokeExport(scope,'export-a','attempt-1',{publicationId:publication.id});const failed=f.r.claimOutbox(scope,{kinds:['retract']})!;f.r.finishOutbox(scope,failed.id,failed.leaseToken,'failed');
    expect(f.r.revokeExport(scope,'export-a','attempt-1',{publicationId:publication.id})).toEqual(first);
    const retry=f.r.revokeExport(scope,'export-a','attempt-2',{publicationId:publication.id});expect(retry.id).not.toBe(first.id);expect(retry.publishSeq).toBeGreaterThan(first.publishSeq);
    f.r.invalidate(scope,{kind:'message',sessionId:'session',externalMessageId:'unseen'},{idempotencyKey:'later-privacy',reason:'privacy'});expect(f.r.getPublicationWork(scope,retry.id)?.state).toBe('cancelled');
    const current=f.r.revokeExport(scope,'export-a','attempt-3',{publicationId:publication.id});expect(current.publishSeq).toBeGreaterThan(retry.publishSeq);expect(f.r.getPublicationWork(scope,current.id)?.privacyEpoch).toBe(1);expect(f.r.getSession(scope,'session').privacyEpoch).toBe(1);
  });
});
