import {createHash} from 'node:crypto';
import {SourceSchema,safetyAllowsPublication,type Source} from '../../shared/contracts/index.js';
import {validateBundle,type CaptureBundle,type RecordedOutcome} from '../../replay/contracts.js';
import {ReplayDriver} from '../../replay/driver.js';
import {assertNoCredentials} from './recorder.js';
import type {RecordingRecord,RecordingReview,RecordingSummary} from './recording-types.js';

export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceHash=(source:Source)=>digest({id:source.id,revision:source.revision,text:source.text,startMs:source.startMs,endMs:source.endMs,kind:source.kind});
export function summary(record:RecordingRecord):RecordingSummary{return {id:record.id,status:record.status,revision:record.revision,sessionId:record.sessionId,startedAt:record.startedAt,stoppedAt:record.stoppedAt,eventCount:record.events.length,providerCount:record.providers.length,message:record.message,exportId:record.exportId};}
const textKeys=new Set(['text','title','summary','explanation','term','label','goal','change','now','category','channelContext','script']);
export function textFields(value:unknown):{hash:string;text:string}[]{const values=new Set<string>();const visit=(item:unknown,key='')=>{if(typeof item==='string'&&textKeys.has(key)&&item)values.add(item);else if(Array.isArray(item))item.forEach(x=>visit(x,key));else if(item&&typeof item==='object')Object.entries(item).forEach(([k,v])=>visit(v,k));};visit(value);return [...values].map(text=>({hash:digest(text),text}));}
export function reviewOf(record:RecordingRecord):RecordingReview {
  const blockedReasons:string[]=[];
  if(record.status!=='stopped'&&record.status!=='exported')blockedReasons.push('Stop the recording before reviewing it.');
  if(!record.initial||!record.events.length)blockedReasons.push('No complete session prefix was captured.');
  if(!record.providers.some(p=>p.operation==='story'&&!p.error))blockedReasons.push('A checked story result has not been recorded.');
  if(!record.correction)blockedReasons.push('Record one checked owner correction before exporting.');
  if(!record.milestones.some(m=>m.id==='raid'))blockedReasons.push('An incoming raid has not been recorded.');
  if(!record.providers.some(p=>p.operation==='translation'&&(p.input as {language?:string}).language==='ru'&&!p.error)||!record.providers.some(p=>p.operation==='translation'&&(p.input as {language?:string}).language==='en'&&!p.error))blockedReasons.push('Both checked English and Russian presentations are required.');
  const sources=record.sources.map(source=>({id:source.id,revision:source.revision,textHash:sourceHash(source),kind:source.kind,startMs:source.startMs,endMs:source.endMs,text:source.text,safe:record.safeSourceHashes.includes(sourceHash(source))}));
  if(sources.some(s=>s.text!==null&&!s.safe))blockedReasons.push('Some captured source wording lacks an unchanged, completed safety check. Record clean material again; unchecked or redacted input cannot reuse an old provider result.');
  for(const {event}of record.events)if('safety' in event&&!['owner.edit','lore.confirm'].includes(event.type)&&!safetyAllowsPublication(event.safety))blockedReasons.push('A captured text result is still awaiting a completed safety check.');
  for(const p of record.providers){if(p.error)continue;const safety=(p.output as {safety?:unknown})?.safety;if(!safety||!safetyAllowsPublication(safety as Parameters<typeof safetyAllowsPublication>[0]))blockedReasons.push('A recorded provider result is still held.');}
  const outputs=textFields({initial:record.initial,events:record.events,providers:record.providers,correction:record.correction,media:record.selectedMedia});
  return {recording:summary(record),digest:digest({revision:record.revision,initial:record.initial,events:record.events,providers:record.providers,sources:record.sources,correction:record.correction,media:record.selectedMedia}),sources,outputs,metadata:{channel:record.initial?.channel.displayName??'',title:record.initial?.session.title??'',category:record.initial?.session.category??''},blockedReasons:[...new Set(blockedReasons)],mediaPolicy:'owner-selected',mediaCandidates:(record.mediaEvents??[]).filter(m=>m.media.state==='ready'&&!m.media.previousSession&&['video','audio'].includes(m.media.kind)).map(m=>({id:m.media.id,kind:m.media.kind,startMs:m.media.captureStartMs,endMs:m.media.captureEndMs})),media:(record.selectedMedia??[]).map(m=>({id:m.id,kind:m.media.kind,hash:m.hash,bytes:m.bytes,mime:m.mime,startMs:m.media.captureStartMs,endMs:m.media.captureEndMs,sourceRefs:m.media.refs,previewUrl:`/api/owner/recordings/${record.id}/media/${encodeURIComponent(m.id)}`}))};
}
/** Structural scope/actor sanitization preserves source text and exact normalized provider inputs. */
export function exportBundle(record:RecordingRecord):CaptureBundle {
  if(!record.initial||!record.sessionId||!record.correction||!record.stoppedAt)throw new Error('recording_not_ready');
  const actors=new Map<string,string>();const clean=(value:unknown,key=''):unknown=>{
    if(key==='channelId')return 'recorded-channel';if(key==='runId')return 'recorded';if(key==='channelContext')return '';
    if(key==='actorId'&&typeof value==='string'){if(!actors.has(value))actors.set(value,`participant-${actors.size+1}`);return actors.get(value);}
    if(key==='twitchStreamId')return null;
    if(Array.isArray(value))return value.map(v=>clean(v,key));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v,k)]));return value;
  };
  const initial=clean(record.initial) as CaptureBundle['initial'];initial.channel.id='recorded-channel';
  // Only selected, reviewed media descriptors enter replay. Raw paths and clip management URLs stay private.
  const events=[...record.events.filter(e=>e.event.type!=='media'),...(record.selectedMedia??[]).map(m=>({atMs:m.atMs,event:{type:'media' as const,media:m.media,privacyEpoch:record.privacyEpoch}}))].sort((a,b)=>a.atMs-b.atMs).map(e=>clean(e) as CaptureBundle['events'][number]);
  const providers=clean(record.providers) as RecordedOutcome[];
  const bundle:CaptureBundle={schemaVersion:1,origin:'own-stream',id:`recording-${record.id}`,revision:1,tickMode:'recorded',durationMs:Math.max(...record.events.map(e=>e.atMs),Math.floor(Date.parse(record.stoppedAt)-Date.parse(record.initial.session.startedAt))),initial,events,providers,media:(record.selectedMedia??[]).map(m=>({id:m.id,assetId:m.assetId,sourceRefs:m.media.refs,startMs:m.media.captureStartMs,endMs:m.media.captureEndMs})),milestones:record.milestones,correction:record.correction,assertions:[{atMs:Math.max(...record.events.map(e=>e.atMs)),kind:'no-live-effects',value:true}]};
  assertNoCredentials(bundle);const parsed=validateBundle(bundle);
  const first=new ReplayDriver(parsed,'export-check-a'),second=new ReplayDriver(parsed,'export-check-b');first.advanceTo(parsed.durationMs);second.advanceTo(parsed.durationMs);
  if(first.error||second.error||!first.state.published?.chapters.length||first.normalizedHash()!==second.normalizedHash())throw new Error('recording_replay_verification_failed');
  return parsed;
}
export function collectSources(record:RecordingRecord,sources:Source[]){for(const input of sources){const source=SourceSchema.parse(input),key=sourceHash(source);if(!record.sources.some(s=>sourceHash(s)===key))record.sources.push(structuredClone(source));if(source.status==='active'&&['allowed','redacted'].includes(source.moderation)&&!record.safeSourceHashes.includes(key))record.safeSourceHashes.push(key);}}
