import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createStorage} from '../../src/server/storage/index.js';
import type {EntityHistoryCursor} from '../../src/server/storage/index.js';
import type {Source} from '../../src/shared/contracts/index.js';
const scope={channelId:'history-channel',runId:'live'},start='2026-11-02T00:00:00.000Z';
const resources:{store:ReturnType<typeof createStorage>;path:string;dir:string}[]=[];
afterEach(()=>{for(const f of resources.splice(0)){f.store.close();if(!resolve(f.dir).startsWith(resolve(tmpdir())+sep))throw Error('Unsafe cleanup');rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'previously-history-')),path=join(dir,'state.sqlite'),store=createStorage({path,now:()=>Date.parse(start)+100000});resources.push({store,path,dir});store.repository.ensureChannel(scope,'synthetic');store.repository.createSession(scope,{id:'session',startedAt:start});store.repository.createSession(scope,{id:'other-session',startedAt:start});return {store,path,r:store.repository};}
function source(f:ReturnType<typeof fixture>,id='source',extra:Partial<Source>={}){const value:Source={...scope,id,sessionId:'session',revision:1,kind:'speech',startMs:100,endMs:200,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'Private source text must not be hydrated by history.',status:'active',externalMessageId:null,moderation:'allowed',...extra};f.r.ingest({...scope,schemaVersion:1,eventId:`event-${id}`,externalId:id,origin:'owner',kind:'speech.transcribed',occurredAt:start,receivedAt:start,sessionId:value.sessionId,sessionOffsetMs:200,payload:null},{sources:[value]});return value;}
function entity(f:ReturnType<typeof fixture>,id:string,kind:'chapter'|'lore'|'claim'|'presentation'='chapter',refs=[{id:'source',revision:1}],body:unknown={id,title:id},startMs=100){f.r.saveEntity(scope,{id,sessionId:'session',kind,refs,body,startMs,endMs:200});}

describe('bounded historical entity graph',()=>{
  it('pages roots by time/id beyond the active lore cap without returning source transcript text',()=>{
    const f=fixture();source(f);
    for(let i=0;i<71;i++)entity(f,`lore-${String(i).padStart(3,'0')}`,'lore',undefined,{term:`term-${i}`,explanation:'Approved authored explanation'},i%2?100:200);
    const ids:string[]=[];let cursor:EntityHistoryCursor|undefined;
    do{const page=f.r.listEntityHistory(scope,'session',{kind:'lore',limit:20,cursor});ids.push(...page.items.map(item=>item.id));cursor=page.nextCursor??undefined;}while(cursor);
    expect(ids).toHaveLength(71);expect(new Set(ids).size).toBe(71);expect(ids[0]).toBe('lore-070');expect(ids.at(-1)).toBe('lore-001');
    const graph=f.r.getEntityGraph(scope,'session','lore-000')!;expect(graph.root.id).toBe('lore-000');expect(graph.sources).toHaveLength(1);expect(graph.sources[0]?.text).toBeNull();expect(JSON.stringify(graph)).not.toContain('Private source text');
    expect(f.r.getEntityGraph(scope,'other-session','lore-000')).toBeNull();expect(()=>f.r.getEntityGraph({...scope,runId:'replay'},'session','lore-000')).toThrow();
  });
  it('advances the raw cursor across invalid roots while checking authoritative source revisions',()=>{
    const f=fixture();source(f);source(f,'old');entity(f,'newest-invalid','chapter',[{id:'old',revision:1}],{title:'Stale body'},300);entity(f,'older-valid','chapter',undefined,{title:'Safe body'},100);
    const db=new DatabaseSync(f.path);try{db.prepare('UPDATE sources SET revision=2 WHERE id=?').run('old');}finally{db.close();}
    const first=f.r.listEntityHistory(scope,'session',{kind:'chapter',limit:1});expect(first.items).toEqual([]);expect(first.nextCursor).toEqual({startMs:300,id:'newest-invalid'});
    const second=f.r.listEntityHistory(scope,'session',{kind:'chapter',limit:1,cursor:first.nextCursor!});expect(second.items.map(item=>item.id)).toEqual(['older-valid']);
  });
  it('honors durable bans, chat-clear policy, blocked terms and cross-session source privacy',()=>{
    const f=fixture();source(f,'chat',{kind:'chat',actorId:'actor',externalMessageId:'message'});source(f,'earlier',{sessionId:'other-session'});entity(f,'chat-root','chapter',[{id:'chat',revision:1}]);entity(f,'old-root','chapter',[{id:'earlier',revision:1}]);entity(f,'term-root','lore',[],{term:'BRICK',aliases:['brick']});
    expect(f.r.getEntityGraph(scope,'session','chat-root')).not.toBeNull();f.r.controlPut(scope,'chat-clear:session',200);expect(f.r.getEntityGraph(scope,'session','chat-root')).toBeNull();f.r.controlDelete(scope,'chat-clear:session');
    const db=new DatabaseSync(f.path);try{db.prepare('INSERT INTO channel_bans VALUES(?,?,?)').run(scope.channelId,scope.runId,'actor');}finally{db.close();}
    expect(f.r.getEntityGraph(scope,'session','chat-root')).toBeNull();f.r.invalidate(scope,{kind:'source',sessionId:'other-session',id:'earlier'},{idempotencyKey:'cross-session-forget',reason:'privacy'});expect(f.r.getEntityGraph(scope,'session','old-root')).toBeNull();
    f.r.invalidate(scope,{kind:'term',sessionId:'session',term:'brick'},{idempotencyKey:'term-forget',reason:'privacy'});expect(f.r.getEntityGraph(scope,'session','term-root')).toBeNull();
  });
  it('includes both current lore presentations with their complete active dependency closure',()=>{
    const f=fixture();source(f);entity(f,'lore','lore',undefined,{term:'brick',explanation:'Approved origin'});
    for(const language of ['en','ru'])entity(f,`view-${language}`,'presentation',[{id:'lore',revision:1},{id:'source',revision:1}],{kind:'lore',entityId:'lore',entityRevision:1,language,term:'brick'});
    const graph=f.r.getEntityGraph(scope,'session','lore')!;expect(graph.entities.map(node=>node.id)).toEqual(expect.arrayContaining(['lore','view-en','view-ru']));expect(graph.sources).toHaveLength(1);
    f.r.invalidate(scope,{kind:'source',sessionId:'session',id:'source'},{idempotencyKey:'all-languages-forget',reason:'privacy'});expect(f.r.getEntityGraph(scope,'session','lore')).toBeNull();
  });
  it('includes current-owner candidates and current-state ancestry but never old-owner or old-epoch pending text',()=>{
    const f=fixture();source(f);entity(f,'chapter');entity(f,'current','claim');
    const db=new DatabaseSync(f.path);try{
      for(const [id,language,ownerRevision,privacyEpoch,status] of [['english','en',0,0,'published'],['russian','ru',0,0,'published'],['old-owner','en',1,0,'published'],['old-epoch','en',0,99,'pending']] as const){
        entity(f,id,'presentation');const body={id,entityId:'chapter',revision:1,ownerRevision,privacyEpoch,inputRefs:[{id:'source',revision:1}],eligibleAtMs:0,currentNodeId:'current',chapter:{id:'chapter',revision:1,sessionId:'session'},language,status,safety:{moderation:'allowed',pii:'allowed',checkedAt:start,reason:null}};
        db.prepare('INSERT INTO publication_candidates(channel_id,run_id,id,session_id,entity_id,revision,owner_revision,privacy_epoch,eligible_at_ms,status,safe,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(scope.channelId,scope.runId,id,'session','chapter',1,ownerRevision,privacyEpoch,0,status,1,JSON.stringify(body));
      }
    }finally{db.close();}
    const graph=f.r.getEntityGraph(scope,'session','chapter')!;expect(graph.candidates.map(value=>value.id).sort()).toEqual(['english','russian']);expect(graph.entities.map(value=>value.id)).toEqual(expect.arrayContaining(['chapter','english','russian','current']));expect(graph.entities.map(value=>value.id)).not.toContain('old-owner');
    expect(f.r.findGenerationHistory(scope,'session',{text:''})).toEqual([]);f.r.pinEntity(scope,'chapter',1,true);expect(f.r.findGenerationHistory(scope,'session',{text:''})).toEqual(['chapter']);
  });
  it('retrieves only exact mentioned verified lore through normalized aliases and never guesses a substring topic',()=>{
    const f=fixture();source(f);const safe={moderation:'allowed',pii:'allowed',checkedAt:start,reason:null};
    entity(f,'old-lore','lore',undefined,{term:'ＢＲＩＣＫ',aliases:['Cafe\u0301'],status:'confirmed',originKind:'spoken',safety:safe});
    for(let i=0;i<60;i++)entity(f,`later-${i}`,'lore',undefined,{term:`unmentioned-${i}`,status:'confirmed',originKind:'spoken',safety:safe},300+i);
    expect(f.r.findGenerationHistory(scope,'session',{text:'Brickwork and cafés are unrelated.'})).toEqual([]);
    expect(f.r.findGenerationHistory(scope,'session',{text:'We mentioned the CAFÉ again.'})).toEqual(['old-lore']);
    entity(f,'regex-lore','lore',undefined,{term:'c++',aliases:[],status:'confirmed',originKind:'owner_confirmed',safety:safe});expect(f.r.findGenerationHistory(scope,'session',{text:'I said C++.'})).toEqual(['regex-lore']);
    entity(f,'unverified','lore',undefined,{term:'unknown',status:'held',originKind:'unknown',safety:safe});expect(f.r.findGenerationHistory(scope,'session',{text:'Unknown.'})).toEqual([]);
    f.r.invalidate(scope,{kind:'term',sessionId:'session',term:'brick'},{idempotencyKey:'generation-term-block',reason:'privacy'});expect(f.r.findGenerationHistory(scope,'session',{text:'CAFÉ and brick.'})).toEqual([]);
    expect(()=>f.r.findGenerationHistory(scope,'session',{text:'x'.repeat(12001)})).toThrow(/exceeds its limit/);
  });
  it('caps generation lore selection at four roots while preserving an explicit smaller retrieval limit',()=>{
    const f=fixture();source(f);for(let i=0;i<7;i++)entity(f,`mentioned-${i}`,'lore',undefined,{term:`phrase${i}`,status:'published',originKind:'spoken',safety:{moderation:'allowed',pii:'allowed',checkedAt:start,reason:null}},300+i);
    const text=Array.from({length:7},(_,i)=>`phrase${i}`).join(' ');expect(f.r.findGenerationHistory(scope,'session',{text})).toHaveLength(4);expect(f.r.findGenerationHistory(scope,'session',{text,limit:2})).toHaveLength(2);
    f.r.invalidate(scope,{kind:'source',sessionId:'session',id:'source'},{idempotencyKey:'generation-source-forget',reason:'privacy'});expect(f.r.findGenerationHistory(scope,'session',{text})).toEqual([]);
  });
  it('fails explicitly instead of silently truncating a dependency closure over the cap',()=>{
    const f=fixture();source(f);const refs=[];
    for(let i=0;i<512;i++){entity(f,`claim-${i}`,'claim',[]);refs.push({id:`claim-${i}`,revision:1});}
    entity(f,'oversized','chapter',refs);expect(()=>f.r.getEntityGraph(scope,'session','oversized')).toThrow(/exceeds its limit/);
  });
});
