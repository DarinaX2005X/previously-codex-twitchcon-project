import {it,expect} from 'vitest';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
it('review: unrelated privacy action must not roll back behind pending candidate',async()=>{
 const now=Date.parse('2026-11-02T00:00:10Z'),scope={channelId:'channel',runId:'live'},storage=createStorage({path:':memory:',now:()=>now});
 try{
 const engine=new StoryEngine({scope,channel:{id:'channel',login:'fixture',displayName:'Fixture'},storage,clock:{now:()=>now,iso:()=>new Date(now).toISOString()},updates:new RevisionStream(),safety:new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'},()=>now),story:{propose:async()=>{throw Error('unused');}}});
 storage.repository.updateSettings(scope,0,{listeningPaused:false});storage.repository.createSession(scope,{id:'session',startedAt:'2026-11-02T00:00:00.000Z'});
 const state=await engine.dispatch('session',{type:'source',source:{...scope,sessionId:'session',id:'speech',revision:1,kind:'speech',startMs:9000,endMs:10000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'I am testing persistence.',status:'active',externalMessageId:null,moderation:'allowed'}});
 const ticket=state.pendingGeneration!.ticket;
 await engine.dispatch('session',{type:'generation.result',ticket,patch:{sessionId:'session',baseRevision:0,action:'update',title:'Testing',claims:[{id:'claim',text:'I am testing persistence.',role:'state',support:[{id:'speech',revision:1}],attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]},safety:{moderation:'allowed',pii:'allowed',checkedAt:new Date(now).toISOString(),reason:null}});
 expect(engine.state('session').candidates).toHaveLength(1);
 await expect(engine.dispatch('session',{type:'privacy',target:{kind:'message',sessionId:'session',externalMessageId:'not-yet-seen'}})).resolves.toMatchObject({session:{privacyEpoch:1}});
 }finally{storage.close();}
});
