import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { OwnerSnapshot, RecapClient, RecapPlan } from '../../shared/contracts';
import { ActionGroup, Brand, Button, Dialog, Field, InlineNotice, QuietButton, Sheet } from '../../ui';
import type { DockCapturePort, DockPreviewRenderer } from '../dock/ports';
import { errorCode } from '../dock/model';
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
export function SetupPage({ client, setup, capture, renderPreview }: SetupPageProps) {
  const [diagnostics, setDiagnostics] = useState<SetupDiagnostics | null>(null);
  const [snapshot, setSnapshot] = useState<OwnerSnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(setup)), [pending, setPending] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [overlayUrl, setOverlayUrl] = useState(''), [rotate, setRotate] = useState(false), [copyFallback, setCopyFallback] = useState(false);
  const [candidate, setCandidate] = useState<PreviousClipCandidate | null>(null), [clipPreview, setClipPreview] = useState('');
  const [clipFailed, setClipFailed] = useState(false), [clipPending, setClipPending] = useState(false);
  const [preview, setPreview] = useState<RecapPlan | null>(null), [previewOpen, setPreviewOpen] = useState(false);
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
    } catch { if (ticket === generation.current) setError('Could not check local setup. Keep the local process running, then Check configuration again.'); }
    finally { if (ticket === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { ++generation.current; ++visibilityGeneration.current; }; }, [setup, client]);
  useEffect(() => client.subscribe(event => {
    if (event.event === 'privacy.invalidated' || event.event === 'snapshot.reset') { ++visibilityGeneration.current; ++generation.current; setClipPreview(''); setPreview(null); setPreviewOpen(false); setCandidate(null); }
    if (event.event === 'source.status' || event.event === 'snapshot.changed') void load();
  }), [client, setup]);
  async function act(key: string, action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true; setPending(key); setError('');
    try { await action(); }
    catch (cause) { if (errorCode(cause) === 'overlay_rotation_required') setRotate(true); else setError(errorCode(cause) === 'role_forbidden' ? 'Sign in with the configured Twitch channel account. This account cannot open the owner dock.' : 'Could not complete this step. Your setup choices are still here. Try again.'); }
    finally { busy.current = false; setPending(''); }
  }
  async function copyOverlay(shouldRotate = false) {
    if (!setup) return;
    await act('overlay', async () => {
      const value = overlayUrl && !shouldRotate ? overlayUrl : (await setup.overlayLink(shouldRotate)).url;
      setOverlayUrl(value); setRotate(false);
      const copied = await copyValue(value, navigator.clipboard);
      setCopyFallback(!copied); setNotice(copied ? 'Overlay URL copied. Add it as a 1920 × 1080 OBS Browser Source.' : 'The clipboard is unavailable. Select the overlay URL below and copy it.');
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
      setNotice(use ? 'Previous-stream clip permitted for early welcomes. Automatic clip creation is a separate setting.' : result.status === 'ready' ? 'Previous-stream preview ready.' : 'Preparing the previous-stream preview. Check preview again when it is ready.');
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
  return <main className="setup-page" data-theme="light">
    <header className="setup-header"><a href="/" aria-label="Previously home"><Brand /></a><a href="/replay">Try a recorded stream</a></header>
    <div className="setup-intro"><p>Local setup</p><h1>Give your next arrival the story so far</h1><p>Keep Previously running on your streaming computer. Connect your Twitch channel, choose what it can hear, then add its scene to OBS.</p></div>
    {error && <InlineNotice tone="danger" live>{error}</InlineNotice>}{notice && <InlineNotice tone="success" live>{notice}</InlineNotice>}
    <ol className="setup-steps">
      <li><div className="setup-step-number">1</div><section><h2>Check local configuration</h2><p>From the project folder, run <code>npm run setup:local</code>, then <code>npm run build</code> and <code>npm start</code>. Keep the local HTTPS process running while streaming.</p><p>Set credentials in the local <code>.env</code> file. Previously never asks you to paste secrets into this page. Restart the process after changing the file.</p><details className="setup-env"><summary>Configuration names and Twitch callback</summary><p>Twitch needs <code>TWITCH_CLIENT_ID</code>, <code>TWITCH_CLIENT_SECRET</code> and <code>TWITCH_CHANNEL_LOGIN</code>. Speech and story checks use <code>OPENAI_API_KEY</code>. Paid calls require your explicit <code>OPENAI_PAID_CALLS_ENABLED=true</code> setting.</p><p>Public sharing needs <code>RECAP_PUBLIC_ORIGIN</code> and <code>PUBLISH_SHARED_SECRET</code>. The setup command creates local encryption and session settings.</p><Field label="Exact Twitch OAuth callback" readOnly value="https://localhost:4317/auth/twitch/callback" onFocus={event => event.currentTarget.select()} /></details>
        {diagnostics && <div className="setup-diagnostics"><p>Local storage: <strong>{diagnostics.storage === 'ready' ? 'Ready' : 'Unavailable. Check free disk space and restart.'}</strong></p><p>Twitch: <strong>{diagnostics.twitch.connected ? 'Account connected' : 'Account not connected'}</strong></p><p>Speech provider: <strong>{diagnostics.openai.configured ? diagnostics.openai.paidCallsEnabled ? 'Configured. Paid calls enabled by local setting.' : 'Configured. Paid calls disabled.' : 'Not configured'}</strong></p>{diagnostics.missing.length > 0 && <p>Still needed: {diagnostics.missing.join(', ')}.</p>}{diagnostics.integrationError && <p>The local connection could not start. Check the configured channel and credentials, then restart.</p>}</div>}
        {setup && <QuietButton pending={loading} onClick={() => void load()}>Check configuration</QuietButton>}
      </section></li>
      <li><div className="setup-step-number">2</div><section><h2>Connect your Twitch channel</h2><p>Sign in with the channel named in your local configuration. A different account cannot open its dock.</p>{authenticated ? <InlineNotice tone="success">Signed in as {snapshot?.channel.displayName ?? 'the configured channel'}.</InlineNotice> : diagnostics?.auth.available ? <a className="pv-button pv-button--primary" href={setup?.connectUrl ?? '/api/auth/twitch/start?returnTo=/setup'}>Connect Twitch</a> : <p className="pv-secondary">Complete local configuration and restart to make Twitch connection available.</p>}<p className="setup-step-note">Cancelling Twitch sign-in leaves your saved settings and chapters in place.</p></section></li>
      <li><div className="setup-step-number">3</div><section><h2>Start listening when you are ready</h2><p>Returning to this page never starts the microphone. Speech language is detected automatically; recap language is chosen in the dock.</p>{capture ? <><ActionGroup><Button disabled={!authenticated || !snapshot?.session} pending={captureState.status === 'permission_pending' || pending === 'listen'} onClick={() => snapshot?.session && void act('listen', async () => { await capture.start(snapshot.session!.id); if (!['listening', 'delayed'].includes(capture.getSnapshot().status)) return; await client.setSettings({ listeningPaused: false, baseRevision: snapshot.settings.revision }); setNotice('Microphone listening. Pause and Forget are available in the dock.'); await load(); })}>{captureState.status === 'listening' ? 'Microphone listening' : 'Start listening'}</Button>{captureState.status === 'permission_pending' && <QuietButton onClick={() => { const stopped = capture.pause(); void stopped; if (snapshot) void client.setSettings({ listeningPaused: true, baseRevision: snapshot.settings.revision }).then(() => load()).catch(() => setError('Microphone stopped. Could not save the server pause. Retry from the dock.')); }}>Cancel microphone request</QuietButton>}{captureState.status === 'listening' && <QuietButton onClick={() => void act('pause', async () => { const stopped = capture.pause(); if (snapshot) await client.setSettings({ listeningPaused: true, baseRevision: snapshot.settings.revision }); await stopped; await load(); })}>Pause listening</QuietButton>}{captureState.status === 'conflict' && <QuietButton onClick={() => snapshot?.session && void capture.start(snapshot.session.id, true)}>Take over microphone</QuietButton>}</ActionGroup>{captureState.message && <InlineNotice tone="warning" live>{captureState.message}</InlineNotice>}{['denied', 'no_device'].includes(captureState.status) && <QuietButton disabled={!snapshot} onClick={() => snapshot && void act('chatOnly', async () => { await client.setSettings({ listeningPaused: false, baseRevision: snapshot.settings.revision }); setNotice('Chat-only listening enabled. Microphone remains off.'); await load(); })}>Continue with chat only</QuietButton>}</> : <p className="pv-secondary">Open the local dock in a normal browser tab to enable a microphone. OBS browser sources cannot provide microphone permission.</p>}{authenticated && !snapshot?.session && <p className="pv-secondary">No live session yet. Start your stream on Twitch, then Check configuration.</p>}<a href="/dock" target="_blank" rel="noreferrer">Open the streamer dock</a></section></li>
      <li><div className="setup-step-number">4</div><section><h2>Add the scene to OBS</h2><p>Add a Browser Source at 1920 × 1080. Its private URL grants access to the published scene, with no microphone or editing access.</p><ActionGroup><Button disabled={!authenticated || !setup} pending={pending === 'overlay'} onClick={() => void copyOverlay()}>Copy OBS overlay URL</Button><QuietButton disabled={!authenticated || !setup} onClick={() => setRotate(true)}>Rotate link</QuietButton></ActionGroup>{overlayUrl && <div className="setup-overlay-url"><Field label="Private OBS overlay URL" readOnly value={overlayUrl} onFocus={event => event.currentTarget.select()} />{copyFallback && <p>Select the URL and use your keyboard’s Copy command.</p>}</div>}<p className="setup-step-note">Enable OBS audio control for this source if you turn on narration or scene sounds. Start with a local preview and check your mixer level.</p></section></li>
      <li><div className="setup-step-number">5</div><section><h2>Preview before showing it</h2><p>Preview is local. Show recap sends a request to your connected OBS source. The dock keeps Pause, Forget and Cancel beside the scene controls.</p><Button disabled={!snapshot?.session} pending={pending === 'preview'} onClick={() => void openPreview()}>Preview recap</Button>
        {candidate && candidate.status !== 'rejected' && <div className="setup-previous"><h3>Optional previous-stream clip</h3><p>{candidate.clip.title}</p><p className="pv-secondary">From {new Date(candidate.clip.created_at).toLocaleDateString()}. It will be identified as a previous stream during an early welcome.</p><ActionGroup><QuietButton pending={pending === 'previewClip'} onClick={() => void prepareClip(false)}>{clipPending ? 'Check preview' : 'Preview previous clip'}</QuietButton><QuietButton pending={pending === 'useClip'} onClick={() => void prepareClip(true)}>{snapshot?.settings.earlyWelcomeClipId === candidate.clip.id ? 'Previous clip selected' : 'Use previous clip'}</QuietButton></ActionGroup>{clipPreview && !clipFailed ? <video src={clipPreview} controls playsInline preload="metadata" onError={() => setClipFailed(true)} aria-label="Previous-stream clip preview" /> : clipFailed ? <p>Clip unavailable. <a href={candidate.clip.url} target="_blank" rel="noreferrer">Watch it on Twitch</a>.</p> : null}{clipPending && <p className="pv-secondary">Clip preparation pending. This does not enable automatic clip creation.</p>}</div>}
      </section></li>
      <li><div className="setup-step-number">6</div><section><h2>Share the public recap</h2>{diagnostics?.publicUrl ? <><p>Your public link shows published chapters. Drafts and source transcripts stay in your dock.</p><a href={diagnostics.publicUrl} target="_blank" rel="noreferrer">Open your public recap</a><QuietButton onClick={() => void act('publicCopy', async () => { const copied = await copyValue(diagnostics.publicUrl!, navigator.clipboard); setNotice(copied ? 'Public recap link copied.' : 'Select the public recap URL below and copy it.'); })}>Copy public link</QuietButton><Field label="Public recap URL" value={diagnostics.publicUrl} readOnly onFocus={event => event.currentTarget.select()} /></> : <p>Configure public sharing, then Check configuration. Local previews and editing remain available while cloud sync is unavailable.</p>}</section></li>
    </ol>
    <Dialog open={rotate} onOpenChange={setRotate} title="Replace your OBS link?" footer={<ActionGroup><Button tone="danger" pending={pending === 'overlay'} onClick={() => void copyOverlay(true)}>Rotate and copy link</Button><QuietButton onClick={() => setRotate(false)}>Keep current link</QuietButton></ActionGroup>}><p>The old link stops working immediately. Replace the URL in your OBS Browser Source with the new one.</p>{error && <InlineNotice tone="danger">{error}</InlineNotice>}</Dialog>
    <Sheet open={previewOpen} onOpenChange={open => { setPreviewOpen(open); if (!open) setPreview(null); }} title="Local recap preview" description="This does not broadcast to OBS." footer={<QuietButton onClick={() => { setPreviewOpen(false); setPreview(null); }}>Close preview</QuietButton>}>{preview ? renderPreview ? renderPreview(preview, () => { setPreviewOpen(false); setPreview(null); }) : <div>{preview.beats.map(beat => <p key={beat.id}>{beat.text}</p>)}</div> : <p>The stream is still gathering context. Preview again after a safe chapter is published.</p>}</Sheet>
  </main>;
}


