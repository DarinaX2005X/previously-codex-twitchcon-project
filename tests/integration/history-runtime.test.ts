import {afterEach, describe, expect, it} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RuntimeOwnerService} from '../../src/server/runtime/owner-service.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {enrichGenerationHistory} from '../../src/server/runtime/history.js';
import {canDispatch, reduceDomain} from '../../src/core/index.js';
import type {Chapter, Lore, OwnerHistoryQuery, Safety, Source, StoryPatch} from '../../src/shared/contracts/index.js';
import type {Principal} from '../../src/server/runtime/security.js';

// Authored storage/runtime cases. Every review is local; there are no provider requests.
const start = Date.parse('2026-11-02T00:00:00Z'), scope = {channelId:'history',runId:'live'};
const safe:Safety = {moderation:'allowed',pii:'allowed',checkedAt:new Date(start).toISOString(),reason:null};
const stores:ReturnType<typeof createStorage>[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});

async function fixture(){
  let now=start+1_000_000;
  const store=createStorage({path:':memory:',now:()=>now});stores.push(store);
  const engine=new StoryEngine({scope,channel:{id:'history',login:'authored',displayName:'Authored history'},storage:store,clock:{now:()=>now,iso:()=>new Date(now).toISOString()},updates:new RevisionStream(),
    safety:new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=>'allowed'},()=>now),story:{propose:async()=>{throw Error('No provider requests');}}});
  const r=store.repository;r.updateSettings(scope,0,{listeningPaused:false});r.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});
  const source=(id:string,text:string,at=1000):Source=>({...scope,sessionId:'session',id,revision:1,kind:'speech',startMs:at,endMs:at,actorId:null,languageCodes:['en'],timePrecision:'event',text,status:'active',externalMessageId:null,moderation:'allowed'});
  for(const value of [source('shared','The artist described the earlier watercolor studies.'),source('private-old','An old qualified account to forget.')])r.ingest({...scope,schemaVersion:1,eventId:`event:${value.id}`,externalId:value.id,origin:'owner',kind:'speech',occurredAt:new Date(start+1000).toISOString(),receivedAt:new Date(now).toISOString(),sessionId:'session',sessionOffsetMs:1000,payload:null},{sources:[value]});
  for(let i=0;i<305;i++){
    const id=`chapter:${String(i).padStart(3,'0')}`,refs=[{id:i===0?'private-old':'shared',revision:1}];
    const chapter:Chapter={id,sessionId:'session',revision:1,title:`Watercolor study ${i}`,summary:`The artist described watercolor study ${i}.`,startMs:i*1000,endMs:i*1000+500,mood:'',claimIds:[],momentIds:[],pinned:false,edited:false,sourceLabels:[],maxDependencyEndMs:1000,ownerEditRevision:0,publicationState:'draft',eligibleAt:new Date(start).toISOString(),safety:safe,dependencyRefs:refs};
    r.saveEntity(scope,{id,sessionId:'session',kind:'chapter',body:chapter,refs,startMs:chapter.startMs,endMs:chapter.endMs});
  }
  for(let i=0;i<55;i++){
    const id=`lore:${String(i).padStart(3,'0')}`,refs=[{id:'shared',revision:1}];
    const lore:Lore={id,sessionId:'session',revision:1,term:`nickname ${i}`,explanation:'',firstSeenMs:i*1000,originMs:null,originKind:'unknown',momentId:null,maxDependencyEndMs:1000,status:'held',aliases:[],dependencyRefs:refs,safety:safe};
    if(i===0)Object.assign(lore,{term:'wet corner',explanation:'The owner named a watercolor wash.',originMs:1000,originKind:'owner_confirmed',status:'confirmed'});
    r.saveEntity(scope,{id,sessionId:'session',kind:'lore',body:lore,refs,startMs:lore.firstSeenMs,endMs:1000});
    if(i===0){const id='lore-presentation:old:en',body={kind:'lore',id,entityId:lore.id,entityRevision:1,language:'en',term:lore.term,explanation:lore.explanation,safety:safe,inputRefs:[{id:lore.id,revision:1},...refs],privacyEpoch:0,eligibleAtMs:start,maxDependencyEndMs:1000};r.saveEntity(scope,{id,sessionId:'session',kind:'presentation',body,refs:body.inputRefs,startMs:0,endMs:1000});}
  }
  const activity=source('current','The cook is preparing the soup.',1_000_000),first=await engine.dispatch('session',{type:'source',source:activity}),ticket=first.pendingGeneration!.ticket;
  const patch:StoryPatch={sessionId:'session',baseRevision:ticket.baseEntityRevision,action:'update',title:'Preparing soup',claims:[{id:'now',text:activity.text!,role:'state',support:[{id:activity.id,revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
  await engine.dispatch('session',{type:'generation.result',ticket,patch,safety:safe});now+=75_000;await engine.dispatch('session',{type:'tick'});
  const principal:Principal={...scope,role:'owner',actorId:'owner',sessionId:'browser',expiresAtMs:start+10_000_000},service=new RuntimeOwnerService(engine);
  return {store,r,engine,service,principal,source,set(ms:number){now=start+ms;},context:(key:string,baseRevision=1)=>({principal,idempotencyKey:key,baseRevision}),async review(){const job=r.claimJob(scope,{kinds:['owner.review']});expect(job).not.toBeNull();const result=await service.executeReview(job!,new AbortController().signal);r.finishJob(scope,job!.id,job!.leaseToken,result.state,result.retryAtMs);return result;}};
}

function allHistory(h:Awaited<ReturnType<typeof fixture>>,kind:OwnerHistoryQuery['kind']){
  const items:(Chapter|Lore)[]=[];let cursor:string|undefined,pages=0;
  do{const page=h.service.listHistory(h.principal,{sessionId:'session',kind,limit:20,cursor});items.push(...page.items);cursor=page.nextCursor??undefined;if(++pages>30)throw Error('Cursor did not finish');}while(cursor);
  return items;
}

describe('durable owner history',()=>{
  it('pages beyond both active caps, edits an old chapter through review, and preserves current activity',async()=>{
    const h=await fixture(),before=h.engine.state('session'),current=before.current,active=before.activeChapterId;
    expect(before.chapters).toHaveLength(300);expect(before.chapters.some(chapter=>chapter.id==='chapter:000')).toBe(false);
    expect(allHistory(h,'chapter')).toHaveLength(305);expect(allHistory(h,'lore')).toHaveLength(55);
    const edited=await h.service.editChapter(h.context('history-chapter-edit'),'chapter:000',{title:'A checked earlier study',summary:'The earlier study used a dry brush.'});
    expect(edited.publicationState).toBe('held');expect(h.engine.state('session').current).toEqual(current);expect(h.engine.state('session').activeChapterId).toBe(active);
    expect(await h.review()).toEqual({state:'done'});
    const page=h.service.listHistory(h.principal,{sessionId:'session',kind:'chapter',filter:'published',limit:50});
    const rest=page.nextCursor?allHistory(h,'chapter'):page.items;
    expect(rest.find(item=>item.id==='chapter:000')).toMatchObject({summary:'The earlier study used a dry brush.',publicationState:'published'});
    expect(h.engine.state('session').current).toEqual(current);expect(h.engine.state('session').chapters.length).toBeLessThanOrEqual(300);
    const reviewed=h.engine.state('session').chapters.find(item=>item.id==='chapter:000')!;
    const pinned=await h.service.editChapter(h.context('history-chapter-pin',reviewed.revision),reviewed.id,{pinned:true});
    const preview=h.service.previewRecap(h.principal,'session')!;
    expect(preview.beats.some(beat=>beat.text==='The earlier study used a dry brush.')).toBe(true);
    expect(canDispatch(h.engine.state('session'),preview)).toBe(true);
    // The durable pin also works when a bounded working set no longer contains the old record.
    const cache=h.engine.state('session');cache.chapters=cache.chapters.filter(item=>item.id!==pinned.id);cache.candidates=cache.candidates.filter(item=>item.entityId!==pinned.id);cache.published!.chapters=cache.published!.chapters.filter(item=>item.id!==pinned.id);
    h.set(1_200_000);const transition=reduceDomain(cache,{type:'source',source:h.source('later','The cook is stirring the soup.',1_200_000)},h.engine.clock);
    enrichGenerationHistory(h.r,transition,h.engine.clock.now());
    expect(transition.state.pendingGeneration?.packet.chapters.some(chapter=>chapter.summary==='The earlier study used a dry brush.')).toBe(true);
    expect(transition.state.pendingGeneration?.ticket.inputRefs).toContainEqual({id:pinned.id,revision:pinned.revision});
    expect(transition.state.chapters.length).toBeLessThanOrEqual(300);
    expect(h.store.budget.status().usedMicroUsd).toBe(0);
  });

  it('reviews an evicted lore origin and forgets historical source descendants without reviving them',async()=>{
    const h=await fixture(),oldId='lore:054';
    // Cold recovery intentionally has a bounded lore working set; choose a durable item outside it.
    const resident=new Set(h.engine.state('session').lore.map(item=>item.id));
    const id=allHistory(h,'lore').find(item=>!resident.has(item.id))?.id??oldId;
    const edited=await h.service.editLore(h.context('history-lore-edit'),id,{explanation:'The owner named a particular watercolor study.',originMs:1000});
    expect(edited.status).toBe('held');expect(await h.review()).toEqual({state:'done'});
    expect(allHistory(h,'lore').find(item=>item.id===id)).toMatchObject({explanation:'The owner named a particular watercolor study.',status:'published'});
    const first=h.service.listHistory(h.principal,{sessionId:'session',kind:'chapter',limit:1});
    await h.service.privacy(h.context('history-forget-old'),{target:{kind:'source',sessionId:'session',id:'private-old'},reason:'Forget old evidence'});
    expect(allHistory(h,'chapter').some(item=>item.id==='chapter:000')).toBe(false);
    await expect(h.service.editChapter(h.context('history-deleted-edit'),'chapter:000',{summary:'Must not return.'})).rejects.toMatchObject({status:404});
    expect(()=>h.service.listHistory(h.principal,{sessionId:'session',kind:'chapter',limit:1,cursor:first.nextCursor!})).toThrow('History changed');
    await expect(h.service.privacy(h.context('history-repeat-removal'),{target:{kind:'entity',sessionId:'session',id:'chapter:000'},reason:'Repeat removal of an unavailable historical item'})).resolves.toHaveProperty('privacyEpoch');
  });

  it('fails closed during privacy recovery and rejects foreign or mismatched history cursors',async()=>{
    const h=await fixture(),page=h.service.listHistory(h.principal,{sessionId:'session',kind:'chapter',limit:1});
    expect(()=>h.service.listHistory({...h.principal,channelId:'other'},{sessionId:'session',kind:'chapter',limit:20})).toThrow('cannot access');
    expect(()=>h.service.listHistory(h.principal,{sessionId:'session',kind:'lore',limit:1,cursor:page.nextCursor!})).toThrow('cursor is invalid');
    h.engine.setOutputsBlocked(true);expect(()=>h.service.listHistory(h.principal,{sessionId:'session',kind:'chapter',limit:20})).toThrow('pending chat removal');
  });

  it('retrieves evicted verified lore only on an exact mention and fences the frozen request after Forget',async()=>{
    const h=await fixture();expect(h.engine.state('session').lore.some(lore=>lore.id==='lore:000')).toBe(false);
    h.set(1_200_000);const unrelated=await h.engine.dispatch('session',{type:'source',source:h.source('unrelated','The cook is stirring the soup.',1_200_000)});
    expect(unrelated.pendingGeneration?.packet.lore.some(lore=>lore.term==='wet corner')).toBe(false);
    await h.engine.dispatch('session',{type:'generation.failed',jobId:unrelated.pendingGeneration!.ticket.jobId,reason:'authored_failure'});
    h.set(1_300_000);const mentioned=await h.engine.dispatch('session',{type:'source',source:h.source('mention','The host mentions the wet corner again.',1_300_000)}),request=mentioned.pendingGeneration!;
    expect(request.packet.lore.some(lore=>lore.term==='wet corner'&&lore.explanation==='The owner named a watercolor wash.')).toBe(true);
    expect(request.ticket.inputRefs).toContainEqual({id:'lore:000',revision:1});
    const frozen=request.ticket.inputRefs.find(ref=>ref.id.startsWith('history:'))!;
    expect(mentioned.nodes[frozen.id]?.exposedTo).toContainEqual({id:'lore-presentation:old:en',revision:1});
    expect(h.engine.allowed({sessionId:'session',privacyEpoch:request.ticket.privacyEpoch,dependencyRefs:request.ticket.inputRefs})).toBe(true);
    await h.service.privacy(h.context('history-forget-lore'),{target:{kind:'source',sessionId:'session',id:'shared'},reason:'Forget original context'});
    expect(h.engine.allowed({sessionId:'session',privacyEpoch:request.ticket.privacyEpoch,dependencyRefs:request.ticket.inputRefs})).toBe(false);
    expect(h.r.findGenerationHistory(scope,'session',{text:'The wet corner is mentioned.'})).not.toContain('lore:000');
  });
});
