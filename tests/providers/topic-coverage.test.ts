import {describe,it,expect,vi} from 'vitest';
import {OpenAIStoryProvider,ProviderTransport,SafetyService} from '../../src/server/providers/index.js';
import type {EvidencePacket,GenerationTicket,StoryPatch} from '../../src/shared/contracts/index.js';

const cases=[
  {topic:'gaming',text:'I am exploring the castle courtyard.',ru:'Я исследую двор замка.',role:'state'},
  {topic:'music',text:'I am playing a piano piece in D minor.',ru:'Я играю фортепианную пьесу в ре миноре.',role:'state'},
  {topic:'art',text:'I added ultramarine to the sky.',ru:'Я добавил ультрамарин в небо.',role:'change'},
  {topic:'cooking',text:'The dough is resting for twenty minutes.',ru:'Тесто отдыхает двадцать минут.',role:'state'},
  {topic:'conversation',text:'What makes a city feel like home?',ru:'Что делает город родным?',role:'question'},
  {topic:'coding',text:'I am testing the undo command.',ru:'Я проверяю команду отмены.',role:'attempt'},
] as const;
const safety=()=>new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'});
function setup(values:unknown[]){
  const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(values.shift())}]}]})));
  const provider=new OpenAIStoryProvider(new ProviderTransport({apiKey:'authored',runId:'live',externalCallsEnabled:true,budget:{status:()=>({enabled:true}),reserve:()=>true,settle:()=>{}},fetch:fetcher}));
  return {provider,fetcher};
}
function evidence(text:string){
  const packet:EvidencePacket={sessionId:'session',sources:[{channelId:'channel',runId:'live',id:'speech',sessionId:'session',revision:1,kind:'speech',startMs:0,endMs:20000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text,status:'active',externalMessageId:null,moderation:'allowed'}],memory:[],chapters:[],lore:[],constraints:[],recapLanguage:'en'};
  const ticket:GenerationTicket={channelId:'channel',runId:'live',jobId:'job',sessionId:'session',privacyEpoch:0,baseEntityRevision:0,inputRefs:[{id:'speech',revision:1}],inputHash:'authored',schemaVersion:1,promptVersion:'1',recapLanguage:'en',eligibleAt:'2026-11-02T00:00:00Z'};
  return {packet,ticket};
}
describe('topic-neutral authored provider contract; does not measure live model quality',()=>{
  it.each(cases)('preserves $topic evidence without adding a goal, solution or lore',async row=>{
    const {packet,ticket}=evidence(row.text);
    const patch:StoryPatch={sessionId:packet.sessionId,baseRevision:0,action:'update',title:row.topic,claims:[{id:'fact',text:row.text,role:row.role,support:ticket.inputRefs,attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:row.role==='attempt'?'fact':null,language:'en',missingContext:[]};
    const presentation=(text:string)=>({title:text,summary:text,current:{goal:null,change:row.role==='change'?text:null,now:['state','attempt'].includes(row.role)?text:null}});
    const {provider,fetcher}=setup([patch,{acceptedClaimIds:['fact'],acceptedRelationKeys:[],issues:[]},presentation(row.text),{faithful:true,issues:[]},presentation(row.ru),{faithful:true,issues:[]}]);
    const proposed=await provider.propose(packet,ticket);expect(proposed.value).toEqual(patch);
    expect((await provider.review(packet,ticket,proposed.value)).value.acceptedClaimIds).toEqual(['fact']);
    const rendered=await provider.present(proposed.value.claims,{entityId:'chapter',revision:1,eligibleAt:ticket.eligibleAt,claimRefs:[{id:'fact',revision:1}]},safety());
    expect(rendered.en.current.goal).toBeNull();expect(rendered.ru.current.goal).toBeNull();expect(rendered.en.summary).toBe(row.text);expect(rendered.ru.summary).toBe(row.ru);
    if(row.role!=='change')expect(rendered.en.current.change).toBeNull();
    expect((await provider.proposeLore(packet,[],safety())).value).toEqual({candidates:[],observations:[],heldIds:[]});expect(fetcher).toHaveBeenCalledTimes(6);
    const request=JSON.parse(fetcher.mock.calls[0][1]!.body as string);expect(request.input[0].content).toContain('never force a goal/problem/fix arc or local joke');expect(JSON.parse(request.input[1].content).packet.sources[0].text).toBe(row.text);
  });
  it('accepts a genuine empty hold and refuses to manufacture a presentation from it',async()=>{
    const {packet,ticket}=evidence('Mm.');const hold:StoryPatch={sessionId:'session',baseRevision:0,action:'hold',title:null,claims:[],relations:[],currentAttemptId:null,language:'en',missingContext:['No supported activity or discussion.']};
    const {provider,fetcher}=setup([hold]);expect((await provider.propose(packet,ticket)).value).toEqual(hold);
    expect(await provider.review(packet,ticket,hold)).toMatchObject({value:{acceptedClaimIds:[],acceptedRelationKeys:[]},model:'local-empty-review',usage:{chargedMicroUsd:0}});
    await expect(provider.present([],{entityId:'empty',revision:1,eligibleAt:ticket.eligibleAt,claimRefs:[]},safety())).rejects.toMatchObject({code:'held'});expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects an invented goal for an ordinary performance before translation review',async()=>{
    const {packet,ticket}=evidence(cases[1].text);const claim:StoryPatch['claims'][number]={id:'music',text:packet.sources[0].text!,role:'state',support:ticket.inputRefs,attribution:'streamer',epistemic:'explicit'};
    const {provider,fetcher}=setup([{title:'Piano performance',summary:claim.text,current:{goal:'Win the piano competition.',change:null,now:claim.text}}]);
    await expect(provider.present([claim],{entityId:'chapter',revision:1,eligibleAt:ticket.eligibleAt,claimRefs:[{id:'music',revision:1}]},safety())).rejects.toMatchObject({code:'held'});expect(fetcher).toHaveBeenCalledOnce();
  });
});
