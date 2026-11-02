import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';

// AUTHORED DEVELOPMENT FIXTURE. A database written before Unicode case folding, upgraded in place.
const start=Date.parse('2026-11-02T00:00:00Z'),scope={channelId:'channel',runId:'live'};
const directories:string[]=[],resources:{close():void}[]=[];
afterEach(()=>{for(const resource of resources.splice(0).reverse())try{resource.close();}catch{/* Already closed. */}for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function open(path:string,clock:{now:()=>number;iso:()=>string}){
  const storage=createStorage({path,now:clock.now});resources.push(storage);
  const engine=new StoryEngine({scope,channel:{id:'channel',login:'fixture',displayName:'Authored fixture'},storage,clock,updates:new RevisionStream(),
    safety:new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=>'allowed'},clock.now),story:{propose:async()=>{throw new Error('No provider calls');}}});
  return {storage,engine};
}

describe('blocked terms after the case-folding upgrade',()=>{
  it('keeps a pre-upgrade "Straße" block through the next ordinary transition and across sessions',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'previously-terms-'));directories.push(directory);const path=join(directory,'state.sqlite');
    let at=10_000;const clock={now:()=>start+at,iso:()=>new Date(start+at).toISOString()};
    let {storage,engine}=open(path,clock);
    storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});storage.repository.updateSettings(scope,0,{listeningPaused:false});
    await engine.dispatch('session',{type:'privacy',target:{kind:'term',sessionId:'session',term:'Straße'}});await engine.dispatch('session',{type:'tick'});
    storage.close();
    // The previous version lower-cased without folding, in the table and inside saved checkpoints.
    const previous=new DatabaseSync(path);
    previous.prepare("UPDATE blocked_terms SET term='straße'").run();
    previous.prepare("UPDATE domain_checkpoints SET body=json_set(body,'$.blockedTerms',json_array('straße'))").run();
    previous.exec('DELETE FROM schema_migrations WHERE version=5');previous.close();
    ({storage,engine}=open(path,clock));
    expect(storage.repository.isTermBlocked(scope,'session','STRASSE')).toBe(true);
    at+=1000;
    await engine.dispatch('session',{type:'source',source:{...scope,id:'speech',sessionId:'session',revision:1,kind:'speech',startMs:11_000,endMs:12_000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'Hello there.',status:'active',externalMessageId:null,moderation:'allowed'}});
    expect(storage.repository.listBlockedTerms(scope,'session')).toEqual(['strasse']);
    expect(storage.repository.isTermBlocked(scope,'next-session','Straße')).toBe(true);
    // An explicit unblock still removes the migrated block.
    await engine.dispatch('session',{type:'term.unblock',term:'STRASSE'});
    expect(storage.repository.listBlockedTerms(scope,'session')).toEqual([]);
    storage.close();
  });
  it('unblocks a term while another session keeps a checkpoint larger than 8 MB',()=>{
    const directory=mkdtempSync(join(tmpdir(),'previously-terms-'));directories.push(directory);const path=join(directory,'state.sqlite');
    const clock={now:()=>start,iso:()=>new Date(start).toISOString()};
    let {storage}=open(path,clock);
    storage.repository.createSession(scope,{id:'long',startedAt:new Date(start).toISOString()});
    storage.repository.invalidate(scope,{kind:'term',sessionId:'long',term:'brick'},{idempotencyKey:'block-brick',reason:'test'});
    storage.close();
    const previous=new DatabaseSync(path);
    previous.prepare('INSERT INTO domain_checkpoints VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id,run_id,session_id) DO UPDATE SET body=excluded.body').run(scope.channelId,scope.runId,'long',1,1,JSON.stringify({revision:1,blockedTerms:['brick'],padding:'x'.repeat(9_000_000)}),start);
    previous.close();
    ({storage}=open(path,clock));
    expect(storage.repository.unblockTerm(scope,'BRICK')).toBe(true);
    expect(storage.repository.isTermBlocked(scope,'long','brick')).toBe(false);
    storage.close();
  });
});
