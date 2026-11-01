import { CasConflict, type BlobStore, type BlobObject } from '../../src/cloud/blob-store.js';
import type { PublicSnapshot } from '../../src/shared/contracts/index.js';
export class MemoryBlobStore implements BlobStore{
  data=new Map<string,BlobObject>();version=0;conflicts=0;
  beforeGet?: (path:string)=>Promise<void>;beforePut?:(path:string)=>Promise<void>;
  async get(path:string){await this.beforeGet?.(path);const v=this.data.get(path);return v?structuredClone(v):null;}
  async put(path:string,bytes:Uint8Array,options:{ifMatch?:string;contentType:string}){
    await this.beforePut?.(path);const previous=this.data.get(path);
    if(options.ifMatch?previous?.etag!==options.ifMatch:!!previous){this.conflicts++;throw new CasConflict();}
    const etag=`etag-${++this.version}`;this.data.set(path,{bytes:bytes.slice(),etag,uploadedAt:Date.now()});return {etag};
  }
  async delete(path:string){this.data.delete(path);}
}
export const NOW=Date.parse('2026-11-02T12:00:00.000Z');
export function snapshot(id='episode1',revision=1,status:'live'|'closing'|'finalized'='live'):PublicSnapshot{return {
  schemaVersion:1,channel:{id:'channel123',login:'authored_channel',displayName:'Authored channel'},session:{id,title:'Fixture title',category:'Science',startedAt:new Date(NOW-120_000).toISOString(),endedAt:status==='finalized'?new Date(NOW).toISOString():null,status,metadataMaxDependencyEndMs:10},revision,privacyEpoch:0,language:'en',asOf:new Date(NOW-75_000).toISOString(),publishedAt:new Date(NOW).toISOString(),liveLeaseUntil:status==='finalized'?null:new Date(NOW+30_000).toISOString(),current:{goal:'A known goal',change:null,now:'Checking',sourceTimeMs:10,maxDependencyEndMs:90},chapters:[{id:'chapter1',revision:1,title:'Title',summary:'A safe authored summary',startMs:10,endMs:20,mood:'focused',claimIds:[],momentIds:['moment1'],pinned:false,edited:false,sourceLabels:[],maxDependencyEndMs:100}],lore:[{id:'lore1',term:'term',explanation:'An authored meaning',firstSeenMs:1,originMs:null,originKind:'unknown',momentId:'moment1',maxDependencyEndMs:80}],moments:[{id:'moment1',startMs:5,endMs:10,label:'Moment',triggerReasons:[],clip:null,mediaState:'none',maxDependencyEndMs:120}],gaps:[],lastSyncedAt:null,vodUrl:null,
};}
