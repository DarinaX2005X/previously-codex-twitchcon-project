import { useEffect, useId, useRef, useState } from 'react';
import type { PublicChapter, PublicLore, PublicMoment, PublicSnapshot } from '../../shared/contracts';
import { Brand, Button, Dialog, Field, LorePlate, QuietButton, SourceDisclosure, Timecode, buttonClass, formatTimecode } from '../../ui';
import { Icon } from '../dock/icons';
import { PublicRecapController, sourceAge, twitchClipEmbed, type PublicRecapClient, type PublicViewState } from './controller';
import { parseReadingTime, ReadingHistory } from './reading-history';
import './public.css';

/** Playable media for a published moment, when the page can serve it (an example recording's own clips). */
export type PublicMomentMedia = { src: string; poster?: string };
export interface PublicRecapPageProps {
  client: PublicRecapClient; login: string; episodeId?: string;
  /** Example recordings say once what they are. The channel link is hidden because the channel is not real. */
  example?: { notice: string; clipUrl?: (momentId: string) => string | undefined };
  /** Resolves a moment to a clip this page can play inline. Twitch clips are embedded without it. */
  resolveMoment?: (moment: PublicMoment) => PublicMomentMedia | null;
}
const initial: PublicViewState = { status: 'loading', snapshot: null, untilMs: undefined };
function browserHistory() { try { return new ReadingHistory(window.localStorage); } catch { return new ReadingHistory(); } }

export function PublicRecapPage({ client, login, episodeId, example, resolveMoment }: PublicRecapPageProps) {
  const [view, setView] = useState<PublicViewState>(initial);
  const controller = useRef<PublicRecapController | null>(null);
  useEffect(() => {
    setView(initial);
    const next = new PublicRecapController({ client, login, episodeId, history: browserHistory(), onState: setView });
    controller.current = next; next.start();
    const focus = () => next.revalidate();
    window.addEventListener('focus', focus);
    return () => { window.removeEventListener('focus', focus); next.stop(); controller.current = null; };
  }, [client, login, episodeId]);
  const watch = `https://www.twitch.tv/${encodeURIComponent(login)}`;
  const snapshot = view.snapshot;
  const clipUrl = example?.clipUrl;
  const momentMedia = resolveMoment ?? (clipUrl ? (moment: PublicMoment) => { const src = clipUrl(moment.id); return src ? { src } : null; } : undefined);
  const ended = snapshot?.session.status === 'finalized';
  return <main className="pr-page">
    <header className="pr-masthead"><a href="/" className="pr-home" aria-label="Previously home"><Brand /></a><a className="pr-about" href="/">What is Previously</a></header>
    {example && <p className="pr-example" role="note"><Icon name="cast" />{example.notice}</p>}
    {view.status === 'loading' && <section className="pr-hero" aria-busy="true"><div className="pr-id"><h1 className="pr-channel">{login}</h1><p className="pr-meta"><span className="pr-live" data-state="paused">Opening the recap</span></p></div><div className="pr-now pr-now--empty" role="status"><p>Checking the latest published context</p></div></section>}
    {view.status === 'unavailable' && <section className="pr-hero"><div className="pr-id"><h1 className="pr-channel">{login}</h1></div><div className="pr-now pr-now--problem" role="status"><h2>The recap is unavailable right now</h2><p>The channel has not published a recap recently, or the connection dropped. The stream itself may still be live.</p><div className="pr-actions"><Button onClick={() => controller.current?.revalidate()}>Check again</Button>{!example && <a className={buttonClass('quiet')} href={watch} target="_blank" rel="noreferrer">Open the channel on Twitch</a>}</div></div></section>}
    {view.status === 'ready' && snapshot && <RecapContent key={`${login}:${snapshot.session.id}:${view.untilMs ?? 'all'}`} snapshot={snapshot} untilMs={view.untilMs} watch={example ? null : watch} example={Boolean(example)} resolveMoment={momentMedia} onUntil={time => controller.current?.setUntil(time)} onClear={() => controller.current?.clearHistory()} />}
    <footer className="pr-footer">
      <a href="/" aria-label="Previously home"><Brand variant="mark" /></a>
      <p>Previously writes short chapters while a stream is live, so people who arrive late can catch up.{ended ? '' : ' This page updates on its own.'}</p>
      <nav aria-label="Previously"><a href="/">Set up Previously for your channel</a><a href="/replay">Watch an example recording</a></nav>
    </footer>
  </main>;
}

function RecapContent({ snapshot, untilMs, watch, example, resolveMoment, onUntil, onClear }: { snapshot: PublicSnapshot; untilMs?: number; watch: string | null; example: boolean; resolveMoment?: PublicRecapPageProps['resolveMoment']; onUntil: (time?: number) => void; onClear: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [clipId, setClipId] = useState<string | null>(null);
  const [input, setInput] = useState(untilMs === undefined ? '' : formatTimecode(untilMs));
  const [error, setError] = useState<string>();
  const formId = useId();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setClipId(null); }, [snapshot.privacyEpoch, snapshot.revision]);
  const [activeChapter, setActiveChapter] = useState<string | null>(null);
  // The chapter index follows the reader: the card nearest the middle of the screen is the current one.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) setActiveChapter((entry.target as HTMLElement).dataset.chapter ?? null); }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll<HTMLElement>('[data-chapter]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [snapshot.revision, snapshot.chapters.length]);
  const activeClip = snapshot.moments.find(moment => moment.id === clipId && moment.mediaState === 'ready' && moment.clip);
  const embed = activeClip?.clip ? twitchClipEmbed(activeClip.clip.id, window.location.hostname) : null;
  const ended = snapshot.session.status === 'finalized';
  const current = snapshot.current;
  const hero = current?.now ?? current?.goal ?? current?.change;
  const date = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(snapshot.session.startedAt));
  const assignedLore = (chapter: PublicChapter) => snapshot.lore.filter(lore => chapterForLore(snapshot, lore)?.id === chapter.id);
  const assignedMoments = new Set(snapshot.chapters.flatMap(chapter => chapter.momentIds));
  const chapters = [...snapshot.chapters].sort((a, b) => a.startMs - b.startMs);
  const looseMoments = snapshot.moments.filter(moment => !assignedMoments.has(moment.id));
  const looseLore = snapshot.lore.filter(lore => !chapterForLore(snapshot, lore));
  const synced = snapshot.lastSyncedAt ? new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(snapshot.lastSyncedAt)) : null;
  return <div className="pr-content" lang="en">
    <section className="pr-hero" aria-labelledby="pr-channel">
      <div className="pr-id">
        <h1 className="pr-channel" id="pr-channel">{snapshot.channel.displayName}</h1>
        {snapshot.session.title && <p className="pr-title">{snapshot.session.title}</p>}
        <p className="pr-meta"><span className="pr-live" data-state={ended ? 'ended' : 'live'}>{ended ? `Stream ended ${date}` : 'Live now'}</span>{snapshot.session.category && <span>{snapshot.session.category}</span>}</p>
        <div className="pr-actions">
          {ended ? snapshot.vodUrl ? <a className={buttonClass('primary', 'large')} href={snapshot.vodUrl} target="_blank" rel="noreferrer">Watch the recording</a> : <p className="pr-muted">The recording is unavailable. The chapters below are still here.</p>
            : watch ? <a className={buttonClass('primary', 'large')} href={watch} target="_blank" rel="noreferrer"><Icon name="play" />Watch live on Twitch</a>
            : example ? <a className={buttonClass('primary', 'large')} href="/replay"><Icon name="play" />Watch the example recording</a> : null}
        </div>
      </div>
      {hero ? <article className="pr-now" aria-labelledby="pr-now-text">
        <span className="pv-tab pv-tab--now">{ended ? 'Where it finished' : 'Right now'}</span>
        <h2 id="pr-now-text" className="pr-now__text" lang={snapshot.language}>{hero}</h2>
        {(current?.goal && current.goal !== hero) || (current?.change && current.change !== hero) ? <dl className="pr-facts">
          {current?.goal && current.goal !== hero && <div><dt>The goal</dt><dd lang={snapshot.language}>{current.goal}</dd></div>}
          {current?.change && current.change !== hero && <div><dt>What changed</dt><dd lang={snapshot.language}>{current.change}</dd></div>}
        </dl> : null}
        <p className="pr-fresh" data-live={!ended || undefined}>{current && <>From <Timecode milliseconds={current.sourceTimeMs} /> in the stream{ended ? '. ' : `, ${sourceAge(snapshot, now)}. `}</>}{synced && (ended ? `Final recap published at ${synced}.` : `Published at ${synced}.`)}</p>
      </article> : <div className="pr-now pr-now--empty">{untilMs === undefined ? <><h2>The stream is still gathering context</h2><p>The first update appears a minute or two after something happens on stream.</p></> : chapters.length ? <><h2>What is happening now is hidden</h2><p>You chose to read up to {formatTimecode(untilMs)}, so the story below stops there.</p></> : <><h2>Nothing was published before {formatTimecode(untilMs)}</h2><p>Choose a later time, or read the whole recap.</p><QuietButton onClick={() => onUntil(undefined)}>Read the whole recap</QuietButton></>}</div>}
    </section>

    {untilMs !== undefined && <div className="pr-cutoff" role="status"><Icon name="clock" /><p>You are reading up to <strong>{formatTimecode(untilMs)}</strong>. Anything after it is hidden.</p><Button onClick={() => onUntil(undefined)}>Read everything</Button></div>}

    {chapters.length > 0 && <section className="pr-story" aria-labelledby="pr-story-title">
      <div className="pr-rail">
        <h2 id="pr-story-title" className="pr-story__title">The story so far</h2>
        <nav aria-label="Chapters"><ol className="pr-index">{chapters.map(chapter => <li key={chapter.id}><a href={`#chapter-${chapter.id}`} aria-current={activeChapter === chapter.id ? 'true' : undefined} onClick={event => { event.preventDefault(); document.getElementById(`chapter-${chapter.id}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); }}><Timecode milliseconds={chapter.startMs} /><span>{chapter.title}</span></a></li>)}</ol></nav>
      </div>
      <ol className="pr-chapters">{chapters.map((chapter, index) => {
        const moment = chapter.momentIds.map(id => snapshot.moments.find(item => item.id === id)).find((item): item is PublicMoment => Boolean(item));
        const lore = assignedLore(chapter);
        return <li key={chapter.id} id={`chapter-${chapter.id}`} data-chapter={chapter.id} className="pr-chapter" style={{ ['--pr-i' as string]: index }}>
          <article className="pv-card pv-card--tabbed pr-card" data-theme="light" data-media={moment ? 'yes' : 'no'}>
            <span className="pv-tab">{formatTimecode(chapter.startMs)}</span>
            <div className="pr-card__text">
              <h3 className="pr-card__title" lang={snapshot.language}>{chapter.title}</h3>
              <p className="pr-card__summary" lang={snapshot.language}>{chapter.summary}</p>
              {chapter.edited && <p className="pr-card__edited"><Icon name="pencil" />Wording edited by the streamer</p>}
              <div className="pr-card__actions">
                <button type="button" className="pr-readto" onClick={() => onUntil(chapter.endMs)}><Icon name="arrowUp" />Read up to here</button>
                <SourceDisclosure label="Sources"><ul className="pr-sources">{chapter.sourceLabels.map(source => <li key={source.id}><Timecode milliseconds={source.atMs} /><span>{source.label || source.type.replaceAll('_', ' ')}</span>{source.quote && <blockquote>{source.quote}</blockquote>}</li>)}</ul>{chapter.sourceLabels.length === 0 && <p>Source details are not available for this chapter.</p>}</SourceDisclosure>
              </div>
            </div>
            {moment && <MomentFrame moment={moment} media={resolveMoment?.(moment) ?? null} onOpen={setClipId} />}
          </article>
          {lore.map(item => <LoreBlock key={item.id} lore={item} moments={snapshot.moments} resolveMoment={resolveMoment} onOpen={setClipId} language={snapshot.language} />)}
        </li>;
      })}</ol>
    </section>}
    {(looseMoments.length > 0 || looseLore.length > 0) && <section className="pr-extra" aria-label="More from this stream">
      {looseMoments.map(moment => <MomentFrame key={moment.id} moment={moment} media={resolveMoment?.(moment) ?? null} onOpen={setClipId} standalone />)}
      {looseLore.map(lore => <LoreBlock key={lore.id} lore={lore} moments={snapshot.moments} resolveMoment={resolveMoment} onOpen={setClipId} language={snapshot.language} />)}
    </section>}
    {snapshot.gaps.length > 0 && <p className="pr-gap">Some parts of the stream are not covered. The recap only includes what could be published.</p>}

    {(chapters.length > 0 || untilMs !== undefined) && <details className="pr-limit">
      <summary><Icon name="clock" /><span>{untilMs === undefined ? 'Stop reading at a specific time' : `Reading up to ${formatTimecode(untilMs)}`}</span></summary>
      <div className="pr-limit__body">
        <p>Watching the recording later? Enter how far you have watched. Chapters, titles and clips from after that time are hidden.</p>
        <form id={formId} onSubmit={event => { event.preventDefault(); const time = parseReadingTime(input); if (time === null) { setError('Enter a time such as 24:18 or 1:24:18.'); return; } setError(undefined); onUntil(time); }}>
          <Field label="Read up to" value={input} onChange={event => setInput(event.target.value)} hint="Minutes and seconds, or hours, minutes and seconds" error={error} inputMode="numeric" placeholder="24:18" />
          <Button type="submit">Hide what comes after</Button>
        </form>
        <div className="pr-limit__more">{untilMs !== undefined && <QuietButton onClick={() => onUntil(undefined)}>Read everything</QuietButton>}<QuietButton onClick={onClear}>Clear saved reading times</QuietButton></div>
        <p className="pr-muted">This device remembers only the channel, the stream and the time.</p>
      </div>
    </details>}
    {activeClip && embed && <Dialog open onOpenChange={open => { if (!open) setClipId(null); }} title={activeClip.label} description={`From ${formatTimecode(activeClip.startMs)} in the stream`} className="pr-clip-dialog"><iframe title={activeClip.label} src={embed} allow="autoplay; fullscreen" allowFullScreen /><p><a href={`https://clips.twitch.tv/${encodeURIComponent(activeClip.clip!.id)}`} target="_blank" rel="noreferrer">Open this clip on Twitch</a></p></Dialog>}
  </div>;
}

function chapterForLore(snapshot: PublicSnapshot, lore: PublicLore) { return [...snapshot.chapters].filter(chapter => chapter.startMs <= (lore.originMs ?? lore.firstSeenMs)).sort((a, b) => b.startMs - a.startMs)[0]; }

const chatBurst = (moment: PublicMoment) => moment.triggerReasons.some(reason => reason === 'activity_burst' || reason === 'laughter' || reason === 'emotes');

function MomentFrame({ moment, media, onOpen, standalone = false }: { moment: PublicMoment; media: PublicMomentMedia | null; onOpen: (id: string) => void; standalone?: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const twitch = moment.mediaState === 'ready' && moment.clip && twitchClipEmbed(moment.clip.id, 'localhost') ? moment.clip : null;
  const caption = <figcaption className="pr-frame__caption">{chatBurst(moment) ? <span className="pv-slip pr-frame__slip"><Icon name="chat" />Chat reacted here</span> : <span>Clip</span>}<Timecode milliseconds={moment.startMs} /></figcaption>;
  if (media && !failed) return <figure className={['pv-frame pr-frame', standalone && 'pr-frame--standalone'].filter(Boolean).join(' ')}>
    {playing ? <video src={media.src} poster={media.poster} controls autoPlay muted playsInline onError={() => setFailed(true)} aria-label={`${moment.label} at ${formatTimecode(moment.startMs)}`} />
      : <button type="button" className="pr-frame__play" onClick={() => setPlaying(true)} aria-label={`Play the clip from ${formatTimecode(moment.startMs)}`}>{media.poster ? <img src={media.poster} alt="" /> : <video src={`${media.src}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />}<span className="pr-frame__button"><Icon name="play" /></span></button>}
    {caption}
  </figure>;
  if (twitch) return <figure className={['pv-frame pr-frame pr-frame--twitch', standalone && 'pr-frame--standalone'].filter(Boolean).join(' ')}>
    <button type="button" className="pr-frame__play" onClick={() => onOpen(moment.id)}><span className="pr-frame__button"><Icon name="play" /></span><span className="pr-frame__label">Watch the clip</span></button>
    {caption}
  </figure>;
  return <p className="pr-noclip"><Timecode milliseconds={moment.startMs} /><span>{moment.mediaState === 'pending' ? 'The clip from this moment is still being prepared.' : moment.label}</span></p>;
}

function LoreBlock({ lore, moments, resolveMoment, onOpen, language }: { lore: PublicLore; moments: PublicMoment[]; resolveMoment?: PublicRecapPageProps['resolveMoment']; onOpen: (id: string) => void; language?: string }) {
  const moment = moments.find(item => item.id === lore.momentId);
  return <aside className="pr-lore" aria-label={`Running joke: ${lore.term}`} lang={lore.originKind === 'unknown' ? undefined : language}>
    <LorePlate term={lore.term} originMs={lore.originMs ?? undefined} explanation={lore.originKind === 'unknown' ? 'Where this came from has not been confirmed yet.' : lore.explanation} />
    {moment && <MomentFrame moment={moment} media={resolveMoment?.(moment) ?? null} onOpen={onOpen} standalone />}
  </aside>;
}
