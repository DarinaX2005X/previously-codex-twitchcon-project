import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brand, ClipFrame, LorePlate, Plate, TitleCard, buttonClass, formatTimecode } from '../../ui';
import { ScenePlayer } from '../overlay';
import { composeReply } from '../../shared/chat-commands.js';
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
    <div className="lp-field lp-field--paper">
      <nav className="lp-nav lp-in" aria-label="Main navigation">
        <a href="/" className="lp-nav__home" aria-label="Previously home"><Brand /></a>
        <div className="lp-nav__links"><a href={replayHref}>Example recording</a><a href={setupHref}>Set up my channel</a><a className={buttonClass('primary')} href={raidHref}>Watch the raid scene</a></div>
      </nav>
      <section className="lp-hero lp-in" aria-labelledby="lp-hero-title">
        <h1 id="lp-hero-title"><span>Show late arrivals</span> <Plate>what they missed</Plate></h1>
        <div className="lp-hero__aside">
          <p>Previously listens to your stream and its chat, writes short chapters as you go, and plays a “Previously on” recap over the stream when a raid comes in.</p>
          <a className={buttonClass('primary', 'large')} href={raidHref}>Watch the raid scene</a>
        </div>
      </section>
      <HeroEnsemble story={story} footage={footage} unavailable={unavailable} />
    </div>

    {story && story.published.chapters.length > 0 && <StoryScroll story={story} poster={footage.poster} />}
    {story && <ChatCommand story={story} />}
    {story && <FixOnce story={story} poster={footage.poster} />}

    <Closing story={story} raidHref={raidHref} setupHref={setupHref} />
    <footer className="lp-field lp-field--paper lp-footer">
      <div className="lp-in lp-footer__in">
        <div className="lp-footer__id"><a href="/" aria-label="Previously home"><Brand /></a><p>A “Previously on” recap for live streams, written from the stream and its chat.</p></div>
        <nav aria-label="Footer"><a href={replayHref}>Example recording</a><a href={setupHref}>Set up my channel</a><a href={REPOSITORY}>Source code</a></nav>
      </div>
    </footer>
  </main>;
}

/** The stream with the raid scene, and around it the material the recap is made from. */
function HeroEnsemble({ story, footage, unavailable }: { story: LandingStory | null; footage: Footage; unavailable: boolean }) {
  const reduced = useReducedMotion();
  const [cycle, setCycle] = useState(0), [paused, setPaused] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const plan = story?.plan ?? null;
  useEffect(() => { if (!video.current) return; if (paused || reduced) video.current.pause(); else void video.current.play().catch(() => undefined); }, [paused, reduced, footage.src]);
  const restartLater = () => { window.setTimeout(() => setCycle(value => value + 1), 2600); };
  const chapters = story ? [...story.published.chapters].sort((a, b) => a.startMs - b.startMs) : [];
  const now = story?.published.current?.now;
  const lore = story?.published.lore.find(l => l.originKind !== 'unknown');
  return <div className="lp-ensemble lp-in">
    {chapters[0] && <TitleCard className="lp-obj lp-obj--card-a" title={chapters[0].title} atMs={chapters[0].startMs} ground="var(--lp-paper)" aria-hidden="true"><p>{chapters[0].summary}</p></TitleCard>}
    {chapters[1] && <TitleCard className="lp-obj lp-obj--card-b" title={chapters[1].title} atMs={chapters[1].startMs} aria-hidden="true"><p>{chapters[1].summary}</p></TitleCard>}
    <figure className="lp-player" aria-label="A raid recap playing over the stream">
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
    </figure>
    {now && <article className="pv-card lp-obj lp-obj--now" aria-hidden="true"><p className="lp-obj__label">Right now</p><p className="lp-obj__now">{now}</p></article>}
    {lore && <LorePlate className="lp-obj lp-obj--lore" term={lore.term} explanation={lore.explanation} originMs={lore.originMs ?? lore.firstSeenMs} />}
  </div>;
}

/** Scroll story: the recording's moments on the right; on the left, what viewers can read at that moment. */
function StoryScroll({ story, poster }: { story: LandingStory; poster?: string }) {
  const chapters = [...story.published.chapters].sort((a, b) => a.startMs - b.startMs);
  const steps = chapters.length + (story.raider ? 1 : 0);
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.step));
    }, { rootMargin: '-45% 0px -50% 0px' });
    refs.current.forEach(node => node && observer.observe(node));
    return () => observer.disconnect();
  }, [steps]);
  const goTo = (i: number) => refs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const raid = !!story.raider && active >= chapters.length;
  const top = chapters[Math.min(active, chapters.length - 1)];
  const earlier = chapters.slice(0, Math.min(active, chapters.length - 1) + (raid ? 1 : 0)).filter(c => raid || c.id !== top.id);
  const lore = story.published.lore.find(l => l.originKind !== 'unknown');
  const loreAt = lore ? chapters.findIndex(c => lore.firstSeenMs >= c.startMs && lore.firstSeenMs <= c.endMs + 120000) : -1;
  const loreVisible = !!lore && loreAt >= 0 && active >= loreAt;
  const clip = story.focus?.chapter.id === top.id ? story.focus.clipUrl : undefined;
  const duration = Math.max(story.raidAtMs ?? 0, ...chapters.map(c => c.endMs)) || 1;
  const stepTime = (i: number) => i >= chapters.length ? story.raidAtMs ?? duration : chapters[i].startMs + story.delaySeconds * 1000;
  const position = Math.min(1, stepTime(active) / duration);
  return <section className="lp-field lp-field--cave lp-story" aria-labelledby="lp-story-title">
    <div className="lp-in">
      <div className="lp-story__head">
        <h2 id="lp-story-title">Chapters come from what you say and how chat reacts</h2>
        <p>Scroll to move through the recording. Scroll back up to rewind.</p>
      </div>
      <div className="lp-story__in">
        <div className="lp-story__sticky">
          <div className="lp-story__panel" style={poster ? { ['--lp-poster' as string]: `url("${poster}")` } : undefined}>
            <div className="lp-story__clock">
              <span className="lp-story__time">{formatTimecode(stepTime(active))}</span>
              <div className="lp-story__bar" aria-hidden="true">
                <span className="lp-story__fill" style={{ width: `${position * 100}%` }} />
                {chapters.map((c, i) => <button key={c.id} type="button" tabIndex={-1} className={`lp-story__tick ${i <= active ? 'is-past' : ''}`} style={{ left: `${Math.min(1, stepTime(i) / duration) * 100}%` }} onClick={() => goTo(i)} />)}
                {story.raider && <button type="button" tabIndex={-1} className={`lp-story__tick lp-story__tick--raid ${raid ? 'is-past' : ''}`} style={{ left: '100%' }} onClick={() => goTo(chapters.length)} />}
              </div>
              <span className="lp-story__end">{formatTimecode(duration)}</span>
            </div>
            <p className="lp-story__label">{raid ? 'What the raiders see' : 'What viewers can read now'}</p>
            {raid && story.published.current?.now
              ? <article key="now" className="pv-card pv-card--now lp-story__now"><p className="lp-story__now-label">Right now</p><p className="lp-story__now-text">{story.published.current.now}</p></article>
              : <TitleCard key={top.id} className="lp-story__card" title={top.title} atMs={top.startMs} ground="var(--lp-cave-deep)"><p>{top.summary}</p>{clip && <ClipFrame className="lp-story__clip" src={clip} label={`Clip from ${top.title}`} autoPlay />}</TitleCard>}
            <div className="lp-story__after">
              {earlier.length > 0 && <ol className="lp-story__earlier" aria-label="Earlier chapters">{earlier.map(c => <li key={c.id}><span>{formatTimecode(c.startMs)}</span>{c.title}</li>)}</ol>}
              {loreVisible && lore && <LorePlate key={lore.id} className="lp-story__lore" term={lore.term} explanation={lore.explanation} originMs={lore.originMs ?? lore.firstSeenMs} />}
            </div>
          </div>
        </div>
        <ol className="lp-story__steps">
          {chapters.map((c, i) => {
            const speech = story.chapterSpeech[c.id], moment = story.chapterMoments[c.id];
            return <li key={c.id} ref={node => { refs.current[i] = node; }} data-step={i} className={`lp-step ${active === i ? 'is-active' : ''}`} onClick={() => goTo(i)}>
              <span className="pv-tab">{formatTimecode(speech?.startMs ?? c.startMs)}</span>
              {speech ? <blockquote>“{speech.text}”</blockquote> : <p className="lp-step__text">{c.summary}</p>}
              {moment && <p className="lp-step__burst"><strong>{moment.count}</strong> chat messages in {Math.max(1, Math.round((moment.endMs - moment.startMs) / 1000))} seconds</p>}
              <p className="lp-step__result">Published as <b>{c.title}</b> {story.delaySeconds} seconds later</p>
            </li>;
          })}
          {story.raider && <li ref={node => { refs.current[chapters.length] = node; }} data-step={chapters.length} className={`lp-step lp-step--raid ${raid ? 'is-active' : ''}`} onClick={() => goTo(chapters.length)}>
            <span className="pv-tab pv-tab--now">{story.raidAtMs !== undefined ? formatTimecode(story.raidAtMs) : 'Raid'}</span>
            <p className="lp-step__text"><b>{story.raider.login}</b> raids with {story.raider.viewers} viewers. The recap plays over the stream, then leaves it alone.</p>
          </li>}
        </ol>
      </div>
    </div>
  </section>;
}

function ChatCommand({ story }: { story: LandingStory }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const url = `${PUBLIC_ORIGIN}/c/${story.channel.login}`;
  let reply = '', loreReply = '';
  try { reply = composeReply({ kind: 'previously' }, story.published, story.published.language, url); } catch { reply = ''; }
  const lore = story.published.lore.find(l => l.originKind !== 'unknown');
  try { if (lore) loreReply = composeReply({ kind: 'lore', term: lore.term }, story.published, story.published.language, url); } catch { loreReply = ''; }
  const before = story.chatBeforeRaid.slice(-4);
  const lines: { who: string | null; text: ReactNode; kind?: 'you' | 'reply' }[] = [
    ...before.map(c => ({ who: chatterName(c.actor), text: c.text })),
    { who: 'you', text: '!previously', kind: 'you' as const },
    ...(reply ? [{ who: story.channel.displayName, text: linkify(reply, url), kind: 'reply' as const }] : []),
    ...(lore && loreReply ? [{ who: 'you', text: `!lore ${lore.term}`, kind: 'you' as const }, { who: story.channel.displayName, text: linkify(loreReply, url), kind: 'reply' as const }] : []),
  ];
  return <section className="lp-field lp-field--vermilion lp-chat" aria-labelledby="lp-chat-title">
    <div className="lp-in lp-chat__in">
      <div className="lp-chat__copy">
        <h2 id="lp-chat-title">Anyone who joins late can type <span className="lp-command">!previously</span></h2>
        <p>The answer comes from your channel, with the latest chapters, what is happening now and a link to the whole recap. Only published chapters are used.</p>
      </div>
      <div ref={ref} className={`lp-chat__window ${seen ? 'is-seen' : ''}`} role="log" aria-label="Stream chat in the example recording">
        <div className="lp-chat__head"><span>Stream chat</span><span>{story.channel.displayName}</span></div>
        <ol>{lines.map((line, i) => <li key={i} className={line.kind ? `lp-chat__line lp-chat__line--${line.kind}` : 'lp-chat__line'} style={{ ['--i' as string]: i }}>
          {line.who && <><b>{line.who}</b> </>}<span>{line.text}</span>
        </li>)}</ol>
      </div>
    </div>
  </section>;
}

/** One chapter, sent from the dock to every place viewers meet it. */
function FixOnce({ story, poster }: { story: LandingStory; poster?: string }) {
  const chapters = [...story.published.chapters].sort((a, b) => a.startMs - b.startMs);
  const base = chapters.find(c => c.id === story.correction?.targetId) ?? chapters.at(-1);
  const [ref, seen] = useSeen<HTMLDivElement>();
  const reduced = useReducedMotion();
  const [run, setRun] = useState(0);
  if (!base) return null;
  const card = story.correction ? { ...base, title: story.correction.title, summary: story.correction.summary } : base;
  const snapshot = { ...story.published, chapters: story.published.chapters.map(c => c.id === base.id ? { ...c, title: card.title, summary: card.summary } : c) };
  const url = `${PUBLIC_ORIGIN}/c/${story.channel.login}`;
  let reply = ''; try { reply = composeReply({ kind: 'previously' }, snapshot, snapshot.language, url); } catch { reply = ''; }
  const at = reply.indexOf(card.summary);
  const answer: ReactNode = at < 0 ? linkify(reply, url) : <>{reply.slice(0, at)}<mark className="lp-fix__mark">{card.summary}</mark>{linkify(reply.slice(at + card.summary.length), url)}</>;
  const page = [...snapshot.chapters].sort((a, b) => b.startMs - a.startMs).slice(0, 3);
  return <section className="lp-field lp-field--paper lp-fix" aria-labelledby="lp-fix-title">
    <div className="lp-in">
      <div className="lp-fix__head">
        <h2 id="lp-fix-title">Fix it once</h2>
        <p>Change a chapter in the dock and the recap page, the chat answer and the next raid scene all use your wording. Chapters wait {story.delaySeconds} seconds before viewers see them, so there is time.</p>
      </div>
      <div ref={ref} key={run} className={`lp-fix__stage ${seen && !reduced ? 'is-sending' : ''}`}>
        <div className="lp-fix__source">
          <p className="lp-fix__where">Dock in OBS</p>
          <div className="lp-fix__dock">
            <TitleCard title={card.title} atMs={card.startMs} className="lp-fix__card"><p>{card.summary}</p></TitleCard>
            {!reduced && <button type="button" className={buttonClass('primary', 'regular', 'lp-fix__send')} onClick={() => setRun(value => value + 1)}>Send it again</button>}
          </div>
        </div>
        <svg className="lp-fix__wires" viewBox="0 0 100 300" preserveAspectRatio="none" aria-hidden="true">
          <path className="w1" d="M0 150 C 50 150, 50 50, 100 50" /><path className="w2" d="M0 150 L 100 150" /><path className="w3" d="M0 150 C 50 150, 50 250, 100 250" />
        </svg>
        <div className="lp-fix__dests">
          <figure className="lp-fix__dest lp-fix__dest--page">
            <figcaption>Recap page</figcaption>
            <div className="lp-fix__page">{page.map(c => <TitleCard key={c.id} title={c.title} atMs={c.startMs} ground="#0E1115" className={`lp-fix__pagecard ${c.id === base.id ? 'is-target' : ''}`} />)}</div>
          </figure>
          <figure className="lp-fix__dest lp-fix__dest--chat">
            <figcaption>Chat answer to !previously</figcaption>
            <p className="lp-fix__answer"><b>{story.channel.displayName}</b> {answer}</p>
          </figure>
          <figure className="lp-fix__dest lp-fix__dest--scene">
            <figcaption>Next raid scene</figcaption>
            <div className="lp-fix__screen" style={poster ? { backgroundImage: `url("${poster}")` } : undefined}>
              <span className="lp-fix__lower"><span className="pv-tab">{formatTimecode(card.startMs)}</span>{card.title}</span>
            </div>
          </figure>
        </div>
      </div>
    </div>
  </section>;
}

/** Closing: the episode's chapters as a hand of cards, with the present on top. */
function Closing({ story, raidHref, setupHref }: { story: LandingStory | null; raidHref: string; setupHref: string }) {
  const chapters = story ? [...story.published.chapters].sort((a, b) => a.startMs - b.startMs).slice(-4) : [];
  const now = story?.published.current?.now;
  return <section className="lp-field lp-field--cave lp-close" aria-labelledby="lp-close-title">
    <div className="lp-in lp-close__in">
      <div className="lp-close__copy">
        <h2 id="lp-close-title">Your next raid arrives already caught up</h2>
        <div className="lp-close__actions"><a className={buttonClass('primary', 'large')} href={raidHref}>Watch the raid scene</a><a className={buttonClass('text', 'regular', 'lp-close__setup')} href={setupHref}>Set up my channel</a></div>
      </div>
      {chapters.length > 0 && <div className="lp-hand" aria-hidden="true" style={{ ['--n' as string]: chapters.length + (now ? 1 : 0) }}>
        {chapters.map((c, i) => <TitleCard key={c.id} className="lp-hand__card" title={c.title} atMs={c.startMs} ground="var(--lp-cave)" style={{ ['--i' as string]: i }} />)}
        {story?.raider && <p className="lp-hand__raid"><b>{story.raider.login}</b> is raiding with {story.raider.viewers} viewers</p>}
        {now && <article className="pv-card pv-card--now lp-hand__card lp-hand__now" style={{ ['--i' as string]: chapters.length }}><p className="lp-hand__label">Right now</p><p className="lp-hand__text">{now}</p></article>}
      </div>}
    </div>
  </section>;
}

/** A chatter's display name when the recording carries one; opaque ids are not shown. */
function chatterName(actor: string | null): string | null {
  if (!actor || /viewer[-_]?\d+$/i.test(actor) || /^fx-/.test(actor)) return null;
  const value = actor.replace(/^(user|chatter|actor)[-_:]/, '');
  return /^[a-z0-9_]{2,25}$/i.test(value) ? value : null;
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
