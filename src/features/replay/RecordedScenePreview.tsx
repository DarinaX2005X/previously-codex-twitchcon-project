import {useEffect,useState} from 'react';
import {ScenePreview} from '../overlay/index.js';
import type {RecapPlan} from '../../shared/contracts/index.js';
import {useRecording} from './useRecording.js';
export function RecordedScenePreview({manifestUrl}:{manifestUrl?:string}){
  const {client,error,view,resolveMedia}=useRecording(manifestUrl),[plan,setPlan]=useState<RecapPlan|null>(null),[playing,setPlaying]=useState(false);
  useEffect(()=>{let disposed=false;setPlan(null);if(client)void client.controlReplay({action:'seek',milestone:'published'}).then(()=>client.getSnapshot()).then(s=>client.previewRecap(s.session!.id)).then(value=>{if(!disposed)setPlan(value);});return()=>{disposed=true;};},[client]);
  if(error)return <p className="replay-preview-unavailable">The recorded scene is currently unavailable.</p>;
  if(!plan||!view)return <p className="replay-preview-unavailable">Loading the recorded scene…</p>;
  return <div className="recorded-scene-preview"><ScenePreview key={playing?'playing':'settled'} plan={plan} timeMs={playing?undefined:12000} viewerSkip={playing} clipAudio playing={playing} soundEnabled={false} resolveMedia={resolveMedia} onEnded={()=>setPlaying(false)}/><button type="button" disabled={playing} onClick={()=>setPlaying(true)}>{playing?'Playing scene':'Play scene'}</button></div>;
}

