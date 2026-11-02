import type {Source} from '../shared/contracts/index.js';
import {DOMAIN_LIMITS} from './types.js';

/** Shared with packet construction and the bounded SQLite recovery projection. */
export const EVIDENCE_HORIZON_MS=90_000;
export const NON_CHAT_SOURCE_RESERVE=64;

/** Unicode scalar order matches SQLite's UTF-8 BINARY collation, including astral IDs.
 * Locale collation equates some distinct IDs; JS UTF-16 comparison misorders astral/BMP IDs.
 */
export function compareSourceIds(a:string,b:string):number {
  if(a===b)return 0;
  let i=0,j=0;
  while(i<a.length&&j<b.length){
    const ac=a.codePointAt(i)!,bc=b.codePointAt(j)!;
    // UTF-8 encoders replace isolated surrogates with the replacement character.
    const av=ac>=0xd800&&ac<=0xdfff?0xfffd:ac,bv=bc>=0xd800&&bc<=0xdfff?0xfffd:bc;
    if(av!==bv)return av-bv;
    i+=ac>0xffff?2:1;j+=bc>0xffff?2:1;
  }
  return (i<a.length?1:0)-(j<b.length?1:0);
}
export const newestSourceFirst=(a:Source,b:Source):number=>b.endMs-a.endMs||compareSourceIds(b.id,a.id);

/** Chat volume must not evict all fresh spoken/metadata/owner context before a retry.
 * The reserve is inside the total cap, expires at the existing evidence horizon,
 * and includes held sources so a safety outage can recover. It grants no trust.
 */
export function retainRecentSources(sources:Source[]):Source[] {
  if(sources.length<=DOMAIN_LIMITS.sources)return sources;
  const newest=Math.max(0,...sources.map(source=>source.endMs));
  const newestFirst=sources.slice().sort(newestSourceFirst);
  const selected=new Set(newestFirst.filter(source=>source.kind!=='chat'&&source.text!==null
    &&source.status!=='deleted'&&source.status!=='blocked'&&source.endMs>=newest-EVIDENCE_HORIZON_MS)
    .slice(0,NON_CHAT_SOURCE_RESERVE).map(source=>source.id));
  for(const source of newestFirst){if(selected.size>=DOMAIN_LIMITS.sources)break;selected.add(source.id);}
  return sources.filter(source=>selected.has(source.id));
}
