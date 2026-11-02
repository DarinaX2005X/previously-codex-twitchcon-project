import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Chapter, InvalidationReceipt, Lore, Moment, OwnerIssue, OwnerSnapshot, PrivacyTarget, PublicChapter, RecapClient, RecapLanguage, RecapPlan } from '../../shared/contracts';
import { ActionGroup, Brand, Button, ClipFrame, Dialog, DockLayout, Field, IconButton, InlineNotice, LanguageControl, QuietButton, SegmentedControl, Sheet, SourceDisclosure, Textarea, Timecode, formatTimecode } from '../../ui';
import { SettingsSheet } from '../settings/SettingsSheet';
import { dockClock, DockStore, errorCode, forgetWindow, hotkeyMatches, pauseListening, privacyAcknowledged, publicationLabel, recordingRecovery, saveChapterDraft, type DockClockMode } from './model';
import type { DockCapturePort, DockMarkerSnapshot, DockOwnerPort, DockPreviewRenderer } from './ports';
import { SourceSheet, type SourceContext } from './SourceSheet';
import { LoreRow } from './LoreRow';
import { DockHistoryStore, historyKey, mergeHistory, type HistoryContext } from './history';
import type { RecordingPanelStatus, RecordingPort } from './RecordingPanel';
import { Icon } from './icons';
import './dock.css';

const RecordingPanel = import.meta.env.MODE === 'public' ? null : lazy(() => import('./RecordingPanel').then(module => ({ default: module.RecordingPanel })));

/** Where a saved clip can be played. Returns nothing when this dock cannot show media for the id. */
export type DockMediaResolver = (mediaId: string) => { src?: string; poster?: string } | undefined;
export interface DockPageProps { client: RecapClient; capture?: DockCapturePort; owner?: DockOwnerPort; renderPreview?: DockPreviewRenderer; recordingPort?: RecordingPort; label?: string; clockMode?: DockClockMode; recording?: boolean; availableLanguages?: RecapLanguage[]; resolveMedia?: DockMediaResolver; }
type Edit = { id: string; title: string; summary: string; baseRevision: number; error: string; conflict: boolean };
type SignalState = 'live' | 'paused' | 'pending' | 'error';
const idleCapture = { status: 'idle' as const, level: 0, message: null, droppedChunks: 0 };
const idleSubscribe = () => () => {};
const getIdleCapture = () => idleCapture;

function signalOf(state: OwnerSnapshot['status']['mic']['state']): SignalState {
  return state === 'ready' || state === 'listening' ? 'live' : state === 'paused' ? 'paused' : state === 'error' || state === 'disconnected' ? 'error' : state === 'connecting' || state === 'delayed' ? 'pending' : 'paused';
}
export function dockMarkerLabel(marker: DockMarkerSnapshot['items'][number]): string {
  if (marker.status === 'sent') return marker.positionSeconds === undefined ? 'Twitch marker saved' : `Twitch marker saved at ${formatTimecode(marker.positionSeconds * 1000)}`;
  if (marker.status === 'queued') return 'Twitch marker pending';
  if (marker.status === 'unknown_outcome') return 'Twitch marker not confirmed. No automatic retry.';
  return 'Twitch marker unavailable. Timecode saved.';
}
/** This polls only owner result metadata; it never creates a Twitch side effect. */
export function pollDockMarkers(read: NonNullable<DockOwnerPort['listMarkers']>, sessionId: string, onValue: (value: DockMarkerSnapshot) => void, onError: () => void, visible: () => boolean): () => void {
  let closed = false, enabled: boolean | null = null, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
  async function poll() {
    if (closed) return;
    if (!visible()) { timer = setTimeout(() => void poll(), 2000); return; }
    active = new AbortController();
    try {
      const value = await read(sessionId, active.signal);
      if (closed) return;
      if (value.sessionId !== sessionId) throw new Error('Marker session changed');
      enabled = value.enabled; failures = 0; onValue(value);
    } catch { if (!closed) { ++failures; onError(); } }
    finally {
      active = undefined;
      if (!closed && enabled !== false) timer = setTimeout(() => void poll(), Math.min(10000, 2000 * 2 ** failures));
    }
  }
  void poll();
  return () => { closed = true; clearTimeout(timer); active?.abort(); };
}

const clockTime = (iso: string) => { const time = Date.parse(iso); return Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
const issueSubject: Record<OwnerIssue['component'], string> = { transcription: 'Speech', story: 'Chapters', moderation: 'Safety checks', narration: 'Narration', chat: 'Chat' };

function Signal({ icon, label, detail, state }: { icon: 'mic' | 'chat'; label: string; detail: string; state: SignalState }) {
  return <div className="dk-signal" data-state={state} title={detail}>
    <span className="dk-signal__icon"><Icon name={icon} /><i aria-hidden="true" /></span>
    <span className="dk-signal__text"><strong>{label}</strong>{state !== 'live' && <span>{detail}</span>}</span>
  </div>;
}

function IssueCard({ issue, action }: { issue: OwnerIssue; action?: ReactNode }) {
  return <article className="dk-issue" data-source={issue.source}>
    <Icon name="alert" className="dk-issue__icon" />
    <div className="dk-issue__body">
      <p className="dk-issue__reason">{issue.reason}</p>
      <p className="dk-issue__recovery">{issue.recovery}</p>
      <p className="dk-issue__meta">{issue.source === 'twitch' ? 'Twitch' : 'OpenAI'} {issueSubject[issue.component].toLowerCase()}{clockTime(issue.since) && <>, since {clockTime(issue.since)}</>}</p>
      {action && <div className="dk-issue__action">{action}</div>}
    </div>
  </article>;
}

interface ChapterCardProps {
  chapter: PublicChapter | Chapter; now: number; delaySeconds: number; media?: { src?: string; poster?: string; label: string };
  pending: Set<string>; confirming: boolean; canSource: boolean; sourceFallback?: ReactNode;
  onSource(): void; onEdit(): void; onPin(): void; onDeleteAsk(): void; onDeleteCancel(): void; onDelete(): void;
}
function ChapterCard({ chapter, now, delaySeconds, media, pending, confirming, canSource, sourceFallback, onSource, onEdit, onPin, onDeleteAsk, onDeleteCancel, onDelete }: ChapterCardProps) {
  const local = 'publicationState' in chapter ? chapter : null;
  const label = local ? publicationLabel(local, now) : null;
  const waiting = local && label?.startsWith('Publishes in');
  const blocked = local && !waiting && label !== 'Ready for the next publication';
  const remaining = local ? Math.max(0, (Date.parse(local.eligibleAt) - now) / 1000) : 0;
  const fuse = waiting ? Math.min(1, remaining / Math.max(1, delaySeconds)) : 0;
  const titleId = useId();
  return <article className="pv-card pv-card--ink pv-card--tabbed dk-chapter" data-state={blocked ? 'review' : waiting ? 'waiting' : 'published'} data-pinned={chapter.pinned || undefined} aria-labelledby={titleId}>
    <span className="pv-tab dk-chapter__tab">{formatTimecode(chapter.startMs)}</span>
    {chapter.pinned && <span className="dk-chapter__pin" title="Pinned for the next scene"><Icon name="pin" /><span className="pv-sr-only">Pinned for the next scene</span></span>}
    <div className="dk-chapter__head">
      <div className="dk-chapter__text">
        {label && <p className="dk-chapter__state">{blocked && <Icon name="alert" />}{waiting && <Icon name="clock" />}<span>{label}</span></p>}
        {waiting && <span className="dk-fuse" aria-hidden="true"><span style={{ transform: `scaleX(${fuse})` }} /></span>}
        <h3 id={titleId}>{chapter.title}</h3>
        {!local && chapter.edited && <p className="dk-chapter__state"><Icon name="pencil" /><span>Your wording</span></p>}
      </div>
      {media && <ClipFrame className="dk-chapter__clip" src={media.src} poster={media.poster} label={media.label} onPointerEnter={event => { const video = event.currentTarget.querySelector('video'); void video?.play().catch(() => {}); }} onPointerLeave={event => { const video = event.currentTarget.querySelector('video'); video?.pause(); }} />}
    </div>
    <p className="dk-chapter__summary">{chapter.summary}</p>
    {sourceFallback}
    {confirming ? <div className="dk-confirm" role="group" aria-label={`Delete ${chapter.title}`}>
      <p>Remove this chapter from the recap and queued scenes? Its captured sources stay.</p>
      <div className="dk-confirm__actions"><Button tone="danger" pending={pending.has(`delete:${chapter.id}`)} onClick={onDelete}>Delete chapter</Button><QuietButton onClick={onDeleteCancel}>Keep it</QuietButton></div>
    </div> : <div className="dk-actions">
      {canSource && <button type="button" className="dk-act" onClick={onSource}><Icon name="quote" />Source</button>}
      <button type="button" className="dk-act" onClick={onEdit}><Icon name="pencil" />Edit</button>
      <button type="button" className="dk-act" aria-pressed={chapter.pinned} aria-busy={pending.has(`pin:${chapter.id}`) || undefined} disabled={pending.has(`pin:${chapter.id}`)} onClick={onPin}><Icon name="pin" />{chapter.pinned ? 'Unpin' : 'Pin'}</button>
      <button type="button" className="dk-act dk-act--danger" onClick={onDeleteAsk}><Icon name="trash" />Delete</button>
    </div>}
  </article>;
}

export function DockPage({ client, capture: providedCapture, owner, renderPreview, recordingPort, label, clockMode = 'server', recording = false, availableLanguages, resolveMedia }: DockPageProps) {
  const capture = import.meta.env.MODE === 'public' || recording ? undefined : providedCapture;
  const store = useMemo(() => new DockStore(client), [client]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const captureState = useSyncExternalStore(capture?.subscribe ?? idleSubscribe, capture?.getSnapshot ?? getIdleCapture, getIdleCapture);
  const snapshot = state.snapshot;
  const historyStore = useMemo(() => new DockHistoryStore(owner?.listHistory ? query => owner.listHistory!(query) : undefined, () => { store.invalidate(); void store.refresh(); }), [owner, store]);
  const historyState = useSyncExternalStore(historyStore.subscribe, historyStore.getSnapshot, historyStore.getSnapshot);
  const [filter, setFilter] = useState('published'), [limit, setLimit] = useState(20);
  const [loreLimit, setLoreLimit] = useState(20);
  const [markerResult, setMarkerResult] = useState<{ key: string; value: DockMarkerSnapshot; error: boolean } | null>(null);
  const markerKey = `${snapshot?.session?.id ?? ''}:${state.sourceEpoch}`;
  const markerMomentIds = snapshot?.moments.slice(-10).map(item => item.id).join('|') ?? '';
  const hasMarkerUI = import.meta.env.MODE !== 'public' && !recording && Boolean(owner?.listMarkers) && Boolean(snapshot?.session) && Boolean(snapshot?.moments.length);
  const markers = hasMarkerUI && markerResult?.key === markerKey ? markerResult : null;
  const historyContext: HistoryContext | null = snapshot?.session ? { sessionId: snapshot.session.id, privacyEpoch: snapshot.session.privacyEpoch, language: snapshot.settings.recapLanguage, filter: filter === 'drafts' ? 'draft' : filter === 'held' ? 'held' : 'published', resetKey: `${state.sourceEpoch}:${snapshot.published?.language ?? ''}` } : null;
  const contextKey = historyContext ? historyKey(historyContext) : '';
  const history = historyState.key === contextKey ? historyState : null;
  const durableHistory = Boolean(owner?.listHistory && historyContext && !(filter === 'published' && snapshot?.published && snapshot.published.language !== snapshot.settings.recapLanguage));
  const [edit, setEdit] = useState<Edit | null>(null), [settings, setSettings] = useState(false);
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<{ epoch: number; value: RecordingPanelStatus } | null>(null);
  const recordingsId = useId();
  const hasRecordingUI = import.meta.env.MODE !== 'public' && !recording && Boolean(recordingPort) && Boolean(RecordingPanel);
  const receiveRecordingStatus = useCallback((value: RecordingPanelStatus) => { setRecordingStatus({ epoch: state.sourceEpoch, value }); }, [state.sourceEpoch]);
  const activeRecording = hasRecordingUI && recordingStatus?.epoch === state.sourceEpoch && recordingStatus.value.activeId ? recordingStatus.value : null;
  const [source, setSource] = useState<SourceContext | null>(null), [forget, setForget] = useState<PrivacyTarget | null>(null);
  const [preview, setPreview] = useState<RecapPlan | null>(null), [previewOpen, setPreviewOpen] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
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
    ++previewGeneration.current; ++privacyGeneration.current; setPreview(null); setPreviewOpen(false); setSource(null); setConfirmDelete(null);
    setEdit(current => current && (state.invalidatedIds === null || state.invalidatedIds.includes(current.id)) ? null : current);
  }, [state.sourceEpoch]);
  useEffect(() => { setLimit(20); setConfirmDelete(null); }, [filter, snapshot?.session?.id]);
  useEffect(() => { historyStore.reset(historyContext ?? undefined); setLoreLimit(20); return () => historyStore.reset(); }, [historyStore, contextKey]);
  useEffect(() => {
    if (!hasMarkerUI || !owner?.listMarkers || !snapshot?.session) return;
    return pollDockMarkers((sessionId, signal) => owner.listMarkers!(sessionId, signal), snapshot.session.id,
      value => setMarkerResult({ key: markerKey, value, error: false }),
      () => setMarkerResult(current => current?.key === markerKey ? { ...current, error: true } : current),
      () => document.visibilityState === 'visible');
  }, [hasMarkerUI, owner, markerKey, markerMomentIds]);
  // A result receipt stays long enough to read, then leaves; a new action replaces it at once.
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 9000); return () => clearTimeout(timer); }, [notice]);

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
    await run('show', async () => { const result = await client.triggerRecap(snapshot.session!.id); setNotice(result.status === 'skipped' ? 'No eligible recap is ready to show.' : 'Recap sent to OBS.'); await store.refresh(); });
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
      if (result.ok) { if (historyContext) historyStore.apply(result.chapter, historyContext); setEdit(null); setNotice(result.chapter.publicationState === 'held' ? publicationLabel(result.chapter, now) : 'Your wording is saved. New audio will not replace it.'); await store.refresh(); }
      else { setEdit(current => current?.id === value.id ? { ...current, error: result.error, conflict: result.conflict } : current); if (result.conflict) await store.refresh(); }
    });
  }
  async function applyForget() {
    if (!forget) return;
    await run('forget', async () => {
      // A privacy action cancels both the local preview sink and pending preview preparation.
      ++previewGeneration.current; ++privacyGeneration.current; setPreview(null); setPreviewOpen(false); setSource(null); setEdit(null);
      const result = await client.privacy(forget, 'owner_forget'); setReceipt(result); store.invalidate(result.hiddenEntityIds); setReceiptKind('forget'); setForget(null); setNotice(''); await store.refresh();
    });
  }
  async function deleteChapter(chapter: PublicChapter | Chapter) {
    await run(`delete:${chapter.id}`, async () => {
      const result = await client.deleteChapter(chapter.id, chapter.revision);
      setReceipt(result); store.invalidate(result.hiddenEntityIds); setReceiptKind('chapter'); ++previewGeneration.current; setSource(null); setPreview(null); setPreviewOpen(false); setNotice(''); setConfirmDelete(null); await store.refresh();
    });
  }
  async function togglePin(chapter: PublicChapter | Chapter) {
    await run(`pin:${chapter.id}`, async () => { const updated = await client.pinChapter(chapter.id, !chapter.pinned, chapter.revision); if (historyContext) historyStore.apply(updated, historyContext); setNotice(chapter.pinned ? 'Chapter unpinned.' : 'Pinned for the next scene. Safety checks still apply.'); await store.refresh(); });
  }
  async function toggleListening() {
    if (!snapshot) return;
    const pausing = captureEngaged || !snapshot.settings.listeningPaused;
    await run(pausing ? 'pause' : 'listen', async () => {
      if (pausing) { await pauseListening(client, snapshot, capture); setNotice('Listening paused. New speech and chat are not being added.'); }
      else { if (capture && snapshot.session) { await capture.start(snapshot.session.id); if (!['listening', 'delayed'].includes(capture.getSnapshot().status)) return; } else if (capture) throw new Error('No live session'); await client.setSettings({ listeningPaused: false, baseRevision: snapshot.settings.revision }); setNotice(capture ? 'Microphone listening. New speech and chat can be added.' : 'Listening resumed in this recording.'); }
      await store.refresh();
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
  const localChapters: (PublicChapter | Chapter)[] = filter === 'drafts' ? snapshot?.drafts ?? [] : filter === 'held' ? heldChapters : published?.chapters ?? [];
  const recentChapters = [...localChapters].sort((a, b) => b.startMs - a.startMs || b.id.localeCompare(a.id));
  const chapters = durableHistory && history?.chapterLoaded ? mergeHistory<PublicChapter | Chapter>(history.chapters, recentChapters.slice(0, 20)) : recentChapters;
  // Chronology is stable when pinning. Pin changes the next scene selection, not keyboard order.
  const visible = [...chapters].sort((a, b) => b.startMs - a.startMs || b.id.localeCompare(a.id)).slice(0, durableHistory && history?.chapterLoaded ? chapters.length : limit);
  const comparison = edit && [...localChapters, ...(snapshot?.drafts ?? []), ...heldChapters, ...(history?.chapters ?? [])].filter(item => item.id === edit.id).sort((a, b) => b.revision - a.revision)[0];
  const localLore = [...(snapshot?.lore.filter(item => item.status === 'held' || item.status === 'observed') ?? [])].sort((a, b) => b.firstSeenMs - a.firstSeenMs || b.id.localeCompare(a.id));
  const lore = (durableHistory && history?.loreLoaded ? mergeHistory<Lore>(history.lore, localLore.slice(0, 20)) : localLore.slice(0, loreLimit)).sort((a, b) => b.firstSeenMs - a.firstSeenMs || b.id.localeCompare(a.id));
  const paused = snapshot?.settings.listeningPaused || captureState.status === 'paused';
  const captured = captureState.status === 'listening' || captureState.status === 'delayed';
  const captureEngaged = captured || ['permission_pending', 'pausing', 'pause_failed'].includes(captureState.status);
  const micLabel = recording ? 'Recorded speech' : capture ? captureState.status === 'permission_pending' ? 'Asking for the microphone' : captured ? 'Microphone on' : captureState.status === 'no_device' ? 'No microphone' : captureState.status === 'denied' ? 'Microphone blocked' : 'Microphone off' : snapshot?.status.mic.message ?? 'Microphone not enabled here';
  const micObservation = recording ? paused ? 'Paused in this recording' : 'From this recording' : captureState.message ?? (paused ? 'New speech is not being added' : snapshot?.status.mic.lastObservedAt ? `Heard at ${clockTime(snapshot.status.mic.lastObservedAt)}` : 'Start listening to include speech');
  const chatObservation = recording ? paused ? 'Paused in this recording' : 'From this recording' : snapshot?.status.chat.lastObservedAt ? `Last message at ${clockTime(snapshot.status.chat.lastObservedAt)}` : 'No chat messages yet';
  const chatLabel = recording ? 'Recorded chat' : { unconfigured: 'Chat not configured', disconnected: 'Chat disconnected', connecting: 'Chat reconnecting', ready: 'Chat connected', listening: 'Chat arriving', paused: 'Chat paused', delayed: 'Chat delayed', error: 'Chat disconnected' }[snapshot?.status.chat.state ?? 'unconfigured'];
  const micState: SignalState = recording ? paused ? 'paused' : 'live' : ['denied', 'error', 'pause_failed', 'no_device', 'device_lost'].includes(captureState.status) ? 'error' : captureState.status === 'permission_pending' ? 'pending' : captured ? 'live' : 'paused';
  const chatState: SignalState = recording ? paused ? 'paused' : 'live' : signalOf(snapshot?.status.chat.state ?? 'unconfigured');
  const issues = recording ? [] : snapshot?.issues ?? [];
  const issueComponents = new Set(issues.map(issue => issue.component));
  const overlayReady = snapshot?.status.overlay.state === 'ready';
  const current = published?.current;
  const nowText = current ? current.now ?? current.goal ?? current.change : null;
  const delaySeconds = snapshot?.settings.publicationDelaySeconds ?? 75;
  const mediaFor = (chapter: PublicChapter | Chapter) => {
    if (!resolveMedia || !snapshot) return undefined;
    const moment = chapter.momentIds.map(id => snapshot.moments.find(item => item.id === id)).find((item): item is Moment => Boolean(item && item.mediaState === 'ready' && item.mediaId));
    const value = moment?.mediaId ? resolveMedia(moment.mediaId) : undefined;
    return value && (value.src || value.poster) ? { ...value, label: `Clip from ${chapter.title} at ${formatTimecode(moment!.startMs)}` } : undefined;
  };
  const counts = { drafts: snapshot?.drafts.length ?? 0, held: snapshot?.held.length ?? 0 };
  const reconnect = import.meta.env.MODE === 'public' || recording ? undefined : <a className="dk-link" href="/api/auth/twitch/start?returnTo=/dock" target="_blank" rel="noreferrer"><Icon name="twitch" />Reconnect Twitch</a>;

  const header = <>
    <div className="dk-id">
      <Brand variant="small-mark" tone="dark" />
      <div className="dk-id__text"><strong>{snapshot?.channel.displayName ?? 'Your channel'}</strong><span>{label ?? (snapshot?.session ? snapshot.session.status === 'live' ? snapshot.session.title || 'Live now' : 'Stream ended' : 'No live stream')}</span></div>
      {hasRecordingUI && <QuietButton className="dk-id__button" aria-expanded={recordingsOpen} aria-controls={recordingsId} onClick={() => setRecordingsOpen(true)}>Recordings</QuietButton>}
      <IconButton label="Scene settings" className="dk-id__settings" disabled={!snapshot} onClick={() => setSettings(true)}><Icon name="gear" /></IconButton>
    </div>
    <div className="dk-signals"><Signal icon="mic" label={micLabel} detail={micObservation} state={micState} /><Signal icon="chat" label={chatLabel} detail={chatObservation} state={chatState} /></div>
    <section className="dk-now" aria-label="What viewers read now">
      {nowText ? <article className="pv-card pv-card--tabbed dk-now__card">
        <span className="pv-tab pv-tab--now">Now at {formatTimecode(current!.sourceTimeMs)}</span>
        <h2 className="dk-now__text">{nowText}</h2>
        {current?.goal && current.goal !== nowText && <p className="dk-now__fact"><span>Goal</span>{current.goal}</p>}
      </article> : <div className="dk-now__empty"><p>{snapshot?.session ? 'The first statement for viewers appears here once the stream has something to share.' : 'Viewers will read what is happening on stream here.'}</p></div>}
    </section>
    <div className="dk-scene">
      <Button className="dk-show" pending={pending.has('show')} disabled={!snapshot?.session || !overlayReady} onClick={() => void show()}><Icon name="cast" />Show recap{snapshot?.settings.hotkey && <kbd>{snapshot.settings.hotkey}</kbd>}</Button>
      <QuietButton pending={pending.has('preview')} disabled={!snapshot?.session} onClick={() => void showPreview()}><Icon name="eye" />Preview</QuietButton>
      <QuietButton pending={pending.has('moment')} disabled={!snapshot?.session} onClick={() => void run('moment', async () => { const moment = await client.saveMoment({ sessionId: snapshot!.session!.id }); setNotice(`Moment saved at ${formatTimecode(moment.startMs)}. ${moment.mediaState === 'pending' ? 'Clip pending.' : moment.mediaState === 'ready' ? 'Clip ready.' : 'Clip unavailable. The time is saved.'}`); await store.refresh(); })}><Icon name="bookmark" />Save moment</QuietButton>
    </div>
    {snapshot?.session && !overlayReady && <p className="dk-reason"><Icon name="alert" /><span>{recording ? 'The recorded scene is unavailable. Try Preview again or restart the recording.' : <>{snapshot.status.overlay.message ?? 'OBS is not showing the scene source.'} Preview still works here. <a href="/setup">Set up OBS</a></>}</span></p>}
    <div className="dk-privacy">
      <QuietButton className="dk-privacy__pause" data-paused={!captureEngaged && snapshot?.settings.listeningPaused ? true : undefined} pending={pending.has(captureEngaged || !snapshot?.settings.listeningPaused ? 'pause' : 'listen')} disabled={!snapshot} onClick={() => void toggleListening()}><Icon name={captureEngaged || !snapshot?.settings.listeningPaused ? 'pause' : 'play'} />{captureState.status === 'pause_failed' ? 'Retry pause' : captureEngaged || !snapshot?.settings.listeningPaused ? 'Pause listening' : 'Resume listening'}</QuietButton>
      <QuietButton className="dk-privacy__forget" disabled={!snapshot?.session} onClick={() => snapshot && setForget(forgetWindow(snapshot, elapsed))}><Icon name="rewind" />Forget last 2 min</QuietButton>
    </div>
    {active.map(item => <div className="dk-strip" key={item.id}><span className="dk-strip__dot" data-state={item.status} /><span>{item.status === 'queued' ? 'Recap queued' : item.status === 'preparing' ? 'Preparing the scene for OBS' : 'Recap playing in OBS'}</span><QuietButton pending={pending.has(`cancel:${item.id}`)} onClick={() => void run(`cancel:${item.id}`, async () => { await client.cancelRecap(item.id); setNotice('Recap cancelled.'); refresh(); })}>Cancel recap</QuietButton></div>)}
    {activeRecording && <div className="dk-strip" role="status"><span className="dk-strip__dot" data-state="recording" /><span>{activeRecording.status === 'armed' ? 'Recording armed for the next session' : 'Recording privately'}</span><QuietButton pending={activeRecording.pending} onClick={activeRecording.stop}>Stop recording</QuietButton></div>}
  </>;

  return <main className="dock-page" onKeyDown={focusHotkey}>
    <DockLayout header={header} aria-label={label ?? 'Streamer dock'}>
      {state.loading && <div className="dk-loading" role="status"><span /><span /><p>Loading your channel</p></div>}
      {issues.length > 0 && <section className="dk-issues" aria-label="Problems that need attention">{issues.map(issue => <IssueCard key={`${issue.source}:${issue.component}:${issue.code}`} issue={issue} action={issue.source === 'twitch' ? reconnect : import.meta.env.MODE === 'public' ? undefined : <a className="dk-link" href="/setup"><Icon name="key" />Open setup</a>} />)}</section>}
      {(state.error || error) && <InlineNotice tone="danger" live action={recording ? undefined : <QuietButton onClick={refresh}>Refresh dock</QuietButton>}>{recording ? recordingRecovery : error || state.error}</InlineNotice>}
      {receipt && <InlineNotice tone={recording || privacyAcknowledged(receipt, snapshot) ? 'success' : 'warning'} action={<QuietButton onClick={() => setReceipt(null)}>Done</QuietButton>}><p className="dk-receipt__title">{receiptKind === 'chapter' ? 'Chapter removed from the recap and queued scenes. Captured sources are kept.' : 'The interval and the chapters, moments, lore and media made from it are removed locally.'}</p><p>{recording ? 'This changes only the recording sandbox. Reset recording restores the original recording; your live channel is unchanged.' : privacyAcknowledged(receipt, snapshot) ? 'Cloud removal acknowledged.' : 'Cloud removal pending. Keep this process running until the cloud acknowledges it.'}</p>{!recording && receipt.externalClipActions.length > 0 && <div><p>Delete these clips manually on Twitch:</p>{receipt.externalClipActions.map(action => <a key={action.clipId} href={action.manageUrl} target="_blank" rel="noreferrer">Manage Twitch clip {action.clipId}</a>)}</div>}</InlineNotice>}
      {snapshot && <>
        {captureState.status === 'conflict' && <InlineNotice tone="warning" action={<QuietButton onClick={() => snapshot.session && void run('listen', () => capture!.start(snapshot.session!.id, true))}>Take over listening</QuietButton>}>Another dock owns this microphone session. Take over to stop that capture and listen here.</InlineNotice>}
        {captureState.status === 'denied' && <InlineNotice tone="warning">Microphone access is blocked. Allow access in your browser, then Resume listening. In OBS, open <a href="/dock" target="_blank" rel="noreferrer">the dock in a browser tab</a> to use your microphone.</InlineNotice>}
        {captureState.status === 'no_device' && <InlineNotice tone="warning">No microphone found. Connect one and Resume listening, or continue with chat.</InlineNotice>}
        {(capture && snapshot.session && !captureEngaged && !snapshot.settings.listeningPaused) || (['denied', 'no_device'].includes(captureState.status) && snapshot.settings.listeningPaused) ? <div className="dk-fixes">
          {capture && snapshot.session && !captureEngaged && !snapshot.settings.listeningPaused && <QuietButton pending={pending.has('startMic')} onClick={() => void run('startMic', async () => { await capture.start(snapshot.session!.id); if (['listening', 'delayed'].includes(capture.getSnapshot().status)) setNotice('Microphone listening.'); })}><Icon name="mic" />{['denied', 'no_device', 'device_lost', 'error'].includes(captureState.status) ? 'Retry microphone' : 'Start microphone'}</QuietButton>}
          {['denied', 'no_device'].includes(captureState.status) && snapshot.settings.listeningPaused && <QuietButton pending={pending.has('chatOnly')} onClick={() => void run('chatOnly', async () => { await client.setSettings({ listeningPaused: false, baseRevision: snapshot.settings.revision }); setNotice('Chat-only listening enabled. The microphone remains off.'); await store.refresh(); })}><Icon name="chat" />Continue with chat only</QuietButton>}
        </div> : null}
        {!issueComponents.has('chat') && (snapshot.status.chat.state === 'error' || snapshot.status.chat.state === 'disconnected') ? <InlineNotice tone="warning" action={reconnect}>{import.meta.env.MODE === 'public' || recording ? 'Recorded chat is unavailable. Use the recording controls to restart.' : <>{snapshot.status.chat.message ?? 'Chat is disconnected.'} Your edits stay open in this tab.</>}</InlineNotice> : null}
        {(['story', 'transcription', 'moderation'] as const).some(key => !issueComponents.has(key) && ['delayed', 'error'].includes(snapshot.status[key].state)) && <InlineNotice tone="warning">{recording ? recordingRecovery : <>Recap updates are delayed. Your published chapters stay online. {snapshot.status.story.action ?? 'Check the connection, then refresh the dock.'}</>}</InlineNotice>}
        {!snapshot.session && <InlineNotice>There is no live stream. Start your stream on Twitch, then refresh this dock. Your saved settings stay available.</InlineNotice>}
        {snapshot.session && snapshot.session.status !== 'live' && <InlineNotice tone={snapshot.session.finalSnapshotAckAt ? 'success' : 'info'}>{snapshot.session.status === 'closing' ? 'Finishing the recap. Keep this process running.' : snapshot.session.finalSnapshotAckAt ? 'The stream ended and its recap is saved online.' : 'Public update pending. Keep this process running until the final recap is acknowledged.'}</InlineNotice>}
        {!recording && snapshot.sync.state === 'unconfigured' && <InlineNotice tone="warning">Public sharing is not set up, so the recap is saved on this computer only. <a href="/setup">Set up public sharing</a></InlineNotice>}
        {published && published.language !== snapshot.settings.recapLanguage && <InlineNotice>Preparing the {snapshot.settings.recapLanguage === 'ru' ? 'Russian' : 'English'} recap. The {published.language === 'en' ? 'English' : 'Russian'} version stays published until the new one is ready.</InlineNotice>}
        <SegmentedControl className="dk-filter" label="Chapter collection" value={filter} onChange={setFilter} options={[{ value: 'published', label: 'Published' }, { value: 'drafts', label: counts.drafts ? `Drafts ${counts.drafts}` : 'Drafts' }, { value: 'held', label: counts.held ? `Held ${counts.held}` : 'Held' }]} />
        <section className="dk-list" aria-label={`${filter} chapters`}>
          {!visible.length && <div className="dk-empty"><span className="dk-empty__card" aria-hidden="true"><span className="dk-empty__tab" /></span><p>{filter === 'published' ? published?.current ? 'No chapters yet. The first one is written after a few minutes of stream.' : 'Chapters appear here after they pass the publication delay.' : filter === 'drafts' ? 'Nothing is waiting to publish.' : 'Nothing needs your review.'}</p></div>}
          {visible.map(chapter => <ChapterCard key={chapter.id} chapter={chapter} now={now} delaySeconds={delaySeconds} media={mediaFor(chapter)} pending={pending} confirming={confirmDelete === chapter.id}
            canSource={Boolean(owner && snapshot.session)} sourceFallback={owner && snapshot.session ? undefined : <SourceDisclosure label="Sources">{chapter.sourceLabels.length ? chapter.sourceLabels.map(item => <p key={item.id}>{item.label} <Timecode milliseconds={item.atMs} /></p>) : <p>No source details in this recording.</p>}</SourceDisclosure>}
            onSource={() => setSource({ title: chapter.title, sessionId: snapshot.session!.id, fromMs: chapter.startMs, toMs: Math.max(chapter.endMs, chapter.maxDependencyEndMs) })}
            onEdit={() => openEdit(chapter)} onPin={() => void togglePin(chapter)} onDeleteAsk={() => setConfirmDelete(chapter.id)} onDeleteCancel={() => setConfirmDelete(null)} onDelete={() => void deleteChapter(chapter)} />)}
          {durableHistory && historyContext ? (!history?.chapterLoaded || history.chapterCursor) && <QuietButton className="dk-more" pending={history?.loading === 'chapter'} disabled={Boolean(history?.loading)} onClick={() => void historyStore.load('chapter', historyContext)}>{history?.chapterLoaded || localChapters.length > 20 ? 'Earlier chapters' : 'Browse chapter history'}</QuietButton> : chapters.length > limit && <QuietButton className="dk-more" onClick={() => setLimit(value => value + 20)}>Show more chapters</QuietButton>}
          {history?.error && <InlineNotice tone="danger">{history.error}</InlineNotice>}
        </section>
        {filter === 'held' && lore.length > 0 && <section className="dk-lore-list" aria-label="Running jokes waiting for review">{lore.map(item => <LoreRow key={`${item.id}:${state.sourceEpoch}`} lore={item} owner={owner} onSaved={result => { if (result && 'status' in result && historyContext) historyStore.apply(result, historyContext); else if (result && 'privacyEpoch' in result) store.invalidate(result.hiddenEntityIds); refresh(); }} onSource={() => snapshot.session && setSource({ title: item.term, sessionId: snapshot.session.id, fromMs: Math.max(0, item.firstSeenMs - 30_000), toMs: Math.min(172_800_000, item.firstSeenMs + 30_000) })} />)}{durableHistory && historyContext ? (!history?.loreLoaded || history.loreCursor) && <QuietButton className="dk-more" pending={history?.loading === 'lore'} disabled={Boolean(history?.loading)} onClick={() => void historyStore.load('lore', historyContext)}>{history?.loreLoaded || localLore.length > 20 ? 'Earlier lore' : 'Browse lore history'}</QuietButton> : localLore.length > loreLimit && <QuietButton className="dk-more" onClick={() => setLoreLimit(value => value + 20)}>Show more lore</QuietButton>}</section>}
        {snapshot.moments.length > 0 && <section className="dk-moments" aria-labelledby="dk-moments-title"><h2 id="dk-moments-title">Saved moments</h2><ul>{snapshot.moments.slice(-10).reverse().map(moment => {
          const marker = markers?.value.enabled ? markers.value.items.find(item => item.momentId === moment.id) : null;
          const clip = moment.mediaState === 'ready' && moment.mediaId && resolveMedia ? resolveMedia(moment.mediaId) : undefined;
          return <li key={moment.id}>
            {clip?.poster ? <img className="dk-moment__thumb" src={clip.poster} alt="" /> : <span className="dk-moment__thumb dk-moment__thumb--empty" aria-hidden="true"><Icon name="bookmark" /></span>}
            <div><p><Timecode milliseconds={moment.startMs} /><strong>{moment.label}</strong></p><p className="dk-moment__state">{moment.mediaState === 'ready' ? 'Clip ready' : moment.mediaState === 'pending' ? 'Clip pending' : 'Clip unavailable, time saved'}{moment.count > 0 && `. ${moment.count} chat messages`}</p>{marker && <p className="dk-moment__state">{dockMarkerLabel(marker)}</p>}</div>
          </li>;
        })}</ul>{markers?.value.enabled && markers.error && <p className="dk-moment__error">Twitch marker status could not refresh. The saved timecodes are still available.</p>}</section>}
        <section className="dk-language">{availableLanguages === undefined || availableLanguages.length > 1 ? <LanguageControl showHint={!recording} value={snapshot.settings.recapLanguage} disabled={pending.has('language')} onChange={language => void run('language', async () => { if (availableLanguages && !availableLanguages.includes(language)) return; await client.setSettings({ recapLanguage: language, baseRevision: snapshot.settings.revision }); await store.refresh(); })} /> : availableLanguages.length === 1 ? <p>Recap language: {availableLanguages[0] === 'ru' ? 'Русский' : 'English'}</p> : null}</section>
      </>}
    </DockLayout>
    {notice && <div className="dk-toast" role="status" key={notice}><Icon name="check" /><p>{notice}</p><button type="button" className="dk-toast__close" aria-label="Dismiss" onClick={() => setNotice('')}><Icon name="close" /></button></div>}
    {hasRecordingUI && recordingPort && RecordingPanel && <Sheet open={recordingsOpen} onOpenChange={setRecordingsOpen} title="Stream recordings" className="dock-paper dock-recordings-sheet" footer={<QuietButton onClick={() => setRecordingsOpen(false)}>Close recordings</QuietButton>}><div id={recordingsId}><Suspense fallback={<p role="status">Opening recording controls…</p>}><RecordingPanel port={recordingPort} sessionId={snapshot?.session?.status === 'live' ? snapshot.session.id : null} sourceEpoch={state.sourceEpoch} onStatusChange={receiveRecordingStatus} /></Suspense></div></Sheet>}
    <Sheet open={!!edit} onOpenChange={open => { if (!open) closeEdit(); }} title="Edit chapter" className="dock-paper" description="New audio will not replace your wording. Publication still waits for its safety check." footer={<ActionGroup><Button pending={pending.has('edit')} disabled={!edit?.title.trim() || !edit?.summary.trim() || edit.conflict} onClick={() => void saveEdit()}>Save chapter</Button><QuietButton onClick={closeEdit}>Cancel</QuietButton></ActionGroup>}>
      {edit && <><Field label="Chapter title" disabled={pending.has('edit')} value={edit.title} maxLength={120} onChange={event => setEdit({ ...edit, title: event.target.value })} /><Textarea label="Chapter summary" disabled={pending.has('edit')} value={edit.summary} maxLength={700} onChange={event => setEdit({ ...edit, summary: event.target.value })} />{edit.error && <InlineNotice tone="danger" live>{edit.error}</InlineNotice>}{edit.conflict && <section className="dock-comparison"><h3>Latest saved version</h3>{comparison ? <><strong>{comparison.title}</strong><p>{comparison.summary}</p><QuietButton onClick={() => setEdit({ ...edit, baseRevision: comparison.revision, conflict: false, error: '' })}>Keep my edit against this version</QuietButton></> : <p>This chapter is no longer available. Copy any wording you want to keep before closing.</p>}</section>}<p className="pv-secondary">Deleting a chapter removes it from the recap. To remove what was captured, open Source and use Forget.</p></>}
    </Sheet>
    <Dialog open={!!forget} onOpenChange={open => { if (!open) setForget(null); }} title={forget?.kind === 'interval' ? `Forget ${formatTimecode(forget.fromMs)} to ${formatTimecode(forget.toMs)}?` : 'Forget captured material?'} className="dock-paper dk-forget" footer={<ActionGroup><Button tone="danger" pending={pending.has('forget')} onClick={() => void applyForget()}>{forget?.kind === 'interval' ? `Forget these ${Math.round((forget.toMs - forget.fromMs) / 1000)} seconds` : 'Forget this interval'}</Button><QuietButton onClick={() => setForget(null)}>Keep it</QuietButton></ActionGroup>}>
      {forget?.kind === 'interval' && <div className="dk-forget__window" aria-hidden="true"><span>{formatTimecode(forget.fromMs)}</span><i /><span>{formatTimecode(forget.toMs)}</span></div>}
      {recording ? <p>This removes the interval and the chapters, moments, lore and media made from it in this recording’s sandbox. Reset recording restores the original. Your live channel and Twitch clips are unchanged.</p> : <><p>Speech and chat from this interval are deleted, along with the chapters, moments, lore and Previously media made from them. This cannot be undone.</p><p>Twitch clips have to be deleted on Twitch. Any affected clips are listed after removal.</p><p>Keep this process running until the cloud confirms the removal.</p></>}{error && <InlineNotice tone="danger">{error}</InlineNotice>}
    </Dialog>
    {source && owner && <SourceSheet key={`${state.sourceEpoch}:${source.fromMs}:${source.toMs}`} context={source} owner={owner} onClose={() => setSource(null)} onForget={target => { setSource(null); setForget(target); }} />}
    {settings && snapshot && <SettingsSheet settings={snapshot.settings} client={client} recording={recording} onClose={() => setSettings(false)} onSaved={refresh} />}
    <Sheet open={previewOpen} onOpenChange={open => { if (!open) { ++previewGeneration.current; setPreview(null); } setPreviewOpen(open); }} title="Preview" description="Only you see this preview. Nothing is sent to OBS." className="dock-paper dk-preview" footer={<QuietButton onClick={() => { setPreview(null); setPreviewOpen(false); }}>Close preview</QuietButton>}>
      {preview ? renderPreview ? renderPreview(preview, () => { setPreview(null); setPreviewOpen(false); }) : <div className="dock-plan-preview"><p>{preview.variant === 'welcome' ? 'Welcome scene' : 'Recap scene'}, {preview.durationMs / 1000} seconds</p>{preview.beats.map(beat => <p key={beat.id}><strong>{beat.kind === 'now' ? 'What matters now' : beat.kind === 'change' ? 'What changed' : beat.kind === 'origin' ? 'Confirmed origin' : beat.kind === 'context' ? 'Context' : 'Earlier'}</strong><br />{beat.text}</p>)}</div> : <p>No eligible story is ready to preview yet.</p>}
    </Sheet>
  </main>;
}
