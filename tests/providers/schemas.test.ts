import {describe,it,expect} from 'vitest';
import {OpenAIStoryProvider,OpenAIContextualPrivacy,ProviderTransport,SafetyService} from '../../src/server/providers/index.js';
import type {EvidencePacket,GenerationTicket,StoryPatch} from '../../src/shared/contracts/index.js';

describe('emitted Structured Outputs requests, authored transport only',()=>{
  it('uses supported strict object schemas and bounded requests across every production text path',async()=>{
    const refs=[{id:'speech',revision:1}],term='moon toast';
    const packet:EvidencePacket={sessionId:'s',recapLanguage:'en',sources:[{channelId:'c',runId:'live',sessionId:'s',id:'speech',revision:1,kind:'speech',startMs:0,endMs:1000,actorId:null,languageCodes:['en'],timePrecision:'chunk',text:'We call this moon toast because the first toast had a crater-shaped burn.',status:'active',externalMessageId:null,moderation:'allowed'}],memory:[],chapters:[],lore:[],constraints:[]};
    const ticket:GenerationTicket={channelId:'c',runId:'live',sessionId:'s',jobId:'job',privacyEpoch:0,baseEntityRevision:0,inputRefs:refs,inputHash:'authored',schemaVersion:1,promptVersion:'1',recapLanguage:'en',eligibleAt:'2026-11-02T00:00:00Z'};
    const patch:StoryPatch={sessionId:'s',baseRevision:0,action:'update',title:'Breakfast',claims:[{id:'claim',text:packet.sources[0].text!,role:'state',support:refs,attribution:'streamer',epistemic:'explicit'}],relations:[],currentAttemptId:null,language:'en',missingContext:[]};
    const sizes=new Map<string,number>();let unknown=false;
    const transport=new ProviderTransport({apiKey:'authored',runId:'live',externalCallsEnabled:true,budget:{status:()=>({enabled:true}),reserve:()=>true,settle:()=>{}},fetch:async(_url,init)=>{
      const body=String(init?.body),request=JSON.parse(body),format=request.text.format,data=JSON.parse(request.input[1].content);
      expect(request).toMatchObject({model:'gpt-6-luna',service_tier:'default',store:false,reasoning:{effort:'none'},max_output_tokens:1024});
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(7600);sizes.set(format.name,Math.max(sizes.get(format.name)??0,Buffer.byteLength(body)));
      expect(format.strict).toBe(true);expect(format.schema.type).toBe('object');expect(format.schema.anyOf).toBeUndefined();
      let properties=0,enums=0,strings=0;
      const visit=(node:Record<string,any>,depth=1)=>{
        expect(depth).toBeLessThanOrEqual(10);
        for(const key of ['allOf','not','dependentRequired','dependentSchemas','if','then','else','patternProperties'])expect(node[key]).toBeUndefined();
        if(node.type==='object'){
          const keys=Object.keys(node.properties??{});properties+=keys.length;strings+=keys.join('').length;
          expect(node.additionalProperties).toBe(false);expect([...(node.required??[])].sort()).toEqual(keys.sort());
          for(const child of Object.values(node.properties??{}))visit(child as Record<string,any>,depth+1);
        }
        if(node.enum){enums+=node.enum.length;strings+=node.enum.filter((v:unknown)=>typeof v==='string').join('').length;}
        if(node.items)visit(node.items,depth+1);for(const child of node.anyOf??[])visit(child,depth);
        for(const [name,child] of Object.entries(node.$defs??{})){strings+=name.length;visit(child as Record<string,any>,depth);}
      };
      visit(format.schema);expect(properties).toBeLessThanOrEqual(5000);expect(enums).toBeLessThanOrEqual(1000);expect(strings).toBeLessThanOrEqual(120000);
      const text=data.language==='ru'?'Подгоревший тост.':'Toasted breakfast.';
      const values:Record<string,unknown>={
        story_patch:patch,grounding_review:{acceptedClaimIds:['claim'],acceptedRelationKeys:[],issues:[]},
        presentation:{title:text,summary:text,current:{goal:null,change:null,now:text}},presentation_review:{faithful:true,issues:[]},
        lore_proposals:unknown?{candidates:[],heldIds:['lore']}:{candidates:[{id:'lore',term,explanation:packet.sources[0].text,originRefs:refs}],heldIds:[]},
        lore_origin_review:{channelSpecific:true,explicitOrigin:true,unambiguous:true,notInstructions:true,faithful:true,issues:[]},
        lore_observation_review:{channelSpecific:true,unambiguous:true,notInstructions:true,evidenceRefs:refs,issues:[]},
        lore_presentations:{en:{term,explanation:'The speaker named the toast after its crater-shaped burn.'},ru:{term,explanation:'Автор назвал тост так из-за следа, похожего на кратер.'}},
        lore_translation_review:{en:{faithful:true,issues:[]},ru:{faithful:true,issues:[]}},
        privacy_spans:{decision:'allow',spans:[]},privacy_batch:{items:(data.texts??[]).map(()=>({decision:'allow',spans:[]}))},
      };
      expect(values[format.name]).toBeDefined();
      return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(values[format.name])}]}]}));
    }});
    const provider=new OpenAIStoryProvider(transport),context=new OpenAIContextualPrivacy(transport),safety=new SafetyService({classify:async()=>({decision:'allow',spans:[]})},{moderate:async()=> 'allowed'});
    await provider.propose(packet,ticket);await provider.review(packet,ticket,patch);
    await provider.present(patch.claims,{entityId:'chapter',revision:1,eligibleAt:ticket.eligibleAt,claimRefs:[{id:'claim',revision:1}]},safety);
    expect((await provider.proposeLore(packet,[{id:'lore',term}],safety)).value.candidates).toHaveLength(1);
    unknown=true;expect((await provider.proposeLore(packet,[{id:'lore',term}],safety)).value.observations).toHaveLength(1);
    await provider.presentLore({term,explanation:packet.sources[0].text!,originRefs:refs},safety);
    await context.classify('Safe text');await context.classifyMany(['First safe text','Second safe text']);
    expect([...sizes.keys()].sort()).toEqual(['grounding_review','lore_observation_review','lore_origin_review','lore_presentations','lore_proposals','lore_translation_review','presentation','presentation_review','privacy_batch','privacy_spans','story_patch']);
  });
});
