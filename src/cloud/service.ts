import { PublicSnapshotSchema, filterSnapshotAt, type PublicSnapshot } from '../shared/contracts/index.js';
import { type BlobStore, CasConflict } from './blob-store.js';
import { UploadSchema, OperationSchema, ManifestSchema, LIMITS, PublicationError, type ChannelHead, type PublicationAck, type PublicationOperation } from './contracts.js';
import { sha256 } from './signing.js';

const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
const decode=<T>(v:Uint8Array):T=>JSON.parse(new TextDecoder().decode(v)) as T;
const headPath=(id:string)=>`channels/${id}/head.json`;
const assetPath=(id:string,seq:number,exportId:string,revision:number,assetId:string,hash:string)=>`channels/${id}/objects/${seq}/exports/${exportId}/${revision}/${assetId}-${hash}`;
function bounded(bytes:Uint8Array,limit:number){if(bytes.byteLength>limit)throw new PublicationError(413,'payload_too_large');return bytes;}
function unique(ids:string[]){return new Set(ids).size===ids.length;}
const REVOKED_EXPORTS=50;

/** The caller supplies only reviewed published state. Strict schema rejects private extra fields. */
export function validatePublicSnapshot(input:unknown):PublicSnapshot{
  const snapshot=PublicSnapshotSchema.parse(input);
  bounded(encode(snapshot),LIMITS.snapshot);
  if(snapshot.session.status==='finalized'&&!snapshot.session.endedAt)throw new PublicationError(400,'finalized_episode_requires_end');
  if(!unique(snapshot.chapters.map(v=>v.id))||!unique(snapshot.moments.map(v=>v.id))||!unique(snapshot.lore.map(v=>v.id)))throw new PublicationError(400,'duplicate_public_id');
  const isTwitch=(raw:string,hosts:string[])=>{const u=new URL(raw);return u.protocol==='https:'&&hosts.includes(u.hostname)&&!u.username&&!u.password;};
  for(const moment of snapshot.moments)if(moment.clip&&(!isTwitch(moment.clip.url,['clips.twitch.tv','www.twitch.tv','twitch.tv'])||!isTwitch(moment.clip.embedUrl,['clips.twitch.tv','player.twitch.tv'])))throw new PublicationError(400,'unapproved_public_media');
  if(snapshot.vodUrl&&!isTwitch(snapshot.vodUrl,['www.twitch.tv','twitch.tv']))throw new PublicationError(400,'unapproved_public_media');
  return snapshot;
}

export class PublicationService {
  constructor(private readonly options:{store:BlobStore;channelLogin:string;now?:()=>number}){}
  private now(){return this.options.now?.()??Date.now();}
  private checkChannel(channelId:string,login:string){if(login!==this.options.channelLogin||!/^[a-zA-Z0-9_-]{1,120}$/.test(channelId))throw new PublicationError(403,'wrong_channel');}
  private async bindChannel(channelId:string){
    const path=`identities/${this.options.channelLogin}.json`,bytes=encode({channelId});
    try{await this.options.store.put(path,bytes,{contentType:'application/json'});}
    catch(error){if(!(error instanceof CasConflict))throw error;const old=await this.options.store.get(path);if(!old||decode<{channelId:string}>(old.bytes).channelId!==channelId)throw new PublicationError(403,'channel_identity_changed');}
  }
  async resolveChannel(){const blob=await this.options.store.get(`identities/${this.options.channelLogin}.json`);if(!blob)throw new PublicationError(404,'not_found');return decode<{channelId:string}>(blob.bytes).channelId;}
  async getHead(channelId:string){
    if(!/^[a-zA-Z0-9_-]{1,120}$/.test(channelId))throw new PublicationError(404,'not_found');
    const blob=await this.options.store.get(headPath(channelId));
    if(!blob)return null;
    const head=decode<ChannelHead>(bounded(blob.bytes,LIMITS.head));
    if(head.channelId!==channelId||head.channelLogin!==this.options.channelLogin)throw new PublicationError(404,'not_found');
    return {head,etag:blob.etag};
  }
  private async immutable(path:string,bytes:Uint8Array,mime='application/json'){
    try{await this.options.store.put(path,bytes,{contentType:mime});}
    catch(error){if(!(error instanceof CasConflict))throw error;const prior=await this.options.store.get(path);if(!prior||sha256(prior.bytes)!==sha256(bytes))throw new PublicationError(409,'immutable_conflict');}
  }
  private ack(head:ChannelHead,etag:string):PublicationAck{return {publishSeq:head.publishSeq,headEtag:etag,publicRevision:Math.max(0,...head.episodePointers.map(p=>p.publicationRevision)),lastSyncedAt:head.lastSyncedAt};}
  async publish(input:unknown,bodyHash:string):Promise<PublicationAck>{
    const op=OperationSchema.parse(input);bounded(encode(op),LIMITS.request);this.checkChannel(op.channelId,op.channelLogin);
    await this.bindChannel(op.channelId);
    for(let attempt=0;attempt<3;attempt++){
      const previous=await this.getHead(op.channelId), old=previous?.head;
      if(old&&op.publishSeq===old.publishSeq){if(bodyHash!==old.bodyHash)throw new PublicationError(409,'sequence_body_conflict');return this.ack(old,previous!.etag);}
      if(old&&op.publishSeq<old.publishSeq)throw new PublicationError(409,'stale_sequence');
      if(old&&op.privacyRevision<old.privacyRevision)throw new PublicationError(409,'stale_privacy');
      if(old&&op.privacyRevision>old.privacyRevision&&op.operation!=='retract')throw new PublicationError(409,'retraction_required');
      const now=this.now(),iso=new Date(now).toISOString();
      const head:ChannelHead=old?structuredClone(old):{schemaVersion:1,channelId:op.channelId,channelLogin:op.channelLogin,publishSeq:0,bodyHash:'',privacyRevision:0,activeSessionId:null,liveLeaseUntil:null,lastSyncedAt:iso,episodePointers:[],exports:[]};
      if(op.operation==='retract'){
        head.episodePointers=head.episodePointers.filter(p=>!op.sessionIds.includes(p.sessionId));
        head.exports=head.exports.map(p=>op.exportIds.includes(p.id)?{...p,status:'revoked'}:p);
        // Session withdrawal also revokes replay bundles whose primary source is that episode.
        for(const p of head.exports){if(p.status!=='active')continue;const blob=await this.options.store.get(p.manifestPath);if(!blob||sha256(blob.bytes)!==p.manifestHash)throw new PublicationError(503,'manifest_unavailable');const manifest=ManifestSchema.parse(decode(blob.bytes));if(op.sessionIds.includes(manifest.sourceSessionId))p.status='revoked';}
        if(head.activeSessionId&&op.sessionIds.includes(head.activeSessionId)&&!op.snapshots.some(s=>s.session.id===head.activeSessionId&&s.session.status!=='finalized')){head.activeSessionId=null;head.liveLeaseUntil=null;}
      }
      if(op.operation==='snapshot'||op.operation==='retract'){
        if(!unique(op.snapshots.map(s=>s.session.id)))throw new PublicationError(400,'duplicate_session');
        for(const raw of op.snapshots){
          const s=validatePublicSnapshot(raw);
          if(s.channel.id!==op.channelId||s.channel.login!==op.channelLogin)throw new PublicationError(403,'wrong_channel');
          const prior=old?.episodePointers.find(p=>p.sessionId===s.session.id);
          if(prior&&(s.revision<prior.publicationRevision||s.privacyEpoch<prior.privacyEpoch||(prior.status==='finalized'&&s.session.status!=='finalized')))throw new PublicationError(409,'stale_episode');
          const bytes=encode(s),hash=sha256(bytes),path=`channels/${op.channelId}/objects/${op.publishSeq}/snapshots/${s.revision}-${hash}.json`;
          await this.immutable(path,bytes);
          head.episodePointers=head.episodePointers.filter(p=>p.sessionId!==s.session.id);
          head.episodePointers.push({sessionId:s.session.id,publicationRevision:s.revision,privacyEpoch:s.privacyEpoch,snapshotPath:path,hash,status:s.session.status,updatedAt:iso,startedAt:s.session.startedAt});
        }
      }
      if(op.operation==='snapshot'){
        // A delayed durable retry may carry an expired lease. It can commit safely but remains
        // unreadable until a separately sequenced heartbeat; never stretch its original lease.
        if(op.liveLeaseUntil&&Date.parse(op.liveLeaseUntil)>now+30_000)throw new PublicationError(400,'invalid_live_lease');
        if(op.activeSessionId&&!head.episodePointers.some(p=>p.sessionId===op.activeSessionId&&p.status!=='finalized'))throw new PublicationError(400,'unknown_active_session');
        head.activeSessionId=op.activeSessionId;head.liveLeaseUntil=op.activeSessionId?op.liveLeaseUntil:null;
      }
      if(op.operation==='export_manifest'){
        const m=op.manifest,prior=head.exports.find(p=>p.id===m.id);
        if(prior&&m.revision<=prior.revision)throw new PublicationError(409,'stale_export');
        if(!unique(m.assets.map(a=>a.id)))throw new PublicationError(400,'duplicate_asset');
        for(const a of m.assets){const blob=await this.options.store.get(assetPath(op.channelId,op.publishSeq,m.id,m.revision,a.id,a.hash));if(!blob||blob.bytes.length!==a.bytes||sha256(blob.bytes)!==a.hash)throw new PublicationError(409,'unverified_asset');}
        const bytes=bounded(encode(m),LIMITS.snapshot),hash=sha256(bytes),path=`channels/${op.channelId}/objects/${op.publishSeq}/manifests/${m.id}-${m.revision}-${hash}.json`;
        await this.immutable(path,bytes);
        head.exports=head.exports.filter(p=>p.id!==m.id);head.exports.push({id:m.id,revision:m.revision,manifestPath:path,manifestHash:hash,publishSeq:op.publishSeq,status:'active'});
      }
      this.retain(head,op);
      if(head.episodePointers.length>LIMITS.episodes||head.exports.filter(p=>p.status==='active').length>LIMITS.exports)throw new PublicationError(409,'retention_capacity');
      head.publishSeq=op.publishSeq;head.bodyHash=bodyHash;head.privacyRevision=op.privacyRevision;head.lastSyncedAt=iso;
      let saved:{etag:string};
      try{saved=await this.options.store.put(headPath(op.channelId),bounded(encode(head),LIMITS.head),{ifMatch:previous?.etag,contentType:'application/json'});}
      catch(error){if(!(error instanceof CasConflict))throw error;continue;}
      // The committed head no longer references these objects, and no later sequence can: remove them now.
      if(old)await this.removeUnreferenced(op.channelId,old,head);
      return this.ack(head,saved.etag);
    }
    throw new PublicationError(503,'cas_retry_exhausted');
  }
  /** Retention keeps the newest finalized episodes and active exports; the live episode and this operation's own items stay. */
  private retain(head:ChannelHead,op:PublicationOperation){
    const keep=new Set([...op.operation==='export_manifest'?[]:op.snapshots.map(s=>s.session.id),...op.operation==='snapshot'&&op.activeSessionId?[op.activeSessionId]:[],...head.activeSessionId?[head.activeSessionId]:[]]);
    const evictable=head.episodePointers.filter(p=>!keep.has(p.sessionId)).sort((a,b)=>(a.startedAt??a.updatedAt).localeCompare(b.startedAt??b.updatedAt));
    const evicted=new Set(evictable.slice(0,Math.max(0,head.episodePointers.length-LIMITS.episodes)).map(p=>p.sessionId));
    head.episodePointers=head.episodePointers.filter(p=>!evicted.has(p.sessionId));
    const current=op.operation==='export_manifest'?op.manifest.id:null,active=head.exports.filter(p=>p.status==='active'&&p.id!==current).sort((a,b)=>a.publishSeq-b.publishSeq);
    for(const p of active.slice(0,Math.max(0,head.exports.filter(x=>x.status==='active').length-LIMITS.exports)))p.status='revoked';
    // A short tombstone list still fences replays of withdrawn export revisions without counting against capacity.
    const revoked=head.exports.filter(p=>p.status==='revoked').sort((a,b)=>b.publishSeq-a.publishSeq).slice(0,REVOKED_EXPORTS);
    head.exports=head.exports.filter(p=>p.status==='active'||revoked.includes(p));
  }
  /** Best effort: a failed delete leaves an unreferenced object that the signed maintenance endpoint can remove later. */
  private async removeUnreferenced(channelId:string,old:ChannelHead,head:ChannelHead){
    const kept=new Set(head.exports.filter(p=>p.status==='active').map(p=>p.manifestPath)),after=new Set([...head.episodePointers.map(p=>p.snapshotPath),...kept]);
    const before=new Set(old.episodePointers.map(p=>p.snapshotPath));
    for(const p of old.exports){
      if(p.status!=='active'||kept.has(p.manifestPath))continue;
      before.add(p.manifestPath);
      try{const blob=await this.options.store.get(p.manifestPath);if(blob&&sha256(blob.bytes)===p.manifestHash)for(const a of ManifestSchema.parse(decode(blob.bytes)).assets)before.add(assetPath(channelId,p.publishSeq,p.id,p.revision,a.id,a.hash));}catch{/* Its assets stay for maintenance. */}
    }
    for(const path of before)if(!after.has(path)){try{await this.options.store.delete(path);}catch{/* Retried by maintenance. */}}
  }
  async uploadAsset(input:unknown,bytes:Uint8Array){
    const meta=UploadSchema.parse(input);this.checkChannel(meta.channelId,meta.channelLogin);bounded(bytes,LIMITS.asset);
    await this.bindChannel(meta.channelId);
    if(bytes.length!==meta.asset.bytes||sha256(bytes)!==meta.asset.hash)throw new PublicationError(400,'asset_hash_mismatch');
    const current=await this.getHead(meta.channelId);
    if(current&&(meta.publishSeq<=current.head.publishSeq||meta.privacyRevision!==current.head.privacyRevision))throw new PublicationError(409,'stale_asset_upload');
    await this.immutable(assetPath(meta.channelId,meta.publishSeq,meta.exportId,meta.revision,meta.asset.id,meta.asset.hash),bytes,meta.asset.mime);
    return {id:meta.asset.id,hash:meta.asset.hash,bytes:bytes.length};
  }
  async readSnapshot(channelId:string,sessionId?:string,untilMs?:number){
    const current=await this.getHead(channelId);if(!current)throw new PublicationError(404,'not_found');
    const {head}=current,id=sessionId??head.activeSessionId??head.episodePointers.toSorted((a,b)=>(b.startedAt??b.updatedAt).localeCompare(a.startedAt??a.updatedAt))[0]?.sessionId;
    const pointer=head.episodePointers.find(p=>p.sessionId===id);if(!pointer)throw new PublicationError(410,'snapshot_revoked');
    if(pointer.status!=='finalized'&&(head.activeSessionId!==id||!head.liveLeaseUntil||Date.parse(head.liveLeaseUntil)<=this.now()))throw new PublicationError(503,'live_recap_unavailable');
    const blob=await this.options.store.get(pointer.snapshotPath);
    // An object removed after a newer commit replaced its pointer reads like any other replaced pointer.
    if(!blob&&(await this.getHead(channelId))?.head.episodePointers.find(p=>p.sessionId===id)?.snapshotPath!==pointer.snapshotPath)throw new PublicationError(409,'revalidate');
    if(!blob||sha256(blob.bytes)!==pointer.hash)throw new PublicationError(503,'snapshot_unavailable');
    let snapshot=validatePublicSnapshot(decode(blob.bytes));
    // A retraction arriving while the immutable object was loading must gate that read too.
    const latest=await this.getHead(channelId);if(latest?.head.episodePointers.find(p=>p.sessionId===id)?.snapshotPath!==pointer.snapshotPath)throw new PublicationError(409,'revalidate');
    if(pointer.status!=='finalized'&&(latest.head.activeSessionId!==id||!latest.head.liveLeaseUntil||Date.parse(latest.head.liveLeaseUntil)<=this.now()))throw new PublicationError(503,'live_recap_unavailable');
    snapshot={...snapshot,liveLeaseUntil:pointer.status==='finalized'?null:latest.head.liveLeaseUntil,lastSyncedAt:latest.head.lastSyncedAt};
    if(untilMs!==undefined){if(!Number.isSafeInteger(untilMs)||untilMs<0)throw new PublicationError(400,'invalid_cutoff');snapshot=filterSnapshotAt(snapshot,untilMs);}
    return snapshot;
  }
  async readManifest(channelId:string,exportId:string,revision:number){
    const head=await this.getHead(channelId),pointer=head?.head.exports.find(p=>p.id===exportId);
    if(!pointer||pointer.status!=='active'||pointer.revision!==revision)throw new PublicationError(410,'export_revoked');
    const blob=await this.options.store.get(pointer.manifestPath);
    if(!blob&&(await this.getHead(channelId))?.head.exports.find(p=>p.id===exportId&&p.status==='active')?.manifestPath!==pointer.manifestPath)throw new PublicationError(410,'export_revoked');
    if(!blob||sha256(blob.bytes)!==pointer.manifestHash)throw new PublicationError(503,'manifest_unavailable');
    const manifest=ManifestSchema.parse(decode(blob.bytes));
    const latest=await this.getHead(channelId),p=latest?.head.exports.find(p=>p.id===exportId);
    if(!p||p.status!=='active'||p.manifestPath!==pointer.manifestPath)throw new PublicationError(410,'export_revoked');
    return {manifest,publishSeq:pointer.publishSeq};
  }
  async readAsset(channelId:string,exportId:string,revision:number,assetId:string){
    const {manifest,publishSeq}=await this.readManifest(channelId,exportId,revision),asset=manifest.assets.find(a=>a.id===assetId);if(!asset)throw new PublicationError(404,'asset_not_found');
    const blob=await this.options.store.get(assetPath(channelId,publishSeq,exportId,revision,asset.id,asset.hash));
    if(!blob)await this.readManifest(channelId,exportId,revision);
    if(!blob||blob.bytes.length!==asset.bytes||sha256(blob.bytes)!==asset.hash)throw new PublicationError(503,'asset_unavailable');
    await this.readManifest(channelId,exportId,revision);
    return {bytes:blob.bytes,mime:asset.mime};
  }
  async maintenance(channelId:string,paths:string[]){
    if(paths.length>100)throw new PublicationError(400,'maintenance_capacity');
    const current=await this.getHead(channelId);if(!current)throw new PublicationError(404,'not_found');
    const refs=new Set(current.head.episodePointers.map(p=>p.snapshotPath));
    for(const p of current.head.exports){if(p.status!=='active')continue;refs.add(p.manifestPath);const {manifest}=await this.readManifest(channelId,p.id,p.revision);for(const a of manifest.assets)refs.add(assetPath(channelId,p.publishSeq,p.id,p.revision,a.id,a.hash));}
    const deleted:string[]=[];
    for(const path of paths){
      const prefix=`channels/${channelId}/objects/`;const match=path.startsWith(prefix)?path.slice(prefix.length).match(/^(\d+)\/[a-zA-Z0-9_/.\-]+$/):null;
      // Every future commit uses its own, strictly greater sequence: it cannot reference these paths.
      if(!match||path.includes('..')||Number(match[1])>=current.head.publishSeq||refs.has(path))continue;
      await this.options.store.delete(path);deleted.push(path);
    }
    return {deleted};
  }
}
export const createPublicationService=(options:ConstructorParameters<typeof PublicationService>[0])=>new PublicationService(options);
