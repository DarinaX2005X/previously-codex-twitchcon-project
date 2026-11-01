import {mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {Scope} from '../../shared/contracts/index.js';
import type {SqliteRepository,WorkLease} from '../storage/index.js';
import {ManifestSchema,type AssetUpload,type ExportManifest} from '../../cloud/contracts.js';
import type {ReviewedExport} from './recording-types.js';
import {unpackRecordingBundle} from './recording-package.js';

type Registration={exportId:string;recordingId:string;reviewReceiptId:string;sessionId:string;privacyEpoch:number;manifest:ExportManifest;sourceRefs:ReviewedExport['sourceRefs'];mediaRefs?:ReviewedExport['mediaRefs'];};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Original-source lineage lives in SQLite; public assets contain only the reviewed bundle. */
export class RecordingExportRegistry {
  private directory:string;
  constructor(private options:{repository:SqliteRepository;scope:Scope;dataDir:string;channelLogin:string;outputsBlocked?:()=>boolean}){this.directory=resolve(options.dataDir,'exports','reviewed-recordings');mkdirSync(this.directory,{recursive:true});}
  private path(exportId:string,assetId:string){if(!/^recording-[a-f0-9-]{36}$/.test(exportId)||!/^[-a-zA-Z0-9_]{1,120}$/.test(assetId))throw new Error('invalid_export_asset');const path=resolve(this.directory,`${exportId}.${assetId}.asset`);if(dirname(path)!==this.directory)throw new Error('invalid_export_path');return path;}
  private registration(exportId:string){return this.options.repository.controlGet<Registration>(this.options.scope,`recording-export:${exportId}`);}
  private valid(registration:Registration){const {repository,scope}=this.options;if(this.options.outputsBlocked?.())return false;const entity=repository.getEntity(scope,registration.exportId);return !!entity&&entity.kind==='export'&&entity.status==='active'&&entity.revision===registration.manifest.revision&&repository.getSession(scope,registration.sessionId).privacyEpoch===registration.privacyEpoch&&registration.sourceRefs.every(ref=>{const source=repository.getSource(scope,ref.id);return !!source&&source.status==='active'&&source.revision===ref.revision;})&&(registration.mediaRefs??[]).every(ref=>{const media=repository.getEntity(scope,ref.id);return !!media&&media.kind==='media'&&media.status==='active'&&media.revision===ref.revision;});}
  register=(value:ReviewedExport):{exportId:string;status:'staged'}=>{
    const {repository,scope}=this.options;if(this.options.outputsBlocked?.()||value.scope.channelId!==scope.channelId||value.scope.runId!==scope.runId||repository.getSession(scope,value.sourceSessionId).privacyEpoch!==value.privacyEpoch)throw new Error('export_source_changed');
    const manifest=ManifestSchema.parse(value.manifest),existing=this.registration(manifest.id);
    if(existing){if(existing.manifest.bundleHash!==manifest.bundleHash||!this.valid(existing))throw new Error('export_source_changed');return {exportId:manifest.id,status:'staged'};}
    for(const {asset,bytes}of value.assets){if(hash(bytes)!==asset.hash||bytes.length!==asset.bytes)throw new Error('export_asset_changed');const path=this.path(manifest.id,asset.id),temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,bytes,{flag:'wx',mode:0o600});try{renameSync(temp,path);}catch(error){try{unlinkSync(temp);}catch{}throw error;}}
    try{
      return repository.runIdempotentControl(scope,`recording-export:${manifest.id}`,{hash:manifest.bundleHash,receipt:value.reviewReceiptId},()=>{
        if(repository.getSession(scope,value.sourceSessionId).privacyEpoch!==value.privacyEpoch)throw new Error('export_source_changed');
        repository.saveEntity(scope,{id:manifest.id,sessionId:value.sourceSessionId,kind:'export',body:{manifest,reviewReceiptId:value.reviewReceiptId,recordingId:value.recordingId},refs:[...value.sourceRefs,...value.mediaRefs??[]],startMs:Math.min(...value.intervals.map(r=>r.startMs)),endMs:Math.max(...value.intervals.map(r=>r.endMs))});
        repository.controlPut(scope,`recording-export:${manifest.id}`,{exportId:manifest.id,recordingId:value.recordingId,reviewReceiptId:value.reviewReceiptId,sessionId:value.sourceSessionId,privacyEpoch:value.privacyEpoch,manifest,sourceRefs:value.sourceRefs,mediaRefs:value.mediaRefs??[]} satisfies Registration);
        return {exportId:manifest.id,status:'staged' as const};
      });
    }catch(error){for(const {asset}of value.assets)try{unlinkSync(this.path(manifest.id,asset.id));}catch{}throw error;}
  };
  /** Explicit owner Publish action queues work; start/stop/review/export never call it. */
  queue(exportId:string){const registration=this.registration(exportId);if(!registration||!this.valid(registration))throw new Error('export_source_changed');const publication=this.options.repository.preparePublication(this.options.scope,{sessionId:registration.sessionId,kind:'export_manifest',businessKey:`recording-publish:${exportId}:1`,payload:{manifest:registration.manifest,recordingExportId:exportId},dependencyRefs:registration.sourceRefs});return {...publication,exportId,status:'queued' as const};}
  /** MAIN calls from cloud buildOperation for an explicitly queued export before sending its manifest. */
  async uploadForLease(lease:WorkLease,upload:(metadata:AssetUpload,bytes:Uint8Array)=>Promise<void>){
    const data=lease.payload as {recordingExportId?:unknown},id=typeof data?.recordingExportId==='string'?data.recordingExportId:'';const registration=this.registration(id);
    if(lease.kind!=='export_manifest'||!lease.publishSeq||!registration||lease.sessionId!==registration.sessionId||lease.privacyEpoch!==registration.privacyEpoch||!this.valid(registration))throw new Error('export_source_changed');
    for(const asset of registration.manifest.assets){if(!this.valid(registration))throw new Error('export_source_changed');const path=this.path(id,asset.id);if(statSync(path).size!==asset.bytes)throw new Error('export_asset_changed');const bytes=new Uint8Array(readFileSync(path));if(hash(bytes)!==asset.hash)throw new Error('export_asset_changed');const sync=this.options.repository.getPublicationState(this.options.scope);await upload({channelId:this.options.scope.channelId,channelLogin:this.options.channelLogin,publishSeq:lease.publishSeq,privacyRevision:sync.privacyRevision,exportId:id,revision:registration.manifest.revision,asset},bytes);}
    if(!this.valid(registration))throw new Error('export_source_changed');
  }
  read(exportId:string){const registration=this.registration(exportId);if(!registration||!this.valid(registration))throw new Error('export_revoked');const bundle=unpackRecordingBundle(registration.manifest,asset=>{const path=this.path(exportId,asset.id);if(statSync(path).size!==asset.bytes)throw new Error('export_asset_changed');return new Uint8Array(readFileSync(path));});return {bytes:new TextEncoder().encode(JSON.stringify(bundle)),mime:'application/json'};}
  purgeInvalidated(){const {repository,scope}=this.options;let cursor:{startedAt:string;id:string}|undefined;for(;;){const sessions=repository.listSessions(scope,{limit:50,cursor});for(const session of sessions){let afterId='';for(;;){const entities=repository.listEntities(scope,session.id,{kind:'export',status:'hidden',limit:500,afterId});for(const entity of entities){const registration=this.registration(entity.id);if(registration)for(const asset of registration.manifest.assets)try{unlinkSync(this.path(entity.id,asset.id));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}if(entities.length<500)break;afterId=entities.at(-1)!.id;}}if(sessions.length<50)break;const last=sessions.at(-1)!;cursor={startedAt:last.startedAt,id:last.id};}}
}
