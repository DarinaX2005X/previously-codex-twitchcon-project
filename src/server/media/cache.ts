import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VersionRef } from '../../shared/contracts/index.js';
const execute=promisify(execFile);
export type MediaInput={id:string;url:string;kind:'video'|'audio';sessionId:string;privacyEpoch:number;dependencyRefs:VersionRef[];captureStartMs:number;captureEndMs:number;mimeType?:string};
export type MediaRecord=Omit<MediaInput,'url'> & {file:string;size:number;durationMs:number;mimeType:string;lastUsedAt:number;state:'ready'|'revoked'};
export type MediaProbe={durationMs:number;mimeType:string};
export interface MediaCacheOptions {directory:string;allowedHosts:readonly string[];visible:(input:Omit<MediaInput,'url'>)=>boolean|Promise<boolean>;fetch?:typeof fetch;probe?:(file:string,kind:MediaInput['kind'])=>Promise<MediaProbe>;now?:()=>number;onRevoke?:(id:string)=>void;maxBytes?:number;maxFiles?:number}
export class MediaError extends Error {constructor(readonly code:'revoked'|'unavailable'|'capacity'|'invalid'){super(`Media ${code}.`);}}
export function createFFmpegProbe(options:{ffprobe?:string;ffmpeg?:string}={}) {
  return async(file:string,kind:MediaInput['kind']):Promise<MediaProbe>=>{
    const result=await execute(options.ffprobe??'ffprobe',['-v','error','-show_entries','format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels,width,height','-of','json',file],{timeout:15000,maxBuffer:100000,windowsHide:true});
    const parsed=JSON.parse(result.stdout),durationMs=Number(parsed.format?.duration)*1000;
    if(!Number.isFinite(durationMs)||durationMs<=0||durationMs>120000||!Array.isArray(parsed.streams))throw new MediaError('invalid');
    const audio=parsed.streams.find((s:any)=>s.codec_type==='audio'),video=parsed.streams.find((s:any)=>s.codec_type==='video');
    if(kind==='video'&&(!video||!Number.isFinite(video.width)||!Number.isFinite(video.height)))throw new MediaError('invalid');
    if(kind==='audio'&&(!audio||!Number.isFinite(Number(audio.sample_rate))||Number(audio.sample_rate)<8000||!audio.channels))throw new MediaError('invalid');
    // Probe metadata alone is not proof that a truncated file decodes.
    await execute(options.ffmpeg??'ffmpeg',['-v','error','-xerror','-i',file,'-f','null','-'],{timeout:30000,maxBuffer:100000,windowsHide:true});
    const format=String(parsed.format?.format_name??'');const mimeType=kind==='video'?(format.includes('webm')?'video/webm':format.includes('mp4')||format.includes('mov')?'video/mp4':''):(format.includes('wav')?'audio/wav':format.includes('mp3')?'audio/mpeg':format.includes('ogg')?'audio/ogg':'');
    if(!mimeType)throw new MediaError('invalid');return {durationMs:Math.round(durationMs),mimeType};
  };
}
export class PrivateMediaCache {
  private records=new Map<string,MediaRecord>();private revoked=new Set<string>();private protected=new Map<string,number>();private pending:Promise<unknown>=Promise.resolve();private loaded=false;private initialization:Promise<void>|null=null;private revokeListeners=new Set<(id:string)=>void>();private readonly now:()=>number;readonly directory:string;
  constructor(private readonly options:MediaCacheOptions){this.directory=path.resolve(options.directory);this.now=options.now??Date.now;}
  private filename(id:string){return createHash('sha256').update(id).digest('hex')+'.media';}
  private location(file:string){if(!/^[a-f0-9]{64}\.media$/.test(file))throw new MediaError('invalid');return path.join(this.directory,file);}
  initialize():Promise<void>{if(this.loaded)return Promise.resolve();if(!this.initialization)this.initialization=this.initializeFiles().catch(error=>{this.initialization=null;throw error;});return this.initialization;}
  private async initializeFiles(){await mkdir(this.directory,{recursive:true,mode:0o700});try {const parsed=JSON.parse(await readFile(path.join(this.directory,'index.json'),'utf8'));if(!Array.isArray(parsed.records)||!Array.isArray(parsed.revoked))throw new Error();for(const id of parsed.revoked)if(typeof id==='string')this.revoked.add(id);for(const record of parsed.records as MediaRecord[]){if(typeof record.id!=='string'||record.file!==this.filename(record.id)||record.state!=='ready'||this.revoked.has(record.id))continue;const stats=await stat(this.location(record.file)).catch(()=>null);if(stats&&stats.size===record.size)this.records.set(record.id,record);}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){this.records.clear();}}
    // Unknown/partial files are unusable after restart; discard only generated cache filenames.
    const known=new Set([...this.records.values()].map(record=>record.file));for(const file of await readdir(this.directory)){if((/^[a-f0-9-]+\.part$/.test(file)||/^[a-f0-9]{64}\.media$/.test(file))&&!known.has(file))await unlink(path.join(this.directory,file)).catch(()=>{});}this.loaded=true;await this.persist();}
  private async persist(){await writeFile(path.join(this.directory,'index.tmp'),JSON.stringify({records:[...this.records.values()],revoked:[...this.revoked]}),{mode:0o600});await rename(path.join(this.directory,'index.tmp'),path.join(this.directory,'index.json'));}
  private allowed(value:string){let url:URL;try{url=new URL(value);}catch{throw new MediaError('invalid');}if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!this.options.allowedHosts.includes(url.hostname.toLowerCase()))throw new MediaError('invalid');return url;}
  private async visible(input:Omit<MediaInput,'url'>){if(this.revoked.has(input.id)||!(await this.options.visible(input)))throw new MediaError('revoked');}
  private serialize<T>(fn:()=>Promise<T>):Promise<T>{const next=this.pending.then(fn,fn);this.pending=next.catch(()=>{});return next;}
  prepare(input:MediaInput):Promise<MediaRecord>{return this.serialize(async()=>{await this.initialize();await this.visible(input);if(!Number.isFinite(input.captureStartMs)||input.captureEndMs<input.captureStartMs||input.dependencyRefs.length>100)throw new MediaError('invalid');const existing=this.records.get(input.id);if(existing){await this.visible(existing);return existing;}
    let url=this.allowed(input.url),response:Response|undefined;const controller=AbortSignal.timeout(45000);const fetcher=this.options.fetch??fetch;
    for(let redirect=0;redirect<=3;redirect++){response=await fetcher(url,{redirect:'manual',signal:controller});if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location||redirect===3)throw new MediaError('invalid');url=this.allowed(new URL(location,url).href);continue;}break;}
    if(!response?.ok||!response.body||response.status===206)throw new MediaError('unavailable');const type=response.headers.get('content-type')?.split(';')[0]??'';if(type&&!['application/octet-stream','video/mp4','video/webm','audio/wav','audio/x-wav','audio/mpeg','audio/ogg'].includes(type))throw new MediaError('invalid');
    const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>80_000_000))throw new MediaError('capacity');
    const temporary=path.join(this.directory,randomUUID()+'.part');let file:Awaited<ReturnType<typeof open>>|undefined;let size=0;
    try{file=await open(temporary,'wx',0o600);const reader=response.body.getReader();try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>80_000_000)throw new MediaError('capacity');await this.visible(input);await file.write(part.value);}}finally{await reader.cancel().catch(()=>{});}await file.close();file=undefined;if(!size||(declared&&size!==Number(declared)))throw new MediaError('invalid');const probed=await (this.options.probe??createFFmpegProbe())(temporary,input.kind);await this.visible(input);await this.evict(size);const target=this.filename(input.id);await rename(temporary,this.location(target));const {url:_url,...metadata}=input;const record:MediaRecord={...metadata,file:target,size,durationMs:probed.durationMs,mimeType:probed.mimeType,lastUsedAt:this.now(),state:'ready'};this.records.set(input.id,record);try{await this.persist();}catch(error){this.records.delete(input.id);await unlink(this.location(target)).catch(()=>{});throw error;}return record;
    }catch(error){throw error instanceof MediaError?error:new MediaError((error as NodeJS.ErrnoException).code==='ENOSPC'?'capacity':'unavailable');}finally{await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
  }).catch(error=>{throw error instanceof MediaError?error:new MediaError((error as NodeJS.ErrnoException).code==='ENOSPC'?'capacity':'unavailable');});}
  private async evict(incoming:number){const maxBytes=this.options.maxBytes??512_000_000,maxFiles=this.options.maxFiles??12;if(incoming>maxBytes)throw new MediaError('capacity');let used=[...this.records.values()].reduce((sum,record)=>sum+record.size,0);for(const record of [...this.records.values()].sort((a,b)=>a.lastUsedAt-b.lastUsedAt)){if(used+incoming<=maxBytes&&this.records.size<maxFiles)break;if((this.protected.get(record.id)??0)>this.now())continue;await unlink(this.location(record.file)).catch(()=>{});this.records.delete(record.id);used-=record.size;}if(used+incoming>maxBytes||this.records.size>=maxFiles)throw new MediaError('capacity');}
  protect(id:string,untilMs:number){this.protected.set(id,Math.min(untilMs,this.now()+180000));}
  release(id:string){this.protected.delete(id);}
  onRevoked(listener:(id:string)=>void){this.revokeListeners.add(listener);return()=>{this.revokeListeners.delete(listener);};}
  async get(id:string):Promise<{record:MediaRecord;path:string}>{await this.initialize();const record=this.records.get(id);if(this.revoked.has(id))throw new MediaError('revoked');if(!record)throw new MediaError('unavailable');await this.visible(record);const info=await stat(this.location(record.file)).catch(()=>null);if(!info||info.size!==record.size)throw new MediaError('unavailable');record.lastUsedAt=this.now();return {record:{...record},path:this.location(record.file)};}
  revoke(id:string):Promise<void>{this.revoked.add(id);for(const listener of this.revokeListeners)listener(id);this.options.onRevoke?.(id);return this.serialize(async()=>{await this.initialize();this.revoked.add(id);const record=this.records.get(id);this.records.delete(id);this.protected.delete(id);await this.persist();if(record)await unlink(this.location(record.file)).catch(()=>{});});}
}
