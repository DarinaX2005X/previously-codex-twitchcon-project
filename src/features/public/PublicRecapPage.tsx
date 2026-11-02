import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { PublicChapter, PublicLore, PublicMoment, PublicSnapshot } from '../../shared/contracts';
import { Brand, Button, ChapterRow, Dialog, Field, QuietButton, ReadingLayout, SourceDisclosure, Timecode, formatTimecode } from '../../ui';
import { PublicRecapController, sourceAge, twitchClipEmbed, type PublicRecapClient, type PublicViewState } from './controller';
import { parseReadingTime, ReadingHistory } from './reading-history';
import './public.css';

export interface PublicRecapPageProps {
  client: PublicRecapClient; login: string; episodeId?: string;
  /** Example recordings say once what they are. The channel link is hidden because the channel is not real. */
  example?: { notice: string; clipUrl?: (momentId: string) => string | undefined };
}
/** Clips an example recording serves itself, by public moment id. Real channels use Twitch clips only. */
const ExampleClips = createContext<((momentId: string) => string | undefined) | undefined>(undefined);
const initial: PublicViewState = { status: 'loading', snapshot: null, untilMs: undefined };
function browserHistory() { try { return new ReadingHistory(window.localStorage); } catch { return new ReadingHistory(); } }
export function PublicRecapPage({ client, login, episodeId, example }: PublicRecapPageProps) {
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
  return <ExampleClips.Provider value={example?.clipUrl}><main className="public-page">
    <div className="public-masthead"><a href="/" aria-label="Previously home"><Brand /></a><a href="/replay">Try a recorded stream</a></div>
    <ReadingLayout className="public-recap">
      <header className="public-header"><div><p className="public-channel">{view.snapshot?.channel.displayName ?? login}</p>{view.snapshot && <p className="public-secondary">{view.snapshot.session.status === 'finalized' ? 'This stream has ended' : 'Live recap'}</p>}</div>{!example && <a className="pv-button pv-button--quiet" href={watch} target="_blank" rel="noreferrer">Watch live</a>}</header>
      {example && <p className="public-example-notice" role="note">{example.notice}</p>}
      {view.status === 'loading' && <div className="public-empty" role="status"><h1>Opening the recap</h1><p>Checking the latest published context.</p></div>}
      {view.status === 'unavailable' && <div className="public-empty" role="status"><h1>The live recap is temporarily unavailable</h1><p>Watch the channel while the public story reconnects.</p><QuietButton onClick={() => controller.current?.revalidate()}>Check again</QuietButton></div>}
      {view.status === 'ready' && view.snapshot && <RecapContent key={`${login}:${view.snapshot.session.id}:${view.untilMs ?? 'all'}`} snapshot={view.snapshot} untilMs={view.untilMs} onUntil={time => controller.current?.setUntil(time)} onClear={() => controller.current?.clearHistory()} />}
    </ReadingLayout>
    <footer className="public-footer"><a href="/">Previously</a><span>Catch up with the stream while it keeps going</span></footer>
  </main></ExampleClips.Provider>;
}

function RecapContent({ snapshot, untilMs, onUntil, onClear }: { snapshot: PublicSnapshot; untilMs?: number; onUntil: (time?: number) => void; onClear: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [clipId, setClipId] = useState<string | null>(null);
  const [input, setInput] = useState(untilMs === undefined ? '' : formatTimecode(untilMs));
  const [error, setError] = useState<string>();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setClipId(null); }, [snapshot.privacyEpoch, snapshot.revision]);
  const activeClip = snapshot.moments.find(moment => moment.id === clipId && moment.mediaState === 'ready' && moment.clip);
  const embed = activeClip?.clip ? twitchClipEmbed(activeClip.clip.id, window.location.hostname) : null;
  const exampleClip = useContext(ExampleClips), exampleSrc = clipId ? exampleClip?.(clipId) : undefined;
  const exampleMoment = exampleSrc ? snapshot.moments.find(moment => moment.id === clipId && moment.mediaState === 'ready') : undefined;
  const ended = snapshot.session.status === 'finalized';
  const CurrentHeading = ended ? 'h2' : 'h1';
  const current = snapshot.current;
  const hero = current?.now ?? current?.goal ?? current?.change;
  const date = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(snapshot.session.startedAt));
  const assignedLore = (chapter: PublicChapter) => snapshot.lore.filter(lore => chapterForLore(snapshot, lore)?.id === chapter.id);
  const assignedMoments = new Set(snapshot.chapters.flatMap(chapter => chapter.momentIds));
  return <div lang={snapshot.language}>
    {ended && <div className="public-episode"><p>{date}</p><h1>{snapshot.session.title || `${snapshot.channel.displayName}'s stream`}</h1>{snapshot.vodUrl ? <a className="pv-button pv-button--quiet" href={snapshot.vodUrl} target="_blank" rel="noreferrer">Watch the recording</a> : <p className="public-secondary">The recording is unavailable. You can still read the published chapters.</p>}</div>}
    {hero ? <section className="public-current" aria-labelledby="public-now"><p className="public-current__label">{ended ? 'Where the stream finished' : 'What matters now'}</p><CurrentHeading id="public-now">{hero}</CurrentHeading>{current?.goal && current.goal !== hero && <p><span className="public-fact-label">The goal</span>{current.goal}</p>}{current?.change && current.change !== hero && <p><span className="public-fact-label">What changed</span>{current.change}</p>}<p className="public-source-age">{current && <span>Source at <Timecode milliseconds={current.sourceTimeMs} /></span>}{!ended && <span>{sourceAge(snapshot, now)}</span>}</p></section> : <section className="public-empty"><h2>{untilMs === undefined ? 'The stream is still gathering context' : 'No published context at this reading limit'}</h2><p>{untilMs === undefined ? 'The recap will appear when there is a story to share.' : 'Choose a later time or read the full recap.'}</p></section>}
    <details className="public-reading-limit"><summary>{untilMs === undefined ? 'Choose how far to read' : `Reading through ${formatTimecode(untilMs)}`}</summary><p>Read up to a time in this stream. Chapters, titles and media that depend on later sources are hidden.</p><form onSubmit={event => { event.preventDefault(); const time = parseReadingTime(input); if (time === null) { setError('Enter a time such as 24:18 or 1:24:18.'); return; } setError(undefined); onUntil(time); }}><Field label="Read up to" value={input} onChange={event => setInput(event.target.value)} hint="Minutes:seconds or hours:minutes:seconds" error={error} inputMode="numeric" /><Button type="submit">Apply reading limit</Button></form>{untilMs !== undefined && <QuietButton onClick={() => onUntil(undefined)}>Read full recap</QuietButton>}<QuietButton onClick={onClear}>Clear reading history</QuietButton><p className="public-secondary">Saved on this device as channel, stream and time only.</p></details>
    {snapshot.chapters.length > 0 && <section className="public-chapters" aria-labelledby="public-chapters-title"><h2 id="public-chapters-title">The story so far</h2>{snapshot.chapters.map(chapter => <ChapterRow key={chapter.id} title={chapter.title} atMs={chapter.startMs} sources={<SourceDisclosure label="Sources"><ul className="public-source-list">{chapter.sourceLabels.map(source => <li key={source.id}><div><Timecode milliseconds={source.atMs} /> <span>{source.label || source.type.replaceAll('_', ' ')}</span></div>{source.quote && <blockquote>{source.quote}</blockquote>}</li>)}</ul>{chapter.sourceLabels.length === 0 && <p>Source details are not available for this chapter.</p>}</SourceDisclosure>} actions={<QuietButton onClick={() => onUntil(chapter.endMs)}>Read up to here</QuietButton>}><p>{chapter.summary}</p>{chapter.edited && <p className="public-owner-edit">Edited by the streamer</p>}{chapter.momentIds.map(id => snapshot.moments.find(moment => moment.id === id)).filter((moment): moment is PublicMoment => !!moment).map(moment => <PublicMomentLink key={moment.id} moment={moment} onOpen={setClipId} />)}{assignedLore(chapter).map(lore => <LoreExplanation key={lore.id} lore={lore} moments={snapshot.moments} onOpen={setClipId} />)}</ChapterRow>)}</section>}
    {snapshot.moments.filter(moment => !assignedMoments.has(moment.id)).map(moment => <PublicMomentLink key={moment.id} moment={moment} onOpen={setClipId} />)}
    {snapshot.lore.filter(lore => !chapterForLore(snapshot, lore)).map(lore => <LoreExplanation key={lore.id} lore={lore} moments={snapshot.moments} onOpen={setClipId} />)}
    {snapshot.gaps.length > 0 && <p className="public-gap">Some source intervals are unavailable. The recap only includes context that could be published.</p>}
    <p className="public-sync">{snapshot.lastSyncedAt ? `Last published sync ${new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(snapshot.lastSyncedAt))}` : 'Public sync time is unavailable'}</p>
    {exampleMoment && exampleSrc && <Dialog open onOpenChange={open => { if (!open) setClipId(null); }} title={exampleMoment.label} description={`Source at ${formatTimecode(exampleMoment.startMs)}`} className="public-clip-dialog"><video src={exampleSrc} controls autoPlay muted playsInline aria-label={exampleMoment.label} /></Dialog>}
    {activeClip && embed && <Dialog open onOpenChange={open => { if (!open) setClipId(null); }} title={activeClip.label} description={`Source at ${formatTimecode(activeClip.startMs)}`} className="public-clip-dialog"><iframe title={activeClip.label} src={embed} allow="autoplay; fullscreen" allowFullScreen /><p><a href={`https://clips.twitch.tv/${encodeURIComponent(activeClip.clip!.id)}`} target="_blank" rel="noreferrer">Open this clip on Twitch</a></p></Dialog>}
  </div>;
}
function chapterForLore(snapshot: PublicSnapshot, lore: PublicLore) { return [...snapshot.chapters].filter(chapter => chapter.startMs <= (lore.originMs ?? lore.firstSeenMs)).sort((a, b) => b.startMs - a.startMs)[0]; }
function PublicMomentLink({ moment, onOpen }: { moment: PublicMoment; onOpen: (id: string) => void }) {
  const exampleClip = useContext(ExampleClips)?.(moment.id);
  const playable = moment.mediaState === 'ready' && (!!exampleClip || moment.clip && twitchClipEmbed(moment.clip.id, 'localhost'));
  return <div className="public-moment-link"><Timecode milliseconds={moment.startMs} /><div><p>{moment.label}</p>{playable ? <QuietButton onClick={() => onOpen(moment.id)}>Watch source clip</QuietButton> : <p className="public-secondary">{moment.mediaState === 'pending' ? 'Clip is being prepared' : 'Clip unavailable. The source time is still available.'}</p>}</div></div>;
}
function LoreExplanation({ lore, moments, onOpen }: { lore: PublicLore; moments: PublicMoment[]; onOpen: (id: string) => void }) {
  const moment = moments.find(item => item.id === lore.momentId);
  return <aside className="public-lore"><h3>Why “{lore.term}”?</h3><p>{lore.originKind === 'unknown' ? 'The origin has not been confirmed.' : lore.explanation}</p>{lore.originMs !== null && <p className="public-secondary">First explained at <Timecode milliseconds={lore.originMs} /></p>}{moment && <PublicMomentLink moment={moment} onOpen={onOpen} />}</aside>;
}

