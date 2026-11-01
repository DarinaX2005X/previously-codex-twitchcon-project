import {mkdir,readFile,writeFile,rename,stat,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {type BlobStore,CasConflict} from '../../cloud/blob-store.js';
import {sha256} from '../../cloud/signing.js';
import {PublicationService} from '../../cloud/service.js';
import {createCloudHandler} from '../../cloud/http.js';
import {bootstrapAuthoredReplay} from './export.js';

/** Single-process local registry. Content-addressed file names prevent URL path traversal. */
export class LocalReplayStore implements BlobStore {
  private tail=Promise.resolve();constructor(private directory:string){}
  private path(key:string){return resolve(this.directory,sha256(new TextEncoder().encode(key))+'.json');}
  async get(key:string){try{const path=this.path(key),info=await stat(path);if(info.size>5_000_000)throw new Error('replay_asset_too_large');const record=JSON.parse(await readFile(path,'utf8'));return {bytes:new Uint8Array(Buffer.from(record.data,'base64')),etag:record.etag,uploadedAt:record.uploadedAt};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
  async put(key:string,bytes:Uint8Array,options:{ifMatch?:string;contentType:string}){const task=this.tail.then(async()=>{if(bytes.length>3_500_000)throw new Error('replay_asset_too_large');await mkdir(this.directory,{recursive:true});const old=await this.get(key);if(options.ifMatch?old?.etag!==options.ifMatch:old!==null)throw new CasConflict();const etag=randomUUID(),path=this.path(key),temp=path+'.'+etag+'.tmp';await writeFile(temp,JSON.stringify({data:Buffer.from(bytes).toString('base64'),etag,uploadedAt:Date.now()}),{flag:'wx'});await rename(temp,path);return {etag};});this.tail=task.then(()=>{},()=>{});return task;}
  async delete(key:string){try{await unlink(this.path(key));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
export async function createLocalReplayHandler(dataDir:string){const service=new PublicationService({store:new LocalReplayStore(resolve(dataDir,'replay-registry')),channelLogin:'authored_channel'});await bootstrapAuthoredReplay(service,'authored_channel','authored_channel');const handler=createCloudHandler({service,secret:randomUUID(),channelLogin:'authored_channel'});return async(request:Request)=>{if(request.method!=='GET'||!new URL(request.url).pathname.startsWith('/api/public/replays/authored-notes'))return new Response(null,{status:404});return handler(request);};}
