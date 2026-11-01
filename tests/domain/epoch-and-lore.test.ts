import {describe,it,expect} from 'vitest';
import {createDomainState,reduceDomain,type DomainEvent,type DomainState} from '../../src/core/index.js';
import {defaultSettings,type Clock,type Safety,type Source,type StoryPatch} from '../../src/shared/contracts/index.js';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';

// Authored development cases, including actual in-memory SQLite transactions. No network calls.
const start=Date.parse('2026-11-02T00:00:00.000Z'),scope={channelId:'channel',runId:'live'};
const allowed:Safety={moderation:'allowed',pii:'allowed',checkedAt:new Date(start).toISOString(),reason:null};
const pending:Safety={moderation:'pending',pii:'pending',checkedAt:null,reason:null};
const source=(id:string,text:string,atMs:number,extra:Partial<Source>={}):Source=>({...scope,sessionId:'session',id,revision:1,kind:'speech',startMs:atMs,endMs:atMs,actorId:null,languageCodes:['en'],timePrecision:'event',text,status:'active',externalMessageId:null,moderation:'allowed',...extra});
function fixture(){let ms=0;const clock:Clock={now:()=>start+ms,iso:()=>new Date(start+ms).toISOString()};let state=createDomainState({channel:{id:'channel',login:'fixture',displayName:'Authored fixture'},session:{...scope,id:'session',twitchStreamId:null,title:'',category:'',startedAt:new Date(start).toISOString(),endedAt:null,status:'live',privacyEpoch:0,publicationRevision:0,metadataMaxDependencyEndMs:0,finalizedAt:null,finalSnapshotAckAt:null},settings:{...defaultSettings,listeningPaused:false}});return {clock,get state(){return state;},set(msValue:number){ms=msValue;},send(event:DomainEvent){const result=reduceDomain(state,event,clock);state=result.state;return result;}};}
function patchFor(state:DomainState):StoryPatch{const request=state.pendingGeneration!,s=request.packet.sources.at(-1)!;return {sessionId:'session',baseRevision:request.ticket.baseEntityRevision,action:'update',title:'Testing persistence',claims:[{id:'goal',text:s.text!,role:'goal',support:[{id:s.id,revision:s.revision}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};}
function confirmedLore(){const h=fixture();h.set(1000);h.send({type:'source',source:source('chat-one','BRICK',1000,{kind:'chat',actorId:'one'}),phrase:'BRICK'});h.set(2000);h.send({type:'source',source:source('chat-two','BRICK',2000,{kind:'chat',actorId:'two'}),phrase:'BRICK'});h.set(3000);h.send({type:'source',source:source('origin','BRICK began when I called the broken prototype a brick.',3000,{kind:'owner_statement'})});h.set(100000);h.send({type:'lore.propose',id:'lore',term:'brick',explanation:'The owner called the broken prototype a brick.',originRefs:[{id:'origin',revision:1}],safety:allowed,grounding:{acceptedClaimIds:['lore'],acceptedRelationKeys:[]},language:'en'});return h;}

describe('privacy epoch reconciliation',()=>{
  it('commits an unrelated delete-before-create tombstone with a pending candidate in SQLite',async()=>{
    const now=start+10000,storage=createStorage({path:':memory:',now:()=>now});try{
      const engine=new StoryEngine({scope,channel:{id:'channel',login:'fixture',displayName:'Fixture'},storage,clock:{now:()=>now,iso:()=>new Date(now).toISOString()},updates:new RevisionStream(),safety:new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=>'allowed'},()=>now),story:{propose:async()=>{throw Error('unused');}}});
      storage.repository.updateSettings(scope,0,{listeningPaused:false});storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});
      const first=await engine.dispatch('session',{type:'source',source:source('speech','I am testing persistence.',10000)}),ticket=first.pendingGeneration!.ticket;
      await engine.dispatch('session',{type:'generation.result',ticket,patch:patchFor(first),safety:allowed});expect(engine.state('session').candidates).toHaveLength(1);
      const next=await engine.dispatch('session',{type:'privacy',target:{kind:'message',sessionId:'session',externalMessageId:'not-yet-created'}});expect(next.session.privacyEpoch).toBe(1);expect(next.candidates).toHaveLength(0);expect(next.pendingGeneration?.ticket.privacyEpoch).toBe(1);expect(next.pendingGeneration?.ticket.jobId).not.toBe(ticket.jobId);
      expect(storage.repository.getDomainHydration(scope,'session').tombstones).toContainEqual({kind:'message',sessionId:'session',externalMessageId:'not-yet-created'});
    }finally{storage.close();}
  });
  it('keeps an unaffected published baseline and requeues a surviving held owner review at the new epoch',()=>{
    const h=fixture();h.set(10000);h.send({type:'source',source:source('speech','I am testing persistence.',10000)});h.send({type:'generation.result',ticket:h.state.pendingGeneration!.ticket,patch:patchFor(h.state),safety:allowed});h.set(85000);h.send({type:'tick'});const before=structuredClone(h.state.published!);
    h.send({type:'privacy',target:{kind:'message',sessionId:'session',externalMessageId:'unseen-first'}});expect(h.state.published!.current).toEqual(before.current);expect(h.state.published!.chapters).toEqual(before.chapters);expect(h.state.published!.asOf).toBe(before.asOf);
    const chapter=h.state.chapters[0]!;h.send({type:'owner.edit',entityId:chapter.id,baseRevision:chapter.revision,source:source('owner','A checked correction is pending.',85000,{kind:'owner_statement',moderation:'pending'}),title:'Correction',summary:'A checked correction is pending.',safety:pending});
    const result=h.send({type:'privacy',target:{kind:'message',sessionId:'session',externalMessageId:'unseen-second'}});expect(h.state.candidates.some(c=>c.status==='pending'&&c.privacyEpoch<2)).toBe(false);expect(result.effects).toContainEqual(expect.objectContaining({type:'owner.review.request',kind:'chapter',entityId:chapter.id,sourceId:'owner',sourceRevision:1,ownerRevision:1,privacyEpoch:2}));
  });
  it('retains the reviewed metadata erasure pointer after raw evidence eviction',()=>{
    const h=fixture();h.set(1000);h.send({type:'metadata',title:'Private heading',category:'Development',atMs:1000,safety:allowed});const metadataId=h.state.sources.find(s=>s.kind==='channel_metadata')!.id;
    for(let i=0;i<501;i++){h.set(2000+i);h.send({type:'source',source:source(`later-chat-${i}`,'Working',2000+i,{kind:'chat',actorId:'one'})});}
    expect(h.state.sources.some(s=>s.id===metadataId)).toBe(false);expect(h.state.nodes[metadataId]?.body).toHaveProperty('evidenceMetadata');h.send({type:'privacy',target:{kind:'source',sessionId:'session',id:metadataId}});expect(h.state.session.title).toBe('');expect(h.state.published?.session.title).toBe('');
  });
  it('commits rejected pending chat safety when that chat already contributed a moment',async()=>{
    let now=start+1000;const storage=createStorage({path:':memory:',now:()=>now});try{
      const engine=new StoryEngine({scope,channel:{id:'channel',login:'fixture',displayName:'Fixture'},storage,clock:{now:()=>now,iso:()=>new Date(now).toISOString()},updates:new RevisionStream(),safety:new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=>'allowed'},()=>now),story:{propose:async()=>{throw Error('unused');}}});storage.repository.updateSettings(scope,0,{listeningPaused:false});storage.repository.createSession(scope,{id:'session',startedAt:new Date(start).toISOString()});
      for(const [i,actorId] of ['one','two'].entries())await engine.dispatch('session',{type:'source',source:source(`signal${i}`,'clip it',1000+i,{kind:'chat',actorId,moderation:'pending'}),signals:{clipIt:true}});now=start+10000;await engine.dispatch('session',{type:'tick'});expect(engine.state('session').moments).toHaveLength(1);
      const next=await engine.dispatch('session',{type:'source.safety',id:'signal0',baseRevision:1,text:null,safety:{moderation:'blocked',pii:'review',checkedAt:new Date(now).toISOString(),reason:'held'}});expect(next.moments).toHaveLength(0);expect(storage.repository.getSource(scope,'signal0')?.status).toBe('quarantined');
    }finally{storage.close();}
  });
});

describe('whole-language lore publication',()=>{
  it('refuses to drop visible approved lore until the target-language presentation is ready',()=>{
    const h=confirmedLore();expect(h.state.published!.lore[0]?.explanation).toContain('owner');
    const failed=h.send({type:'language',language:'ru'});expect(failed.effects).toContainEqual({type:'held',reason:'language_not_ready'});expect(h.state.published!.language).toBe('en');expect(h.state.published!.lore).toHaveLength(1);
    h.send({type:'lore.presentation',id:'lore',baseRevision:1,privacyEpoch:0,language:'ru',term:'brick',explanation:'Автор назвал сломанный прототип кирпичом.',safety:allowed,inputRefs:[{id:'lore',revision:1}]});
    h.send({type:'lore.propose',id:'held-lore',term:'brick',explanation:'This proposed origin is uncertain.',originRefs:[],safety:allowed,language:'en'});
    h.send({type:'language',language:'ru'});expect(h.state.published!.language).toBe('ru');expect(h.state.published!.lore).toHaveLength(1);expect(h.state.published!.lore[0]?.explanation).toBe('Автор назвал сломанный прототип кирпичом.');h.send({type:'tick'});expect(h.state.published!.lore[0]?.explanation).not.toContain('owner');
  });
  it('owner editing invalidates both languages and rejects the previous revision’s late translation',()=>{
    const h=confirmedLore();h.send({type:'lore.presentation',id:'lore',baseRevision:1,privacyEpoch:0,language:'ru',term:'brick',explanation:'Автор назвал прототип кирпичом.',safety:allowed,inputRefs:[{id:'lore',revision:1}]});expect(h.state.lorePresentations).toHaveLength(2);
    const owner=source('owner-correction','The term described a mockup, not the app.',100000,{kind:'owner_statement',moderation:'pending'});h.send({type:'lore.edit',id:'lore',baseRevision:1,source:owner,explanation:'The term described a mockup, not the app.',language:'en'});expect(h.state.lorePresentations).toHaveLength(0);expect(h.state.published!.lore).toHaveLength(0);
    h.send({type:'lore.presentation',id:'lore',baseRevision:1,privacyEpoch:0,language:'ru',term:'brick',explanation:'Устаревшее объяснение.',safety:allowed,inputRefs:[{id:'origin',revision:1}]});expect(h.state.lorePresentations).toHaveLength(0);
    h.send({type:'lore.review',id:'lore',baseRevision:2,sourceId:owner.id,sourceRevision:1,privacyEpoch:0,explanation:'The term described a mockup, not the app.',safety:allowed,language:'en'});expect(h.state.lorePresentations).toHaveLength(1);expect(h.state.published!.lore[0]?.explanation).toContain('mockup');h.send({type:'language',language:'ru'});expect(h.state.settings.recapLanguage).toBe('en');
  });
  it('registers extra translation exposures and erases both language derivatives transitively',()=>{
    const h=confirmedLore();h.send({type:'source',source:source('extra-context','PRIVATE-TRANSLATION-CONTEXT',100000)});h.send({type:'lore.presentation',id:'lore',baseRevision:1,privacyEpoch:0,language:'ru',term:'brick',explanation:'Проверенное русское объяснение.',safety:allowed,inputRefs:[{id:'lore',revision:1},{id:'extra-context',revision:1}]});h.send({type:'language',language:'ru'});expect(h.state.published!.lore).toHaveLength(1);
    h.send({type:'privacy',target:{kind:'source',sessionId:'session',id:'extra-context'}});expect(h.state.lorePresentations).toHaveLength(0);expect(h.state.published!.lore).toHaveLength(0);expect(JSON.stringify(h.state)).not.toContain('PRIVATE-TRANSLATION-CONTEXT');
  });
  it('does not relabel an English owner review when the selected language changes during moderation',()=>{
    const h=confirmedLore(),owner=source('editing-owner','A corrected English explanation.',100000,{kind:'owner_statement',moderation:'pending',languageCodes:['en']});h.send({type:'lore.edit',id:'lore',baseRevision:1,source:owner,explanation:owner.text!});h.send({type:'language',language:'ru'});expect(h.state.settings.recapLanguage).toBe('ru');
    h.send({type:'lore.review',id:'lore',baseRevision:2,sourceId:owner.id,sourceRevision:1,privacyEpoch:0,explanation:'A corrected English explanation.',safety:allowed});expect(h.state.lorePresentations[0]?.language).toBe('en');expect(h.state.published!.language).toBe('ru');expect(h.state.published!.lore).toHaveLength(0);
    h.send({type:'lore.presentation',id:'lore',baseRevision:3,privacyEpoch:0,language:'ru',term:'brick',explanation:'Исправленное русское объяснение.',safety:allowed,inputRefs:[{id:'lore',revision:3}]});expect(h.state.published!.lore[0]?.explanation).toBe('Исправленное русское объяснение.');
  });
});
