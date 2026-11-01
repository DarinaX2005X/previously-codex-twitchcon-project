import {useEffect,useMemo,useState} from 'react';
import {Button,QuietButton,SegmentedControl} from '../../ui/index.js';
import {DockPage} from '../dock/index.js';
import {ScenePreview} from '../overlay/index.js';
import type {RecapPlan,Source} from '../../shared/contracts/index.js';
import {useRecording} from './useRecording.js';
import './replay.css';
const time=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;

export function ReplayPage({manifestUrl}:{manifestUrl?:string}){
  const {client,view,error,origin,resolveMedia}=useRecording(manifestUrl),[dock,setDock]=useState(false),[evidence,setEvidence]=useState<Source[]|null>(null),[actionError,setActionError]=useState<string|null>(null),[preview,setPreview]=useState<RecapPlan|null>(null),[busy,setBusy]=useState(false);
  const s=view?.snapshot,t=view?.transport,published=s?.published,chapter=published?.chapters.at(-1),active=s?.playback.find(p=>p.status==='playing'&&p.plan);
  const owner=useMemo(()=>client?{listSources:client.listSources.bind(client),editLore:async()=>{throw new Error('This recording has no safety check for this edit');},confirmLore:async()=>{throw new Error('This recording has no recorded lore confirmation');},deleteLore:async(id:string)=>client.privacy({kind:'entity',sessionId:client.view!.snapshot.session!.id,id},'Replay lore deletion'),blockLore:async()=>{throw new Error('This recording has no recorded lore');}}:undefined,[client]);
  const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setActionError(null);try{await action();}catch(e){setActionError(e instanceof Error?e.message:'Action failed');}finally{setBusy(false);}};
  useEffect(()=>{setEvidence(null);setPreview(null);},[s?.published?.privacyEpoch,s?.session?.id,s?.published?.revision]);
  useEffect(()=>{if(!client){setEvidence(null);setPreview(null);setDock(false);}},[client]);
  const elapsed=active?.startAt&&s?Math.max(0,Date.parse(s.serverNow)-Date.parse(active.startAt)):0;
  return <main className="replay-page">
    <header className="replay-heading"><div><a href="/" className="replay-brand">Previously</a><h1>{'Recorded stream'}</h1><p>{origin==='own-stream'?('An owned stream recording. Changes stay in this tab.'):('An authored example, not a live stream. Changes stay in this tab.')}</p></div><a href="/setup">{'Set up my channel'}</a></header>
    {error?<div className="replay-unavailable" role="alert"><h2>Recording unavailable</h2><p>{error}</p><Button onClick={()=>location.reload()}>Reload recording</Button></div>:!client||!view?<div className="replay-unavailable" role="status">Loading the current recording…</div>:<>
      <section className="replay-stage" aria-label={'Current stream context'}>
        {active?.plan?<ScenePreview plan={active.plan} timeMs={elapsed} playing={t!.playing} channel={s!.channel.displayName} title={published?.session.title} soundEnabled={false} resolveMedia={resolveMedia}/>:<div className="replay-story">
          <span className="replay-stage-label">{'The stream so far'}</span>
          {published?.current?<><p className="replay-goal">{published.current.goal}</p><h2>{published.current.now??chapter?.title}</h2><p className="replay-change">{published.current.change??chapter?.summary}</p></>:<><h2>{s!.held.length?('The edit is held for review'):t!.atMs>=76000?('No published context remains'):t!.atMs<1000?('From spoken context to the story so far'):('Context is held before publication')}</h2><p>{t!.atMs>=76000?('Restart to restore the original recording in this tab.'):t!.atMs<1000?('Play the recording, then jump to the raid to see its welcome scene.'):('The first checked context publishes at 1:16. You can jump straight to the raid.')}</p></>}
          <span className="replay-source-note">{published?.current?`${'Source'} ${time(published.current.sourceTimeMs)} · ${chapter?.edited?('Owner correction'):('Speech')}`:'Text example, no recorded video'}</span>
        </div>}
      </section>
      <section className="replay-transport" aria-label="Playback controls">
        <div className="replay-transport-row"><Button disabled={busy} onClick={()=>void run(()=>client.controlReplay({action:t!.playing?'pause':'play'}))}>{t!.playing?('Pause'):('Play recording')}</Button><QuietButton onClick={()=>void run(()=>client.controlReplay({action:'reset'}))}>{'Restart'}</QuietButton><QuietButton onClick={()=>void run(async()=>{await client.controlReplay({action:'seek',milestone:'raid'});await client.controlReplay({action:'play'});})}>{'Jump to raid'}</QuietButton><output>{time(t!.atMs)} / {time(t!.durationMs)}</output></div>
        <div className="replay-progress" role="progressbar" aria-label="Recording position" aria-valuemin={0} aria-valuemax={t!.durationMs} aria-valuenow={Math.round(t!.atMs)}><span style={{width:`${t!.atMs/t!.durationMs*100}%`}}/></div>
        <div className="replay-transport-row replay-secondary"><SegmentedControl label="Recording speed" value={String(t!.speed)} options={[{value:'1',label:'1×'},{value:'2',label:'2×'},{value:'4',label:'4×'}]} onChange={speed=>void run(()=>client.controlReplay({action:t!.playing?'play':'pause',speed:Number(speed) as 1|2|4}))}/><span>{t!.speed===1?('Recorded time'):('Accelerated recorded time')}</span><SegmentedControl label="Recap language" value={s!.settings.recapLanguage} options={[{value:'en',label:'English'},{value:'ru',label:'Русский'}]} onChange={language=>void run(()=>client.setSettings({baseRevision:s!.settings.revision,recapLanguage:language as 'en'|'ru'}))}/><QuietButton onClick={()=>setDock(!dock)}>{dock?('Close demo dock'):('Open demo dock')}</QuietButton></div>
      </section>
      <section className="replay-after"><div><h2>{'Make one correction'}</h2><p>{'Jump to the raid, apply the checked correction, then preview the next scene.'}</p><blockquote>{t!.correction.summary}</blockquote><div className="replay-transport-row"><Button disabled={!chapter||busy} onClick={()=>void run(()=>client.editChapter(chapter!.id,{...t!.correction,baseRevision:chapter!.revision}))}>{'Apply correction'}</Button><QuietButton disabled={!chapter} onClick={()=>void run(async()=>setPreview(await client.previewRecap(s!.session!.id)))}>{'Preview next recap'}</QuietButton></div><p className="replay-small">{'Open the demo dock to type your own edit. Unrecorded wording stays held because this recording has no safety check for it.'}</p></div><div className="replay-evidence"><h2>{'From source to chapter'}</h2><p>{chapter?.summary??('Published context appears after its safety check and hold.')}</p><QuietButton disabled={!chapter} onClick={()=>void run(async()=>setEvidence(evidence?null:await client.getEvidence(chapter!.id)))}>{evidence?('Hide source'):('Show source')}</QuietButton>{evidence&&<div className="replay-source-drawer">{evidence.map(source=><blockquote key={source.id}><span>{time(source.startMs)} · {source.kind==='owner_statement'?'Owner correction':'Speech'}</span>{source.text}</blockquote>)}<p>{'Checked wording passes the same publication hold used by the live stream.'}</p></div>}</div></section>
      {(actionError||t!.error==='fixture_missing')&&<p role="status" className="replay-action-error">{actionError??'This recording has no safety check for this edit. The edit remains held.'}</p>}
      {dock&&<section className="replay-dock" aria-label="Demo dock"><DockPage client={client} owner={owner} clockMode="snapshot" recording label="Recorded stream" renderPreview={(plan,close)=><div><ScenePreview plan={plan} playing soundEnabled={false} resolveMedia={resolveMedia}/><QuietButton onClick={close}>Close preview</QuietButton></div>}/></section>}
      {preview&&<section className="replay-preview" aria-label="Local scene preview"><div className="replay-transport-row"><h2>{'Next recap preview'}</h2><QuietButton onClick={()=>setPreview(null)}>{'Close preview'}</QuietButton></div><ScenePreview plan={preview} playing soundEnabled={false} resolveMedia={resolveMedia}/></section>}
    </>}
  </main>;
}




