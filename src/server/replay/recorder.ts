import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SourceSchema,StoryPatchSchema,GenerationTicketSchema,SafetySchema,type PrivacyTarget} from '../../shared/contracts/index.js';
import type {DomainEvent} from '../../core/index.js';
import {validateBundle,type CaptureBundle,type RecordedOutcome} from '../../replay/contracts.js';

const forbidden=/^(authorization|cookie|headers|accesstoken|refreshtoken|clientsecret|apikey|sessionsecret|token|capability|capturelease|sessioncookie|rawaudio|rawpath|filepath)$/i;
/** Reject secrets rather than silently changing an exact provider request. */
export function assertNoCredentials(value:unknown):void {
  if(typeof value==='string'&&(/(?:Bearer\s+|sk-proj-|oauth:|#capability=)/i.test(value)))throw new Error('capture_contains_credentials');
  if(Array.isArray(value)){for(const item of value)assertNoCredentials(item);return;}
  if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){if(forbidden.test(key.replace(/[_-]/g,'')))throw new Error('capture_contains_credentials');assertNoCredentials(item);}
}
function normalizedEvent(event:DomainEvent):DomainEvent {
  assertNoCredentials(event);
  if(event.type==='source')return {...event,source:SourceSchema.parse(event.source)};
  if(event.type==='generation.result')return {...event,ticket:GenerationTicketSchema.parse(event.ticket),patch:StoryPatchSchema.parse(event.patch),safety:SafetySchema.parse(event.safety)};
  // Raw request/log envelopes have no domain discriminator and cannot enter capture.
  const types=['source.safety','tick','metadata','topic','generation.failed','privacy','ban','unban','pause','settings','chat.clear','owner.edit','owner.review','owner.pin','candidate.safety','presentation','language','lore.propose','lore.confirm','lore.edit','lore.review','lore.presentation','term.unblock','moment.save','media','recap.trigger','playback','closing','tail.drained','cloud.ack','gap'];
  if(!types.includes(event.type))throw new Error('capture_requires_normalized_event');return structuredClone(event);
}
export type ExportReview={ownerApproved:boolean;textAndSourcesReviewed:boolean;mediaReviewedIds:string[];moderationApproved:boolean};
/** Private local recorder, opt-in by owner action. No provider or publication IO. */
export class LocalReplayRecorder {
  private events:CaptureBundle['events']=[];private providers:RecordedOutcome[]=[];private invalidated=false;
  constructor(private initial:CaptureBundle['initial']){}
  event(atMs:number,event:DomainEvent){if(this.invalidated)return;if(!Number.isSafeInteger(atMs)||atMs<0)throw new Error('invalid_capture_time');if(this.events.length>=10000)throw new Error('capture_event_limit');if(event.type==='privacy'){this.forget(event.target);return;}this.events.push({atMs,event:normalizedEvent(event)});}
  provider(outcome:RecordedOutcome){if(this.invalidated)return;assertNoCredentials(outcome);if(this.providers.length>=10000)throw new Error('capture_provider_limit');this.providers.push(structuredClone(outcome));}
  /** Conservative policy: any erasure destroys the whole in-progress capture. */
  forget(_target:PrivacyTarget){this.events=[];this.providers=[];this.initial={...this.initial,session:{...this.initial.session,title:'',category:''},settings:{...this.initial.settings,channelContext:''}};this.invalidated=true;}
  privateDraft(input:Omit<CaptureBundle,'schemaVersion'|'origin'|'initial'|'events'|'providers'>):CaptureBundle {if(this.invalidated)throw new Error('capture_invalidated_by_privacy');return validateBundle({...input,schemaVersion:1,origin:'own-stream',initial:this.initial,events:this.events,providers:this.providers});}
  /** Sanitization must preserve exact recorded requests, or those outcomes need fresh review. */
  approveExport(candidate:CaptureBundle,review:ExportReview):CaptureBundle {
    if(this.invalidated)throw new Error('capture_invalidated_by_privacy');assertNoCredentials(candidate);
    if(!review.ownerApproved||!review.textAndSourcesReviewed||!review.moderationApproved)throw new Error('export_review_required');
    if(candidate.media.some(media=>!review.mediaReviewedIds.includes(media.id)))throw new Error('screen_media_requires_visual_review');
    const recordedInputs=new Set(this.providers.map(p=>JSON.stringify({operation:p.operation,input:p.input,output:p.output})));
    if(candidate.providers.some(p=>!recordedInputs.has(JSON.stringify({operation:p.operation,input:p.input,output:p.output}))))throw new Error('sanitized_provider_outcome_requires_new_review');
    const sourceRefs=new Set(candidate.events.flatMap(e=>e.event.type==='source'?[e.event.source.id]:[]));
    const sources=candidate.events.flatMap(e=>e.event.type==='source'?[e.event.source]:[]);
    for(const provider of candidate.providers){const packet=(provider.input as {packet?:{sources?:unknown[]}})?.packet;if(!packet)continue;for(const input of packet.sources??[]){const source=SourceSchema.parse(input),exported=sources.find(s=>s.id===source.id&&s.revision===source.revision);if(!exported||exported.text!==source.text||exported.startMs!==source.startMs||exported.endMs!==source.endMs)throw new Error('sanitized_source_invalidates_provider_outcome');}}
    if(candidate.media.some(m=>m.sourceRefs.some(ref=>!sourceRefs.has(ref.id))))throw new Error('export_unknown_media_lineage');
    return validateBundle(candidate);
  }
  async savePrivate(dataDir:string,bundle:CaptureBundle){assertNoCredentials(bundle);const directory=resolve(dataDir,'exports','private-capture');await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'capture.json'),JSON.stringify(bundle),{mode:0o600});}
}
