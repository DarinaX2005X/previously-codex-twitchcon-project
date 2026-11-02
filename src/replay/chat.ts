import type {CaptureBundle} from './contracts.js';
/** One chat line of the recording, in recording time, under its logical (bundle) id. Only active, moderation-allowed chat with text. */
export type RecordedChat={id:string;atMs:number;text:string;actor:string|null};
export function recordedChat(bundle:CaptureBundle):RecordedChat[]{
  const out:RecordedChat[]=[];
  for(const {atMs,event} of bundle.events){
    if(event.type!=='source')continue;
    const source=(event as {source?:{id:string;kind:string;text:string|null;status:string;moderation?:string;actorId:string|null;startMs:number}}).source;
    if(!source||source.kind!=='chat'||!source.text||source.status!=='active'||(source.moderation&&source.moderation!=='allowed'))continue;
    out.push({id:source.id,atMs:Math.max(atMs,source.startMs),text:source.text,actor:source.actorId});
  }
  return out;
}
/** Recorded chat up to `atMs` that the run still shows. `hidden` holds logical ids the run removed (Forget, ban, chat clear). */
export function visibleChat(chat:RecordedChat[],atMs:number,hidden:readonly string[]):RecordedChat[]{
  const removed=new Set(hidden);return chat.filter(c=>c.atMs<=atMs&&!removed.has(c.id));
}
