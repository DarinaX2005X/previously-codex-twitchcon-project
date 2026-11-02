import { createDomainState, reduceDomain, stateHash, compileRecap, recapLineage, type DomainState, type DomainEvent, type DomainEffect } from '../core/index.js';
import {safetyAllowsPublication,type Chapter,type Clock,type OwnerSnapshot,type Source,type Settings,type PrivacyTarget,type ReplayControl,type Safety,type RecapLanguage} from '../shared/contracts/index.js';
import {isRefActive} from '../core/evidence.js';
import { validateBundle, storyInput, type CaptureBundle, type StoryOutcome, type WordingOutcome } from './contracts.js';
import { LogicalIds, RecordedProviders, FixtureMissing } from './providers.js';
import { SimulationSink } from './simulation.js';

export class ReplayDriver {
  state:DomainState;atMs=0;playing=false;speed:1|2|4=1;error:string|null=null;
  readonly sink=new SimulationSink();readonly ids:LogicalIds;readonly providers:RecordedProviders;
  private eventIndex=0;private nextTick=0;private queue:{atMs:number;event:DomainEvent}[]=[];private serial=0;
  private bundle:CaptureBundle;private epoch:number;private revoked=false;private replayingRecorded=false;private correctedOwners=new Map<string,number>();
  readonly clock:Clock;
  /** Runtime scope of this run. Every run uses the same length, so byte-bounded evidence packets select the same sources. */
  readonly runId:string;
  constructor(bundle:CaptureBundle,run:string){
    const runId=this.runId=stateHash(`replay-run:${run}`);
    this.bundle=validateBundle(bundle);this.epoch=Date.parse(bundle.initial.session.startedAt);
    const identities=[bundle.initial.session.id,...bundle.media.map(m=>m.id),...bundle.events.flatMap(({event})=>'source' in event&&typeof event.source==='object'?[event.source.id,...event.source.actorId?[event.source.actorId]:[]]:[])];
    this.ids=new LogicalIds(runId,identities);this.providers=new RecordedProviders(bundle.providers);
    this.ids.register(stateHash(bundle.initial.session.id),stateHash(this.ids.map(bundle.initial.session.id,'runtime')));
    if(bundle.tickMode==='recorded')this.nextTick=Infinity;
    const initial=this.ids.map(bundle.initial,'runtime');initial.session.runId=runId;
    this.state=createDomainState(initial);this.clock={now:()=>this.epoch+this.atMs,iso:()=>new Date(this.epoch+this.atMs).toISOString()};
  }
  get durationMs(){return this.bundle.durationMs;}
  /** A correction is offered once the recording has no later story outcome that its owner lock would redirect. */
  get correction(){const correction=this.bundle.correction;if(!correction||correction.availableAtMs!==undefined&&this.atMs<correction.availableAtMs&&!this.correctedOwners.size)return null;const {availableAtMs:_available,...value}=correction;return this.ids.map(value,'runtime');}
  get milestones(){return this.bundle.milestones;}
  get correctionApplied(){const correction=this.correction;if(!correction)return false;const target=correction.targetId;return this.state.published?.chapters.some(c=>(!target||c.id===target)&&c.edited&&this.correctedOwners.get(c.id)===this.state.ownerRevisions[c.id])??false;}
  get availableLanguages():RecapLanguage[]{
    if(this.revoked)return [];
    const chapters=this.state.chapters.filter(chapter=>chapter.publicationState!=='deleted');
    if(!chapters.length){const initial=this.bundle.initial.settings.recapLanguage;return this.bundle.providers.some(record=>record.operation==='story'&&!record.error&&(record.input as {packet?:{recapLanguage?:string}}).packet?.recapLanguage===initial&&safetyAllowsPublication((record.output as StoryOutcome).safety))?[initial]:[];}
    return (['en','ru'] as const).filter(language=>[...this.laggingPublished(),...chapters].every(chapter=>{
      if(!chapter.dependencyRefs.every(ref=>isRefActive(this.state,ref)))return false;
      if(this.state.candidates.some(candidate=>candidate.entityId===chapter.id&&candidate.revision===chapter.revision&&candidate.ownerRevision===chapter.ownerEditRevision&&candidate.language===language&&candidate.status!=='rejected'&&safetyAllowsPublication(candidate.safety)&&candidate.inputRefs.every(ref=>isRefActive(this.state,ref))))return true;
      try{const recorded=this.providers.lookup('translation',{title:chapter.title,summary:chapter.summary,language});return !recorded.error&&safetyAllowsPublication((recorded.output as WordingOutcome).safety);}catch{return false;}
    }));
  }
  /** Published revisions that a newer draft has not replaced yet, with the wording that is public now. */
  private laggingPublished():Chapter[]{
    return (this.state.published?.chapters??[]).flatMap(p=>{
      const c=this.state.chapters.find(x=>x.id===p.id),published=this.state.candidates.find(x=>x.entityId===p.id&&x.revision===p.revision&&x.status==='published'&&x.language===this.state.settings.recapLanguage);
      return c&&published&&c.revision!==p.revision?[{...published.chapter,revision:p.revision,ownerEditRevision:c.ownerEditRevision}]:[];
    });
  }
  get latestSource(){const source=[...this.state.sources].reverse().find(s=>s.status==='active'&&['allowed','redacted'].includes(s.moderation)&&!!s.text);return source?{id:source.id,text:source.text!.slice(0,500),truncated:source.text!.length>500,kind:source.kind,startMs:source.startMs,endMs:source.endMs}:null;}
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
      try{const recorded=this.providers.lookup('story',this.ids.map(storyInput(effect.request),'logical'),logicalJob);
        const output=this.ids.map(recorded.output as StoryOutcome,'runtime');
        if(this.bundle.tickMode!=='recorded')this.queue.push({atMs:this.atMs+recorded.delayMs,event:recorded.error?{type:'generation.failed',jobId:effect.request.ticket.jobId,reason:recorded.error}:{type:'generation.result',ticket:effect.request.ticket,...output}});
      }catch{this.error='fixture_missing';this.queue.push({atMs:this.atMs,event:{type:'generation.failed',jobId:effect.request.ticket.jobId,reason:'fixture_missing'}});}
    }
    if(effect.type==='playback.prepare'&&effect.playback.plan&&!this.replayingRecorded){this.queue.push({atMs:this.atMs,event:{type:'playback',id:effect.playback.id,action:'prepared'}});this.queue.push({atMs:this.atMs+300,event:{type:'playback',id:effect.playback.id,action:'start'}});}
    if(effect.type==='held')this.error=effect.reason;
  }
  private recorded(event:DomainEvent){
    if(this.bundle.tickMode!=='recorded'){this.send(event);return;}
    this.replayingRecorded=true;
    try{
      if(event.type==='generation.result'||event.type==='generation.failed'){
        const request=this.state.pendingGeneration;if(!request)throw new FixtureMissing();
        const outcome=this.providers.lookup('story',this.ids.map(storyInput(request),'logical'),this.ids.map(request.ticket.jobId,'logical'));
        event=outcome.error?{type:'generation.failed',jobId:request.ticket.jobId,reason:outcome.error}:{type:'generation.result',ticket:request.ticket,...this.ids.map(outcome.output as StoryOutcome,'runtime')};
      }else if(event.type==='source.safety'){
        const {id,baseRevision}=event;const source=this.state.sources.find(s=>s.id===id&&s.revision===baseRevision);if(!source)throw new FixtureMissing();
        const outcome=this.providers.lookup('source_safety',this.ids.map(source,'logical'));if(outcome.error)throw new FixtureMissing();event={...event,...this.ids.map(outcome.output as {text:string|null;safety:Safety},'runtime')};
      }else if(event.type==='owner.review'||event.type==='presentation'){
        const {entityId}=event;const chapter=this.state.chapters.find(c=>c.id===entityId);if(!chapter)throw new FixtureMissing();
        const input={title:chapter.title,summary:chapter.summary,...event.type==='presentation'?{language:event.language}:{}};
        const outcome=this.providers.lookup(event.type==='presentation'?'translation':'owner_review',input);if(outcome.error)throw new FixtureMissing();if(event.type==='owner.review'&&this.correction&&input.title===this.correction.title&&input.summary===this.correction.summary)this.correctedOwners.set(event.entityId,event.ownerRevision);event={...event,...outcome.output as WordingOutcome};
      }
      this.send(event);
    }catch{this.error='fixture_missing';}
    finally{this.replayingRecorded=false;}
  }
  /** Every seek executes the complete prefix, including hold and scheduler ticks. */
  advanceTo(target:number){
    if(this.revoked)return;
    if(this.bundle.tickMode==='recorded'&&this.atMs>=this.durationMs&&this.nextTick===Infinity)this.nextTick=Math.ceil(this.atMs/100)*100;
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
      if(input&&input.atMs===next){this.eventIndex++;const event=this.ids.map(input.event,'runtime');if('source' in event&&typeof event.source==='object')event.source.runId=this.runId;this.recorded(event);}
      else if(this.queue[0]?.atMs===next)this.send(this.queue.shift()!.event);
      else {this.nextTick+=this.bundle.tickIntervalMs??100;this.send({type:'tick'});}
    }
    this.atMs=target;if(target>=this.durationMs&&!this.state.playbacks.some(p=>['queued','preparing','playing'].includes(p.status)))this.playing=false;
  }
  /** Recorded offset a seek moves to: a milestone, or `atMs` floored and clamped to the recording. Null when the control names neither. */
  seekTarget(control:ReplayControl):number|null{
    if(control.milestone!==undefined){const m=this.milestones.find(x=>x.id===control.milestone);return m?m.atMs:null;}
    if(control.atMs===undefined)return null;
    if(typeof control.atMs!=='number'||!Number.isFinite(control.atMs))throw Object.assign(new Error('Choose a time inside the recording.'),{code:'invalid_seek',status:400});
    return Math.min(this.durationMs,Math.max(0,Math.floor(control.atMs)));
  }
  /** A seek only moves forward by executing every recorded event up to the target. Moving back needs a fresh run (the worker does that). */
  control(control:ReplayControl){if(control.speed)this.speed=control.speed;if(control.action==='play')this.playing=true;if(control.action==='pause')this.playing=false;if(control.action==='seek'){const target=this.seekTarget(control);if(target!==null)this.advanceTo(target);}}
  chapter(id:string,revision:number){const c=this.state.chapters.find(x=>x.id===id);if(!c||c.revision!==revision)throw Object.assign(new Error('The chapter changed. Compare the current version.'),{code:'revision_conflict',status:409});return c;}
  editChapter(id:string,patch:{title:string;summary:string;baseRevision:number}):Chapter {
    if(!patch.title.trim()||!patch.summary.trim()||patch.title.length>120||patch.summary.length>700)throw new Error('The correction needs a title and summary within the chapter limits.');
    const before=this.chapter(id,patch.baseRevision);const source:Source={channelId:this.state.session.channelId,runId:this.runId,sessionId:this.state.session.id,id:`${this.runId}~owner-${++this.serial}`,revision:1,kind:'owner_statement',startMs:this.atMs,endMs:this.atMs,actorId:null,languageCodes:[this.state.settings.recapLanguage],timePrecision:'event',text:patch.summary,status:'active',externalMessageId:null,moderation:'pending'};
    const pending={moderation:'pending',pii:'pending',checkedAt:null,reason:null} as const;
    this.send({type:'owner.edit',entityId:id,baseRevision:patch.baseRevision,source,title:patch.title,summary:patch.summary,safety:pending});
    if((this.state.ownerRevisions[id]??0)<=before.ownerEditRevision)throw new Error('This chapter can no longer be edited. Restart the recording to restore the original.');
    try{const record=this.providers.lookup('owner_review',{title:patch.title,summary:patch.summary});if(record.error)throw new FixtureMissing();const out=record.output as WordingOutcome;const c=this.state.chapters.find(x=>x.id===id)!;
      const nativeLanguage=this.correction&&patch.title===this.correction.title&&patch.summary===this.correction.summary?this.correction.language??this.bundle.initial.settings.recapLanguage:this.bundle.initial.settings.recapLanguage;
      this.send({type:'owner.review',entityId:id,ownerRevision:c.ownerEditRevision,sourceId:source.id,sourceRevision:1,privacyEpoch:this.state.session.privacyEpoch,language:nativeLanguage,...out});
      if(this.state.settings.recapLanguage!==nativeLanguage){const translated=this.providers.lookup('translation',{title:out.title,summary:out.summary,language:this.state.settings.recapLanguage});if(translated.error)throw new FixtureMissing();const updated=this.state.chapters.find(x=>x.id===id)!;this.send({type:'presentation',entityId:id,baseRevision:updated.revision,ownerRevision:updated.ownerEditRevision,language:this.state.settings.recapLanguage,inputRefs:updated.dependencyRefs,...translated.output as WordingOutcome});}if(this.correction&&patch.title===this.correction.title&&patch.summary===this.correction.summary)this.correctedOwners.set(id,this.state.ownerRevisions[id]!);this.error=null;
    }catch{this.error='fixture_missing';const c=this.state.chapters.find(x=>x.id===id)!;this.send({type:'owner.review',entityId:id,ownerRevision:c.ownerEditRevision,sourceId:source.id,sourceRevision:1,privacyEpoch:this.state.session.privacyEpoch,title:patch.title,summary:patch.summary,safety:{moderation:'unavailable',pii:'review',checkedAt:null,reason:'fixture_missing'}});}
    this.flush();return this.state.chapters.find(c=>c.id===id)!;
  }
  setSettings(patch:Partial<Settings>&{baseRevision:number}){
    if(patch.baseRevision!==this.state.settings.revision)throw new Error('revision_conflict');
    if(patch.recapLanguage&&patch.recapLanguage!==this.state.settings.recapLanguage&&!this.availableLanguages.includes(patch.recapLanguage))throw new FixtureMissing();
    if(patch.recapLanguage&&patch.recapLanguage!==this.state.settings.recapLanguage){
      // A published revision that lags its newer draft needs its own presentation for the switch to complete.
      // It is added last: candidate capacity then retires the superseded intermediate draft instead.
      for(const c of [...this.state.chapters.filter(x=>x.publicationState!=='deleted'),...this.laggingPublished()]){
        if(this.state.candidates.some(candidate=>candidate.entityId===c.id&&candidate.revision===c.revision&&candidate.language===patch.recapLanguage&&safetyAllowsPublication(candidate.safety)))continue;
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
  revoke(){this.playing=false;this.revoked=true;this.queue=[];this.providers.clear();this.sink.clear();this.bundle={...this.bundle,events:[],providers:[],media:[],correction:null};this.state=createDomainState({channel:{id:'revoked',login:'recording',displayName:'Recording unavailable'},session:{...this.state.session,title:'',category:''}});}
}
