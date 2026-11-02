import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brand, ChatSlip, ClipFrame, LorePlate, Plate, TitleCard, buttonClass, formatTimecode } from '../../ui';
import { ScenePlayer } from '../overlay';
import { composeReply } from '../../server/twitch/commands';
import { useFootage, type Footage } from '../replay/footage';
import type { LandingStory } from './useLandingStory';
import './landing.css';

const PUBLIC_ORIGIN = 'https://previously-seven.vercel.app';
const REPOSITORY = 'https://github.com/DarinaX2005X/previously-codex-twitchcon-project';

export interface LandingPageProps {
  story?: LandingStory | null;
  unavailable?: boolean;
  replayHref?: string;
  setupHref?: string;
}

function useReducedMotion() {
  const [value, setValue] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { const q = matchMedia('(prefers-reduced-motion: reduce)'), update = () => setValue(q.matches); q.addEventListener('change', update); return () => q.removeEventListener('change', update); }, []);
  return value;
}
/** Marks a section as seen once it scrolls into view, so its objects can arrive in order. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null), [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current; if (!node || seen) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setSeen(true); observer.disconnect(); } }, { threshold: .25 });
    observer.observe(node); return () => observer.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

export function LandingPage({ story = null, unavailable = false, replayHref = '/replay', setupHref = '/setup/local' }: LandingPageProps) {
  const footage = useFootage();
  const raidHref = `${replayHref}${replayHref.includes('?') ? '&' : '?'}at=raid`;
  return <main className="lp">
    <nav className="lp-nav lp-in" aria-label="Main navigation">
      <a href="/" className="lp-nav__home" aria-label="Previously home"><Brand /></a>
      <div className="lp-nav__links"><a href={setupHref}>Set up my channel</a><a className={buttonClass('primary')} href={raidHref}>Watch the raid scene</a></div>
    </nav>
    <section className="lp-hero lp-in" aria-labelledby="lp-hero-title">
      <h1 id="lp-hero-title"><span>Show late arrivals</span> <Plate>what they missed</Plate></h1>
      <div className="lp-hero__aside">
        <p>Previously listens to your stream and its chat, writes short chapters as you go, and plays a “Previously on” recap over the stream when a raid comes in.</p>
        <a className={buttonClass('primary', 'large')} href={raidHref}>Watch the raid scene</a>
      </div>
    </section>
    <HeroStage story={story} footage={footage} unavailable={unavailable} />

    {story?.focus && <ChapterForms story={story} />}
    {story && <ChatCommand story={story} />}
    {story && <CorrectionTravels story={story} />}

    <section className="lp-close lp-in" aria-labelledby="lp-close-title">
      <h2 id="lp-close-title">Your next raid arrives already caught up</h2>
      <div className="lp-close__actions"><a className={buttonClass('primary', 'large')} href={raidHref}>Watch the raid scene</a><a className={buttonClass('text')} href={setupHref}>Set up my channel</a></div>
    </section>
    <footer className="lp-footer lp-in">
      <div className="lp-footer__id"><a href="/" aria-label="Previously home"><Brand /></a><p>A “Previously on” recap for live streams, written from the stream and its chat.</p></div>
      <nav aria-label="Footer"><a href={replayHref}>Example recording</a><a href={setupHref}>Set up my channel</a><a href={REPOSITORY}>Source code</a></nav>
    </footer>
  </main>;
}

function HeroStage({ story, footage, unavailable }: { story: LandingStory | null; footage: Footage; unavailable: boolean }) {
  const reduced = useReducedMotion();
  const [cycle, setCycle] = useState(0), [paused, setPaused] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const plan = story?.plan ?? null;
  useEffect(() => { if (!video.current) return; if (paused || reduced) video.current.pause(); else void video.current.play().catch(() => undefined); }, [paused, reduced, footage.src]);
  const restartLater = () => { window.setTimeout(() => setCycle(value => value + 1), 2600); };
  return <figure className="lp-player lp-in" aria-label="A raid recap playing over the stream">
    <div className="lp-player__frame">
      <div className="lp-player__chrome"><span className="lp-player__name">{story?.channel.displayName ?? ''}</span><span className="lp-player__title">{story?.title ?? ''}</span><span className="lp-player__note">Example recording</span></div>
      <div className="lp-player__screen">
        {footage.src ? <video ref={video} className="lp-player__footage" src={footage.src} poster={footage.poster} muted loop playsInline autoPlay={!reduced} preload="auto" aria-hidden="true" />
          : footage.poster ? <img className="lp-player__footage" src={footage.poster} alt="" /> : <div className="lp-player__footage" />}
        {plan && <ScenePlayer key={`${plan.id}:${cycle}`} className="lp-player__scene" plan={plan} channel={story?.channel.displayName} title={story?.title ?? undefined} playing={!paused && !reduced} timeMs={reduced ? 9000 : undefined} soundEnabled={false} resolveMedia={story?.resolveMedia} onEnded={restartLater} />}
        {story?.raider && <p key={`raid:${cycle}`} className={`lp-player__raid ${plan && !reduced ? '' : 'is-static'}`}><b>{story.raider.login}</b> is raiding with {story.raider.viewers} viewers</p>}
        {!story && <p className="lp-player__status" role="status">{unavailable ? 'The example recording could not open. Reload to try again.' : 'Opening the example recording…'}</p>}
        {plan && !reduced && <button type="button" className="lp-player__toggle" onClick={() => setPaused(value => !value)} aria-label={paused ? 'Play the scene' : 'Pause the scene'}>
          {paused ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13M16 5.5v13" /></svg>}
        </button>}
      </div>
    </div>
  </figure>;
}

type BurstPhase = 'idle' | 'burst' | 'collapse' | 'settled';
function ChapterForms({ story }: { story: LandingStory }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<BurstPhase>('idle'), [run, setRun] = useState(0);
  const { chapter, speech, moment, messages, clipUrl, lore } = story.focus!;
  const windowSeconds = moment ? Math.max(1, Math.round((moment.endMs - moment.startMs) / 1000)) : story.plan?.scene?.moment?.windowSeconds;
  const count = moment?.count ?? story.plan?.scene?.moment?.count;
  const slips = messages.slice(0, 10);
  useEffect(() => {
    if (!seen) return;
    if (reduced || !slips.length || !lore) { setPhase(slips.length && !lore ? 'burst' : 'settled'); return; }
    setPhase('burst');
    const a = window.setTimeout(() => setPhase('collapse'), 1500), b = window.setTimeout(() => setPhase('settled'), 2000);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, [seen, run, reduced, slips.length, !!lore]);
  return <section className="lp-forms lp-in" aria-labelledby="lp-forms-title">
    <h2 id="lp-forms-title">Chapters come from what you say and how chat reacts</h2>
    <div ref={ref} className="lp-forms__stage" data-phase={phase}>
      <div className="lp-forms__inputs">
        {speech?.text && <figure className="lp-quote">
          <figcaption>You said at {formatTimecode(speech.startMs)}</figcaption>
          <blockquote>“{speech.text}”</blockquote>
        </figure>}
        {slips.length > 0 && <div className="lp-burst">
          {count !== undefined && windowSeconds !== undefined && <p className="lp-burst__count"><strong>{count}</strong> chat messages in {windowSeconds} seconds{moment ? ` at ${formatTimecode(moment.startMs)}` : ''}</p>}
          <div className="lp-burst__slips">{slips.map((text, i) => <ChatSlip key={`${run}:${i}`} style={{ ['--i' as string]: i, ['--r' as string]: scatter(i) }}>{text}</ChatSlip>)}</div>
        </div>}
      </div>
      <svg className="lp-forms__join" viewBox="0 0 60 400" preserveAspectRatio="none" aria-hidden="true"><path d="M2 60 H22 Q30 60 30 68 V192 Q30 200 38 200 H58 M2 330 H22 Q30 330 30 322 V208 Q30 200 38 200" /></svg>
      <div className="lp-forms__output">
        <TitleCard title={chapter.title} atMs={chapter.startMs} className="lp-forms__card">
          <p>{chapter.summary}</p>
          {clipUrl && <ClipFrame className="lp-forms__clip" src={clipUrl} label={`Clip from ${chapter.title}`} autoPlay={seen && !reduced} />}
        </TitleCard>
        {lore && <LorePlate className="lp-forms__lore" term={lore.term} explanation={lore.explanation} originMs={lore.originMs ?? lore.firstSeenMs} />}
      </div>
      {!reduced && slips.length > 0 && lore && <button type="button" className={buttonClass('text', 'regular', 'lp-forms__again')} onClick={() => { setPhase('idle'); setRun(value => value + 1); }}>Replay the chat burst</button>}
    </div>
  </section>;
}
/** Deterministic tilt for slip i, in degrees. */
function scatter(i: number) {
  const n = Math.sin((i + 1) * 37.719) * 43758.5453, f = n - Math.floor(n);
  return `${(f - .5) * 7}deg`;
}

function ChatCommand({ story }: { story: LandingStory }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const url = `${PUBLIC_ORIGIN}/c/${story.channel.login}`;
  let reply = '', loreReply = '';
  try { reply = composeReply({ kind: 'previously' }, story.published, story.published.language, url); } catch { reply = ''; }
  const lore = story.published.lore.find(l => l.originKind !== 'unknown');
  try { if (lore) loreReply = composeReply({ kind: 'lore', term: lore.term }, story.published, story.published.language, url); } catch { loreReply = ''; }
  const before = story.chatBeforeRaid.slice(-4);
  const lines: { who: string; text: ReactNode; kind?: 'you' | 'reply' }[] = [
    ...before.map(c => ({ who: chatterName(c.actor), text: c.text })),
    { who: 'you', text: '!previously', kind: 'you' as const },
    ...(reply ? [{ who: story.channel.displayName, text: linkify(reply, url), kind: 'reply' as const }] : []),
    ...(lore && loreReply ? [{ who: 'you', text: `!lore ${lore.term}`, kind: 'you' as const }, { who: story.channel.displayName, text: linkify(loreReply, url), kind: 'reply' as const }] : []),
  ];
  return <section className="lp-chat lp-in" aria-labelledby="lp-chat-title">
    <h2 id="lp-chat-title">Anyone who joins late can type <span className="lp-command">!previously</span></h2>
    <div ref={ref} className={`lp-chat__window ${seen ? 'is-seen' : ''}`} role="log" aria-label="Stream chat in the example recording">
      <ol>{lines.map((line, i) => <li key={i} className={line.kind ? `lp-chat__line lp-chat__line--${line.kind}` : 'lp-chat__line'} style={{ ['--i' as string]: i }}>
        <b>{line.who}</b> <span>{line.text}</span>
      </li>)}</ol>
    </div>
    <p className="lp-chat__note">The answer comes from your channel and only uses chapters that are already published.</p>
  </section>;
}

type Travel = 'original' | 'edited' | 'page' | 'chat';
const TRAVEL_ORDER: Travel[] = ['original', 'edited', 'page', 'chat'];
function CorrectionTravels({ story }: { story: LandingStory }) {
  const chapters = [...story.published.chapters].sort((a, b) => a.startMs - b.startMs);
  const target = chapters.find(c => c.id === story.correction?.targetId) ?? chapters.at(-1);
  const [ref, seen] = useSeen<HTMLDivElement>();
  const reduced = useReducedMotion();
  const [step, setStep] = useState<Travel>('chat'), [run, setRun] = useState(0);
  useEffect(() => {
    if (!seen || reduced || !story.correction) { setStep('chat'); return; }
    setStep('original');
    const timers = [window.setTimeout(() => setStep('edited'), 900), window.setTimeout(() => setStep('page'), 2300), window.setTimeout(() => setStep('chat'), 3300)];
    return () => timers.forEach(t => window.clearTimeout(t));
  }, [seen, run, reduced, !!story.correction]);
  if (!target || !story.correction) return null;
  const correction = story.correction;
  const reached = (at: Travel) => TRAVEL_ORDER.indexOf(step) >= TRAVEL_ORDER.indexOf(at);
  const snapshotFor = (applied: boolean) => applied ? { ...story.published, chapters: story.published.chapters.map(c => c.id === target.id ? { ...c, title: correction.title, summary: correction.summary, edited: true } : c) } : story.published;
  const pageSnapshot = snapshotFor(reached('page')), chatSnapshot = snapshotFor(reached('chat'));
  const url = `${PUBLIC_ORIGIN}/c/${story.channel.login}`;
  let reply = ''; try { reply = composeReply({ kind: 'previously' }, chatSnapshot, chatSnapshot.language, url); } catch { reply = ''; }
  const phoneChapters = [...pageSnapshot.chapters].sort((a, b) => b.startMs - a.startMs).slice(0, 3);
  return <section className="lp-travel lp-in" aria-labelledby="lp-travel-title">
    <div className="lp-travel__head">
      <h2 id="lp-travel-title">Fix a chapter once and every place shows the fix</h2>
      <p>Chapters wait {story.delaySeconds} seconds before viewers see them. An edit from the dock in OBS replaces the chapter on the recap page and in the chat answer.</p>
    </div>
    <div ref={ref} className="lp-travel__stage" data-step={step}>
      <svg className="lp-travel__path" viewBox="0 0 1000 120" preserveAspectRatio="none" aria-hidden="true"><path key={run} d="M150 70 C 300 0, 420 0, 500 60 S 720 120, 860 50" /></svg>
      <div className="lp-travel__dock">
        <p className="lp-travel__where">Dock in OBS</p>
        <article className="pv-card pv-card--tabbed lp-travel__card" style={{ ['--pv-tab-ground' as string]: 'var(--pv-ink-raised)' }}>
          <span className="pv-tab">{formatTimecode(target.startMs)}</span>
          {reached('edited') && <s className="lp-travel__old">{target.title}</s>}
          <h3 className="pv-card__title">{reached('edited') ? correction.title : target.title}</h3>
          <div className="pv-card__body"><p>{reached('edited') ? correction.summary : target.summary}</p></div>
          {reached('edited') && <p className="lp-travel__mark">Edited by you</p>}
        </article>
      </div>
      <div className="lp-travel__phone">
        <p className="lp-travel__where">Recap page</p>
        <div className="lp-travel__device"><div className="lp-travel__screen">
          {pageSnapshot.current?.now && <div className="lp-phone__now"><span>Right now</span><p>{pageSnapshot.current.now}</p></div>}
          {phoneChapters.map(c => <TitleCard key={`${c.id}:${c.title}`} title={c.title} atMs={c.startMs} ground="#0E1115" className={`lp-phone__card ${c.id === target.id && reached('page') ? 'is-fresh' : ''}`}><p>{c.summary}</p></TitleCard>)}
        </div></div>
      </div>
      <div className="lp-travel__chat">
        <p className="lp-travel__where">Chat</p>
        <p className="lp-travel__ask"><b>you</b> !previously</p>
        {reply && <p key={reply} className={`lp-travel__answer ${reached('chat') ? 'is-fresh' : ''}`}><b>{story.channel.displayName}</b> {linkify(reply, url)}</p>}
      </div>
      {!reduced && <button type="button" className={buttonClass('text', 'regular', 'lp-travel__again')} onClick={() => setRun(value => value + 1)}>Replay the edit</button>}
    </div>
  </section>;
}

function chatterName(actor: string | null) {
  if (!actor) return 'viewer';
  const value = actor.replace(/^(user|chatter|actor)[-_:]/, '');
  return /^[a-z0-9_]{2,25}$/i.test(value) ? value : 'viewer';
}
function linkify(text: string, url: string): ReactNode {
  const at = text.lastIndexOf(url);
  return at < 0 ? text : <>{text.slice(0, at)}<a href={url.replace(PUBLIC_ORIGIN, '')} tabIndex={-1}>{url.replace(/^https:\/\//, '')}</a></>;
}

export interface LocalSetupInstructionsProps { replayHref?: string; localSetupHref?: string }
export function LocalSetupInstructions({ replayHref = '/replay', localSetupHref = 'https://localhost:4317/setup' }: LocalSetupInstructionsProps) {
  return <main className="local-setup-page">
    <nav className="lp-nav"><a href="/" className="lp-nav__home" aria-label="Previously home"><Brand /></a><a className={buttonClass('quiet')} href={replayHref}>Try the recording first</a></nav>
    <article>
      <h1>Set up your channel locally</h1>
      <p className="local-setup-lead">The collector runs on your computer. Your viewers read the published recap online.</p>
      <ol className="local-setup-steps">
        <li><h2>Install and start the local app</h2><p>Use Node.js 22.13 or later. From the repository folder, run:</p><pre><code>{'npm ci\nnpm run setup:local\nnpm run build\nnpm start'}</code></pre><p>The certificate setup command uses the Windows user certificate store and writes local configuration to <code>.env</code>. Keep that file private.</p></li>
        <li><h2>Configure your channel</h2><p>Fill the named settings in <code>.env.example</code> using your local <code>.env</code>: Twitch application ID and secret, your channel login, an OpenAI API key, and your HTTPS public deployment origin.</p><p>Register this exact Twitch OAuth callback:</p><pre><code>https://localhost:4317/auth/twitch/callback</code></pre><p>The public deployment needs a private Vercel Blob store and the same <code>PUBLISH_SHARED_SECRET</code> as the local collector. Configure its token only on the server.</p><p>Paid requests begin only when <code>OPENAI_PAID_CALLS_ENABLED=true</code>. Keep it <code>false</code> while checking configuration or playing the recording.</p></li>
        <li><h2>Connect and choose what to share</h2><p>Restart the local app after changing configuration. Open setup to review diagnostics, connect the matching Twitch account, and start listening with a microphone you choose.</p><a className={buttonClass('primary')} href={localSetupHref}>Open local setup</a></li>
        <li><h2>Add the scene to OBS</h2><p>Copy the overlay URL from local setup into an OBS Browser Source at 1920 × 1080. Treat that URL as private. Preview the scene, set protected areas, and then copy your public recap link.</p><p>New capture stays off when you return until you start listening again. Automatic clip creation is a separate choice.</p></li>
      </ol>
      <div className="local-setup-recording"><h2>Just want to see how it works?</h2><p>The example recording runs without provider keys and keeps its changes separate from your channel.</p><a className={buttonClass('quiet')} href={replayHref}>Open the example recording</a></div>
    </article>
  </main>;
}
