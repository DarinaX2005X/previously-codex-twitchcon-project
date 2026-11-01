/** A scope-bound durable store. Implementations must make claim/take atomic. Never store provider tokens here. */
export interface ControlStore {
  get<T>(key: string): T | null;
  put(key: string, value: unknown, expiresAtMs?: number): void;
  delete(key: string): void;
  take<T>(key: string): T | null;
  claim(key: string, value: unknown, expiresAtMs?: number): boolean;
}

/** Bind repository controls to the already resolved channel/run; consumers cannot select another tenant. */
export function bindControlStore(repository: {
  controlGet<T>(scope:{channelId:string;runId:string},key:string):T|null;
  controlPut(scope:{channelId:string;runId:string},key:string,value:unknown,expiresAtMs?:number):void;
  controlDelete(scope:{channelId:string;runId:string},key:string):void;
  controlTake<T>(scope:{channelId:string;runId:string},key:string):T|null;
  controlClaim(scope:{channelId:string;runId:string},key:string,value:unknown,expiresAtMs?:number):boolean;
},scope:{channelId:string;runId:string}):ControlStore{return {
  get:<T>(key:string)=>repository.controlGet<T>(scope,key),
  put:(key,value,expires)=>repository.controlPut(scope,key,value,expires),
  delete:key=>repository.controlDelete(scope,key),
  take:<T>(key:string)=>repository.controlTake<T>(scope,key),
  claim:(key,value,expires)=>repository.controlClaim(scope,key,value,expires),
};}
