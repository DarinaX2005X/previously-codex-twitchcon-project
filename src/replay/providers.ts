import { stateHash } from '../core/index.js';
import type { RecordedOutcome, ProviderOperation } from './contracts.js';
import { PROVIDER_VERSIONS } from './contracts.js';
/** Scope is execution authority, never part of a recorded provider input. */
export function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['runId','channelId'].includes(k)).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function providerKey(operation:ProviderOperation,input:unknown,versions=PROVIDER_VERSIONS){return `${operation}:${versions.model}:${versions.schemaVersion}:${versions.promptVersion}:${stateHash(canonical(input))}`;}
export class FixtureMissing extends Error {readonly code='fixture_missing';constructor(){super('This recording has no safety check for this edit');}}
export class RecordedProviders {
  private records=new Map<string,RecordedOutcome[]>();
  private versions=new Map<ProviderOperation,typeof PROVIDER_VERSIONS>();
  constructor(records:RecordedOutcome[]){for(const record of records){const versions={model:record.model,schemaVersion:record.schemaVersion,promptVersion:record.promptVersion},previous=this.versions.get(record.operation);if(previous&&JSON.stringify(previous)!==JSON.stringify(versions))throw new Error('ambiguous_recorded_provider_version');this.versions.set(record.operation,versions);const key=providerKey(record.operation,record.input,record);this.records.set(key,[...this.records.get(key)??[],record]);}}
  lookup(operation:ProviderOperation,input:unknown,invocationId?:string){const versions=this.versions.get(operation);if(!versions)throw new FixtureMissing();const candidates=this.records.get(providerKey(operation,input,versions))??[];const result=invocationId?candidates.find(r=>r.invocationId===invocationId)??candidates.find(r=>!r.invocationId):candidates.find(r=>!r.error)??candidates[0];if(!result||JSON.stringify(canonical(result.input))!==JSON.stringify(canonical(input)))throw new FixtureMissing();return structuredClone(result);}
  clear(){this.records.clear();this.versions.clear();}
}
/** Only known logical identities are remapped; text is never rewritten. */
export class LogicalIds {
  private toRuntime=new Map<string,string>();private toLogical=new Map<string,string>();
  constructor(readonly runId:string,identities:string[]){for(const id of identities)this.register(id,`${runId}~${id}`);}
  register(logical:string,runtime:string){this.toRuntime.set(logical,runtime);this.toLogical.set(runtime,logical);}
  map<T>(value:T,direction:'runtime'|'logical'):T {
    const map=direction==='runtime'?this.toRuntime:this.toLogical;
    const visit=(v:unknown):unknown=>{if(typeof v==='string'){if(map.has(v))return map.get(v);let s=v;for(const [from,to]of map)if(s.includes(from)&&!s.includes(' '))s=s.replaceAll(from,to);return s;}if(Array.isArray(v))return v.map(visit);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]));return v;};return visit(value) as T;
  }
}
