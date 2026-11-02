import {canonical,isRefActive,type DomainEffect,type DomainState} from '../../core/index.js';
import {type Channel,type Clock,type PublicSnapshot,type Scope,type SourceStatus} from '../../shared/contracts/index.js';
import {LocalPublisher,TerminalPublicationError,heartbeatOperation,validatePublicSnapshot,signedHeaders,type PublicationLease,type PublicationRepository} from '../publication/index.js';
import {ManifestSchema,type PublicationOperation,type PublicationAck} from '../../cloud/contracts.js';
import type {StoryEngine,RuntimeStorage} from './engine.js';
import type {RevisionStream} from './updates.js';
import type {RecordingExportRegistry} from '../replay/recording-registry.js';

export type CloudRuntimeOptions={scope:Scope;channel:Channel;engine:StoryEngine;storage:RuntimeStorage;publicOrigin?:string;sharedSecret?:string;clock:Clock;fetch?:typeof fetch;updates?:RevisionStream;recordingExports?:Pick<RecordingExportRegistry,'uploadForLease'>};
type HeartbeatMarker={publishSeq:number;sessionId:string;atMs:number;terminal:boolean};
const HEARTBEAT='cloud:heartbeat';
const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];
const payload=(lease:PublicationLease):Record<string,unknown>=>lease.payload&&typeof lease.payload==='object'?lease.payload as Record<string,unknown>:{};
const forgotten=(state:DomainState)=>state.tombstones.some(t=>t.kind==='session'&&t.sessionId===state.session.id);
const content=(snapshot:PublicSnapshot)=>{const {liveLeaseUntil:_lease,lastSyncedAt:_sync,...rest}=snapshot;return canonical(rest);};

/** Local-only adapter. Domain transitions already persist publication effects atomically; this bridge never duplicates them. */
export function createCloudRuntime(options:CloudRuntimeOptions){
  const {scope,channel,engine,storage,clock}=options,repository=storage.repository;
  let closed=false,busy=false,lastLease:PublicationLease|null=null;
  const lifetime=new AbortController();
  let outputWindow=new AbortController();
  const enabled=scope.runId==='live'&&!!options.publicOrigin&&!!options.sharedSecret;
  const sync=()=>repository.getPublicationState(scope);
  const status=(state:SourceStatus['state'],message:string|null,action:string|null=null)=>{
    const last=sync().lastSyncedAtMs;engine.setStatus('cloud',{state,message,action,lastObservedAt:last===null?null:new Date(last).toISOString()});
  };
  const pending=()=>status('delayed','Saved locally. Public update pending.');
  const settled=()=>{const state=sync();if(state.pendingPrivacy||state.publishSeq>state.ackSeq)pending();else if(state.ackSeq>0)status('ready',null);else status('disconnected','The public recap will connect when safe content is ready.');};
  function activeForCloud(fallback?:string):string|null{
    const live=engine.activeSessionId();
    if(live){const state=engine.state(live);return state.published&&!forgotten(state)?live:null;}
    if(fallback){const state=engine.state(fallback);if(state.session.status==='closing'&&state.published&&!forgotten(state))return fallback;}
    const closing=repository.listSessions(scope,{limit:50}).filter(s=>s.status==='closing').sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
    for(const session of closing){const state=engine.state(session.id);if(state.published&&!forgotten(state))return session.id;}
    return null;
  }
  function publicState(sessionId:string):PublicSnapshot|null{
    const state=engine.state(sessionId);if(!state.published||forgotten(state))return null;
    return validatePublicSnapshot(state.published);
  }
  async function buildOperation(lease:PublicationLease):Promise<PublicationOperation>{
    const current=sync(),body=payload(lease),common={channelId:scope.channelId,channelLogin:channel.login,publishSeq:lease.publishSeq!,privacyRevision:current.privacyRevision};
    if(lease.kind==='retract'){
      // Every retract also carries all still-owed withdrawals, so one dropped or superseded retract is never lost.
      const owed=repository.listOwedRetractions(scope);
      const sessionIds=[...new Set([...body.exportOnly===true?[]:[lease.sessionId,...strings(body.affectedSessionIds),...strings(body.sessionIds)],...owed.filter(item=>item.kind==='session').map(item=>item.id)])].slice(0,100);
      const exportIds=[...new Set([...strings(body.exportIds),...strings(body.affectedIds).filter(id=>repository.getEntity(scope,id)?.kind==='export'),...owed.filter(item=>item.kind==='export').map(item=>item.id)])].slice(0,10);
      return {...common,operation:'retract',sessionIds,exportIds,snapshots:sessionIds.map(publicState).filter((s):s is PublicSnapshot=>s!==null)};
    }
    if(lease.kind==='export_manifest'){
      if(body.recordingExportId){
        if(!options.recordingExports)throw new Error('Recording exports are unavailable');
        await options.recordingExports.uploadForLease(lease,async(metadata,bytes)=>{
          if(closed||engine.outputsBlocked()||!repository.renewOutbox(scope,lease.id,lease.leaseToken,30_000))throw new Error('Recording publication was revoked');
          const path='/api/publish/export-assets',framed=Buffer.concat([Buffer.from(JSON.stringify(metadata)+'\n'),Buffer.from(bytes)]);
          const response=await (options.fetch??fetch)(new URL(path,options.publicOrigin!),{method:'POST',headers:{'Content-Type':'application/octet-stream',...signedHeaders(options.sharedSecret!,'POST',path,scope.channelId,lease.publishSeq!,framed,clock.now())},body:framed,redirect:'error',signal:AbortSignal.any([lifetime.signal,outputWindow.signal,AbortSignal.timeout(20_000)])});
          // A newer publication overtook this upload's sequence; only a new publication attempt can succeed.
          if(response.status===409){await response.body?.cancel();throw new TerminalPublicationError('Recording upload was overtaken');}
          if(!response.ok){await response.body?.cancel();throw new Error('Recording upload requires retry');}
          await response.body?.cancel();
        });
      }
      return {...common,operation:'export_manifest',manifest:ManifestSchema.parse(body.manifest)};
    }
    const activeSessionId=activeForCloud(lease.sessionId);
    if(body.heartbeat===true){if(!activeSessionId||activeSessionId!==lease.sessionId)throw new TerminalPublicationError('Heartbeat session is no longer active');return heartbeatOperation({...common,activeSessionId,now:clock.now()});}
    const snapshot=publicState(lease.sessionId);if(!snapshot)throw new Error('Published snapshot is unavailable');
    const snapshots=[snapshot];
    // An older episode can finalize while the new stream starts; atomically retain the new live pointer.
    if(activeSessionId&&activeSessionId!==lease.sessionId){const active=publicState(activeSessionId);if(active)snapshots.push(active);}
    return {...common,operation:'snapshot',snapshots,activeSessionId,liveLeaseUntil:activeSessionId?new Date(clock.now()+30_000).toISOString():null};
  }
  function validate(lease:PublicationLease,operation:PublicationOperation):boolean{
    try{
      if(closed||!enabled||engine.outputsBlocked()||operation.channelId!==scope.channelId||operation.channelLogin!==channel.login||operation.publishSeq!==lease.publishSeq||operation.privacyRevision!==sync().privacyRevision)return false;
      const session=repository.getSession(scope,lease.sessionId);if(session.privacyEpoch!==lease.privacyEpoch)return false;
      if(operation.operation==='export_manifest'){
        const entity=repository.getEntity(scope,operation.manifest.id);return !!entity&&entity.kind==='export'&&entity.status==='active'&&entity.sessionId===operation.manifest.sourceSessionId&&entity.revision===operation.manifest.revision;
      }
      if(operation.operation==='snapshot'&&operation.activeSessionId!==activeForCloud(lease.sessionId))return false;
      if(payload(lease).heartbeat===true&&operation.operation==='snapshot'&&(!operation.liveLeaseUntil||Date.parse(operation.liveLeaseUntil)<=clock.now()))return false;
      for(const snapshot of operation.snapshots){
        const state=engine.state(snapshot.session.id),current=state.published;
        if(!current||forgotten(state)||state.session.privacyEpoch!==snapshot.privacyEpoch||current.revision!==snapshot.revision||content(current)!==content(snapshot))return false;
        // Defense in depth: every visible canonical entity must still have active source lineage.
        for(const item of [...snapshot.chapters,...snapshot.lore,...snapshot.moments]){
          const node=state.nodes[item.id];if(node&&(!node.active||![...node.supports,...node.exposedTo].every(ref=>isRefActive(state,ref))))return false;
        }
      }
      return true;
    }catch{return false;}
  }
  async function onAck(ack:PublicationAck,operation:PublicationOperation){
    if(closed)return;
    if(operation.operation!=='export_manifest')for(const snapshot of operation.snapshots){
      const state=engine.state(snapshot.session.id);
      if(state.published?.revision!==snapshot.revision||state.session.privacyEpoch!==snapshot.privacyEpoch)continue;
      await engine.dispatch(snapshot.session.id,{type:'cloud.ack',revision:snapshot.revision,at:ack.lastSyncedAt});
      options.updates?.publish({...scope,event:'publication.synced',data:{sessionId:snapshot.session.id,revision:snapshot.revision}});
    }
    if(operation.operation==='snapshot'&&operation.activeSessionId&&(!operation.liveLeaseUntil||Date.parse(operation.liveLeaseUntil)<=clock.now()))enqueueHeartbeat(true);
    settled();
  }
  const port:PublicationRepository={
    // While a withdrawal is owed, the cloud rejects newer privacy revisions without it: send the retraction first.
    claimOutbox:(s,args)=>{lastLease=repository.claimOutbox(s,repository.listOwedRetractions(s,1).length?{...args,kinds:['retract']}:args);return lastLease;},
    freezePublication:(...args)=>repository.freezePublication(...args),renewOutbox:(...args)=>repository.renewOutbox(...args),acknowledgePublication:(...args)=>repository.acknowledgePublication(...args),
    finishOutbox:(s,id,token,state,nextAt)=>{
      const saved=repository.finishOutbox(s,id,token,state,nextAt);
      if(saved&&state==='failed'&&nextAt===undefined&&lastLease?.id===id&&payload(lastLease).heartbeat===true){
        const marker=repository.controlGet<HeartbeatMarker>(scope,HEARTBEAT);if(marker?.publishSeq===lastLease.publishSeq)repository.controlPut(scope,HEARTBEAT,{...marker,terminal:true});
      }
      return saved;
    },
  };
  let publisher:LocalPublisher|null=null;
  if(enabled){
    try{publisher=new LocalPublisher({repository:port,scope,publicOrigin:options.publicOrigin!,secret:options.sharedSecret!,now:()=>clock.now(),buildOperation,validate,onAck,fetch:(input,init)=>{const signals=[lifetime.signal,outputWindow.signal,...(init?.signal?[init.signal]:[])];return(options.fetch??fetch)(input,{...init,signal:AbortSignal.any(signals)});}});enqueueHeartbeat();settled();}
    catch{status('error','Public recap configuration needs attention.','Check public recap setup');}
  }else status('unconfigured',scope.runId==='live'?'Configure the public recap to publish safe updates.':'Replay stays local; cloud publication is disabled.');

  let retractionRetryAtMs=0;
  /** An owed withdrawal whose retract rows were dropped (revalidation, supersession, a rejected request) is sent again. */
  function ensureRetraction(){
    if(!publisher||closed||engine.outputsBlocked()||clock.now()<retractionRetryAtMs)return;
    const owed=repository.listOwedRetractions(scope,1)[0];
    if(!owed||repository.hasPendingRetraction(scope))return;
    retractionRetryAtMs=clock.now()+10_000;
    repository.preparePublication(scope,{sessionId:owed.sessionId,kind:'retract',businessKey:`owed-retraction:${sync().publishSeq}:${clock.now()}`,payload:{exportOnly:true,owed:true},priority:1000});
  }
  function enqueueHeartbeat(force=false){
    if(!publisher||closed||engine.outputsBlocked())return;
    const current=sync(),marker=repository.controlGet<HeartbeatMarker>(scope,HEARTBEAT),activeSessionId=activeForCloud();
    if(!activeSessionId||current.pendingPrivacy)return;
    // At most one pending heartbeat. A terminal expired heartbeat may be replaced by a new empty-body lease update.
    const terminalOnly=marker?.terminal&&marker.publishSeq===current.publishSeq;
    if(current.publishSeq>current.ackSeq&&!terminalOnly)return;
    if(!force&&clock.now()-Math.max(marker?.atMs??0,current.lastSyncedAtMs??0)<10_000)return;
    const atMs=clock.now(),created=repository.preparePublication(scope,{sessionId:activeSessionId,kind:'publish',businessKey:`cloud-heartbeat:${activeSessionId}:${Math.floor(atMs/10_000)}`,payload:{heartbeat:true},priority:-100});
    repository.controlPut(scope,HEARTBEAT,{publishSeq:created.publishSeq,sessionId:activeSessionId,atMs,terminal:false} satisfies HeartbeatMarker);
  }
  return {
    suspend(){outputWindow.abort();},
    resume(){if(outputWindow.signal.aborted)outputWindow=new AbortController();},
    onEffects(_sessionId:string,effects:readonly DomainEffect[],_state:DomainState){if(publisher&&!closed&&effects.some(effect=>effect.type==='publication'||effect.type==='privacy'))pending();},
    async tick():Promise<'idle'|'acknowledged'|'retry'|'cancelled'>{
      if(closed||!publisher||busy||engine.outputsBlocked())return 'idle';busy=true;
      try{
        ensureRetraction();enqueueHeartbeat();const result=await publisher.tick();
        if(result==='retry')status('error','Saved locally. The public recap could not be reached and the update is pending.','Check connection');
        else if(result==='cancelled'){const current=sync();if(current.publishSeq>current.ackSeq)pending();else settled();}
        else if(result==='acknowledged')settled();
        return result;
      }finally{busy=false;}
    },
    close(){closed=true;lifetime.abort();},
  };
}
export type CloudRuntime=ReturnType<typeof createCloudRuntime>;
