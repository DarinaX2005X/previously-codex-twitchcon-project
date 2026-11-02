import {useEffect,useMemo,useState} from 'react';
import {PublicSnapshotSchema,filterSnapshotAt,type PublicSnapshot} from '../../shared/contracts/index.js';
import {PublicRecapPage,type PublicRecapClient} from '../public/index.js';
import {useRecording} from './useRecording.js';

/** The public recap of the example recording, opened at /example (never at /c/<login>, which belongs to real channels). */
export const EXAMPLE_LOGIN='foxlight_dev';
const EXAMPLE_RECORDING='/api/public/replays/foxlight';
export const EXAMPLE_NOTICE='This is an example recording of a game development stream. It shows the public recap a viewer can read when the raid arrives.';
const RUNTIME_SCOPE=/[0-9a-f]{16}~/g;

/**
 * The published snapshot of a replay run, as a public reader receives it. Recording offsets stay unchanged;
 * wall-clock fields are moved so that the replay position is the reader's present, and a fresh live lease is
 * granted for this read only. Runtime scope prefixes are removed from identifiers.
 */
export function exampleSnapshot(snapshot:PublicSnapshot,atMs:number,now:number):PublicSnapshot {
  const value=JSON.parse(JSON.stringify(snapshot).replace(RUNTIME_SCOPE,'')) as PublicSnapshot,started=Date.parse(snapshot.session.startedAt),startedAt=now-atMs;
  const shift=(iso:string)=>new Date(Date.parse(iso)-started+startedAt).toISOString();
  return PublicSnapshotSchema.parse({...value,session:{...value.session,startedAt:shift(value.session.startedAt),endedAt:value.session.endedAt&&shift(value.session.endedAt)},
    asOf:shift(value.asOf),publishedAt:shift(value.publishedAt),liveLeaseUntil:value.session.status==='finalized'?null:new Date(now+30_000).toISOString(),lastSyncedAt:new Date(now).toISOString()});
}

const unavailable=()=>Object.assign(new Error('The example recording is unavailable.'),{status:410});
function waitForAbort(signal?:AbortSignal):Promise<never>{return new Promise((_,reject)=>{signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});}

/** Reuses the real public recap page with the snapshot the replay publishes at its raid. Withdrawal removes it. */
export function ExampleRecapPage({login}:{login:string}){
  // The example recording by id: a channel's own published recording is never shown under the example login.
  const {client,error,resolveMedia}=useRecording(EXAMPLE_RECORDING);
  const [state,setState]=useState<{snapshot:PublicSnapshot;atMs:number;clips:Record<string,string>}|null>(null);
  useEffect(()=>{
    setState(null);if(!client)return;let active=true;
    void (async()=>{
      const raid=client.view?.transport.milestones.find(m=>m.id==='raid');
      if(raid)await client.controlReplay({action:'seek',milestone:raid.id});
      const owner=await client.getSnapshot();
      // Clips come from the same gated recording; a withdrawn recording takes them away with the page.
      const clips=Object.fromEntries(owner.moments.flatMap(moment=>moment.mediaId&&moment.mediaState==='ready'?[[moment.id.replace(RUNTIME_SCOPE,''),moment.mediaId]]:[]));
      if(active&&owner.published)setState({snapshot:owner.published,atMs:client.view?.transport.atMs??raid?.atMs??0,clips});
    })().catch(()=>{if(active)setState(null);});
    return()=>{active=false;};
  },[client]);
  const reader=useMemo<PublicRecapClient>(()=>({
    async getPublicSnapshot(requested,options){
      if(error||requested!==login)throw unavailable();
      if(!state)return waitForAbort(options?.signal);
      const snapshot=exampleSnapshot(state.snapshot,state.atMs,Date.now());
      return options?.untilMs===undefined?snapshot:filterSnapshotAt(snapshot,options.untilMs);
    },
  }),[state,error,login]);
  const clipUrl=useMemo(()=>(momentId:string)=>{const media=error?undefined:state?.clips[momentId];return media?resolveMedia(media):undefined;},[state,error,resolveMedia]);
  return <PublicRecapPage client={reader} login={login} example={{notice:EXAMPLE_NOTICE,clipUrl}}/>;
}
