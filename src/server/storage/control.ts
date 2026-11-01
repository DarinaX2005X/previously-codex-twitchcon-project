import type { Scope, Settings } from '../../shared/contracts/index.js';
import { SettingsSchema, defaultSettings } from '../../shared/contracts/index.js';
import { StorageDatabase, StorageError, integer, json } from './database.js';

export class ControlPersistence {
  constructor(private readonly db:StorageDatabase,private readonly now:()=>number) {}
  private scoped(scope:Scope){return [scope.channelId,scope.runId] as const;}
  private key(key:string){if(!key || key.length>256)throw new StorageError('invalid_input','Control key exceeds its limit.');}
  private value(value:unknown):string {
    const body=json(value,32768);
    const visit=(item:unknown):void=>{
      if(item && typeof item==='object')for(const [key,child] of Object.entries(item)) {
        if(/^(access_?token|refresh_?token|client_?secret|authorization)$/i.test(key)) throw new StorageError('invalid_input','Provider credentials belong in the token vault.');
        visit(child);
      }
    };
    visit(value);return body;
  }
  get<T>(scope:Scope,key:string):T|null {
    this.key(key);
    const row=this.db.get('SELECT body FROM control_state WHERE channel_id=? AND run_id=? AND key=? AND (expires_at_ms IS NULL OR expires_at_ms>?)',...this.scoped(scope),key,this.now());
    return row ? JSON.parse(String(row.body)) as T : null;
  }
  put(scope:Scope,key:string,value:unknown,expiresAtMs?:number):void {
    this.key(key);const body=this.value(value);if(expiresAtMs!==undefined)integer(expiresAtMs);
    this.db.run('INSERT INTO control_state VALUES(?,?,?,?,?) ON CONFLICT(channel_id,run_id,key) DO UPDATE SET body=excluded.body,expires_at_ms=excluded.expires_at_ms',...this.scoped(scope),key,body,expiresAtMs ?? null);
  }
  delete(scope:Scope,key:string):boolean {this.key(key);return this.db.run('DELETE FROM control_state WHERE channel_id=? AND run_id=? AND key=?',...this.scoped(scope),key).changes===1;}
  take<T>(scope:Scope,key:string):T|null {return this.db.transaction(()=>{const value=this.get<T>(scope,key);this.delete(scope,key);return value;});}
  claim(scope:Scope,key:string,value:unknown,expiresAtMs?:number):boolean {
    return this.db.transaction(()=>{
      this.key(key);this.db.run('DELETE FROM control_state WHERE channel_id=? AND run_id=? AND key=? AND expires_at_ms<=?',...this.scoped(scope),key,this.now());
      if(this.db.get('SELECT 1 FROM control_state WHERE channel_id=? AND run_id=? AND key=?',...this.scoped(scope),key))return false;
      this.put(scope,key,value,expiresAtMs);return true;
    });
  }
  update<T>(scope:Scope,key:string,updater:(current:T|null)=>T|null,expiresAtMs?:number):T|null {
    return this.db.transaction(()=>{
      const next=updater(this.get<T>(scope,key));
      if(next instanceof Promise || (next && typeof next==='object' && 'then' in next))throw new StorageError('invalid_input','Control updates must be synchronous.');
      if(next===null)this.delete(scope,key);else this.put(scope,key,next,expiresAtMs);
      return next;
    });
  }
  settings(scope:Scope):Settings {
    if(!this.db.get('SELECT 1 FROM channels WHERE channel_id=? AND run_id=?',...this.scoped(scope)))throw new StorageError('inaccessible','Channel is unavailable.');
    const row=this.db.get('SELECT body FROM channel_settings WHERE channel_id=? AND run_id=?',...this.scoped(scope));
    return row ? SettingsSchema.parse(JSON.parse(String(row.body))) : structuredClone(defaultSettings);
  }
  updateSettings(scope:Scope,baseRevision:number,patch:Partial<Omit<Settings,'revision'>>):Settings {
    return this.db.transaction(()=>{
      const current=this.settings(scope);if(current.revision!==baseRevision)throw new StorageError('conflict','Settings have changed.');
      const parsed=SettingsSchema.safeParse({...current,...patch,revision:baseRevision+1});
      if(!parsed.success)throw new StorageError('invalid_input','Settings do not match the shared contract.');
      this.db.run('INSERT INTO channel_settings VALUES(?,?,?,?) ON CONFLICT(channel_id,run_id) DO UPDATE SET revision=excluded.revision,body=excluded.body',...this.scoped(scope),parsed.data.revision,json(parsed.data,32768));
      return parsed.data;
    });
  }
}
