import type { Scope } from '../../shared/contracts/index.js';
import type { WorkLease } from '../storage/index.js';
import { OperationSchema, type PublicationOperation, type PublicationAck } from '../../cloud/contracts.js';
import { sha256, signedHeaders } from '../../cloud/signing.js';
export { validatePublicSnapshot } from '../../cloud/service.js';
export { signedHeaders, sha256 } from '../../cloud/signing.js';
export type { PublicationOperation, PublicationAck, AssetUpload, ExportManifest } from '../../cloud/contracts.js';

export type FrozenPublication={body:string;bodyHash:string};
/** Thrown while building a lease that can never succeed; it is finished without a retry. */
export class TerminalPublicationError extends Error {}
export type PublicationLease=WorkLease&{frozenPublication?:FrozenPublication|null};
export interface PublicationRepository {
  claimOutbox(scope:Scope,options:{kinds:string[];leaseMs:number}):PublicationLease|null;
  freezePublication(scope:Scope,id:string,leaseToken:string,input:FrozenPublication):FrozenPublication|null;
  renewOutbox(scope:Scope,id:string,leaseToken:string,leaseMs:number):boolean;
  finishOutbox(scope:Scope,id:string,leaseToken:string,state:'done'|'failed'|'unknown_outcome',nextAtMs?:number):boolean;
  acknowledgePublication(scope:Scope,publishSeq:number,bodyHash:string):boolean;
}
export type PublisherOptions={repository:PublicationRepository;scope:Scope;publicOrigin:string;secret:string;now?:()=>number;fetch?:typeof fetch;buildOperation:(lease:PublicationLease)=>PublicationOperation|Promise<PublicationOperation>;validate:(lease:PublicationLease,operation:PublicationOperation)=>boolean|Promise<boolean>;onAck?:(ack:PublicationAck,operation:PublicationOperation)=>void|Promise<void>};
export class LocalPublisher {
  private running=false;
  constructor(private readonly options:PublisherOptions){const origin=new URL(options.publicOrigin);if(origin.protocol!=='https:'&&origin.hostname!=='127.0.0.1'&&origin.hostname!=='localhost')throw new Error('Public origin requires HTTPS');if(options.secret.length<32)throw new Error('Publication secret requires at least 32 characters');}
  /** One bounded durable job. Scheduler calls this; no persistent cloud worker exists. */
  async tick():Promise<'idle'|'acknowledged'|'retry'|'cancelled'>{
    if(this.running)return 'idle';this.running=true;
    const {repository,scope}=this.options;let lease:PublicationLease|null=null;
    try{
      lease=repository.claimOutbox(scope,{kinds:['retract','publish','export_manifest'],leaseMs:30_000});if(!lease)return 'idle';
      if(!lease.publishSeq){repository.finishOutbox(scope,lease.id,lease.leaseToken,'failed');return 'cancelled';}
      let frozen:FrozenPublication|null|undefined=lease.frozenPublication;
      if(!frozen){
        const operation=OperationSchema.parse(await this.options.buildOperation(lease));
        if(operation.publishSeq!==lease.publishSeq||operation.channelId!==scope.channelId||!await this.options.validate(lease,operation)){repository.finishOutbox(scope,lease.id,lease.leaseToken,'failed');return 'cancelled';}
        const body=JSON.stringify(operation);frozen=repository.freezePublication(scope,lease.id,lease.leaseToken,{body,bodyHash:sha256(body)});
        if(!frozen)return 'cancelled';
      }
      const operation=OperationSchema.parse(JSON.parse(frozen.body));
      if(operation.publishSeq!==lease.publishSeq||operation.channelId!==scope.channelId||sha256(frozen.body)!==frozen.bodyHash||!await this.options.validate(lease,operation)||!repository.renewOutbox(scope,lease.id,lease.leaseToken,30_000)){repository.finishOutbox(scope,lease.id,lease.leaseToken,'failed');return 'cancelled';}
      const now=this.options.now?.()??Date.now(),path='/api/publish';
      const response=await (this.options.fetch??fetch)(new URL(path,this.options.publicOrigin),{method:'POST',headers:{'content-type':'application/json',...signedHeaders(this.options.secret,'POST',path,scope.channelId,lease.publishSeq,frozen.body,now)},body:frozen.body,signal:AbortSignal.timeout(20_000)});
      if(response.ok){
        const ack=await response.json() as PublicationAck;
        if(ack.publishSeq!==lease.publishSeq||typeof ack.headEtag!=='string'||!ack.headEtag||!Number.isSafeInteger(ack.publicRevision)||ack.publicRevision<0||!Number.isFinite(Date.parse(ack.lastSyncedAt)))throw new Error('Invalid publication ACK');
        // A privacy transaction may have cancelled this lease during fetch; never clear its pending status.
        if(!await this.options.validate(lease,operation)||!repository.finishOutbox(scope,lease.id,lease.leaseToken,'done'))return 'cancelled';
        if(!repository.acknowledgePublication(scope,lease.publishSeq,frozen.bodyHash))return 'cancelled';
        await this.options.onAck?.(ack,operation);return 'acknowledged';
      }
      if(response.status>=400&&response.status<500&&response.status!==429){repository.finishOutbox(scope,lease.id,lease.leaseToken,'failed');return 'cancelled';}
      throw new Error('Publication requires retry');
    }catch(error){
      if(lease&&error instanceof TerminalPublicationError){repository.finishOutbox(scope,lease.id,lease.leaseToken,'failed');return 'cancelled';}
      if(lease){const backoff=Math.min(60_000,1000*2**Math.min(6,lease.attempts));repository.finishOutbox(scope,lease.id,lease.leaseToken,'failed',(this.options.now?.()??Date.now())+backoff);}
      return 'retry';
    }finally{this.running=false;}
  }
}

/** Build a heartbeat without changing publishedAt or source asOf; sequence is assigned by SQLite. */
export function heartbeatOperation(input:{channelId:string;channelLogin:string;publishSeq:number;privacyRevision:number;activeSessionId:string;now:number}):PublicationOperation{
  return {operation:'snapshot',channelId:input.channelId,channelLogin:input.channelLogin,publishSeq:input.publishSeq,privacyRevision:input.privacyRevision,activeSessionId:input.activeSessionId,liveLeaseUntil:new Date(input.now+30_000).toISOString(),snapshots:[]};
}
