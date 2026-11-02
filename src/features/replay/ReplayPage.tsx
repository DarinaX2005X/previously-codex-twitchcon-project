import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Brand,Button,ClipFrame,LorePlate,QuietButton,SegmentedControl,TextButton,TitleCard,formatTimecode} from '../../ui/index.js';
import {DockPage} from '../dock/index.js';
import {ScenePlayer,ScenePreview} from '../overlay/index.js';
import type {OwnerSnapshot,PublicChapter,RecapPlan,Source} from '../../shared/contracts/index.js';
import {englishLanguageName} from '../../shared/languages.js';
import {useRecording,type RecordedChat} from './useRecording.js';
import {correctionTarget} from './correction.js';
import {useFootage} from './footage.js';
import './replay.css';

const time=formatTimecode;
const sourceLabels:Record<Source['kind'],string>={speech:'Heard',chat:'Chat',channel_metadata:'Stream details',owner_statement:'Streamer statement',stream_event:'Stream event'};
function sourceExcerpt(text:string){
  const characters=[...text];if(characters.length<=150)return {text,truncated:false};
  const head=characters.slice(0,150).join(''),boundary=head.lastIndexOf(' ');
  return {text:(boundary>100?head.slice(0,boundary):head).trimEnd(),truncated:true};
}
function chatterName(actor:string|null):string|null{if(!actor||/viewer[-_]?\d+$/i.test(actor)||/^fx-/.test(actor))return null;const value=actor.replace(/^(user|chatter|actor)[-_:]/,'');return /^[a-z0-9_]{2,25}$/i.test(value)?value:null;}

export function ReplayPage({manifestUrl}:{manifestUrl?:string}){
  const {client,view,error,origin,resolveMedia,chat,mediaRanges,seek:seekTo}=useRecording(manifestUrl);
  const footage=useFootage();
  const [dock,setDock]=useState(false),[evidence,setEvidence]=useState<Source[]|null>(null),[actionError,setActionError]=useState<string|null>(null),[preview,setPreview]=useState<RecapPlan|null>(null),[busy,setBusy]=useState(false);
  const dockRegion=useRef<HTMLElement|null>(null),dockTrigger=useRef<HTMLButtonElement|null>(null);
  const closeDock=()=>{setDock(false);dockTrigger.current?.focus({preventScroll:true});};
  useEffect(()=>{if(dock){dockRegion.current?.focus({preventScroll:true});dockRegion.current?.scrollIntoView({block:'start',behavior:'smooth'});}},[dock]);
  const s=view?.snapshot,t=view?.transport,published=s?.published,chapter=published?.chapters.at(-1),active=s?.playback.find(p=>p.status==='playing'&&p.plan);
  const publishMilestone=t?.milestones.find(m=>m.id==='published');
  const raidMilestone=t?.milestones.find(m=>m.id==='raid');
  const availableLanguages=t?.availableLanguages??[];
  const correction=t?.correction;
  const correctionChapter=correctionTarget(s,correction?.targetId);
  // Remember the published wording before the streamer replaces it, to show what changed.
  const original=useRef<{id:string;title:string;summary:string}|null>(null);
  if(correctionChapter&&!t?.correctionApplied&&correctionChapter.title!==correction?.title)original.current={id:correctionChapter.id,title:correctionChapter.title,summary:correctionChapter.summary};
  if(!correctionChapter&&!t?.correctionApplied)original.current=null;
  const replaced=t?.correctionApplied&&original.current?.id===correctionChapter?.id?original.current:null;
  const livePublished=!!correction&&!!published?.chapters.some(c=>c.title===correction.title);
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
  // A landing link can ask to start at the raid: /replay?at=raid
  const startedAtRaid=useRef(false);
  useEffect(()=>{
    if(!client||!raidMilestone||startedAtRaid.current)return;
    if(new URLSearchParams(location.search).get('at')!=='raid')return;
    startedAtRaid.current=true;
    void run(async()=>{await client.controlReplay({action:'seek',milestone:raidMilestone.id});await client.controlReplay({action:'play'});});
  },[client,raidMilestone?.id]);
  const elapsed=active?.startAt&&s?Math.max(0,Date.parse(s.serverNow)-Date.parse(active.startAt)):0;
  const activePlan=useMemo(()=>active?.plan??null,[active?.id,active?.plan?.revision,active?.plan?.privacyEpoch]);
  const current=published?.current;
  const hasContext=!!(current?.now??chapter?.summary);
  const publicationSeen=useRef<{sessionId:string|null;atMs:number;seen:boolean}>({sessionId:null,atMs:0,seen:false});
  const sameTimeline=publicationSeen.current.sessionId===(s?.session?.id??null)&&(t?.atMs??0)>=publicationSeen.current.atMs;
  const removedContext=sameTimeline&&publicationSeen.current.seen&&!hasContext;
  useEffect(()=>{publicationSeen.current={sessionId:s?.session?.id??null,atMs:t?.atMs??0,seen:hasContext||sameTimeline&&publicationSeen.current.seen};},[s?.session?.id,t?.atMs,hasContext,sameTimeline]);
  const held=!!s?.held.length;
  const incoming=!activePlan&&t?.latestSource&&t.latestSource.kind!=='chat'?t.latestSource:null;
  const visibleChat=useVisibleChat(client,s,chat,t?.atMs??0);
  // Jumping to a moment plays it at normal speed so the raid scene can be watched.
  const seek=(milestone:string,play=true)=>void run(async()=>{await client!.controlReplay({action:'seek',milestone});if(play)await client!.controlReplay({action:'play',speed:1});});

  return <main className="rp">
    <nav className="rp-nav" aria-label="Replay navigation">
      <a href="/" className="rp-nav__home" aria-label="Previously home"><Brand/></a>
      <a href="/setup/local">Set up my channel</a>
    </nav>
    {error?<section className="rp-unavailable" role="alert"><h1>The recording could not open</h1><p>{error}</p><Button onClick={()=>location.reload()}>Reload the recording</Button></section>
    :!client||!view||!s||!t?<section className="rp-unavailable" role="status"><p>Opening the recording…</p></section>:<>
      <header className="rp-head">
        <h1>{s.session?.title??s.channel.displayName}</h1>
        <p><b>{s.channel.displayName}</b> {origin==='own-stream'?'Recorded stream. What you change here stays in this tab.':'This is an example recording of a game development stream. What you change here stays in this tab.'}</p>
      </header>
      <div className="rp-watch">
        <section className="rp-player" aria-label="Stream">
          <Screen footage={footage} atMs={t.atMs} durationMs={t.durationMs} playing={t.playing} speed={t.speed}>
            {activePlan&&<ScenePlayer className="rp-scene" plan={activePlan} timeMs={elapsed} playing={t.playing} channel={s.channel.displayName} title={published?.session.title} soundEnabled={false} resolveMedia={resolveMedia}/>}
            {incoming&&!held&&<Caption source={incoming}/>}
            {!t.playing&&t.atMs===0&&<button type="button" className="rp-screen__start" disabled={busy} onClick={()=>void run(()=>client.controlReplay({action:'play'}))}><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg></span>Play the recording</button>}
          </Screen>
          <div className="rp-transport">
            <button type="button" className="rp-play" disabled={busy} aria-label={t.playing?'Pause':'Play'} onClick={()=>void run(()=>client.controlReplay({action:t.playing?'pause':'play'}))}>
              {t.playing?<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13M16 5.5v13"/></svg>:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>}
            </button>
            <output className="rp-clock" aria-label="Recording position">{time(t.atMs)}<span> / {time(t.durationMs)}</span></output>
            <Timeline atMs={t.atMs} durationMs={t.durationMs} chapters={published?.chapters??[]} milestones={t.milestones} chat={chat} busy={busy} onSeek={id=>seek(id)} onSeekTo={ms=>seekTo(ms)} warnBack={t.correctionApplied}/>
          </div>
          <div className="rp-controls">
            <SegmentedControl className="rp-speed" label="Playback speed" disabled={busy} value={String(t.speed)} options={[{value:'1',label:'1×'},{value:'2',label:'2×'},{value:'4',label:'4×'}]} onChange={speed=>void run(()=>client.controlReplay({action:t.playing?'play':'pause',speed:Number(speed) as 1|2|4}))}/>
            {availableLanguages.length>1&&<SegmentedControl className="rp-language" label={`Recap language. This recording holds ${availableLanguages.map(englishLanguageName).join(' and ')} wording only, so a replay offers no other language.`} disabled={busy} value={s.settings.recapLanguage} options={availableLanguages.map(language=>({value:language,label:language.toUpperCase()}))} onChange={language=>void run(()=>client.setSettings({baseRevision:s.settings.revision,recapLanguage:language}))}/>}
            {raidMilestone&&<Button disabled={busy} onClick={()=>seek(raidMilestone.id)}>Jump to the raid</Button>}
            <TextButton disabled={busy} onClick={()=>void run(()=>client.controlReplay({action:'reset'}))}>Restart</TextButton>
          </div>
        </section>
        <ChatColumn messages={visibleChat} atMs={t.atMs}/>
      </div>
      {(actionError||t.error==='fixture_missing')&&<p role="status" className="rp-error">{actionError??'This recording has no safety check for this edit. The edit stays held.'}</p>}

      <section className="rp-story" aria-labelledby="rp-story-title">
        <div className="rp-story__head"><h2 id="rp-story-title">The recap so far</h2>{t.speed!==1&&<p className="rp-story__speed">Playing at {t.speed}×</p>}</div>
        <div className="rp-story__grid">
          <NowCard snapshot={s} held={held} removed={removedContext} publishAtMs={publishMilestone?.atMs} atMs={t.atMs} canCorrect={!!correction&&!!correctionChapter}/>
          <div className="rp-chapters">
            {(published?.chapters.length??0)>0?[...published!.chapters].reverse().map(c=><ChapterCard key={c.id} chapter={c} snapshot={s} mediaUrl={chapterMedia(c,s,mediaRanges,resolveMedia)}/>)
              :<div className="rp-chapters__empty"><span className="pv-tab">{publishMilestone?time(publishMilestone.atMs):'0:00'}</span><p>{publishMilestone?`The first chapter is published at ${time(publishMilestone.atMs)}, after the hold that gives the streamer time to fix it.`:'Chapters appear here as the recording plays.'}</p></div>}
            {published?.lore.map(l=><LorePlate key={l.id} className="rp-lore" term={l.term} explanation={l.explanation} originMs={l.originMs??l.firstSeenMs}/>)}
          </div>
        </div>
        {chapter&&<div className="rp-sources"><TextButton disabled={busy} aria-expanded={!!evidence} aria-controls="rp-source-list" onClick={()=>void run(async()=>setEvidence(evidence?null:await client.getEvidence(chapter.id)))}>{evidence?'Hide what the latest chapter is built from':'Show what the latest chapter is built from'}</TextButton>
          {evidence&&<div className="rp-source-list" id="rp-source-list">{evidence.map(source=><figure key={source.id}><figcaption>{source.kind==='owner_statement'?'Streamer correction':sourceLabels[source.kind]} at {time(source.startMs)}</figcaption><blockquote>{source.text}</blockquote></figure>)}</div>}
        </div>}
      </section>

      <section className="rp-owner" aria-labelledby="rp-owner-title">
        <div className="rp-owner__copy">
          <h2 id="rp-owner-title">Change the recap</h2>
          <p>Here you are the streamer. Your wording replaces the chapter for viewers once it passes the safety check.</p>
          <div className="rp-owner__actions">
            <QuietButton disabled={!chapter||busy} onClick={()=>void run(async()=>setPreview(await client.previewRecap(s.session!.id)))}>Preview the next raid scene</QuietButton>
            <QuietButton aria-expanded={dock} aria-controls="replay-demo-dock" onClick={event=>{dockTrigger.current=event.currentTarget;if(dock)closeDock();else setDock(true);}}>{dock?'Close the streamer dock':'Open the streamer dock'}</QuietButton>
          </div>
        </div>
        {correction?<div className="rp-diff">
          {correctionChapter&&(t.correctionApplied?replaced:true)?<TitleCard tone="ink" title={replaced?.title??correctionChapter.title} atMs={correctionChapter.startMs} ground="var(--pv-ink)" className="rp-diff__before" meta={replaced?'Replaced':'Published now'}><p>{replaced?.summary??correctionChapter.summary}</p></TitleCard>
            :<div className="rp-diff__waiting"><p>{chapter?'Open the streamer dock to choose the chapter to edit.':held?'The edit is waiting for its safety check.':removedContext?'Restart to restore the original recording.':'The chapter to correct is published later in the recording. Play or jump to the raid first.'}</p></div>}
          <TitleCard title={correction.title} atMs={correctionChapter?.startMs} ground="var(--pv-ink)" className="rp-diff__after" meta={t.correctionApplied?'Applied':'Your wording'}><p>{correction.summary}</p></TitleCard>
          {t.correctionApplied?<p className="rp-applied" role="status">{livePublished?'Published. The recap page, the chat answer and the next raid scene use your wording.':'Applied. Your wording is waiting for its safety check before viewers see it.'}</p>
            :<Button size="large" disabled={!correctionChapter||busy} onClick={()=>void run(()=>client.editChapter(correctionChapter!.id,{title:correction.title,summary:correction.summary,baseRevision:correctionChapter!.revision}))}>Apply my wording</Button>}
        </div>:<p className="rp-owner__none">This recording has no suggested correction.</p>}
      </section>

      {preview&&<section className="rp-preview" aria-label="Next raid scene preview"><div className="rp-preview__head"><h2>Next raid scene</h2><QuietButton onClick={()=>setPreview(null)}>Close the preview</QuietButton></div><ScenePreview plan={preview} playing soundEnabled={false} resolveMedia={resolveMedia}/></section>}
      {dock&&<section ref={dockRegion} tabIndex={-1} className="rp-dock" id="replay-demo-dock" aria-label="Streamer dock"><div className="rp-dock__bar"><p>Streamer dock, as it appears inside OBS</p><QuietButton onClick={closeDock}>Close the dock</QuietButton></div><DockPage client={client} owner={owner} clockMode="snapshot" recording availableLanguages={availableLanguages} label="Recorded stream" resolveMedia={id=>{const src=resolveMedia(id);return src?{src}:undefined;}} renderPreview={(plan,close)=><div><ScenePreview plan={plan} playing soundEnabled={false} resolveMedia={resolveMedia}/><QuietButton onClick={close}>Close preview</QuietButton></div>}/></section>}
    </>}
  </main>;
}

/** The stream screen: example footage kept in step with recording time, with the overlay on top. */
function Screen({footage,atMs,durationMs,playing,speed,children}:{footage:ReturnType<typeof useFootage>;atMs:number;durationMs:number;playing:boolean;speed:number;children:ReactNode}){
  const video=useRef<HTMLVideoElement>(null);
  useEffect(()=>{
    const v=video.current;if(!v||!Number.isFinite(v.duration)||!v.duration)return;
    const target=(atMs/1000)%v.duration;if(Math.abs(v.currentTime-target)>1.2&&Math.abs(v.currentTime-target)<v.duration-1.2)v.currentTime=target;
    v.playbackRate=speed;if(playing&&v.paused)void v.play().catch(()=>undefined);if(!playing&&!v.paused)v.pause();
  },[atMs,playing,speed]);
  void durationMs;
  return <div className="rp-screen">
    {footage.src?<video ref={video} className="rp-screen__footage" src={footage.src} poster={footage.poster} muted loop playsInline preload="auto" aria-hidden="true"/>:footage.poster?<img className="rp-screen__footage" src={footage.poster} alt=""/>:<div className="rp-screen__footage"/>}
    {children}
  </div>;
}

function Caption({source}:{source:NonNullable<NonNullable<ReturnType<typeof useRecording>['view']>['transport']['latestSource']>}){
  const excerpt=sourceExcerpt(source.text);
  return <p className="rp-caption" key={source.id}><span>{sourceLabels[source.kind]} at {time(source.startMs)}</span>{excerpt.text}{excerpt.truncated||source.truncated?'…':''}</p>;
}

function Timeline({atMs,durationMs,chapters,milestones,chat,busy,onSeek,onSeekTo,warnBack}:{atMs:number;durationMs:number;chapters:PublicChapter[];milestones:{id:string;label:string;atMs:number}[];chat:RecordedChat[];busy:boolean;onSeek:(id:string)=>void;onSeekTo:(ms:number)=>Promise<unknown>;warnBack:boolean}){
  const bins=useMemo(()=>{const n=96,counts=new Array(n).fill(0);for(const c of chat){const i=Math.min(n-1,Math.floor(c.atMs/Math.max(1,durationMs)*n));counts[i]++;}const max=Math.max(1,...counts);return counts.map(c=>c/max);},[chat,durationMs]);
  const track=useRef<HTMLDivElement>(null);
  const [drag,setDrag]=useState<number|null>(null),[pending,setPending]=useState<number|null>(null);
  const shown=drag??pending??atMs;
  const at=(ms:number)=>`${Math.min(100,Math.max(0,ms/Math.max(1,durationMs)*100))}%`;
  const fromPointer=(clientX:number)=>{const r=track.current!.getBoundingClientRect();return Math.round(Math.min(1,Math.max(0,(clientX-r.left)/r.width))*durationMs/1000)*1000;};
  const commit=(ms:number)=>{const target=Math.min(durationMs,Math.max(0,ms));setDrag(null);setPending(target);void onSeekTo(target).catch(()=>undefined).finally(()=>setPending(null));};
  const locked=busy||pending!==null;
  return <div className={`rp-timeline ${pending!==null?'is-pending':''} ${drag!==null?'is-dragging':''}`}>
    <div className="rp-timeline__chat" aria-hidden="true">{bins.map((v,i)=><span key={i} style={{height:`${Math.round(v*100)}%`}} className={i/bins.length*durationMs<=shown?'is-past':undefined}/>)}</div>
    <div ref={track} className="rp-timeline__track" role="slider" tabIndex={locked?-1:0} aria-label="Recording position" aria-disabled={locked||undefined} aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={Math.round(shown)} aria-valuetext={pending!==null?`Moving to ${time(pending)}`:time(shown)}
      onPointerDown={event=>{if(locked)return;event.currentTarget.setPointerCapture(event.pointerId);setDrag(fromPointer(event.clientX));}}
      onPointerMove={event=>{if(drag!==null)setDrag(fromPointer(event.clientX));}}
      onPointerUp={event=>{if(drag!==null)commit(fromPointer(event.clientX));}}
      onPointerCancel={()=>setDrag(null)}
      onKeyDown={event=>{if(locked)return;const step=event.shiftKey?30000:5000;const target=event.key==='ArrowRight'||event.key==='ArrowUp'?atMs+step:event.key==='ArrowLeft'||event.key==='ArrowDown'?atMs-step:event.key==='Home'?0:event.key==='End'?durationMs:null;if(target===null)return;event.preventDefault();commit(target);}}>
      <span className="rp-timeline__fill" style={{width:at(shown)}}/>
      <span className="rp-timeline__head" style={{left:at(shown)}}>{(drag!==null||pending!==null)&&<span className="rp-timeline__bubble">{pending!==null?`Moving to ${time(pending)}`:time(drag!)}</span>}</span>
    </div>
    <div className="rp-timeline__marks">
      {chapters.map(c=><span key={c.id} className="rp-mark rp-mark--chapter" style={{left:at(c.startMs)}} title={`${time(c.startMs)} ${c.title}`}><span className="pv-sr-only">Chapter at {time(c.startMs)}: {c.title}</span></span>)}
      {milestones.map(m=><button key={m.id} type="button" disabled={locked} className={`rp-mark rp-mark--milestone ${m.id==='raid'?'rp-mark--raid':''}`} style={{left:at(m.atMs)}} onClick={()=>onSeek(m.id)}>{m.id==='raid'?'Raid':m.id==='published'?'First recap':m.label}<span className="pv-sr-only"> at {time(m.atMs)}</span></button>)}
    </div>
    {warnBack&&<p className="rp-timeline__warn">Moving back on the timeline restarts the recording in this tab and removes your change.</p>}
  </div>;
}

function ChatColumn({messages,atMs}:{messages:RecordedChat[];atMs:number}){
  const list=useRef<HTMLOListElement>(null);
  const shown=messages.slice(-60);
  const recent=messages.filter(m=>m.atMs>atMs-10000).length;
  useEffect(()=>{const el=list.current;if(el)el.scrollTop=el.scrollHeight;},[shown.length,shown.at(-1)?.id]);
  return <aside className="rp-chat" aria-label="Stream chat">
    <div className="rp-chat__head"><h2>Stream chat</h2><span className={recent>=12?'rp-chat__rate is-busy':'rp-chat__rate'}>{recent} in the last 10 s</span></div>
    {shown.length?<ol ref={list} className="rp-chat__list" aria-live="off">{shown.map(m=>{const who=chatterName(m.actor);return <li key={m.id}>{who&&<b>{who}</b>}{who?' ':''}{m.text}</li>;})}</ol>
      :<p className="rp-chat__empty">Chat messages from the recording appear here as it plays.</p>}
  </aside>;
}

function NowCard({snapshot,held,removed,publishAtMs,atMs,canCorrect}:{snapshot:OwnerSnapshot;held:boolean;removed:boolean;publishAtMs?:number;atMs:number;canCorrect:boolean}){
  const current=snapshot.published?.current,latest=snapshot.published?.chapters.at(-1);
  const now=current?.now??latest?.summary;
  if(now)return <article className="pv-card pv-card--now rp-now">
    <p className="rp-now__label">Right now</p>
    <p className="rp-now__text">{now}</p>
    {(current?.goal||current?.change)&&<dl>{current?.goal&&current.goal!==now&&<div><dt>The goal</dt><dd>{current.goal}</dd></div>}{current?.change&&current.change!==now&&<div><dt>What changed</dt><dd>{current.change}</dd></div>}</dl>}
    {current&&<p className="rp-now__from">From {time(current.sourceTimeMs)} in the stream</p>}
  </article>;
  return <article className="rp-now rp-now--empty">
    <p className="rp-now__label">Right now</p>
    <p className="rp-now__text">{held?'The edit is waiting for its safety check':removed?'The published recap was cleared':'Nothing is published yet'}</p>
    <p className="rp-now__from">{held?`This recording has no safety check for that wording. ${canCorrect?'Apply the suggested wording below, or restart.':'Restart to restore the original.'}`:removed?'Restart to restore the original recording in this tab.':publishAtMs!==undefined&&atMs<publishAtMs?`The first recap is published at ${time(publishAtMs)}.`:'Play the recording to publish the first recap.'}</p>
  </article>;
}

function ChapterCard({chapter,snapshot,mediaUrl}:{chapter:PublicChapter;snapshot:OwnerSnapshot;mediaUrl?:string}){
  const moment=snapshot.moments.find(m=>chapter.momentIds.includes(m.id)&&m.count>0);
  const meta=[chapter.pinned&&'Pinned',chapter.edited&&'Edited by the streamer',moment&&`${moment.count} chat messages at ${time(moment.startMs)}`].filter(Boolean).join('. ');
  return <TitleCard className="rp-chapter" title={chapter.title} atMs={chapter.startMs} ground="var(--pv-ink)" meta={meta||undefined}>
    <p>{chapter.summary}</p>
    {mediaUrl&&<ClipFrame className="rp-chapter__clip" src={mediaUrl} label={`Clip from ${chapter.title}`}/>}
  </TitleCard>;
}
function chapterMedia(chapter:PublicChapter,snapshot:OwnerSnapshot,ranges:{id:string;startMs:number;endMs:number}[],resolve:(id:string)=>string|undefined){
  const moment=snapshot.moments.find(m=>chapter.momentIds.includes(m.id));
  if(moment?.mediaId){const url=resolve(moment.mediaId);if(url)return url;}
  const range=ranges.find(r=>r.startMs>=chapter.startMs&&r.startMs<=chapter.endMs);
  return range?resolve(range.id):undefined;
}

/** Chat shown in recording time, without messages the streamer has forgotten. */
function useVisibleChat(client:ReturnType<typeof useRecording>['client'],snapshot:OwnerSnapshot|undefined,chat:RecordedChat[],atMs:number){
  const [allowed,setAllowed]=useState<{epoch:number;ids:Set<string>;asOfMs:number}|null>(null);
  const epoch=snapshot?.session?.privacyEpoch??0,sessionId=snapshot?.session?.id;
  useEffect(()=>{
    if(!client||!sessionId||epoch===0){setAllowed(null);return;}
    let active=true;
    void (async()=>{const ids=new Set<string>();let cursor:string|undefined;const asOfMs=atMs;
      do{const page=await client.listSources({sessionId,limit:50,cursor});for(const item of page.items)if(item.kind==='chat')ids.add(item.id);cursor=page.nextCursor??undefined;}while(cursor&&active);
      if(active)setAllowed({epoch,ids,asOfMs});})().catch(()=>undefined);
    return()=>{active=false;};
  },[client,sessionId,epoch]);
  return useMemo(()=>chat.filter(c=>c.atMs<=atMs&&(!allowed||c.atMs>allowed.asOfMs||allowed.ids.has(c.id))),[chat,atMs,allowed]);
}

