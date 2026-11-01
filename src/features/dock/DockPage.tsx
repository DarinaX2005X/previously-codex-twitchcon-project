import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Chapter, InvalidationReceipt, OwnerSnapshot, PrivacyTarget, PublicChapter, RecapClient, RecapPlan } from '../../shared/contracts';
import { ActionGroup, Brand, Button, ChapterRow, Dialog, DockLayout, Field, InlineNotice, LanguageControl, QuietButton, SegmentedControl, Sheet, SourceDisclosure, SourceStatus, Textarea, Timecode, formatTimecode } from '../../ui';
import { SettingsSheet } from '../settings/SettingsSheet';
import { dockClock, DockStore, errorCode, forgetWindow, hotkeyMatches, pauseListening, privacyAcknowledged, publicationLabel, saveChapterDraft, type DockClockMode } from './model';
import type { DockCapturePort, DockOwnerPort, DockPreviewRenderer } from './ports';
import { SourceSheet, type SourceContext } from './SourceSheet';
import { LoreRow } from './LoreRow';
import './dock.css';

export interface DockPageProps { client: RecapClient; capture?: DockCapturePort; owner?: DockOwnerPort; renderPreview?: DockPreviewRenderer; label?: string; clockMode?: DockClockMode; recording?: boolean; }
type Edit = { id: string; title: string; summary: string; baseRevision: number; error: string; conflict: boolean };
const idleCapture = { status: 'idle' as const, level: 0, message: null, droppedChunks: 0 };
const idleSubscribe = () => () => {};
const getIdleCapture = () => idleCapture;

function statusView(state: OwnerSnapshot['status']['mic']['state']): 'ready' | 'pending' | 'paused' | 'unavailable' | 'error' {
  return state === 'ready' || state === 'listening' ? 'ready' : state === 'paused' ? 'paused' : state === 'error' ? 'error' : state === 'connecting' || state === 'delayed' ? 'pending' : 'unavailable';
}
export function DockPage({ client, capture, owner, renderPreview, label, clockMode = 'server', recording = false }: DockPageProps) {
  const store = useMemo(() => new DockStore(client), [client]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const captureState = useSyncExternalStore(capture?.subscribe ?? idleSubscribe, capture?.getSnapshot ?? getIdleCapture, getIdleCapture);
  const snapshot = state.snapshot;
  const [filter, setFilter] = useState('published'), [limit, setLimit] = useState(20);
  const [edit, setEdit] = useState<Edit | null>(null), [settings, setSettings] = useState(false);
  const [source, setSource] = useState<SourceContext | null>(null), [forget, setForget] = useState<PrivacyTarget | null>(null);
  const [preview, setPreview] = useState<RecapPlan | null>(null), [previewOpen, setPreviewOpen] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [receipt, setReceipt] = useState<InvalidationReceipt | null>(null);
  const [receiptKind, setReceiptKind] = useState<'forget' | 'chapter'>('forget');
  const [pending, setPending] = useState<Set<string>>(new Set());
  const busy = useRef(new Set<string>());
  const previewGeneration = useRef(0), privacyGeneration = useRef(0), editGeneration = useRef(0);
  const [clock, setClock] = useState(0);
  const observedAt = useRef({ server: '', local: 0 });
  if (snapshot && snapshot.serverNow !== observedAt.current.server) observedAt.current = { server: snapshot.serverNow, local: Date.now() };
  const { elapsed, now } = dockClock(snapshot?.serverNow ?? new Date().toISOString(), observedAt.current.local, Date.now(), clockMode);
  void clock;
  useEffect(() => store.connect(), [store]);
  useEffect(() => { if (clockMode === 'snapshot') return; const timer = setInterval(() => setClock(value => value + 1), 1000); return () => clearInterval(timer); }, [clockMode]);
  useEffect(() => {
    ++previewGeneration.current; ++privacyGeneration.current; setPreview(null); setPreviewOpen(false); setSource(null);
    setEdit(current => current && (state.invalidatedIds === null || state.invalidatedIds.includes(current.id)) ? null : current);
  }, [state.sourceEpoch]);
  useEffect(() => { setLimit(20); }, [filter, snapshot?.session?.id]);

  async function run(key: string, action: () => Promise<void>) {
    if (busy.current.has(key)) return;
    busy.current.add(key); setPending(new Set(busy.current)); setError('');
    try { await action(); }
    catch (cause) { const code = errorCode(cause); setError(code === 'revision_conflict' ? 'This item changed in another dock. Refresh and compare before trying again.' : code === 'fixture_missing' ? 'This recording has no recorded result for that action.' : 'Could not complete this action. Your current edit is still here. Try again.'); }
    finally { busy.current.delete(key); setPending(new Set(busy.current)); }
  }
  const refresh = () => { void store.refresh(); };
  function openEdit(chapter: PublicChapter) { ++editGeneration.current; setEdit({ id: chapter.id, title: chapter.title, summary: chapter.summary, baseRevision: chapter.revision, error: '', conflict: false }); }
  function closeEdit() { ++editGeneration.current; setEdit(null); }
  async function show() {
    if (!snapshot?.session) return;
    if (snapshot.status.overlay.state !== 'ready') { setError('The OBS source is unavailable. Connect it in setup, or use Preview locally.'); return; }
    await run('show', async () => { const result = await client.triggerRecap(snapshot.session!.id); setNotice(result.status === 'skipped' ? 'No eligible recap is ready to show.' : ''); await store.refresh(); });
  }
  async function showPreview() {
    if (!snapshot?.session) return;
    const generation = ++previewGeneration.current;
    await run('preview', async () => { const plan = await client.previewRecap(snapshot.session!.id); if (generation !== previewGeneration.current) return; setPreview(plan); setPreviewOpen(true); });
  }
  async function saveEdit() {
    if (!edit) return;
    const value = { ...edit }, generation = privacyGeneration.current, editor = editGeneration.current;
    await run('edit', async () => {
      const result = await saveChapterDraft(client, value);
      if (generation !== privacyGeneration.current || editor !== editGeneration.current) return;
      if (result.ok) { setEdit(null); setNotice(result.chapter.publicationState === 'held' ? publicationLabel(result.chapter, now) : 'Your wording is saved. New audio will not replace it.'); await store.refresh(); }
      else { setEdit(current => current?.id === value.id ? { ...current, error: result.error, conflict: result.conflict } : current); if (result.conflict) await store.refresh(); }
    });
  }
  async function applyForget() {
    if (!forget) return;
    await run('forget', async () => {
      // A privacy action cancels both the local preview sink and pending preview preparation.
      ++previewGeneration.current; ++privacyGeneration.current; setPreview(null); setPreviewOpen(false); setSource(null); setEdit(null);
      const result = await client.privacy(forget, 'owner_forget'); setReceipt(result); setReceiptKind('forget'); setForget(null); setNotice(''); await store.refresh();
    });
  }
  function focusHotkey(event: React.KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable=true],dialog') || event.repeat) return;
    if (event.key === 'Escape' && snapshot) {
      const active = snapshot.playback.filter(item => ['playing', 'preparing', 'queued'].includes(item.status));
      if (active.length) { event.preventDefault(); void run('cancel', async () => { await Promise.all(active.map(item => client.cancelRecap(item.id))); refresh(); }); }
      return;
    }
    if (snapshot?.settings.hotkey && hotkeyMatches(event.nativeEvent, snapshot.settings.hotkey)) { event.preventDefault(); void show(); }
  }
  const active = snapshot?.playback.filter(item => ['playing', 'preparing', 'queued'].includes(item.status)) ?? [];
  const published = snapshot?.published;
  const heldChapters = snapshot?.held.filter((item): item is Chapter => 'publicationState' in item) ?? [];
  const chapters: (PublicChapter | Chapter)[] = filter === 'drafts' ? snapshot?.drafts ?? [] : filter === 'held' ? heldChapters : published?.chapters ?? [];
  // Chronology is stable when pinning. Pin changes the next scene selection, not keyboard order.
  const visible = [...chapters].sort((a, b) => b.startMs - a.startMs || a.id.localeCompare(b.id)).slice(0, limit);
  const comparison = edit && [...(published?.chapters ?? []), ...(snapshot?.drafts ?? []), ...heldChapters].find(item => item.id === edit.id);
  const paused = snapshot?.settings.listeningPaused || captureState.status === 'paused';
  const captured = captureState.status === 'listening' || captureState.status === 'delayed';
  const captureEngaged = captured || captureState.status === 'permission_pending';
  const micLabel = recording ? 'Recorded speech' : capture ? captureState.status === 'permission_pending' ? 'Microphone permission pending' : captured ? 'Microphone listening' : captureState.status === 'no_device' ? 'No microphone found' : captureState.status === 'denied' ? 'Microphone access blocked' : 'Microphone off' : snapshot?.status.mic.message ?? 'Microphone is not enabled in this dock';
  const micObservation = recording ? paused ? 'Paused in this recording' : 'No microphone is used' : captureState.message ?? (paused ? 'New speech is not being added' : snapshot?.status.mic.lastObservedAt ? `Observed ${new Date(snapshot.status.mic.lastObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Start listening to include speech');
  const chatObservation = recording ? paused ? 'Paused in this recording' : 'From this recording' : snapshot?.status.chat.lastObservedAt ? `Observed ${new Date(snapshot.status.chat.lastObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'No chat observation yet';

  const header = <>
    <div className="dock-identity"><Brand variant="small-mark" tone="dark" /><div><strong>{snapshot?.channel.displayName ?? 'Your channel'}</strong><span>{label ?? (snapshot?.session ? snapshot.session.status === 'live' ? 'Streamer dock' : 'Stream ended' : 'No live session')}</span></div><QuietButton disabled={!snapshot} onClick={() => setSettings(true)}>Settings</QuietButton></div>
    {snapshot?.session?.title && <p className="dock-stream-title">{snapshot.session.title}</p>}
    <div className="dock-statuses"><SourceStatus label={micLabel} state={recording ? paused ? 'paused' : 'ready' : captureState.status === 'denied' || captureState.status === 'error' ? 'error' : captured ? 'ready' : 'paused'} observation={micObservation} /><SourceStatus label={recording ? 'Recorded chat' : snapshot?.status.chat.message ?? `Chat ${snapshot?.status.chat.state ?? 'unavailable'}`} state={recording ? paused ? 'paused' : 'ready' : statusView(snapshot?.status.chat.state ?? 'unconfigured')} observation={chatObservation} /></div>
    <ActionGroup className="dock-scene-actions"><Button pending={pending.has('show')} disabled={!snapshot?.session || snapshot.status.overlay.state !== 'ready'} title={snapshot?.settings.hotkey ? `Show recap (${snapshot.settings.hotkey} while this dock has focus)` : undefined} onClick={() => void show()}>Show recap</Button><QuietButton pending={pending.has('preview')} disabled={!snapshot?.session} onClick={() => void showPreview()}>Preview</QuietButton><QuietButton pending={pending.has('moment')} disabled={!snapshot?.session} onClick={() => void run('moment', async () => { const moment = await client.saveMoment({ sessionId: snapshot!.session!.id }); setNotice(`Moment saved at ${formatTimecode(moment.startMs)}. ${moment.mediaState === 'pending' ? 'Clip pending.' : moment.mediaState === 'ready' ? 'Clip ready.' : 'Clip unavailable. The time is saved.'}`); await store.refresh(); })}>Save moment</QuietButton></ActionGroup>
    <div className="dock-privacy"><QuietButton pending={pending.has(captureEngaged || !snapshot?.settings.listeningPaused ? 'pause' : 'listen')} disabled={!snapshot} onClick={() => snapshot && void run(captureEngaged || !snapshot.settings.listeningPaused ? 'pause' : 'listen', async () => {
      if (captureEngaged || !snapshot.settings.listeningPaused) { await pauseListening(client, snapshot, capture); setNotice('Listening paused. New speech and chat are not being added.'); }
      else { if (capture && snapshot.session) { await capture.start(snapshot.session.id); if (!['listening', 'delayed'].includes(capture.getSnapshot().status)) return; } else if (capture) throw new Error('No live session'); await client.setSettings({ listeningPaused: false, baseRevision: snapshot.settings.revision }); setNotice(capture ? 'Microphone listening. New speech and chat can be added.' : 'Listening resumed in this recording.'); }
      await store.refresh();
    })}>{captureEngaged || !snapshot?.settings.listeningPaused ? 'Pause listening' : 'Resume listening'}</QuietButton><QuietButton tone="danger" disabled={!snapshot?.session} onClick={() => snapshot && setForget(forgetWindow(snapshot, elapsed))}>Forget last 2 min</QuietButton></div>
    {active.map(item => <div className="dock-queue" key={item.id}><span>{item.status === 'queued' ? 'Recap queued' : item.status === 'preparing' ? 'Preparing broadcast recap' : 'Recap playing'}</span><QuietButton pending={pending.has(`cancel:${item.id}`)} onClick={() => void run(`cancel:${item.id}`, async () => { await client.cancelRecap(item.id); setNotice('Recap cancelled.'); refresh(); })}>Cancel recap</QuietButton></div>)}
  </>;
  return <main className="dock-page" onKeyDown={focusHotkey}>
    <DockLayout header={header} aria-label={label ?? 'Streamer dock'}>
      {state.loading && <p role="status">Loading your channel…</p>}
      {(state.error || error) && <InlineNotice tone="danger" live action={<QuietButton onClick={refresh}>Refresh dock</QuietButton>}>{error || state.error}</InlineNotice>}
      {notice && <p className="dock-result" role="status">{notice}</p>}
      {receipt && <InlineNotice tone={recording || privacyAcknowledged(receipt, snapshot) ? 'success' : 'warning'}><p>{receiptKind === 'chapter' ? 'Chapter removed from the recap and queued scenes. Captured sources are kept.' : 'The source interval and affected chapters, moments, lore and Previously media are removed locally.'}</p><p>{recording ? 'This changes only the recording sandbox. Reset recording restores the original recording; your live channel is unchanged.' : privacyAcknowledged(receipt, snapshot) ? 'Cloud removal acknowledged.' : 'Cloud removal pending. Keep this process running until the cloud acknowledges it.'}</p>{receipt.externalClipActions.length > 0 && <div><p>Delete these clips manually on Twitch:</p>{receipt.externalClipActions.map(action => <a key={action.clipId} href={action.manageUrl} target="_blank" rel="noreferrer">Manage Twitch clip {action.clipId}</a>)}</div>}</InlineNotice>}
      {snapshot && <>
        {captureState.status === 'conflict' && <InlineNotice tone="warning" action={<QuietButton onClick={() => snapshot.session && void run('listen', () => capture!.start(snapshot.session!.id, true))}>Take over listening</QuietButton>}>Another dock owns this microphone session. Take over to stop that capture and listen here.</InlineNotice>}
        {captureState.status === 'denied' && <InlineNotice tone="warning">Microphone access is blocked. Allow access in your browser, then Resume listening. In OBS, open <a href="/dock" target="_blank" rel="noreferrer">the dock in a browser tab</a> to use your microphone.</InlineNotice>}
        {captureState.status === 'no_device' && <InlineNotice tone="warning">No microphone found. Connect one and Resume listening, or continue with chat.</InlineNotice>}
        {capture && snapshot.session && !captureEngaged && !snapshot.settings.listeningPaused && <QuietButton pending={pending.has('startMic')} onClick={() => void run('startMic', async () => { await capture.start(snapshot.session!.id); if (['listening', 'delayed'].includes(capture.getSnapshot().status)) setNotice('Microphone listening.'); })}>{['denied', 'no_device', 'device_lost', 'error'].includes(captureState.status) ? 'Retry microphone' : 'Start microphone'}</QuietButton>}
        {['denied', 'no_device'].includes(captureState.status) && snapshot.settings.listeningPaused && <QuietButton pending={pending.has('chatOnly')} onClick={() => void run('chatOnly', async () => { await client.setSettings({ listeningPaused: false, baseRevision: snapshot.settings.revision }); setNotice('Chat-only listening enabled. The microphone remains off.'); await store.refresh(); })}>Continue with chat only</QuietButton>}
        {snapshot.status.chat.state === 'error' || snapshot.status.chat.state === 'disconnected' ? <InlineNotice tone="warning">{snapshot.status.chat.message ?? 'Chat is disconnected.'} <a href="/api/auth/twitch/start?returnTo=/dock" target="_blank" rel="noreferrer">Reconnect Twitch</a>. Your edit stays open in this tab.</InlineNotice> : null}
        {['story', 'transcription', 'moderation'].some(key => ['delayed', 'error'].includes(snapshot.status[key as 'story'].state)) && <InlineNotice tone="warning">Recap updates are delayed. Your published chapters are still available. {snapshot.status.story.action ?? 'Check the connection, then refresh the dock.'}</InlineNotice>}
        {snapshot.status.overlay.state !== 'ready' && <p className="pv-secondary">{snapshot.status.overlay.message ?? 'The broadcast source is unavailable. Preview works locally.'} <a href="/setup">Set up OBS</a></p>}
        {!snapshot.session && <InlineNotice>There is no live stream. Start your stream on Twitch, then refresh this dock. Your saved settings remain available.</InlineNotice>}
        {snapshot.session && snapshot.session.status !== 'live' && <InlineNotice>{snapshot.session.status === 'closing' ? 'Finishing the recap. Keep this process running.' : snapshot.session.finalSnapshotAckAt ? 'Episode saved online.' : 'Public update pending. Keep this process running until the final snapshot is acknowledged.'}</InlineNotice>}
        {!recording && snapshot.sync.state === 'unconfigured' && <InlineNotice tone="warning">Cloud sync is not configured. Your recap is saved locally. <a href="/setup">Set up public sharing</a>.</InlineNotice>}
        <LanguageControl value={snapshot.settings.recapLanguage} disabled={pending.has('language')} onChange={language => void run('language', async () => { await client.setSettings({ recapLanguage: language, baseRevision: snapshot.settings.revision }); await store.refresh(); })} />
        {published && published.language !== snapshot.settings.recapLanguage && <InlineNotice>Preparing {snapshot.settings.recapLanguage === 'ru' ? 'Russian' : 'English'} recap. The complete {published.language === 'en' ? 'English' : 'Russian'} version stays published until the new version is ready.</InlineNotice>}
        <section className="dock-current" aria-labelledby="dock-current-title"><h2 id="dock-current-title">Currently published</h2>{published?.current ? <><p className="dock-current-main">{published.current.now ?? published.current.goal ?? published.current.change}</p>{published.current.goal && published.current.now && <p>{published.current.goal}</p>}{published.current.change && <p className="pv-secondary">{published.current.change}</p>}</> : <p className="pv-secondary">Your recap will appear after the stream has context to share.</p>}</section>
        <SegmentedControl label="Chapter collection" value={filter} onChange={setFilter} options={[{ value: 'published', label: 'Published' }, { value: 'drafts', label: snapshot.drafts.length ? `Drafts (${snapshot.drafts.length})` : 'Drafts' }, { value: 'held', label: snapshot.held.length ? `Held (${snapshot.held.length})` : 'Held' }]} />
        <section className="dock-chronology" aria-label={`${filter} chapters`}>
          {!visible.length && <p className="dock-empty">{filter === 'published' ? 'No published chapters yet.' : filter === 'drafts' ? 'No chapters waiting to publish.' : 'No held chapters.'}</p>}
          {visible.map(chapter => <ChapterRow key={chapter.id} title={chapter.title} atMs={chapter.startMs} state={'publicationState' in chapter ? publicationLabel(chapter, now) : chapter.edited ? 'Your wording' : undefined} actions={<ActionGroup>{owner && snapshot.session && <QuietButton onClick={() => setSource({ title: chapter.title, sessionId: snapshot.session!.id, fromMs: chapter.startMs, toMs: Math.max(chapter.endMs, chapter.maxDependencyEndMs) })}>Source</QuietButton>}<QuietButton onClick={() => openEdit(chapter)}>Edit</QuietButton><QuietButton aria-pressed={chapter.pinned} pending={pending.has(`pin:${chapter.id}`)} onClick={() => void run(`pin:${chapter.id}`, async () => { await client.pinChapter(chapter.id, !chapter.pinned, chapter.revision); setNotice(chapter.pinned ? 'Chapter unpinned.' : 'Pinned for the next scene. Safety checks still apply.'); await store.refresh(); })}>{chapter.pinned ? 'Unpin' : 'Pin'}</QuietButton><QuietButton tone="danger" pending={pending.has(`delete:${chapter.id}`)} onClick={() => void run(`delete:${chapter.id}`, async () => { const result = await client.deleteChapter(chapter.id, chapter.revision); setReceipt(result); setReceiptKind('chapter'); ++previewGeneration.current; setSource(null); setPreview(null); setPreviewOpen(false); setNotice(''); await store.refresh(); })}>Delete</QuietButton></ActionGroup>} sources={owner && snapshot.session ? undefined : <SourceDisclosure label="Source">{chapter.sourceLabels.length ? chapter.sourceLabels.map(item => <p key={item.id}>{item.label} <Timecode milliseconds={item.atMs} /></p>) : <p>No source details available in this recording.</p>}</SourceDisclosure>}><p>{chapter.summary}</p></ChapterRow>)}
          {chapters.length > limit && <QuietButton onClick={() => setLimit(value => value + 20)}>Earlier chapters</QuietButton>}
        </section>
        {filter === 'held' && snapshot.lore.filter(item => item.status === 'held' || item.status === 'observed').map(lore => <LoreRow key={`${lore.id}:${state.sourceEpoch}`} lore={lore} owner={owner} onSaved={refresh} onSource={() => snapshot.session && setSource({ title: lore.term, sessionId: snapshot.session.id, fromMs: Math.max(0, lore.firstSeenMs - 30_000), toMs: Math.min(172_800_000, lore.firstSeenMs + 30_000) })} />)}
        {snapshot.moments.length > 0 && <section className="dock-moments"><h2>Saved moments</h2>{snapshot.moments.slice(-10).reverse().map(moment => <div key={moment.id}><Timecode milliseconds={moment.startMs} /><span>{moment.label}</span><small>{moment.mediaState === 'ready' ? 'Clip ready' : moment.mediaState === 'pending' ? 'Clip pending' : 'Clip unavailable'}</small></div>)}</section>}
      </>}
    </DockLayout>
    <Sheet open={!!edit} onOpenChange={open => { if (!open) closeEdit(); }} title="Edit chapter" className="dock-paper" description="Your saved wording is kept when new audio arrives. Publication still requires a safety check." footer={<ActionGroup><Button pending={pending.has('edit')} disabled={!edit?.title.trim() || !edit?.summary.trim() || edit.conflict} onClick={() => void saveEdit()}>Save chapter</Button><QuietButton onClick={closeEdit}>Cancel</QuietButton></ActionGroup>}>
      {edit && <><Field label="Chapter title" disabled={pending.has('edit')} value={edit.title} maxLength={120} onChange={event => setEdit({ ...edit, title: event.target.value })} /><Textarea label="Chapter summary" disabled={pending.has('edit')} value={edit.summary} maxLength={700} onChange={event => setEdit({ ...edit, summary: event.target.value })} />{edit.error && <InlineNotice tone="danger" live>{edit.error}</InlineNotice>}{edit.conflict && <section className="dock-comparison"><h3>Latest saved version</h3>{comparison ? <><strong>{comparison.title}</strong><p>{comparison.summary}</p><QuietButton onClick={() => setEdit({ ...edit, baseRevision: comparison.revision, conflict: false, error: '' })}>Keep my edit against this version</QuietButton></> : <p>This chapter is no longer available. Copy any wording you want to keep before closing.</p>}</section>}<p className="pv-secondary">Delete chapter removes the chapter from the recap. Use Forget from Source to remove captured material and its derived stories.</p></>}
    </Sheet>
    <Dialog open={!!forget} onOpenChange={open => { if (!open) setForget(null); }} title="Forget captured material" className="dock-paper" footer={<ActionGroup><Button tone="danger" pending={pending.has('forget')} onClick={() => void applyForget()}>Forget this interval</Button><QuietButton onClick={() => setForget(null)}>Keep it</QuietButton></ActionGroup>}>
      {forget?.kind === 'interval' && <p>Remove <strong>{formatTimecode(forget.fromMs)} to {formatTimecode(forget.toMs)}</strong> ({Math.round((forget.toMs - forget.fromMs) / 1000)} seconds) from this stream.</p>}{recording ? <p>This removes the interval and its affected chapters, moments, lore and media from this recording’s sandbox. Reset recording restores the original recording. Your live channel and Twitch clips are unchanged.</p> : <><p>This permanently removes the captured transcript and affected chapters, moments, lore and Previously media. There is no Undo.</p><p>Twitch clips need manual deletion on Twitch. Any affected clips will appear in a cleanup list after removal.</p><p>Cloud removal stays pending until acknowledged. Keep this process running.</p></>}{error && <InlineNotice tone="danger">{error}</InlineNotice>}
    </Dialog>
    {source && owner && <SourceSheet key={`${state.sourceEpoch}:${source.fromMs}:${source.toMs}`} context={source} owner={owner} onClose={() => setSource(null)} onForget={target => { setSource(null); setForget(target); }} />}
    {settings && snapshot && <SettingsSheet settings={snapshot.settings} client={client} onClose={() => setSettings(false)} onSaved={refresh} />}
    <Sheet open={previewOpen} onOpenChange={open => { if (!open) { ++previewGeneration.current; setPreview(null); } setPreviewOpen(open); }} title="Local preview" description="This preview does not show anything in OBS." className="dock-paper" footer={<QuietButton onClick={() => { setPreview(null); setPreviewOpen(false); }}>Close preview</QuietButton>}>
      {preview ? renderPreview ? renderPreview(preview, () => { setPreview(null); setPreviewOpen(false); }) : <div className="dock-plan-preview"><p>{preview.variant === 'welcome' ? 'Welcome scene' : 'Recap scene'}, {preview.durationMs / 1000} seconds</p>{preview.beats.map(beat => <p key={beat.id}><strong>{beat.kind === 'now' ? 'What matters now' : beat.kind === 'change' ? 'What changed' : beat.kind === 'origin' ? 'Confirmed origin' : 'Earlier'}</strong><br />{beat.text}</p>)}</div> : <p>No eligible story is ready to preview yet.</p>}
    </Sheet>
  </main>;
}






