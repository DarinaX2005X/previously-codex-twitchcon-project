import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {RuntimeOwnerService} from '../../src/server/runtime/owner-service.js';
import type {Source,StoryPatch} from '../../src/shared/contracts/index.js';

const scope={channelId:'reliability',runId:'live'},epoch=Date.parse('2026-11-02T00:00:00Z');
const stores:ReturnType<typeof createStorage>[]=[],dirs:string[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const dir of dirs.splice(0)){if(!resolve(dir).startsWith(resolve(tmpdir())+sep))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}});
function fixture(maxBytes?:number){let now=epoch+10000;const dir=mkdtempSync(join(tmpdir(),'previously-reliability-'));dirs.push(dir);const path=join(dir,'state.sqlite'),store=createStorage({path,now:()=>now,maxBytes});stores.push(store);store.repository.ensureChannel(scope,'synthetic');store.repository.createSession(scope,{id:'session',startedAt:new Date(epoch).toISOString()});return {store,path,clock:{now:()=>now,iso:()=>new Date(now).toISOString()},set(ms:number){now=epoch+ms;}};}
function source(id:string,text='Synthetic source'):Source{return {...scope,id,sessionId:'session',revision:1,kind:'speech',startMs:9000,endMs:10000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text,status:'active',externalMessageId:null,moderation:'allowed'};}
function ingest(f:ReturnType<typeof fixture>,value:Source){return f.store.repository.ingest({...scope,schemaVersion:1,eventId:`event:${value.id}`,externalId:value.id,origin:'owner',kind:'speech.transcribed',occurredAt:f.clock.iso(),receivedAt:f.clock.iso(),sessionId:'session',sessionOffsetMs:value.endMs,payload:null},{sources:[value]});}

describe('cross-boundary reliability under adverse conditions',()=>{
  it('pages all older sources through the owner service after the 500-source hot window and preserves early deletion across restart',()=>{
    const f=fixture();for(let i=0;i<605;i++)ingest(f,{...source(`history-${String(i).padStart(4,'0')}`),startMs:i*1000,endMs:i*1000+100});
    const updates=new RevisionStream();const engine=new StoryEngine({scope,channel:{id:scope.channelId,login:'synthetic',displayName:'Synthetic'},storage:f.store,clock:f.clock,updates,safety:new SafetyService({classify:async()=>({decision:'review',spans:[]})},{moderate:async()=> 'unavailable'}),story:{propose:async()=>{throw Error('No provider');}}});
    try{const service=new RuntimeOwnerService(engine),principal={...scope,role:'owner' as const,actorId:'owner',sessionId:'owner-session',expiresAtMs:epoch+1000000};
      expect(engine.state('session').sources).toHaveLength(500);expect(engine.state('session').sources.some(s=>s.id==='history-0000')).toBe(false);
      const ids:string[]=[];let cursor:string|undefined;let pages=0;
      do{const page=service.listSources(principal,{sessionId:'session',limit:100,cursor});ids.push(...page.items.map(s=>s.id));cursor=page.nextCursor??undefined;pages++;}while(cursor);
      expect(pages).toBe(7);expect(ids).toHaveLength(605);expect(new Set(ids).size).toBe(605);expect(ids[0]).toBe('history-0000');
      f.store.repository.invalidate(scope,{kind:'source',sessionId:'session',id:'history-0000'},{idempotencyKey:'old-source-forget',reason:'privacy'});f.store.close();
      const reopened=createStorage({path:f.path});stores.push(reopened);expect(reopened.repository.listSources(scope,'session',{limit:1})[0]).toMatchObject({id:'history-0000',text:null,status:'deleted'});
    }finally{updates.close();}
  });
  it('privacy remains committable at a full work queue and cancels both leased and queued output before recovery',()=>{
    const f=fixture(),r=f.store.repository;ingest(f,source('private'));const refs=[{id:'private',revision:1}];
    for(let i=0;i<1000;i++)r.enqueueOutbox(scope,{sessionId:'session',kind:i%2?'chat':'clip',businessKey:`saturated-${i}`,payload:{text:'synthetic private content'},dependencyRefs:refs});
    expect(()=>r.enqueueOutbox(scope,{sessionId:'session',kind:'chat',businessKey:'overflow',payload:{}})).toThrow(/full/);
    const running=r.claimOutbox(scope,{kinds:['clip']})!;expect(running).not.toBeNull();
    const receipt=r.invalidate(scope,{kind:'source',sessionId:'session',id:'private'},{idempotencyKey:'forget-at-cap',reason:'privacy'});
    expect(receipt.privacyEpoch).toBe(1);expect(r.getSource(scope,'private')?.text).toBeNull();
    f.set(60000);expect(r.claimOutbox(scope,{kinds:['chat','clip']})).toBeNull();
    expect(r.claimOutbox(scope)?.kind).toBe('retract');
    expect(r.recordRemoteArtifact(scope,running.id,'late-created-clip')).toBe(true);
    const db=new DatabaseSync(f.path);try{expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind IN ('chat','clip') AND payload IS NOT NULL").get()?.n).toBe(0);expect(JSON.parse(String(db.prepare('SELECT outcome FROM outbox WHERE id=?').get(running.id)?.outcome))).toMatchObject({cleanupOnly:true,clipId:'late-created-clip'});}finally{db.close();}
  });
  it('a full SQLite database rejects new ingress atomically and preserves readable previous evidence after restart',()=>{
    const f=fixture(450560);ingest(f,source('first','Previously accepted safe source'));let failure:unknown,accepted=0;
    for(let i=0;i<100;i++){try{ingest(f,source(`fill-${i}`,'Synthetic filler '.repeat(500)));accepted++;}catch(error){failure=error;break;}}
    expect(failure).toBeDefined();expect(accepted).toBeLessThan(100);expect(statSync(f.path).size).toBeLessThanOrEqual(450560);
    expect(f.store.repository.getSource(scope,'first')?.text).toBe('Previously accepted safe source');
    const db=new DatabaseSync(f.path);try{expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE id=?").get(`event:fill-${accepted}`)?.n).toBe(0);}finally{db.close();}
    f.store.close();const restarted=createStorage({path:f.path,maxBytes:450560});stores.push(restarted);expect(restarted.repository.getSource(scope,'first')?.text).toBe('Previously accepted safe source');
  });
  it('Forget during an actual engine model await prevents late output and translations from reaching durable publication',async()=>{
    const f=fixture();f.store.repository.updateSettings(scope,0,{listeningPaused:false});
    let release!:(value:any)=>void;let presentationCalls=0;
    const story={propose:async()=>new Promise<any>(resolve=>{release=resolve;}),present:async()=>{presentationCalls++;throw Error('Late translation must not run');}};
    const updates=new RevisionStream();const engine=new StoryEngine({scope,channel:{id:scope.channelId,login:'synthetic',displayName:'Synthetic'},storage:f.store,clock:f.clock,updates,safety:new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'}),story});
    try{const state=await engine.dispatch('session',{type:'source',source:source('private','Private synthetic goal')});const ticket=state.pendingGeneration!.ticket;
      const job=f.store.repository.claimJob(scope,{kinds:['story']})!;expect(job).not.toBeNull();
      const executing=engine.executeStory(job,new AbortController().signal);for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setTimeout(resolve,0));expect(release).toBeTypeOf('function');
      await engine.dispatch('session',{type:'privacy',target:{kind:'source',sessionId:'session',id:'private'}});
      const patch:StoryPatch={sessionId:'session',baseRevision:ticket.baseEntityRevision,action:'new_chapter',title:'Private synthetic goal',claims:[{id:'goal',text:'Private synthetic goal',role:'goal',support:[{id:'private',revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
      release({value:patch,model:'synthetic',requestId:'late',usage:{chargedMicroUsd:0}});await executing;f.set(100000);await engine.tick();
      expect(presentationCalls).toBe(0);expect(engine.state('session').published?.chapters??[]).toHaveLength(0);expect(f.store.repository.getSource(scope,'private')?.text).toBeNull();expect(JSON.stringify(f.store.repository.getDomainCheckpoint(scope,'session'))).not.toContain('Private synthetic goal');
    }finally{updates.close();}
  });
});

