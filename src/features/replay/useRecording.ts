import {useEffect,useState} from 'react';
import {ReplayClient,type ReplayView} from '../../replay/client.js';
import {ReplayGate} from '../../replay/gate.js';
export function useRecording(manifestUrl='/api/public/replays/authored-notes'){
  const [client,setClient]=useState<ReplayClient|null>(null),[view,setView]=useState<ReplayView|null>(null),[error,setError]=useState<string|null>(null),[origin,setOrigin]=useState<'authored'|'own-stream'|null>(null);
  useEffect(()=>{
    let disposed=false,replay:ReplayClient|undefined,unsubscribe:(()=>void)|undefined;
    const gate=new ReplayGate(manifestUrl,reason=>{replay?.dispose();setClient(null);setView(null);setError(reason);});
    const focus=()=>{void gate.revalidate();};window.addEventListener('focus',focus);
    void gate.load().then(async bundle=>{if(disposed)return;setOrigin(bundle.origin);replay=new ReplayClient(new Worker(new URL('../../replay/worker.ts',import.meta.url),{type:'module'}));unsubscribe=replay.observe(setView);await replay.initialize(bundle);if(disposed){replay.dispose();return;}setClient(replay);}).catch(()=>{if(!disposed){gate.dispose();replay?.dispose();setClient(null);setView(null);setError('The recording is unavailable. Reload to try again.');}});
    return()=>{disposed=true;window.removeEventListener('focus',focus);unsubscribe?.();gate.dispose();replay?.dispose();};
  },[manifestUrl]);
  return {client,view,error,origin};
}
