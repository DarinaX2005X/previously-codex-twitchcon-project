import {useCallback,useEffect,useState} from 'react';
import {ReplayClient,type ReplayView} from '../../replay/client.js';
import {ReplayGate} from '../../replay/gate.js';
export function useRecording(manifestUrl='/api/public/replays/authored-notes'){
  const [client,setClient]=useState<ReplayClient|null>(null),[view,setView]=useState<ReplayView|null>(null),[error,setError]=useState<string|null>(null),[origin,setOrigin]=useState<'authored'|'own-stream'|null>(null),[media,setMedia]=useState<{id:string;url:string}[]>([]);
  const resolveMedia=useCallback((id:string)=>media.find(m=>id===m.id||id.endsWith(`~${m.id}`))?.url,[media]);
  useEffect(()=>{
    let disposed=false,replay:ReplayClient|undefined,unsubscribe:(()=>void)|undefined,phase='manifest';
    const gate=new ReplayGate(manifestUrl,reason=>{replay?.dispose();setMedia([]);setClient(null);setView(null);setError(reason);});
    const focus=()=>{void gate.revalidate();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    void gate.load().then(async bundle=>{if(disposed)return;phase='worker';setOrigin(bundle.origin);setMedia(bundle.media.flatMap(m=>{const url=gate.mediaUrl(m.assetId);return url?[{id:m.id,url}]:[];}));replay=new ReplayClient(new Worker(new URL('../../replay/worker.ts',import.meta.url),{type:'module'}),()=>{if(!disposed){gate.dispose();setMedia([]);setClient(null);setView(null);setError('The recording stopped. Reload to start a new run.');}});unsubscribe=replay.observe(setView);await replay.initialize(bundle);if(disposed){replay.dispose();return;}setClient(replay);}).catch(failure=>{if(!disposed){const code=failure instanceof Error&&/^[a-z_]{1,80}$/.test(failure.message)?failure.message:failure instanceof Error?failure.name:'unknown';console.warn('Recording initialization failed',phase,code);gate.dispose();replay?.dispose();setMedia([]);setClient(null);setView(null);setError('The recording is unavailable. Reload to try again.');}});
    return()=>{disposed=true;window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);unsubscribe?.();gate.dispose();replay?.dispose();};
  },[manifestUrl]);
  return {client,view,error,origin,resolveMedia};
}
