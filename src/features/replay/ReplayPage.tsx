import {useEffect,useMemo,useState} from 'react';
import {Brand,Button,QuietButton,SegmentedControl} from '../../ui/index.js';
import {DockPage} from '../dock/index.js';
import {ScenePreview,renderAt,resolveSceneLayout} from '../overlay/index.js';
import type {RecapPlan,Source} from '../../shared/contracts/index.js';
import {useRecording} from './useRecording.js';
import './replay.css';

const time=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
const beatLabels={context:'Stream context',attempt:'The goal',change:'What changed',origin:'Where it started',now:'What matters now'};
const sourceLabels:Record<Source['kind'],string>={speech:'Speech',chat:'Chat',channel_metadata:'Stream details',owner_statement:'Streamer statement',stream_event:'Stream event'};
function sourceExcerpt(text:string){
  const characters=[...text];if(characters.length<=160)return {text,truncated:false};
  const head=characters.slice(0,160).join(''),boundary=head.lastIndexOf(' ');
  return {text:(boundary>110?head.slice(0,boundary):head).trimEnd(),truncated:true};
}

export function ReplayPage({manifestUrl}:{manifestUrl?:string}){
  const {client,view,error,origin,resolveMedia}=useRecording(manifestUrl);
  const [dock,setDock]=useState(false),[evidence,setEvidence]=useState<Source[]|null>(null),[actionError,setActionError]=useState<string|null>(null),[preview,setPreview]=useState<RecapPlan|null>(null),[busy,setBusy]=useState(false);
  const [sceneMediaUnavailable,setSceneMediaUnavailable]=useState(false);
  const [reducedMotion,setReducedMotion]=useState(()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{const preference=matchMedia('(prefers-reduced-motion: reduce)'),update=()=>setReducedMotion(preference.matches);preference.addEventListener('change',update);return()=>preference.removeEventListener('change',update);},[]);
  const s=view?.snapshot,t=view?.transport,published=s?.published,chapter=published?.chapters.at(-1),active=s?.playback.find(p=>p.status==='playing'&&p.plan);
  const publishMilestone=t?.milestones.find(m=>m.id==='published');
  const raidMilestone=t?.milestones.find(m=>m.id==='raid');
  const correctionId=t?.correction.targetId;
  const correctionChapter=correctionId?published?.chapters.find(c=>c.id===correctionId):published?.chapters.length===1?published.chapters[0]:undefined;
  const owner=useMemo(()=>client?{
    listSources:client.listSources.bind(client),
    editLore:async()=>{throw new Error('This recording has no safety check for this edit');},
    confirmLore:async()=>{throw new Error('This recording has no recorded lore confirmation');},
    deleteLore:async(id:string)=>client.privacy({kind:'entity',sessionId:client.view!.snapshot.session!.id,id},'Replay lore deletion'),
    blockLore:async()=>{throw new Error('This recording has no recorded lore');}
  }:undefined,[client]);
  const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setActionError(null);try{await action();}catch(e){setActionError(e instanceof Error?e.message:'The action could not be completed. Try again.');}finally{setBusy(false);}};
  useEffect(()=>{setEvidence(null);setPreview(null);},[s?.published?.privacyEpoch,s?.session?.id,s?.published?.revision]);
  useEffect(()=>{if(!client){setEvidence(null);setPreview(null);setDock(false);}},[client]);
  const elapsed=active?.startAt&&s?Math.max(0,Date.parse(s.serverNow)-Date.parse(active.startAt)):0;
  const activePlan=useMemo(()=>active?.plan??null,[active?.id,active?.plan?.revision,active?.plan?.privacyEpoch]);
  const sceneLayout=useMemo(()=>activePlan?resolveSceneLayout(activePlan.layout):null,[activePlan]);
  const activeFrame=activePlan&&sceneLayout?renderAt(elapsed,activePlan,sceneLayout,{reducedMotion}):null;
  const visibleCaption=activeFrame?.openingExit&&activeFrame.openingExit>.9?(activeFrame.nextCaption&&activeFrame.nextCaption.reveal>.5?activeFrame.nextCaption:activeFrame.caption):null;
  useEffect(()=>setSceneMediaUnavailable(false),[activePlan?.id]);
  const current=published?.current;
  const currentText=current?.now??chapter?.summary??current?.goal??current?.change;
  const hasContext=!!currentText;
  const removedContext=!!publishMilestone&&!!t&&t.atMs>=publishMilestone.atMs&&!hasContext;
  const held=!!s?.held.length;
  const incomingSource=!hasContext&&!held&&!removedContext?t?.latestSource:null;
  const incomingExcerpt=incomingSource?sourceExcerpt(incomingSource.text):null;
  const sourceIsExcerpt=!!incomingSource&&(incomingSource.truncated||!!incomingExcerpt?.truncated);
  const untilPublication=publishMilestone&&t?Math.max(0,Math.ceil((publishMilestone.atMs-t.atMs)/1000)):null;
  return <main className="replay-page">
    <nav className="replay-nav" aria-label="Replay navigation">
      <a href="/" aria-label="Previously home"><Brand/></a>
      <a href="/setup">Set up my channel</a>
    </nav>
    <header className="replay-heading">
      <h1>Recorded stream</h1>
      <p>{origin==='own-stream'?'Play the stream and try a correction. Changes stay in this tab.':'Explore an authored text example with no recorded video. Changes stay in this tab.'}</p>
    </header>
    {error?<section className="replay-unavailable" role="alert"><h2>Recording unavailable</h2><p>{error}</p><Button onClick={()=>location.reload()}>Reload recording</Button></section>:!client||!view?<section className="replay-unavailable" role="status">Loading the recording…</section>:<>
      <div className="replay-player">
        <section className={`replay-stage ${active?.plan?'replay-stage--scene':''}`} data-theme="dark" aria-label="Stream recap">
          {activePlan?<>
            <ScenePreview plan={activePlan} timeMs={elapsed} playing={t!.playing} channel={s!.channel.displayName} title={published?.session.title} soundEnabled={false} resolveMedia={resolveMedia} onStatus={status=>{if(status==='media_unavailable')setSceneMediaUnavailable(true);}}/>
            {visibleCaption&&visibleCaption.reveal>.05&&<div className={`replay-mobile-context ${activePlan.media.length&&!sceneMediaUnavailable?'replay-mobile-context--assistive':''}`}>
              <p className="replay-mobile-context-label"><span>{beatLabels[visibleCaption.kind]}</span><span>Source {time(visibleCaption.sourceMs)}</span></p>
              <p>{visibleCaption.text}</p>
            </div>}
          </>:<div className={`replay-story ${hasContext?'':incomingSource?'replay-story--source':'replay-story--empty'}`}>
            {hasContext?<>
              <p className="replay-current">{currentText}</p>
              {(current?.goal&&current.goal!==currentText||current?.change&&current.change!==currentText)&&<dl className="replay-story-details">
                {current?.goal&&current.goal!==currentText&&<div><dt>The goal</dt><dd>{current.goal}</dd></div>}
                {current?.change&&current.change!==currentText&&<div><dt>What changed</dt><dd>{current.change}</dd></div>}
              </dl>}
              {current&&<p className="replay-source-time">Context from {time(current.sourceTimeMs)}</p>}
            </>:incomingSource&&incomingExcerpt?<>
              <figure className="replay-incoming-source">
                <blockquote>{incomingExcerpt.text}{sourceIsExcerpt?'…':''}</blockquote>
                <figcaption>{sourceLabels[incomingSource.kind]}{sourceIsExcerpt?' excerpt':''} at {time(incomingSource.startMs)}</figcaption>
              </figure>
              {publishMilestone&&untilPublication!==null&&untilPublication>0&&<p className="replay-source-hold">Recap publication at {time(publishMilestone.atMs)}. {untilPublication} s of recording remaining.</p>}
            </>:<>
              <h2>{held?'The edit is waiting for review':removedContext?'The published recap has been cleared':s!.session?.title||'Waiting for the first recap'}</h2>
              <p>{held?'The recording does not include a safety check for this wording. You can restore the original by restarting.':removedContext?'Restart to restore the original recording in this tab.':publishMilestone?`The first recap appears at ${time(publishMilestone.atMs)}. Play from the start${raidMilestone?' or jump to the incoming raid':''}.`:'Play the recording to follow its published recap.'}</p>
            </>}
          </div>}
        </section>
        <section className="replay-transport" aria-label="Playback controls">
          <div className="replay-transport-row replay-primary-controls">
            <Button disabled={busy} onClick={()=>void run(()=>client.controlReplay({action:t!.playing?'pause':'play'}))}>{t!.playing?'Pause':'Play recording'}</Button>
            <QuietButton disabled={busy} onClick={()=>void run(()=>client.controlReplay({action:'reset'}))}>Restart</QuietButton>
            {raidMilestone&&<QuietButton disabled={busy} onClick={()=>void run(async()=>{await client.controlReplay({action:'seek',milestone:raidMilestone.id});await client.controlReplay({action:'play'});})}>Jump to raid</QuietButton>}
            <output aria-label="Recording position">{time(t!.atMs)} <span>/ {time(t!.durationMs)}</span></output>
          </div>
          <div className="replay-progress" role="progressbar" aria-label="Recording position" aria-valuemin={0} aria-valuemax={t!.durationMs} aria-valuenow={Math.round(t!.atMs)}><span style={{width:`${t!.durationMs?t!.atMs/t!.durationMs*100:0}%`}}/></div>
          <div className="replay-secondary-controls">
            <div className="replay-control-group"><span>Playback speed</span><SegmentedControl label="Recording speed" disabled={busy} value={String(t!.speed)} options={[{value:'1',label:'1×'},{value:'2',label:'2×'},{value:'4',label:'4×'}]} onChange={speed=>void run(()=>client.controlReplay({action:t!.playing?'play':'pause',speed:Number(speed) as 1|2|4}))}/>{t!.speed!==1&&<span className="replay-speed-note">Accelerated recording</span>}</div>
            <div className="replay-control-group"><span>Recap language</span><SegmentedControl label="Recap language" disabled={busy} value={s!.settings.recapLanguage} options={[{value:'en',label:'English'},{value:'ru',label:'Русский'}]} onChange={language=>void run(()=>client.setSettings({baseRevision:s!.settings.revision,recapLanguage:language as 'en'|'ru'}))}/></div>
            <QuietButton aria-expanded={dock} aria-controls="replay-demo-dock" onClick={()=>setDock(!dock)}>{dock?'Close demo dock':'Open demo dock'}</QuietButton>
          </div>
        </section>
      </div>
      {(actionError||t!.error==='fixture_missing')&&<p role="status" className="replay-action-error">{actionError??'This recording has no safety check for this edit. The edit remains held.'}</p>}
      <div className="replay-after">
        <section className="replay-evidence" aria-labelledby="replay-source-title">
          <h2 id="replay-source-title">Published chapter</h2>
          {chapter?<><h3>{chapter.title}</h3><p>{chapter.summary}</p><QuietButton disabled={busy} aria-expanded={!!evidence} aria-controls="replay-source-drawer" onClick={()=>void run(async()=>setEvidence(evidence?null:await client.getEvidence(chapter.id)))}>{evidence?'Hide source':'Show source'}</QuietButton></>:<p>The chapter will appear here when its context is published.</p>}
          {evidence&&<div className="replay-source-drawer" id="replay-source-drawer">{evidence.map(source=><figure key={source.id}><figcaption>{time(source.startMs)} {source.kind==='owner_statement'?'Owner correction':source.kind==='speech'?'Speech':'Source'}</figcaption><blockquote>{source.text}</blockquote></figure>)}</div>}
        </section>
        <section className="replay-correction" aria-labelledby="replay-correction-title">
          <h2 id="replay-correction-title">Change the recap</h2>
          <p className="replay-field-label">Suggested correction</p>
          <blockquote>{t!.correction.summary}</blockquote>
          <div className="replay-transport-row"><Button disabled={!correctionChapter||busy||t!.correctionApplied} onClick={()=>void run(()=>client.editChapter(correctionChapter!.id,{title:t!.correction.title,summary:t!.correction.summary,baseRevision:correctionChapter!.revision}))}>{t!.correctionApplied?'Correction applied':'Apply correction'}</Button><QuietButton disabled={!chapter||busy} onClick={()=>void run(async()=>setPreview(await client.previewRecap(s!.session!.id)))}>Preview next recap</QuietButton></div>
          {!correctionChapter&&<p className="replay-help">{!chapter?'Play the recording to publish a chapter first.':'Open the demo dock to choose a chapter to edit.'}</p>}
          <p className="replay-help">New wording stays held unless this recording includes its safety check.</p>
        </section>
      </div>
      {dock&&<section className="replay-dock" id="replay-demo-dock" aria-label="Demo dock"><DockPage client={client} owner={owner} clockMode="snapshot" recording label="Recorded stream" renderPreview={(plan,close)=><div><ScenePreview plan={plan} playing soundEnabled={false} resolveMedia={resolveMedia}/><QuietButton onClick={close}>Close preview</QuietButton></div>}/></section>}
      {preview&&<section className="replay-preview" aria-label="Local scene preview"><div className="replay-transport-row"><h2>Next recap preview</h2><QuietButton onClick={()=>setPreview(null)}>Close preview</QuietButton></div><ScenePreview plan={preview} playing soundEnabled={false} resolveMedia={resolveMedia}/></section>}
    </>}
  </main>;
}
