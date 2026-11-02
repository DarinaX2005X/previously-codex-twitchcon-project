import {useCallback,useEffect,useState} from 'react';
import {ReplayClient,type ReplayView} from '../../replay/client.js';
import {ReplayGate} from '../../replay/gate.js';
import {recordedChat,type RecordedChat} from '../../replay/chat.js';
export type {RecordedChat};
export function useRecording(manifestUrl?:string){
  const [client,setClient]=useState<ReplayClient|null>(null),[view,setView]=useState<ReplayView|null>(null),[error,setError]=useState<string|null>(null),[origin,setOrigin]=useState<'authored'|'own-stream'|null>(null),[media,setMedia]=useState<{id:string;url:string}[]>([]),[chat,setChat]=useState<RecordedChat[]>([]),[mediaRanges,setMediaRanges]=useState<{id:string;startMs:number;endMs:number}[]>([]);
  const resolveMedia=useCallback((id:string)=>media.find(m=>id===m.id||id.endsWith(`~${m.id}`))?.url,[media]);
  useEffect(()=>{
    let disposed=false,replay:ReplayClient|undefined,unsubscribe:(()=>void)|undefined,gate:ReplayGate|undefined,phase='manifest';
    const discovery=new AbortController();
    const focus=()=>{void gate?.revalidate();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    const load=async()=>{
      let path=manifestUrl;
      if(!path){const response=await fetch('/api/public/replays',{cache:'no-store',credentials:'omit',signal:AbortSignal.any([discovery.signal,AbortSignal.timeout(4500)])});if(!response.ok)throw new Error('recording_unavailable');const value=await response.json();if(!value||typeof value.id!=='string'||!/^[-a-zA-Z0-9_]{1,120}$/.test(value.id))throw new Error('recording_invalid');path=`/api/public/replays/${encodeURIComponent(value.id)}`;}
      if(disposed)return;
      gate=new ReplayGate(path,reason=>{replay?.dispose();setMedia([]);setClient(null);setView(null);setError(reason);});
      const bundle=await gate.load();if(disposed)return;phase='worker';setOrigin(bundle.origin);setChat(recordedChat(bundle));setMediaRanges(bundle.media.map(m=>({id:m.id,startMs:m.startMs,endMs:m.endMs})));setMedia(bundle.media.flatMap(m=>{const url=gate!.mediaUrl(m.assetId);return url?[{id:m.id,url}]:[];}));replay=new ReplayClient(new Worker(new URL('../../replay/worker.ts',import.meta.url),{type:'module'}),()=>{if(!disposed){gate?.dispose();setMedia([]);setClient(null);setView(null);setError('The recording stopped. Reload to start a new run.');}});unsubscribe=replay.observe(setView);await replay.initialize(bundle);if(disposed){replay.dispose();return;}setClient(replay);
    };
    void load().catch(failure=>{if(!disposed){const code=failure instanceof Error&&/^[a-z_]{1,80}$/.test(failure.message)?failure.message:failure instanceof Error?failure.name:'unknown';console.warn('Recording initialization failed',phase,code);gate?.dispose();replay?.dispose();setMedia([]);setClient(null);setView(null);setError('The recording is unavailable. Reload to try again.');}});
    return()=>{disposed=true;discovery.abort();window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);unsubscribe?.();gate?.dispose();replay?.dispose();};
  },[manifestUrl]);
  /** Timeline seek to a recorded offset in ms; resolves once the replay has executed up to that time. */
  const seek=useCallback((atMs:number)=>client?client.seekTo(atMs):Promise.reject(new Error('recording_unavailable')),[client]);
  return {client,view,error,origin,resolveMedia,chat,mediaRanges,seek};
}
