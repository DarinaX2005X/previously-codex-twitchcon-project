import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { OwnerSnapshot, RecapClient, RecapPlan } from '../../shared/contracts';
import { ActionGroup, Brand, Button, Dialog, Field, InlineNotice, QuietButton, Sheet, buttonClass } from '../../ui';
import type { DockCapturePort, DockPreviewRenderer } from '../dock/ports';
import { errorCode } from '../dock/model';
import { Icon, type IconName } from '../dock/icons';
import { IssueCard } from '../dock/IssueCard';
import { SettingsSheet } from '../settings/SettingsSheet';
import type { PreviousClipCandidate, SetupDiagnostics, SetupPort } from './ports';
import './setup.css';

const emptyCapture = { status: 'idle' as const, level: 0, message: null, droppedChunks: 0 };
const noSubscribe = () => () => {};
const getEmpty = () => emptyCapture;
export interface SetupPageProps { client: RecapClient; setup?: SetupPort; capture?: DockCapturePort; renderPreview?: DockPreviewRenderer; }
export async function copyValue(value: string, clipboard?: Pick<Clipboard, 'writeText'>): Promise<boolean> {
  if (!clipboard) return false;
  try { await clipboard.writeText(value); return true; } catch { return false; }
}

type StepState = 'done' | 'action' | 'waiting' | 'blocked';
const stateIcon: Record<StepState, IconName> = { done: 'check', action: 'arrowUp', waiting: 'clock', blocked: 'alert' };
function Status({ state, children }: { state: StepState; children: ReactNode }) {
  return <span className="su-status" data-state={state}><Icon name={stateIcon[state]} />{children}</span>;
}
function Step({ n, id, title, state, status, children }: { n: number; id: string; title: string; state: StepState; status: ReactNode; children: ReactNode }) {
  return <li className="su-step" id={id} data-state={state}>
    <article className="pv-card pv-card--tabbed su-card" data-theme="light" aria-labelledby={`${id}-title`}>
      <span className="pv-tab">Step {n}</span>
      <header className="su-card__head"><h2 id={`${id}-title`}>{title}</h2><Status state={state}>{status}</Status></header>
      <div className="su-card__body">{children}</div>
    </article>
  </li>;
}
function Check({ ok, label, detail, fix }: { ok: boolean | 'warn'; label: string; detail: string; fix?: ReactNode }) {
  return <div className="su-check" data-ok={String(ok)}><span className="su-check__mark"><Icon name={ok === true ? 'check' : 'alert'} /></span><div><p><strong>{label}</strong> {detail}</p>{fix && <p className="su-check__fix">{fix}</p>}</div></div>;
}

export function SetupPage({ client, setup, capture, renderPreview }: SetupPageProps) {
  const [diagnostics, setDiagnostics] = useState<SetupDiagnostics | null>(null);
  const [snapshot, setSnapshot] = useState<OwnerSnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(setup)), [pending, setPending] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [feedbackStep, setFeedbackStep] = useState(0);
  const [overlayUrl, setOverlayUrl] = useState(''), [rotate, setRotate] = useState(false), [copyFallback, setCopyFallback] = useState(false);
  const [candidate, setCandidate] = useState<PreviousClipCandidate | null>(null), [clipPreview, setClipPreview] = useState('');
  const [clipFailed, setClipFailed] = useState(false), [clipPending, setClipPending] = useState(false);
  const [preview, setPreview] = useState<RecapPlan | null>(null), [previewOpen, setPreviewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const busy = useRef(false), generation = useRef(0), visibilityGeneration = useRef(0);
  const captureState = useSyncExternalStore(capture?.subscribe ?? noSubscribe, capture?.getSnapshot ?? getEmpty, getEmpty);

  async function load() {
    if (!setup) return;
    const ticket = ++generation.current; setLoading(true); setError('');
    try {
      const result = await setup.diagnostics();
      if (ticket !== generation.current) return;
      setDiagnostics(result);
      if (result.auth.authenticated) {
        const [owner, clips] = await Promise.allSettled([client.getSnapshot(), setup.previousClip()]);
        if (ticket !== generation.current) return;
        if (owner.status === 'fulfilled') setSnapshot(owner.value);
        if (clips.status === 'fulfilled') setCandidate(clips.value.candidate);
      } else { setSnapshot(null); setCandidate(null); }
    } catch { if (ticket === generation.current) setError('Could not check local setup. Keep the local process running, then Check again.'); }
    finally { if (ticket === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { ++generation.current; ++visibilityGeneration.current; }; }, [setup, client]);
  useEffect(() => client.subscribe(event => {
    if (event.event === 'privacy.invalidated' || event.event === 'snapshot.reset') { ++visibilityGeneration.current; ++generation.current; setClipPreview(''); setPreview(null); setPreviewOpen(false); setCandidate(null); }
    if (event.event === 'source.status' || event.event === 'snapshot.changed') void load();
  }), [client, setup]);
  async function act(key: string, action: () => Promise<void>) {
    if (busy.current) return;
    setFeedbackStep(key === 'overlay' ? 4 : ['listen', 'pause', 'chatOnly'].includes(key) ? 3 : ['preview', 'previewClip', 'useClip'].includes(key) ? 5 : key === 'publicCopy' ? 6 : 0);
    busy.current = true; setPending(key); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { if (errorCode(cause) === 'overlay_rotation_required') setRotate(true); else setError(errorCode(cause) === 'role_forbidden' ? 'Sign in with the configured Twitch channel account. This account cannot open the owner dock.' : 'Could not complete this step. Your setup choices are still here. Try again.'); }
    finally { busy.current = false; setPending(''); }
  }
  function feedback(step: number) {
    return feedbackStep === step ? <>{error && <InlineNotice tone="danger" live>{error}</InlineNotice>}{notice && <p className="su-result" role="status"><Icon name="check" />{notice}</p>}</> : null;
  }
  async function copyOverlay(shouldRotate = false) {
    if (!setup) return;
    await act('overlay', async () => {
      const value = overlayUrl && !shouldRotate ? overlayUrl : (await setup.overlayLink(shouldRotate)).url;
      setOverlayUrl(value); setRotate(false);
      const copied = await copyValue(value, navigator.clipboard);
      setCopyFallback(!copied); setNotice(copied ? 'Overlay URL copied. Add it in OBS as a 1920 × 1080 Browser Source.' : 'The clipboard is unavailable. Select the overlay URL below and copy it.');
    });
  }
  async function prepareClip(use: boolean) {
    if (!setup || !candidate) return;
    const visibility = visibilityGeneration.current;
    await act(use ? 'useClip' : 'previewClip', async () => {
      const result = await setup.preparePreviousClip({ clipId: candidate.clip.id, sessionId: snapshot?.session?.id ?? null, use });
      if (visibility !== visibilityGeneration.current) return;
      if (use && snapshot) { await client.setSettings({ earlyWelcomeClipId: candidate.clip.id, baseRevision: snapshot.settings.revision }); await load(); }
      setClipPending(result.status !== 'ready');
      if (!use && result.status === 'ready') { setClipPreview(`/api/media/${encodeURIComponent(result.mediaId)}`); setClipFailed(false); }
      setNotice(use ? 'Previous-stream clip allowed for early welcomes. Automatic clip creation is a separate setting.' : result.status === 'ready' ? 'Previous-stream preview ready.' : 'Preparing the previous-stream preview. Check the preview again when it is ready.');
    });
  }
  async function openPreview() {
    if (!snapshot?.session) return;
    const visibility = visibilityGeneration.current;
    await act('preview', async () => {
      const plan = await client.previewRecap(snapshot.session!.id);
      if (visibility !== visibilityGeneration.current) return;
      setPreview(plan); setPreviewOpen(true);
    });
  }
  const authenticated = Boolean(diagnostics?.auth.authenticated);
  const openai = diagnostics?.openai;
  const openaiReady = Boolean(openai?.configured && openai.paidCallsEnabled);
  const localReady = Boolean(diagnostics?.configured && diagnostics.storage === 'ready' && openaiReady && !diagnostics.integrationError);
  const listening = ['listening', 'delayed'].includes(captureState.status);
  const micBlocked = ['denied', 'no_device', 'device_lost', 'error'].includes(captureState.status);
  const obsConnected = snapshot?.status.overlay.state === 'ready';
  const issues = snapshot?.issues ?? [];
  // Settings already explained by the OpenAI and Twitch rows are not listed twice.
  const otherMissing = diagnostics?.missing.filter(name => !(name === 'OPENAI_API_KEY' && !openai?.configured) && !(name.startsWith('TWITCH_') && !diagnostics.twitch.connected)) ?? [];
  const steps: { id: string; title: string; state: StepState; status: string }[] = [
    { id: 'su-local', title: 'Run Previously on this computer', state: !diagnostics ? 'waiting' : localReady ? 'done' : 'action', status: !diagnostics ? loading ? 'Checking' : 'Not checked' : localReady ? 'Ready' : 'Needs settings' },
    { id: 'su-twitch', title: 'Connect your Twitch channel', state: authenticated ? 'done' : diagnostics?.auth.available ? 'action' : 'blocked', status: authenticated ? 'Connected' : diagnostics?.auth.available ? 'Not connected' : 'Waiting for step 1' },
    { id: 'su-mic', title: 'Choose when to listen', state: listening ? 'done' : micBlocked ? 'blocked' : snapshot?.settings.listeningPaused === false ? 'done' : 'action', status: listening ? 'Listening' : captureState.status === 'denied' ? 'Microphone blocked' : captureState.status === 'no_device' ? 'No microphone' : snapshot?.settings.listeningPaused === false ? 'Chat only' : 'Off' },
    { id: 'su-obs', title: 'Add the scene to OBS', state: obsConnected ? 'done' : overlayUrl ? 'waiting' : authenticated ? 'action' : 'blocked', status: obsConnected ? 'Connected in OBS' : overlayUrl ? 'Waiting for OBS' : authenticated ? 'Not added' : 'Needs Twitch' },
    { id: 'su-preview', title: 'Preview the scene', state: snapshot?.session ? 'action' : 'waiting', status: snapshot?.session ? 'Ready to preview' : 'Needs a live stream' },
    { id: 'su-public', title: 'Share the public recap', state: diagnostics?.publicUrl ? 'done' : 'action', status: diagnostics?.publicUrl ? 'Link ready' : 'Not set up' },
  ];
  const step = (id: string) => steps.find(item => item.id === id)!;
  const done = steps.filter(item => item.state === 'done').length;
  return <main className="su-page">
    <header className="su-masthead"><a href="/" aria-label="Previously home"><Brand /></a><a className="su-masthead__link" href="/replay">Watch an example recording</a></header>
    <div className="su-layout">
      <aside className="su-intro">
        <h1>Set up Previously for your channel</h1>
        <p>Previously runs on your streaming computer. It listens to your microphone and chat, writes short chapters, and plays a recap scene in OBS when a raid arrives.</p>
        <nav aria-label="Setup steps"><ol className="su-progress">{steps.map((item, index) => <li key={item.id} data-state={item.state}><a href={`#${item.id}`}><span className="su-progress__n">{item.state === 'done' ? <Icon name="check" /> : index + 1}</span><span className="su-progress__text"><span>{item.title}</span><small>{item.status}</small></span></a></li>)}</ol></nav>
        <p className="su-count">{done} of {steps.length} steps ready</p>
        <a className={buttonClass('quiet')} href="/dock" target="_blank" rel="noreferrer">Open the streamer dock</a>
      </aside>
      <div className="su-main">
        {issues.length > 0 && <section className="su-issues" aria-label="Problems that need attention">{issues.map(issue => <IssueCard key={`${issue.source}:${issue.component}:${issue.code}`} issue={issue} action={issue.source === 'twitch' ? <a className="dk-link" href={setup?.connectUrl ?? '/api/auth/twitch/start?returnTo=/setup'}><Icon name="link" />Reconnect Twitch</a> : undefined} />)}</section>}
        {feedback(0)}
        <ol className="su-steps">
          <Step n={1} {...step('su-local')}>
            <p>In the project folder, run these once, then keep the last one running while you stream.</p>
            <ol className="su-commands"><li><code>npm run setup:local</code></li><li><code>npm run build</code></li><li><code>npm start</code></li></ol>
            {diagnostics && <div className="su-checks">
              <Check ok={diagnostics.storage === 'ready'} label="Local storage" detail={diagnostics.storage === 'ready' ? 'is ready.' : 'is unavailable.'} fix={diagnostics.storage === 'ready' ? undefined : 'Check free disk space, then restart Previously.'} />
              <Check ok={!openai?.configured ? false : openai.paidCallsEnabled ? true : 'warn'} label="OpenAI" detail={!openai?.configured ? 'has no API key.' : openai.paidCallsEnabled ? 'is connected and paid calls are on.' : 'is connected, but paid calls are off.'}
                fix={!openai?.configured ? <>Add <code>OPENAI_API_KEY</code> to the <code>.env</code> file and restart. Without it, speech is not transcribed and no chapters are written.</> : !openai.paidCallsEnabled ? <>Set <code>OPENAI_PAID_CALLS_ENABLED=true</code> in <code>.env</code> and restart. Until then Previously makes no OpenAI calls, so no chapters are written.</> : undefined} />
              <Check ok={diagnostics.twitch.connected} label="Twitch app" detail={diagnostics.twitch.connected ? 'credentials work.' : 'is not connected yet.'} fix={diagnostics.twitch.connected ? undefined : <>Add <code>TWITCH_CLIENT_ID</code>, <code>TWITCH_CLIENT_SECRET</code> and <code>TWITCH_CHANNEL_LOGIN</code> to <code>.env</code>, then restart.</>} />
              {otherMissing.length > 0 && <Check ok={false} label="Missing settings:" detail={otherMissing.join(', ')} fix="Add them to the .env file and restart Previously." />}
              {diagnostics.integrationError && <Check ok={false} label="Connection failed." detail="Twitch or OpenAI rejected the configured credentials." fix="Check the channel name and keys in .env, then restart." />}
            </div>}
            <details className="su-more"><summary><Icon name="key" />Credentials and the Twitch callback</summary><div className="su-more__body"><p>Keep keys in the local <code>.env</code> file and restart after a change. Public sharing also needs <code>RECAP_PUBLIC_ORIGIN</code> and <code>PUBLISH_SHARED_SECRET</code>. The setup command creates the local encryption and session settings.</p><Field label="Twitch OAuth callback, exactly as written" readOnly value="https://localhost:4317/auth/twitch/callback" onFocus={event => event.currentTarget.select()} /></div></details>
            {setup && <div className="su-row"><QuietButton pending={loading} onClick={() => { setFeedbackStep(1); setNotice(''); void load(); }}>Check again</QuietButton></div>}{feedback(1)}
          </Step>
          <Step n={2} {...step('su-twitch')}>
            <p>Sign in with the channel named in your local configuration. Previously reads its chat and raids, and can create clips and markers if you allow it.</p>
            {authenticated ? <p className="su-account"><Icon name="check" />Connected as <strong>{snapshot?.channel.displayName ?? 'the configured channel'}</strong></p> : diagnostics?.auth.available ? <a className={buttonClass('primary')} href={setup?.connectUrl ?? '/api/auth/twitch/start?returnTo=/setup'}><Icon name="link" />Connect Twitch</a> : <p className="su-note">Finish step 1 and restart Previously to make the Twitch connection available.</p>}
          </Step>
          <Step n={3} {...step('su-mic')}>
            <p>The microphone stays off until you start it. You can pause at any time, and forget the last two minutes from the dock.</p>
            {capture ? <><div className="su-row">{!listening && <Button disabled={!authenticated || !snapshot?.session || ['pausing', 'pause_failed'].includes(captureState.status)} pending={captureState.status === 'permission_pending' || pending === 'listen'} onClick={() => snapshot?.session && void act('listen', async () => { await capture.start(snapshot.session!.id); if (!['listening', 'delayed'].includes(capture.getSnapshot().status)) return; await client.setSettings({ listeningPaused: false, baseRevision: snapshot.settings.revision }); setNotice('Microphone listening. Pause and Forget are in the dock.'); await load(); })}><Icon name="mic" />Start listening</Button>}
              {captureState.status === 'permission_pending' && <QuietButton onClick={() => { const stopped = capture.pause(); void stopped; if (snapshot) void client.setSettings({ listeningPaused: true, baseRevision: snapshot.settings.revision }).then(() => load()).catch(() => setError('Microphone stopped. Could not save the server pause. Retry from the dock.')); }}>Cancel microphone request</QuietButton>}
              {['listening', 'pause_failed'].includes(captureState.status) && <QuietButton onClick={() => void act('pause', async () => { const stopped = capture.pause(); if (snapshot) await client.setSettings({ listeningPaused: true, baseRevision: snapshot.settings.revision }); await stopped; await load(); })}><Icon name="pause" />{captureState.status === 'pause_failed' ? 'Retry pause' : 'Pause listening'}</QuietButton>}
              {captureState.status === 'conflict' && <QuietButton onClick={() => snapshot?.session && void capture.start(snapshot.session.id, true)}>Take over microphone</QuietButton>}</div>
              {captureState.message && <InlineNotice tone="warning" live>{captureState.message}</InlineNotice>}
              {['denied', 'no_device'].includes(captureState.status) && <div className="su-row"><QuietButton disabled={!snapshot} onClick={() => snapshot && void act('chatOnly', async () => { await client.setSettings({ listeningPaused: false, baseRevision: snapshot.settings.revision }); setNotice('Chat-only listening is on. The microphone stays off.'); await load(); })}><Icon name="chat" />Continue with chat only</QuietButton></div>}</>
              : <p className="su-note">Open the dock in a normal browser tab to use a microphone. OBS browser sources cannot ask for microphone permission.</p>}
            {authenticated && !snapshot?.session && <p className="su-note">No live stream yet. Start your stream on Twitch, then Check again.</p>}
            {feedback(3)}
          </Step>
          <Step n={4} {...step('su-obs')}>
            <p>In OBS, add a Browser Source sized 1920 × 1080 with this private link. The scene stays invisible until a recap plays.</p>
            <div className="su-row"><Button disabled={!authenticated || !setup} pending={pending === 'overlay'} onClick={() => void copyOverlay()}><Icon name="copy" />Copy OBS overlay URL</Button><QuietButton disabled={!authenticated || !setup} onClick={() => setRotate(true)}>Replace the link</QuietButton><QuietButton disabled={!snapshot} onClick={() => setSettingsOpen(true)}><Icon name="gear" />Scene settings</QuietButton></div>
            {overlayUrl && <div className="su-url"><Field label="Private OBS overlay URL" readOnly value={overlayUrl} onFocus={event => event.currentTarget.select()} />{copyFallback && <p className="su-note">Select the URL and use your keyboard’s Copy command.</p>}</div>}
            {feedback(4)}
            <p className="su-note">For narration or scene sounds, turn on “Control audio via OBS” for this source and check its level in the mixer.</p>
          </Step>
          <Step n={5} {...step('su-preview')}>
            <p>The preview plays only here. To put the recap on stream, use Show recap in the dock, or let a raid start it.</p>
            <div className="su-row"><Button disabled={!snapshot?.session} pending={pending === 'preview'} onClick={() => void openPreview()}><Icon name="eye" />Preview recap</Button></div>
            {candidate && candidate.status !== 'rejected' && <div className="su-previous"><h3>A clip from your last stream</h3><p>{candidate.clip.title}</p><p className="su-note">From {new Date(candidate.clip.created_at).toLocaleDateString()}. During an early welcome it is labelled as a previous stream.</p><div className="su-row"><QuietButton pending={pending === 'previewClip'} onClick={() => void prepareClip(false)}>{clipPending ? 'Check preview' : 'Preview previous clip'}</QuietButton><QuietButton pending={pending === 'useClip'} onClick={() => void prepareClip(true)}>{snapshot?.settings.earlyWelcomeClipId === candidate.clip.id ? 'Previous clip selected' : 'Use previous clip'}</QuietButton></div>{clipPreview && !clipFailed ? <video src={clipPreview} controls playsInline preload="metadata" onError={() => setClipFailed(true)} aria-label="Previous-stream clip preview" /> : clipFailed ? <p>Clip unavailable. <a href={candidate.clip.url} target="_blank" rel="noreferrer">Watch it on Twitch</a>.</p> : null}{clipPending && <p className="su-note">The clip is still being prepared. Check the preview again shortly.</p>}</div>}
            {feedback(5)}
          </Step>
          <Step n={6} {...step('su-public')}>
            {diagnostics?.publicUrl ? <><p>Viewers who type <code>!previously</code> in chat get a short recap and this link. The page shows published chapters only; drafts and transcripts stay on this computer.</p><div className="su-url"><Field label="Public recap link" value={diagnostics.publicUrl} readOnly onFocus={event => event.currentTarget.select()} /></div><div className="su-row"><QuietButton onClick={() => void act('publicCopy', async () => { const copied = await copyValue(diagnostics.publicUrl!, navigator.clipboard); setNotice(copied ? 'Public recap link copied.' : 'Select the public recap link above and copy it.'); })}><Icon name="copy" />Copy link</QuietButton><a className={buttonClass('quiet')} href={diagnostics.publicUrl} target="_blank" rel="noreferrer"><Icon name="link" />Open the public recap</a></div></>
              : <><p>Viewers who type <code>!previously</code> in chat get a short recap. With public sharing set up, the reply also links to a recap page they can read.</p><p className="su-note">Add <code>RECAP_PUBLIC_ORIGIN</code> and <code>PUBLISH_SHARED_SECRET</code> to <code>.env</code>, restart, then Check again in step 1. Until then the recap is saved on this computer only.</p></>}
            {feedback(6)}
          </Step>
        </ol>
      </div>
    </div>
    <Dialog open={rotate} onOpenChange={setRotate} title="Replace your OBS link?" className="dock-paper" footer={<ActionGroup><Button tone="danger" pending={pending === 'overlay'} onClick={() => void copyOverlay(true)}>Replace and copy link</Button><QuietButton onClick={() => setRotate(false)}>Keep current link</QuietButton></ActionGroup>}><p>The old link stops working at once. Paste the new one into your OBS Browser Source.</p>{error && <InlineNotice tone="danger">{error}</InlineNotice>}</Dialog>
    <Sheet open={previewOpen} onOpenChange={open => { setPreviewOpen(open); if (!open) setPreview(null); }} title="Preview" description="Only you see this preview. Nothing is sent to OBS." className="dock-paper" footer={<QuietButton onClick={() => { setPreviewOpen(false); setPreview(null); }}>Close preview</QuietButton>}>{preview ? renderPreview ? renderPreview(preview, () => { setPreviewOpen(false); setPreview(null); }) : <div>{preview.beats.map(beat => <p key={beat.id}>{beat.text}</p>)}</div> : <p>The stream is still gathering context. Preview again after a chapter is published.</p>}</Sheet>
    {settingsOpen && snapshot && <SettingsSheet settings={snapshot.settings} client={client} onClose={() => setSettingsOpen(false)} onSaved={() => void load()} />}
  </main>;
}
