import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,unlinkSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {RecordingRecord} from './recording-types.js';

/** Private, bounded files only. URLs and client paths never select a filesystem location. */
export class RecordingStore {
  readonly directory:string;
  constructor(dataDir:string){this.directory=resolve(dataDir,'exports','private-recordings');mkdirSync(this.directory,{recursive:true});}
  private file(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('invalid_recording_id');const path=resolve(this.directory,id+'.json');if(dirname(path)!==this.directory)throw new Error('invalid_recording_path');return path;}
  list():RecordingRecord[]{const names=readdirSync(this.directory).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name));if(names.length>20)throw new Error('recording_retention_limit');return names.map(name=>this.read(name.slice(0,-5)));}
  read(id:string):RecordingRecord{const file=this.file(id);if(statSync(file).size>8_000_000)throw new Error('private_recording_too_large');const value=JSON.parse(readFileSync(file,'utf8')) as RecordingRecord;if(value.id!==id||value.schemaVersion!==1)throw new Error('invalid_private_recording');return value;}
  write(record:RecordingRecord){const bytes=JSON.stringify(record);if(Buffer.byteLength(bytes)>8_000_000)throw new Error('private_recording_too_large');const path=this.file(record.id),temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});try{renameSync(temporary,path);}catch(error){try{unlinkSync(temporary);}catch{}throw error;}}
  remove(id:string){try{unlinkSync(this.file(id));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  command<T>(key:string,requestHash:string,action:()=>T):T {const path=resolve(this.directory,'commands.json');let ledger:Record<string,{hash:string;result:T}>={};try{if(statSync(path).size>1_000_000)throw new Error('recording_command_limit');ledger=JSON.parse(readFileSync(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const old=ledger[key];if(old){if(old.hash!==requestHash)throw new Error('recording_idempotency_conflict');return old.result;}if(Object.keys(ledger).length>=500)throw new Error('recording_command_limit');const result=action();ledger[key]={hash:requestHash,result};const temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(ledger),{flag:'wx',mode:0o600});try{renameSync(temporary,path);}catch(error){try{unlinkSync(temporary);}catch{}throw error;}return result;}
}
