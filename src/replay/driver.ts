import { createDomainState, reduceDomain, stateHash, compileRecap, recapLineage, type DomainState, type DomainEvent, type DomainEffect } from '../core/index.js';
import type { Chapter, Clock, OwnerSnapshot, Source, Settings, PrivacyTarget, ReplayControl } from '../shared/contracts/index.js';
import { validateBundle, storyInput, type CaptureBundle, type StoryOutcome, type WordingOutcome } from './contracts.js';
import { LogicalIds, RecordedProviders, FixtureMissing } from './providers.js';
import { SimulationSink } from './simulation.js';

export class ReplayDriver {
  state:DomainState;atMs=0;playing=false;speed:1|2|4=1;error:string|null=null;
  readonly sink=new SimulationSink();readonly ids:LogicalIds;readonly providers:RecordedProviders;
  private eventIndex=0;private nextTick=0;private queue:{atMs:number;event:DomainEvent}[]=[];private serial=0;
  private bundle:CaptureBundle;private epoch:number;private revoked=false;
  readonly clock:Clock;
  constructor(bundle:CaptureBundle,readonly runId:string){
    this.bundle=validateBundle(bundle);this.epoch=Date.parse(bundle.initial.session.startedAt);
    const identities=[bundle.initial.session.id,...bundle.media.map(m=>m.id),...bundle.events.flatMap(e=>e.event.type==='source'?[e.event.source.id,...e.event.source.actorId?[e.event.source.actorId]:[]]:[])];
    this.ids=new LogicalIds(runId,identities);this.providers=new RecordedProviders(bundle.providers);
    const initial=this.ids.map(bundle.initial,'runtime');initial.session.runId=runId;
    this.state=createDomainState(initial);this.clock={now:()=>this.epoch+this.atMs,iso:()=>new Date(this.epoch+this.atMs).toISOString()};
  }
  get durationMs(){return this.bundle.durationMs;}
  get correction(){return this.bundle.correction;}
  get milestones(){return this.bundle.milestones;}
  send(event:DomainEvent){
    if(this.revoked)throw new Error('recording_revoked');
    const result=reduceDomain(this.state,event,this.clock);this.state=result.state;
    for(const effect of result.effects)this.effect(effect);
  }
  private effect(effect:DomainEffect){
    this.sink.record(effect);
    if(effect.type==='generation.request'){
      const logicalJob=this.ids.map(effect.request.ticket.jobId,'logical');
      this.ids.register(stateHash(logicalJob),stateHash(effect.request.ticket.jobId));
      try{const recorded=this.providers.lookup('story',this.ids.map(storyInput(effect.request),'logical'));
        const output=this.ids.map(recorded.output as StoryOutcome,'runtime');
        this.queue.push({atMs:this.atMs+recorded.delayMs,event:recorded.error?{type:'generation.failed',jobId:effect.request.ticket.jobId,reason:recorded.error}:{type:'generation.result',ticket:effect.request.ticket,...output}});
      }catch{this.error='fixture_missing';this.queue.push({atMs:this.atMs,event:{type:'generation.failed',jobId:effect.request.ticket.jobId,reason:'fixture_missing'}});}
    }
    if(effect.type==='playback.prepare'&&effect.playback.plan){this.queue.push({atMs:this.atMs,event:{type:'playback',id:effect.playback.id,action:'prepared'}});this.queue.push({atMs:this.atMs+300,event:{type:'playback',id:effect.playback.id,action:'start'}});}
    if(effect.type==='held')this.error=effect.reason;
  }
  /** Every seek executes the complete prefix, including hold and scheduler ticks. */
  advanceTo(target:number){
    if(this.revoked)return;
    const playbackEnd=Math.max(0,...this.state.playbacks.filter(p=>p.plan&&['queued','preparing','playing'].includes(p.status)).map(p=>{
      const timing=this.state.playbackTiming[p.id];
      const start=p.startAt?Date.parse(p.startAt)-this.epoch:timing?.prepareAtMs!==null&&timing?.prepareAtMs!==undefined?timing.prepareAtMs-this.epoch+1500:this.atMs+1500;
      return start+(p.plan?.durationMs??0);
    }));
    // Sources stop at the recording boundary; a manual scene can finish on the same clock.
    const horizon=Math.max(this.durationMs,this.atMs,playbackEnd);
    // Contract offsets are integer milliseconds; performance.now() supplies fractions.
    target=Math.floor(Math.min(horizon,Math.max(this.atMs,target)));
    for(let guard=0;guard<400000;guard++){
      this.queue.sort((a,b)=>a.atMs-b.atMs);
      const input=this.bundle.events[this.eventIndex],next=Math.min(input?.atMs??Infinity,this.queue[0]?.atMs??Infinity,this.nextTick);
      if(next>target)break;this.atMs=next;
      if(input&&input.atMs===next){this.eventIndex++;const event=this.ids.map(input.event,'runtime');if(event.type==='source')event.source.runId=this.runId;this.send(event);}
      else if(this.queue[0]?.atMs===next)this.send(this.queue.shift()!.event);
      else {this.nextTick+=100;this.send({type:'tick'});}
    }
    this.atMs=target;if(target>=this.durationMs&&!this.state.playbacks.some(p=>['queued','preparing','playing'].includes(p.status)))this.playing=false;
  }
  control(control:ReplayControl){if(control.speed)this.speed=control.speed;if(control.action==='play')this.playing=true;if(control.action==='pause')this.playing=false;if(control.action==='seek'){const m=this.milestones.find(x=>x.id===control.milestone);if(m)this.advanceTo(m.atMs);}}
  chapter(id:string,revision:number){const c=this.state.chapters.find(x=>x.id===id);if(!c||c.revision!==revision)throw Object.assign(new Error('The chapter changed. Compare the current version.'),{code:'revision_conflict',status:409});return c;}
  editChapter(id:string,patch:{title:string;summary:string;baseRevision:number}):Chapter {
    if(!patch.title.trim()||!patch.summary.trim()||patch.title.length>120||patch.summary.length>700)throw new Error('The correction needs a title and summary within the chapter limits.');
    const before=this.chapter(id,patch.baseRevision);const source:Source={channelId:this.state.session.channelId,runId:this.runId,sessionId:this.state.session.id,id:`${this.runId}~owner-${++this.serial}`,revision:1,kind:'owner_statement',startMs:this.atMs,endMs:this.atMs,actorId:null,languageCodes:[this.state.settings.recapLanguage],timePrecision:'event',text:patch.summary,status:'active',externalMessageId:null,moderation:'pending'};
    const pending={moderation:'pending',pii:'pending',checkedAt:null,reason:null} as const;
    this.send({type:'owner.edit',entityId:id,baseRevision:patch.baseRevision,source,title:patch.title,summary:patch.summary,safety:pending});
    if((this.state.ownerRevisions[id]??0)<=before.ownerEditRevision)throw new Error('This chapter can no longer be edited. Restart the recording to restore the original.');
    try{const record=this.providers.lookup('owner_review',{title:patch.title,summary:patch.summary});if(record.error)throw new FixtureMissing();const out=record.output as WordingOutcome;const c=this.state.chapters.find(x=>x.id===id)!;
      this.send({type:'owner.review',entityId:id,ownerRevision:c.ownerEditRevision,sourceId:source.id,sourceRevision:1,privacyEpoch:this.state.session.privacyEpoch,language:'en',...out});
      if(this.state.settings.recapLanguage==='ru'){const translated=this.providers.lookup('translation',{title:out.title,summary:out.summary,language:'ru'}).output as WordingOutcome;const updated=this.state.chapters.find(x=>x.id===id)!;this.send({type:'presentation',entityId:id,baseRevision:updated.revision,ownerRevision:updated.ownerEditRevision,language:'ru',inputRefs:updated.dependencyRefs,...translated});}this.error=null;
    }catch{this.error='fixture_missing';const c=this.state.chapters.find(x=>x.id===id)!;this.send({type:'owner.review',entityId:id,ownerRevision:c.ownerEditRevision,sourceId:source.id,sourceRevision:1,privacyEpoch:this.state.session.privacyEpoch,title:patch.title,summary:patch.summary,safety:{moderation:'unavailable',pii:'review',checkedAt:null,reason:'This recording has no safety check for this edit'}});}
    this.flush();return this.state.chapters.find(c=>c.id===id)!;
  }
  setSettings(patch:Partial<Settings>&{baseRevision:number}){
    if(patch.baseRevision!==this.state.settings.revision)throw new Error('revision_conflict');
    if(patch.recapLanguage&&patch.recapLanguage!==this.state.settings.recapLanguage){
      for(const c of this.state.chapters.filter(x=>x.publicationState!=='deleted')){
        if(this.state.candidates.some(candidate=>candidate.entityId===c.id&&candidate.revision===c.revision&&candidate.language===patch.recapLanguage&&candidate.safety.moderation==='allowed'))continue;
        try{const record=this.providers.lookup('translation',{title:c.title,summary:c.summary,language:patch.recapLanguage});if(record.error)throw new FixtureMissing();const out=record.output as WordingOutcome;
          this.send({type:'presentation',entityId:c.id,baseRevision:c.revision,ownerRevision:c.ownerEditRevision,language:patch.recapLanguage,inputRefs:c.dependencyRefs,...out});
        }catch{this.error='fixture_missing';}
      }
    }
    const {baseRevision,...values}=patch;
    this.send({type:'settings',settings:{...this.state.settings,...values,revision:this.state.settings.revision+1},baseRevision});this.flush();return this.state.settings;
  }
  privacy(target:PrivacyTarget){if(target.sessionId!==this.state.session.id)throw new Error('wrong_session');this.send({type:'privacy',target,reason:'Replay privacy action'});this.queue=this.queue.filter(q=>q.event.type==='playback');this.flush();return this.state.lastReceipt!;}
  flush(){this.advanceTo(this.atMs);}
  preview(){return this.state.published?compileRecap(this.state.published,this.state.settings.layout,{id:`preview-${this.serial++}`,sessionId:this.state.session.id,reason:'manual',occurredAt:this.clock.iso()},{media:this.state.media,durationMs:this.state.settings.recapDurationMs,generatedAt:this.clock.iso(),...recapLineage(this.state)}):null;}
  snapshot():OwnerSnapshot {
    const s=this.state,offline={state:'paused' as const,lastObservedAt:null,message:'Recorded source',action:null};
    return {channel:s.channel,session:s.session,settings:s.settings,status:{mic:offline,chat:offline,transcription:offline,story:{...offline,state:this.error?'delayed':'ready',message:this.error==='fixture_missing'?'This recording has no safety check for this edit':this.error},moderation:offline,cloud:{...offline,message:'Demo changes stay in this tab'},overlay:{...offline,state:'ready'}},published:s.published,drafts:s.chapters.filter(c=>c.publicationState==='draft'),held:s.chapters.filter(c=>c.publicationState==='held'),lore:s.lore,moments:s.moments,playback:s.playbacks,sync:{state:'unconfigured',revision:s.revision,acknowledgedRevision:null,lastSyncedAt:null,pendingPrivacy:false},revision:s.revision,serverNow:this.clock.iso(),budget:{limitUsd:0,committedUsd:0,reservedUsd:0,paidCallsEnabled:false}};
  }
  evidence(id:string){const c=this.state.chapters.find(x=>x.id===id);return c?this.state.sources.filter(s=>s.text&&c.dependencyRefs.some(r=>r.id===s.id)):[];}
  normalizedHash(){const projected=this.ids.map({published:this.state.published,chapters:this.state.chapters,tombstones:this.state.tombstones,settings:this.state.settings},'logical');return stateHash(projected);}
  revoke(){this.playing=false;this.revoked=true;this.queue=[];this.providers.clear();this.sink.clear();this.bundle={...this.bundle,events:[],providers:[],media:[],correction:{title:'',summary:''}};this.state=createDomainState({channel:{id:'revoked',login:'recording',displayName:'Recording unavailable'},session:{...this.state.session,title:'',category:''}});}
}
