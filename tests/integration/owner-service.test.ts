import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createStorage } from '../../src/server/storage/index.js';
import { StoryEngine } from '../../src/server/runtime/engine.js';
import { RuntimeOwnerService } from '../../src/server/runtime/owner-service.js';
import { SafetyService } from '../../src/server/providers/safety.js';
import { RevisionStream } from '../../src/server/runtime/updates.js';
import type { Principal } from '../../src/server/runtime/security.js';
import type { Safety, Source, StoryPatch } from '../../src/shared/contracts/index.js';
import type { OpenAIStoryProvider } from '../../src/server/providers/story.js';

// Authored integration fixtures; no Twitch or paid provider requests.
const start=Date.parse('2026-11-02T00:00:00Z');
const allowed:Safety={moderation:'allowed',pii:'allowed',checkedAt:new Date(start).toISOString(),reason:null};
const resources:ReturnType<typeof createStorage>[]=[];
const directories:string[]=[];
afterEach(()=>{for(const storage of resources.splice(0))storage.close();for(const directory of directories.splice(0)){if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw new Error('Unexpected test directory');rmSync(directory,{recursive:true,force:true});}});
function harness(options:{deferReview?:boolean;session?:boolean;safeReview?:boolean;blockReview?:boolean;path?:string;transientReview?:boolean;present?:OpenAIStoryProvider['present']}={}) {
  let now=start+10_000;
  const reviewResolvers:((value:{decision:'allow';spans:[]})=>void)[]=[];
  const safety=new SafetyService({classify:async()=>{if(options.transientReview)throw new Error('Fixture provider unavailable');return options.deferReview?await new Promise(resolve=>{reviewResolvers.push(resolve);}):{decision:options.safeReview||options.blockReview?'allow':'review',spans:[]};}}, {moderate:async()=>options.blockReview?'blocked':options.safeReview?'allowed':'unavailable'},()=>now);
  const storage=createStorage({path:options.path??':memory:',now:()=>now});resources.push(storage);
  const scope={channelId:'channel',runId:'live'},channel={id:'channel',login:'fixture',displayName:'Authored fixture'};
  const engine=new StoryEngine({scope,channel,storage,clock:{now:()=>now,iso:()=>new Date(now).toISOString()},updates:new RevisionStream(),safety,story:{propose:async()=>{throw new Error('No provider calls in service tests.');},...options.present?{present:options.present}:{}}});
  storage.repository.updateSettings(scope,0,{listeningPaused:false});
  if(options.session!==false)storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});
  const principal:Principal={...scope,role:'owner',actorId:'owner',sessionId:'auth-session',expiresAtMs:start+1_000_000};
  const service=new RuntimeOwnerService(engine);
  const context=(key='mutation-key-0001',baseRevision=1)=>({principal,idempotencyKey:key,baseRevision});
  return {engine,storage,scope,principal,service,context,set(ms:number){now=start+ms;},release(){for(const resolve of reviewResolvers.splice(0))resolve({decision:'allow',spans:[]});},async runReview(){const job=storage.repository.claimJob(scope,{kinds:['owner.review']});expect(job).not.toBeNull();const result=await service.executeReview(job!,new AbortController().signal);storage.repository.finishJob(scope,job!.id,job!.leaseToken,result.state,result.retryAtMs);return result;},async seed(){
    const source:Source={...scope,id:'speech',sessionId:'session',revision:1,kind:'speech',startMs:9000,endMs:10000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'I am testing note persistence.',status:'active',externalMessageId:null,moderation:'allowed'};
    const state=await engine.dispatch('session',{type:'source',source}),ticket=state.pendingGeneration!.ticket;
    const patch:StoryPatch={sessionId:'session',baseRevision:ticket.baseEntityRevision,action:'new_chapter',title:'Testing persistence',claims:[{id:'goal',text:source.text!,role:'goal',support:[{id:source.id,revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
    await engine.dispatch('session',{type:'generation.result',ticket,patch,safety:allowed,grounding:{acceptedClaimIds:['goal'],acceptedRelationKeys:[]}});
    now=start+85_000;return await engine.dispatch('session',{type:'tick'});
  }};
}

describe('owner service integration',()=>{
  it.each(['pii','moderation'])('publishes checked replacement wording after a %s hold while retaining Forget lineage',async reason=>{
    const options={safeReview:false,blockReview:reason==='moderation'},h=harness(options),seed=await h.seed(),original=seed.chapters[0];
    await h.service.editChapter(h.context('held-replacement-first',original.revision),original.id,{summary:'The first owner statement.'});
    await h.runReview();
    const held=h.engine.state('session').chapters[0],unchecked=h.engine.state('session').sources.find(source=>source.kind==='owner_statement')!;
    expect(held.publicationState).toBe('held');expect(unchecked.moderation).toBe('unavailable');
    expect(reason==='moderation'?held.safety.moderation:held.safety.pii).toBe(reason==='moderation'?'blocked':'review');
    options.safeReview=true;options.blockReview=false;
    await h.service.editChapter(h.context('held-replacement-safe',held.revision),held.id,{summary:'The separately checked replacement.'});
    await h.runReview();
    const restored=h.engine.state('session');
    expect(restored.published?.chapters[0]?.summary).toBe('The separately checked replacement.');
    expect(restored.chapters[0].dependencyRefs.some(ref=>ref.id==='speech')).toBe(true);
    expect(restored.nodes[held.id].exposedTo.some(ref=>ref.id===unchecked.id)).toBe(true);
    await h.service.privacy(h.context('held-replacement-forget'),{target:{kind:'source',sessionId:'session',id:unchecked.id},reason:'Forget the earlier statement'});
    expect(h.engine.state('session').published?.chapters).toHaveLength(0);
  });
  it('clears visible output and source access while a received removal awaits storage recovery',async()=>{
    const h=harness();await h.seed();expect(h.service.bootstrap(h.principal).published).not.toBeNull();
    h.engine.setOutputsBlocked(true);
    const snapshot=h.service.bootstrap(h.principal);
    expect(snapshot.published).toBeNull();expect(snapshot.playback).toEqual([]);expect(snapshot.sync.pendingPrivacy).toBe(true);
    expect(h.service.previewRecap(h.principal,'session')).toBeNull();
    expect(()=>h.service.listSources(h.principal,{sessionId:'session',limit:10})).toThrow('pending chat removal');
    await expect(h.service.triggerRecap(h.context(),{sessionId:'session',reason:'manual'})).rejects.toMatchObject({status:503});
    h.engine.setOutputsBlocked(false);expect(h.service.bootstrap(h.principal).published).not.toBeNull();
  });
  it('enforces principal scope and role before exposing private evidence',()=>{
    const h=harness({session:false});expect(()=>h.service.bootstrap({...h.principal,channelId:'other'})).toThrow('cannot access');
    expect(()=>h.service.listSources({...h.principal,role:'overlay'},{sessionId:'session',limit:10})).toThrow('cannot access');
    expect(()=>h.service.bootstrap({...h.principal,expiresAtMs:start})).toThrow('Sign in');
    expect(h.service.bootstrap(h.principal).budget.paidCallsEnabled).toBe(false);
  });
  it('saves a sparse-chat moment once, retries after service restart, and rejects changed request bodies',async()=>{
    const h=harness(),context=h.context();const first=await h.service.saveMoment(context,{sessionId:'session'});
    expect(first.count).toBe(0);expect(first.clip).toBeNull();
    const restarted=new RuntimeOwnerService(h.engine);expect((await restarted.saveMoment(context,{sessionId:'session'})).id).toBe(first.id);
    await expect(restarted.saveMoment(context,{sessionId:'session',label:'Changed request'})).rejects.toMatchObject({status:409,code:'idempotency_conflict'});
    expect(h.engine.state('session').moments).toHaveLength(1);
    // Simulates a crash after SQLite commits but before the response reference is cached.
    h.storage.repository.controlDelete(h.scope,`owner-mutation:${context.idempotencyKey}`);
    expect((await restarted.saveMoment(context,{sessionId:'session'})).id).toBe(first.id);
    expect(h.engine.state('session').moments).toHaveLength(1);
  });
  it('withdraws an edited chapter before deferred safety completes and rejects stale edits without overwriting input',async()=>{
    const h=harness({deferReview:true}),seed=await h.seed(),chapter=seed.chapters[0];expect(seed.published?.chapters).toHaveLength(1);
    const edited=await h.service.editChapter(h.context('edit-key-0001',chapter.revision),chapter.id,{summary:'The owner correction.',pinned:true});
    expect(edited.summary).toBe('The owner correction.');expect(edited.pinned).toBe(true);
    expect(h.engine.state('session').published?.chapters).toHaveLength(0);
    expect(edited.safety.moderation).toBe('pending');
    await expect(h.service.editChapter(h.context('edit-key-0002',chapter.revision),chapter.id,{summary:'Stale draft'})).rejects.toMatchObject({status:409,code:'revision_conflict'});
    expect(h.engine.state('session').chapters[0].summary).toBe('The owner correction.');
  });
  it('deletes pinned chapters immediately, keeps privacy retries safe, and never returns withdrawn text',async()=>{
    const h=harness(),seed=await h.seed(),chapter=seed.chapters[0];
    const pinned=await h.service.editChapter(h.context('pin-key-0001',chapter.revision),chapter.id,{pinned:true});expect(pinned.revision).toBeGreaterThan(chapter.revision);
    const context=h.context('forget-key-0001');const receipt=await h.service.privacy(context,{target:{kind:'source',sessionId:'session',id:'speech'},reason:'Owner privacy request'});
    expect(receipt.hiddenEntityIds).toContain(chapter.id);expect(h.service.getSession(h.principal,'session').published?.chapters).toHaveLength(0);
    expect(h.service.listSources(h.principal,{sessionId:'session',limit:10}).items[0].text).toBeNull();
    expect(await h.service.privacy(context,{target:{kind:'source',sessionId:'session',id:'speech'},reason:'Owner privacy request'})).toEqual(receipt);
    await expect(h.service.editChapter(h.context('pin-key-0001',chapter.revision),chapter.id,{pinned:true})).rejects.toMatchObject({code:'result_withdrawn'});
  });
  it('holds unavailable safety results and fences review replies after Forget',async()=>{
    const h=harness({deferReview:true}),seed=await h.seed(),chapter=seed.chapters[0];
    await h.service.editChapter(h.context('edit-review-key',chapter.revision),chapter.id,{summary:'Owner correction awaiting review.'});
    const job=h.storage.repository.claimJob(h.scope,{kinds:['owner.review']});expect(job).not.toBeNull();
    const execution=h.service.executeReview(job!,new AbortController().signal);
    await h.service.privacy(h.context('forget-review-key'),{target:{kind:'entity',sessionId:'session',id:chapter.id},reason:'Remove this chapter'});
    h.release();await execution;await h.engine.dispatch('session',{type:'tick'});
    expect(h.engine.state('session').chapters).toHaveLength(0);expect(h.engine.state('session').published?.chapters).toHaveLength(0);
    expect(h.storage.budget.status().usedMicroUsd).toBe(0);
  });
  it('publishes a separately reviewed owner correction without a second hold and retains owner provenance',async()=>{
    const h=harness({safeReview:true}),seed=await h.seed(),chapter=seed.chapters[0];
    await h.service.editChapter(h.context('safe-edit-key',chapter.revision),chapter.id,{summary:'The owner confirmed the reload behavior.'});
    expect(h.engine.state('session').chapters[0].safety.moderation).toBe('pending');
    await h.runReview();await h.engine.dispatch('session',{type:'tick'});
    const reviewed=h.engine.state('session');expect(reviewed.chapters[0].safety.moderation).toBe('allowed');
    expect(reviewed.published?.chapters[0].summary).toBe('The owner confirmed the reload behavior.');
    expect(reviewed.sources.some(s=>s.kind==='owner_statement'&&s.moderation==='allowed')).toBe(true);
    expect(h.storage.budget.status().usedMicroUsd).toBe(0);
  });
  it('resumes an owner review after closing and reopening SQLite before the worker dispatches',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'previously-owner-review-'));directories.push(directory);const path=join(directory,'review.sqlite');
    const h=harness({safeReview:true,path}),seed=await h.seed(),chapter=seed.chapters[0];
    await h.service.editChapter(h.context('restart-review-key',chapter.revision),chapter.id,{summary:'A durable owner correction.'});
    expect(h.storage.repository.pendingJobCount(h.scope,'session',['owner.review'])).toBe(1);
    resources.splice(resources.indexOf(h.storage),1);h.storage.close();
    const storage=createStorage({path,now:h.engine.clock.now});resources.push(storage);
    const engine=new StoryEngine({scope:h.scope,channel:h.engine.channel,storage,clock:h.engine.clock,safety:h.engine.safety,updates:new RevisionStream(),story:{propose:async()=>{throw new Error('No provider calls.');}}});
    const service=new RuntimeOwnerService(engine),job=storage.repository.claimJob(h.scope,{kinds:['owner.review']});expect(job).not.toBeNull();
    expect(JSON.stringify(job!.payload)).not.toContain('A durable owner correction.');
    const result=await service.executeReview(job!,new AbortController().signal);expect(result).toEqual({state:'done'});
    expect(storage.repository.finishJob(h.scope,job!.id,job!.leaseToken,result.state)).toBe(true);
    expect(engine.state('session').published?.chapters[0].summary).toBe('A durable owner correction.');
    expect(storage.repository.pendingJobCount(h.scope,'session',['owner.review'])).toBe(0);
  });
  it('reviews a durable owner source after its raw text leaves the bounded checkpoint window',async()=>{
    const h=harness({safeReview:true}),seed=await h.seed(),chapter=seed.chapters[0];
    await h.service.editChapter(h.context('historical-review-key',chapter.revision),chapter.id,{summary:'A correction retained by its provenance.'});
    const before=h.engine.state('session'),source=before.sources.find(value=>value.kind==='owner_statement')!;
    const evicted=structuredClone(before),{text:_text,...evidenceMetadata}=source;
    // The reducer uses this metadata representation when an evidenced source leaves its 500-item raw window.
    evicted.sources=evicted.sources.filter(value=>value.id!==source.id);
    evicted.nodes[source.id]={id:source.id,revision:source.revision,kind:'provider_cache',supports:[],exposedTo:[],startMs:source.startMs,endMs:source.endMs,active:true,body:{evidenceMetadata}};
    evicted.revision++;
    h.storage.repository.applyDomainTransition(h.scope,'session',{expectedRevision:before.revision,expectedPrivacyEpoch:before.session.privacyEpoch,transition:{state:evicted,effects:[]}});
    expect(h.engine.state('session').sources.some(value=>value.id===source.id)).toBe(false);
    expect(await h.runReview()).toEqual({state:'done'});
    expect(h.engine.state('session').published?.chapters[0].summary).toBe('A correction retained by its provenance.');
    expect(h.storage.repository.getSource(h.scope,source.id)?.revision).toBe(source.revision+1);
  });
  it('drops a queued review forgotten before its first safety dispatch',async()=>{
    const h=harness({safeReview:true}),seed=await h.seed(),chapter=seed.chapters[0];
    await h.service.editChapter(h.context('queued-review-key',chapter.revision),chapter.id,{summary:'Forget this queued correction.'});
    const job=h.storage.repository.claimJob(h.scope,{kinds:['owner.review']});expect(job).not.toBeNull();
    await h.service.privacy(h.context('queued-forget-key'),{target:{kind:'entity',sessionId:'session',id:chapter.id},reason:'Remove before review'});
    expect(await new RuntimeOwnerService(h.engine).executeReview(job!,new AbortController().signal)).toEqual({state:'done'});
    expect(h.engine.state('session').chapters).toHaveLength(0);expect(h.engine.state('session').published?.chapters).toHaveLength(0);
    expect(h.storage.repository.pendingJobCount(h.scope,'session',['owner.review'])).toBe(0);
  });
  it('backs off transient safety failures for at most three attempts then leaves an explicit held result',async()=>{
    const h=harness({transientReview:true}),seed=await h.seed(),chapter=seed.chapters[0];
    await h.service.editChapter(h.context('retry-review-key',chapter.revision),chapter.id,{summary:'Waiting for review.'});
    expect(await h.runReview()).toEqual({state:'failed',retryAtMs:start+87000});
    expect(h.storage.repository.claimJob(h.scope,{kinds:['owner.review']})).toBeNull();
    h.set(87000);expect(await h.runReview()).toEqual({state:'failed',retryAtMs:start+91000});
    h.set(91000);expect(await h.runReview()).toEqual({state:'failed'});
    const held=h.engine.state('session').chapters[0];expect(held.publicationState).toBe('held');expect(held.safety.reason).toBe('owner_review_unavailable');
    expect(h.engine.state('session').published?.chapters).toHaveLength(0);expect(h.storage.repository.claimJob(h.scope,{kinds:['owner.review']})).toBeNull();
    expect(h.storage.budget.status().usedMicroUsd).toBe(0);
  });
  it('accepts owner corrections to a finalized session while keeping the new wording held',async()=>{
    const h=harness({deferReview:true}),seed=await h.seed(),chapter=seed.chapters[0];
    h.storage.repository.updateSession(h.scope,'session',{status:'finalized',endedAt:h.engine.clock.iso(),finalizedAt:h.engine.clock.iso()});
    const edited=await h.service.editChapter(h.context('archive-edit-key',chapter.revision),chapter.id,{summary:'Archived owner correction.'});
    expect(edited.summary).toBe('Archived owner correction.');expect(edited.publicationState).toBe('held');
    expect(h.service.getSession(h.principal,'session').published?.chapters).toHaveLength(0);
  });
  it('persists standalone settings with revision and idempotency fences',async()=>{
    const h=harness({session:false}),context=h.context('settings-key-0001',1);
    const updated=await h.service.setSettings(context,{volume:0.2});expect(updated.revision).toBe(2);
    h.storage.repository.controlDelete(h.scope,`owner-mutation:${context.idempotencyKey}`);
    expect((await new RuntimeOwnerService(h.engine).setSettings(context,{volume:0.2})).revision).toBe(2);
    await expect(h.service.setSettings(h.context('settings-key-0002',1),{volume:0.3})).rejects.toMatchObject({status:409});
  });
  it('switches to a language the published chapters lack by presenting the same claims in it first',async()=>{
    const requested:string[][]=[];
    const present:OpenAIStoryProvider['present']=async(claims,input,_safety,_signal,languages=['en'])=>{requested.push([...languages]);return Object.fromEntries(languages.map(language=>[language,{id:`${input.entityId}:${language}`,entityId:input.entityId,revision:input.revision,language,title:'Probando la persistencia',summary:`La autora prueba la persistencia (${claims.length}).`,current:{goal:'Guardar las notas',change:null,now:null},claimRefs:input.claimRefs!,eligibleAt:input.eligibleAt,safety:allowed}]));};
    const h=harness({present});const seeded=await h.seed();expect(seeded.published?.language).toBe('en');
    const settings=await h.service.setSettings(h.context('language-key-0001',seeded.settings.revision),{recapLanguage:'es'});
    expect(settings.recapLanguage).toBe('es');expect(requested).toEqual([['es']]);
    const state=h.engine.state('session');expect(state.published?.language).toBe('es');expect(state.published?.chapters[0]?.summary).toBe('La autora prueba la persistencia (1).');
  });
  it('keeps the current language and says why when a chapter cannot be prepared',async()=>{
    const h=harness({present:async()=>{throw new Error('Fixture provider unavailable');}});const seeded=await h.seed();
    await expect(h.service.setSettings(h.context('language-key-0002',seeded.settings.revision),{recapLanguage:'fr'})).rejects.toMatchObject({status:409,code:'language_not_ready'});
    expect(h.engine.state('session').published?.language).toBe('en');expect(h.engine.state('session').settings.recapLanguage).toBe('en');
  });
  it('atomically applies active-session pause settings and advances capture epoch',async()=>{
    const h=harness();const before=h.engine.state('session').captureEpoch;
    const settings=await h.service.setSettings(h.context('pause-key-0001',1),{listeningPaused:true});
    expect(settings.listeningPaused).toBe(true);expect(h.engine.state('session').settings.revision).toBe(settings.revision);
    expect(h.engine.state('session').captureEpoch).toBeGreaterThan(before);
  });
  it('blocks lore across its stored authority and unblocks without restoring the old explanation',async()=>{
    const h=harness();
    for(let index=0;index<2;index++)await h.engine.dispatch('session',{type:'source',phrase:'tiny dragon',source:{...h.scope,id:`chat:${index}`,sessionId:'session',revision:1,kind:'chat',startMs:1000+index,endMs:1000+index,actorId:`viewer:${index}`,languageCodes:['en'],timePrecision:'event',text:'tiny dragon',status:'active',externalMessageId:`message:${index}`,moderation:'allowed'}});
    await h.engine.dispatch('session',{type:'lore.propose',id:'lore:dragon',term:'tiny dragon',explanation:'The origin has not been confirmed.',originRefs:[],safety:allowed});
    const lore=h.engine.state('session').lore[0];expect(lore).toBeDefined();
    const blocked=await h.service.blockLore(h.context('block-key-0001',lore.revision),lore.id,true);
    expect(blocked.status).toBe('blocked');expect(blocked.explanation).toBe('');expect(h.storage.repository.isTermBlocked(h.scope,'session',lore.term)).toBe(true);
    const unblocked=await h.service.blockLore(h.context('unblock-key-0001',blocked.revision),lore.id,false);
    expect(unblocked.status).toBe('observed');expect(unblocked.explanation).toBe('');expect(h.storage.repository.isTermBlocked(h.scope,'session',lore.term)).toBe(false);
  });
  it('reviews lore edits as owner statements before confirming an origin',async()=>{
    const h=harness({safeReview:true});
    const presentationCalls:[string,string][]=[];
    (h.engine as typeof h.engine & {presentOwnerLore(sessionId:string,entityId:string):Promise<void>}).presentOwnerLore=async(sessionId,entityId)=>{
      expect(h.engine.state(sessionId).lore.find(l=>l.id===entityId)?.safety.moderation).toBe('allowed');
      presentationCalls.push([sessionId,entityId]);throw new Error('Fixture alternate presentation unavailable');
    };
    for(let index=0;index<2;index++)await h.engine.dispatch('session',{type:'source',phrase:'tiny dragon',source:{...h.scope,id:`chat:${index}`,sessionId:'session',revision:1,kind:'chat',startMs:1000+index,endMs:1000+index,actorId:`viewer:${index}`,languageCodes:['en'],timePrecision:'event',text:'tiny dragon',status:'active',externalMessageId:`message:${index}`,moderation:'allowed'}});
    await h.engine.dispatch('session',{type:'lore.propose',id:'lore:dragon',term:'tiny dragon',explanation:'The origin has not been confirmed.',originRefs:[],safety:allowed});
    const lore=h.engine.state('session').lore[0];
    await h.service.editLore(h.context('lore-edit-key',lore.revision),lore.id,{explanation:'The streamer named the small mascot.',aliases:['little dragon'],originMs:1000});
    expect(await h.runReview()).toEqual({state:'done'});await h.engine.dispatch('session',{type:'tick'});
    const reviewed=h.engine.state('session').lore[0];expect(reviewed.originKind).toBe('owner_confirmed');expect(reviewed.safety.moderation).toBe('allowed');
    expect(reviewed.explanation).toBe('The streamer named the small mascot.');expect(reviewed.aliases).toEqual(['little dragon']);
    expect(presentationCalls).toEqual([['session',lore.id]]);
  });
  it('bounds source pages and intervals and only previews the published projection',async()=>{
    const h=harness();expect(h.service.previewRecap(h.principal,'session')).toBeNull();await h.seed();
    expect(h.service.listSources(h.principal,{sessionId:'session',limit:1,fromMs:20000,toMs:30000}).items).toHaveLength(0);
    const page=h.service.listSources(h.principal,{sessionId:'session',limit:1});expect(page.items).toHaveLength(1);expect(page.nextCursor).not.toBeNull();
    expect(h.service.listSources(h.principal,{sessionId:'session',limit:1,cursor:page.nextCursor!}).items).toHaveLength(0);
    const before=h.engine.state('session').playbacks.length;h.service.previewRecap(h.principal,'session');expect(h.engine.state('session').playbacks).toHaveLength(before);
  });
  it('keeps recap acknowledgements and cancellation scoped to the current playback',async()=>{
    const h=harness();const playback=await h.service.triggerRecap(h.context('recap-key-0001'),{sessionId:'session',reason:'manual'});
    expect(playback.status).toBe('preparing');expect(playback.plan?.variant).toBe('welcome');
    await h.service.acknowledgeRecap(h.context('ack-key-0001'),playback.id,{state:'prepared',timestamp:h.engine.clock.iso()});
    expect(h.engine.state('session').playbacks[0].startAt).not.toBeNull();
    await h.service.cancelRecap(h.context('cancel-key-0001'),playback.id);
    await h.service.acknowledgeRecap(h.context('ack-key-0002'),playback.id,{state:'started',timestamp:h.engine.clock.iso()});
    expect(h.engine.state('session').playbacks).toHaveLength(0);
  });
});
