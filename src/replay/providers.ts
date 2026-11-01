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
  private records=new Map<string,RecordedOutcome>();
  constructor(records:RecordedOutcome[]){for(const record of records)this.records.set(providerKey(record.operation,record.input,record),record);}
  lookup(operation:ProviderOperation,input:unknown){const result=this.records.get(providerKey(operation,input));if(!result||JSON.stringify(canonical(result.input))!==JSON.stringify(canonical(input)))throw new FixtureMissing();return structuredClone(result);}
  clear(){this.records.clear();}
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
