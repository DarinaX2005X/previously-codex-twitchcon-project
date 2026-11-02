import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,unlinkSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {RecordingRecord} from './recording-types.js';

/** Private, bounded files only. URLs and client paths never select a filesystem location. */
export class RecordingStore {
  readonly directory:string;
  static readonly COMMAND_TTL_MS=24*3600_000;static readonly COMMAND_LIMIT=500;
  constructor(dataDir:string,private readonly now:()=>number=Date.now){this.directory=resolve(dataDir,'exports','private-recordings');mkdirSync(this.directory,{recursive:true});}
  private file(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('invalid_recording_id');const path=resolve(this.directory,id+'.json');if(dirname(path)!==this.directory)throw new Error('invalid_recording_path');return path;}
  list():RecordingRecord[]{const names=readdirSync(this.directory).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name));if(names.length>20)throw new Error('recording_retention_limit');return names.map(name=>this.read(name.slice(0,-5)));}
  read(id:string):RecordingRecord{const file=this.file(id);if(statSync(file).size>32_000_000)throw new Error('private_recording_too_large');const value=JSON.parse(readFileSync(file,'utf8')) as RecordingRecord;if(value.id!==id||value.schemaVersion!==1)throw new Error('invalid_private_recording');return value;}
  write(record:RecordingRecord){const bytes=JSON.stringify(record);if(Buffer.byteLength(bytes)>32_000_000)throw new Error('private_recording_too_large');const path=this.file(record.id),temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});try{renameSync(temporary,path);}catch(error){try{unlinkSync(temporary);}catch{}throw error;}}
  remove(id:string){try{unlinkSync(this.file(id));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  private mediaPath(id:string,assetId:string){this.file(id);if(!/^media-[a-f0-9]{32}$/.test(assetId))throw new Error('invalid_recording_asset');return resolve(this.directory,`${id}.${assetId}.asset`);}
  writeMedia(id:string,assetId:string,bytes:Uint8Array){if(bytes.length>3_000_000||!bytes.length)throw new Error('recording_media_size');writeFileSync(this.mediaPath(id,assetId),bytes,{mode:0o600});}
  readMedia(id:string,assetId:string){const path=this.mediaPath(id,assetId);if(statSync(path).size>3_000_000)throw new Error('recording_media_size');return new Uint8Array(readFileSync(path));}
  removeMedia(id:string,assetId:string){try{unlinkSync(this.mediaPath(id,assetId));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  private asyncTail:Promise<unknown>=Promise.resolve();
  /** Idempotency ledger: retries only need recent entries, so old and excess entries are evicted instead of blocking every later command. */
  private ledger<T>():Record<string,{hash:string;result:T;at?:number}>{
    const path=resolve(this.directory,'commands.json');
    try{if(statSync(path).size>8_000_000)return {};return JSON.parse(readFileSync(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {};}
  }
  private replay<T>(ledger:Record<string,{hash:string;result:T;at?:number}>,key:string,requestHash:string):{result:T}|null{const old=ledger[key];if(!old)return null;if(old.hash!==requestHash)throw new Error('recording_idempotency_conflict');return {result:old.result};}
  private save<T>(ledger:Record<string,{hash:string;result:T;at?:number}>,key:string,requestHash:string,result:T){
    const now=this.now(),path=resolve(this.directory,'commands.json');
    // Expire entries after a day (entries without a timestamp predate expiry), oldest first.
    const kept=Object.entries(ledger).filter(([,entry])=>now-(entry.at??0)<RecordingStore.COMMAND_TTL_MS).sort(([,a],[,b])=>(a.at??0)-(b.at??0));
    kept.push([key,{hash:requestHash,result,at:now}]);
    while(kept.length>RecordingStore.COMMAND_LIMIT)kept.shift();
    let bytes=JSON.stringify(Object.fromEntries(kept));
    // Always keep the newest entry so its retry stays idempotent.
    while(kept.length>1&&Buffer.byteLength(bytes)>1_000_000){kept.shift();bytes=JSON.stringify(Object.fromEntries(kept));}
    const temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});try{renameSync(temporary,path);}catch(error){try{unlinkSync(temporary);}catch{}throw error;}
  }
  commandAsync<T>(key:string,requestHash:string,action:()=>Promise<T>):Promise<T>{const execute=async()=>{const old=this.replay(this.ledger<T>(),key,requestHash);if(old)return old.result;const result=await action();return this.command(key,requestHash,()=>result);};const result=this.asyncTail.then(execute,execute);this.asyncTail=result.catch(()=>{});return result;}
  command<T>(key:string,requestHash:string,action:()=>T):T {const ledger=this.ledger<T>(),old=this.replay(ledger,key,requestHash);if(old)return old.result;const result=action();this.save(ledger,key,requestHash,result);return result;}
}
