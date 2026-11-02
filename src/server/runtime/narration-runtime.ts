import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical, compileRecap, narrationScript, recapLineage, type DomainEffect, type DomainEvent, type DomainMedia, type DomainState } from '../../core/index.js';
import { LanguageSchema, VersionRefSchema, type Clock, type NarrationProvider, type RecapLanguage, type Scope, type VersionRef } from '../../shared/contracts/index.js';
import { parseWav } from '../audio/wav.js';
import type { MediaDescriptor, PrivateMediaCache } from '../media/cache.js';
import type { SqliteRepository, WorkLease } from '../storage/index.js';
import type { JobResult } from './scheduler.js';

export interface NarrationEnginePort {
  readonly scope:Scope;
  readonly repository:Pick<SqliteRepository,'enqueueJob'|'renewJob'>;
  activeSessionId():string|null;
  state(sessionId:string):DomainState;
  allowed(input:{sessionId:string;privacyEpoch:number;dependencyRefs:VersionRef[]}):boolean;
  dispatch(sessionId:string,event:DomainEvent):Promise<DomainState>;
}
const TicketSchema=z.object({
  version:z.literal(1),assetId:z.string().min(1).max(160),sessionId:z.string().min(1).max(160),privacyEpoch:z.number().int().nonnegative(),
  language:LanguageSchema,script:z.string().min(1).max(1200),dependencyRefs:z.array(VersionRefSchema).min(1).max(100),
  captureStartMs:z.number().int().nonnegative(),captureEndMs:z.number().int().nonnegative(),maxDurationMs:z.union([z.literal(10000),z.literal(12000),z.literal(15000)]),
}).strict();
export type NarrationTicket=z.infer<typeof TicketSchema>;
export type NarrationStatus={state:'disabled'|'unavailable'|'pending'|'ready';assetId:string|null;message:string|null};
export type NarrationRuntimeOptions={engine:NarrationEnginePort;media:PrivateMediaCache;provider:NarrationProvider;clock:Clock;available:()=>boolean};

/** Exact published caption text, with the same media-sensitive selector used by the actual recap. */
export function narrationTicket(state:DomainState,clock:Clock):NarrationTicket|null {
  if(!state.published||!state.settings.narrationEnabled||state.session.status!=='live')return null;
  const plan=compileRecap(state.published,state.settings.layout,{id:'narration-prewarm',sessionId:state.session.id,reason:'manual',occurredAt:clock.iso()},{
    ...recapLineage(state),media:state.media.filter(media=>media.kind!=='audio'),durationMs:state.settings.recapDurationMs,narrationEnabled:false,generatedAt:clock.iso(),
  });
  if(plan.variant==='welcome'||plan.beats.length<2||plan.durationMs===5000)return null;
  const script=narrationScript(plan);if(!script||Buffer.byteLength(script,'utf8')>1200)return null;
  const refs=plan.dependencyRefs.map(ref=>{const candidate=state.candidates.find(item=>item.entityId===ref.id&&item.revision===ref.revision&&item.language===state.published!.language&&item.status==='published');return candidate?{id:candidate.id,revision:1}:ref;});
  const dependencyRefs=[...new Map(refs.map(ref=>[`${ref.id}:${ref.revision}`,ref])).values()].sort((a,b)=>a.id.localeCompare(b.id)||a.revision-b.revision);
  if(!dependencyRefs.length||dependencyRefs.length>100)return null;
  const ranges=[...plan.beats.map(beat=>beat.sourceRange),...dependencyRefs.flatMap(ref=>{const node=state.nodes[ref.id];return node?[{startMs:node.startMs,endMs:node.endMs}]:[];})];
  const body={version:1 as const,sessionId:state.session.id,privacyEpoch:state.session.privacyEpoch,language:plan.language,script,dependencyRefs,captureStartMs:Math.max(0,Math.min(...ranges.map(range=>range.startMs))),captureEndMs:Math.max(0,...ranges.map(range=>range.endMs)),maxDurationMs:plan.durationMs};
  const assetId='narration:'+createHash('sha256').update(canonical(body)).digest('hex');
  return TicketSchema.parse({...body,assetId});
}

/** Optional background preparation. No provider is called from a raid or overlay preparation path. */
export function createNarrationRuntime(options:NarrationRuntimeOptions) {
  const {engine,media,provider,clock}=options;
  const active=new Map<string,{ticket:NarrationTicket;controller:AbortController;job:WorkLease}>();
  const flights=new Set<Promise<JobResult>>();
  const retiring=new Set<string>();
  let stopped=false,lastStatus:NarrationStatus={state:'disabled',assetId:null,message:'Narration is off.'};
  const stateFor=(sessionId:string):DomainState|null=>{try{return engine.state(sessionId);}catch{return null;}};
  const currentTicket=(sessionId:string)=>{const state=stateFor(sessionId);try{return state?narrationTicket(state,clock):null;}catch{return null;}};
  const matches=(ticket:NarrationTicket)=>!stopped&&options.available()&&engine.activeSessionId()===ticket.sessionId&&engine.allowed(ticket)&&currentTicket(ticket.sessionId)?.assetId===ticket.assetId;
  const usedByPlayback=(state:DomainState,id:string)=>state.playbacks.some(playback=>['queued','preparing','playing'].includes(playback.status)&&playback.plan?.audio?.id===id);
  const descriptor=(ticket:NarrationTicket):MediaDescriptor & {kind:'audio'}=>({id:ticket.assetId,kind:'audio',sessionId:ticket.sessionId,privacyEpoch:ticket.privacyEpoch,dependencyRefs:ticket.dependencyRefs,captureStartMs:ticket.captureStartMs,captureEndMs:ticket.captureEndMs,mimeType:'audio/wav'});
  const domainMedia=(ticket:NarrationTicket,revision:number,state:DomainMedia['state'],durationMs:number):DomainMedia=>({id:ticket.assetId,revision,momentId:null,refs:ticket.dependencyRefs,captureStartMs:ticket.captureStartMs,captureEndMs:ticket.captureEndMs,durationMs,state,kind:'audio',previousSession:false,ownerApproved:true,narration:{language:ticket.language,script:ticket.script}});

  const retire=async(sessionId:string,asset:DomainMedia)=>{
    if(retiring.has(asset.id))return;retiring.add(asset.id);
    try{await media.revoke(asset.id);const state=stateFor(sessionId),current=state?.media.find(item=>item.id===asset.id);if(state&&current&&current.state!=='revoked')await engine.dispatch(sessionId,{type:'media',privacyEpoch:state.session.privacyEpoch,media:{...current,revision:current.revision+1,state:'revoked'}});}catch{/* Visibility gate remains closed even if cleanup must be retried. */}finally{retiring.delete(asset.id);}
  };
  const queue=(state:DomainState)=>{
    if(stopped||engine.activeSessionId()!==state.session.id)return;
    if(!state.settings.narrationEnabled){lastStatus={state:'disabled',assetId:null,message:'Narration is off.'};return;}
    if(!options.available()){lastStatus={state:'unavailable',assetId:null,message:'Narration is unavailable. Captions remain available.'};return;}
    let ticket:NarrationTicket|null;try{ticket=narrationTicket(state,clock);}catch{ticket=null;}
    if(!ticket||!engine.allowed(ticket)){lastStatus={state:'unavailable',assetId:null,message:'Narration waits for a supported published recap.'};return;}
    const prepared=state.media.find(asset=>asset.id===ticket!.assetId&&asset.state==='ready');
    if(prepared){media.protect(prepared.id,clock.now()+180000);lastStatus={state:'ready',assetId:prepared.id,message:null};return;}
    if(lastStatus.assetId===ticket.assetId&&lastStatus.state==='unavailable')return;
    engine.repository.enqueueJob(engine.scope,{sessionId:ticket.sessionId,kind:'narration',businessKey:ticket.assetId,payload:ticket,dependencyRefs:ticket.dependencyRefs});
    lastStatus={state:'pending',assetId:ticket.assetId,message:'Narration is preparing. Captions remain available.'};
  };
  const onEffects=(sessionId:string,_effects:readonly DomainEffect[],state:DomainState)=>{
    for(const entry of active.values())if(entry.ticket.sessionId===sessionId&&!matches(entry.ticket)){entry.controller.abort();void media.revoke(entry.ticket.assetId).catch(()=>{});}
    const desired=currentTicket(sessionId);
    for(const asset of state.media.filter(item=>item.kind==='audio'&&item.narration&&item.state!=='revoked')){
      const permitted=state.settings.narrationEnabled&&engine.allowed({sessionId,privacyEpoch:state.session.privacyEpoch,dependencyRefs:asset.refs});
      if(!permitted||asset.id!==desired?.assetId&&!usedByPlayback(state,asset.id))void retire(sessionId,asset);
      else if(asset.state==='ready')media.protect(asset.id,clock.now()+180000);
    }
    queue(state);
  };
  const approved=(text:string,language:RecapLanguage)=>[...active.values()].some(entry=>!entry.controller.signal.aborted&&entry.ticket.script===text&&entry.ticket.language===language&&matches(entry.ticket));
  const allowsMedia=(input:MediaDescriptor)=>{
    if(input.sessionId===null||input.kind!=='audio'||!input.id.startsWith('narration:'))return false;
    const state=stateFor(input.sessionId);if(!state||!state.settings.narrationEnabled||!engine.allowed(input))return false;
    const asset=state.media.find(item=>item.id===input.id);
    return !!asset&&asset.kind==='audio'&&asset.ownerApproved&&!!asset.narration&&['pending','ready'].includes(asset.state)&&canonical(asset.refs)===canonical(input.dependencyRefs);
  };
  const permitsOverlayMedia=(id:string)=>{
    const sessionId=engine.activeSessionId(),state=sessionId?stateFor(sessionId):null;if(!state||!state.settings.narrationEnabled||!usedByPlayback(state,id))return false;
    const asset=state.media.find(item=>item.id===id);return !!asset&&asset.kind==='audio'&&asset.state==='ready'&&asset.ownerApproved&&engine.allowed({sessionId:state.session.id,privacyEpoch:state.session.privacyEpoch,dependencyRefs:[{id:asset.id,revision:asset.revision},...asset.refs]});
  };

  const executeWork=async(job:WorkLease,signal:AbortSignal):Promise<JobResult>=>{
    const parsed=TicketSchema.safeParse(job.payload);if(!parsed.success||job.kind!=='narration'||job.sessionId!==parsed.data.sessionId||job.privacyEpoch!==parsed.data.privacyEpoch||active.size)return {state:'failed'};
    const ticket=parsed.data,controller=new AbortController();let completed=false;const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)controller.abort();
    active.set(job.id,{ticket,controller,job});
    const valid=()=>!controller.signal.aborted&&matches(ticket)&&engine.repository.renewJob(engine.scope,job.id,job.leaseToken,30000);
    try{
      if(!valid())return {state:'failed'};
      const current=stateFor(ticket.sessionId)?.media.find(asset=>asset.id===ticket.assetId);
      if(current?.state==='ready'){await media.get(ticket.assetId);completed=true;return {state:'done'};}
      const pending=domainMedia(ticket,(current?.revision??0)+1,'pending',0);
      await engine.dispatch(ticket.sessionId,{type:'media',privacyEpoch:ticket.privacyEpoch,media:pending});
      if(!valid()||!allowsMedia(descriptor(ticket)))return {state:'failed'};
      const rendered=await provider.synthesize(ticket.script,ticket.language,controller.signal);
      if(!valid())return {state:'failed'};
      const wav=parseWav(rendered.value.bytes);
      if(rendered.value.mimeType!=='audio/wav'||wav.durationMs<=0||wav.durationMs>ticket.maxDurationMs||Math.abs(wav.durationMs-rendered.value.durationMs)>2)throw new Error('narration_duration');
      await media.storeAudio(descriptor(ticket),rendered.value.bytes);
      if(!valid()){await media.revoke(ticket.assetId);return {state:'failed'};}
      media.protect(ticket.assetId,clock.now()+180000);
      const saved=await engine.dispatch(ticket.sessionId,{type:'media',privacyEpoch:ticket.privacyEpoch,media:domainMedia(ticket,pending.revision+1,'ready',Math.round(wav.durationMs))});
      if(!saved.media.some(asset=>asset.id===ticket.assetId&&asset.state==='ready')||!valid()){await media.revoke(ticket.assetId);return {state:'failed'};}
      completed=true;lastStatus={state:'ready',assetId:ticket.assetId,message:null};return {state:'done'};
    }catch{
      lastStatus={state:'unavailable',assetId:ticket.assetId,message:'Narration is unavailable. Captions remain available.'};
      const asset=stateFor(ticket.sessionId)?.media.find(item=>item.id===ticket.assetId);if(asset)await retire(ticket.sessionId,asset);else await media.revoke(ticket.assetId).catch(()=>{});
      return {state:controller.signal.aborted?'failed':'unknown_outcome'};
    }finally{
      signal.removeEventListener('abort',abort);active.delete(job.id);
      if(!completed){
        if(lastStatus.assetId===ticket.assetId&&lastStatus.state==='pending')lastStatus={state:'unavailable',assetId:ticket.assetId,message:'Narration is unavailable. Captions remain available.'};
        const asset=stateFor(ticket.sessionId)?.media.find(item=>item.id===ticket.assetId);if(asset&&asset.state!=='revoked')await retire(ticket.sessionId,asset);
      }
    }
  };
  const execute=(job:WorkLease,signal:AbortSignal)=>{const work=executeWork(job,signal);flights.add(work);void work.finally(()=>flights.delete(work));return work;};
  const tick=async()=>{
    if(stopped)return;const sessionId=engine.activeSessionId();if(!sessionId)return;const state=stateFor(sessionId);if(!state)return;
    onEffects(sessionId,[],state);
    for(const asset of state.media.filter(item=>item.kind==='audio'&&item.narration&&item.state==='ready')){
      try{await media.get(asset.id);}catch{await retire(sessionId,asset);if(lastStatus.assetId===asset.id)lastStatus={state:'unavailable',assetId:asset.id,message:'Narration is unavailable. Captions remain available.'};}
    }
  };
  return {onEffects,execute,approved,allowsMedia,permitsOverlayMedia,tick,status:()=>({...lastStatus}),async close(){stopped=true;for(const entry of active.values())entry.controller.abort();await Promise.allSettled([...flights]);}};
}
export type NarrationRuntime=ReturnType<typeof createNarrationRuntime>;
