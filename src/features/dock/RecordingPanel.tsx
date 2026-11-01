import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { RecordingReview, RecordingSummary, ReviewReceipt, SourceReview, MediaReview, RecordingPublication, RecordingStartEligibility } from '../../server/replay/recording-types';
import { ActionGroup, Button, Dialog, QuietButton, Sheet, formatTimecode } from '../../ui';
import './recording-panel.css';

export interface RecordingPort {
  request<T>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string }): Promise<T>;
  base?: string;
}
export type { RecordingPublication } from '../../server/replay/recording-types';
export type PanelRecording = RecordingSummary;
type RecordingList = { items: PanelRecording[]; activeId: string | null; startEligibility: RecordingStartEligibility; boundary: string; automaticUpload: false };
export type RecordingChecks = { metadata: boolean; sources: string[]; outputs: string[]; visual: string[]; audio: string[] };
export type RecordingApproval = { captureRevision: number; digest: string; reviewedSources: SourceReview[]; reviewedOutputHashes: string[]; reviewedMedia: MediaReview[]; metadataReviewed: true };
type RecordingPanelState = {
  sourceEpoch: number; items: PanelRecording[]; activeId: string | null; loading: boolean;
  startEligibility: RecordingStartEligibility | null;
  review: RecordingReview | null; checks: RecordingChecks; receiptId: string | null;
  pending: string | null; error: string | null; notice: string | null;
};
const emptyChecks = (): RecordingChecks => ({ metadata: false, sources: [], outputs: [], visual: [], audio: [] });
export const recordingSourceKey = (source: RecordingReview['sources'][number]) => source.id + ':' + source.revision + ':' + source.textHash;
export const recordingMediaKey = (media: RecordingReview['media'][number]) => media.id + ':' + media.hash;
const metadataKey = (review: RecordingReview) => JSON.stringify([review.metadata.channel, review.metadata.title, review.metadata.category]);
/** The fresh server review proves each retained confirmation; the capture digest is never an item identity. */
function retainedChecks(previous: RecordingReview, next: RecordingReview, checked: RecordingChecks): RecordingChecks {
  if (previous.recording.id !== next.recording.id) return emptyChecks();
  const sources = new Set(previous.sources.map(recordingSourceKey)), outputs = new Set(previous.outputs.map(output => output.hash)), media = new Set(previous.media.map(recordingMediaKey));
  return {
    metadata: checked.metadata && metadataKey(previous) === metadataKey(next),
    sources: next.sources.map(recordingSourceKey).filter(key => sources.has(key) && checked.sources.includes(key)),
    outputs: next.outputs.map(output => output.hash).filter(hash => outputs.has(hash) && checked.outputs.includes(hash)),
    visual: next.media.map(recordingMediaKey).filter(key => media.has(key) && checked.visual.includes(key)),
    audio: next.media.map(recordingMediaKey).filter(key => media.has(key) && checked.audio.includes(key)),
  };
}
export function recordingApproval(review: RecordingReview, checks: RecordingChecks): RecordingApproval | null {
  if (review.blockedReasons.length || !checks.metadata ||
    review.sources.some(source => !checks.sources.includes(recordingSourceKey(source))) ||
    review.outputs.some(output => !checks.outputs.includes(output.hash)) ||
    review.media.some(media => !checks.visual.includes(recordingMediaKey(media)) || !checks.audio.includes(recordingMediaKey(media)))) return null;
  return {
    captureRevision: review.recording.revision, digest: review.digest, metadataReviewed: true,
    reviewedSources: review.sources.map(({ id, revision, textHash }) => ({ id, revision, textHash })),
    reviewedOutputHashes: review.outputs.map(output => output.hash),
    reviewedMedia: review.media.map(({ id, hash }) => ({ id, hash, visualReviewed: true, audioReviewed: true })),
  };
}
function safeMessage(error: unknown) { return error instanceof Error ? error.message : 'The recording action could not be completed. Try again.'; }
const pathFor = (id: string) => '/recordings/' + encodeURIComponent(id);
export function recordingAssetUrl(port: RecordingPort, id: string, mediaId?: string): string | null {
  const base = port.base ?? '/api/owner';
  if (!base.startsWith('/') || base.startsWith('//') || /[?#]/.test(base)) return null;
  return base.replace(/\/$/, '') + pathFor(id) + (mediaId === undefined ? '/download' : '/media/' + encodeURIComponent(mediaId));
}
export function recordingReplayUrl(item: PanelRecording): string | null {
  if (!item.exportId || item.publication?.state !== 'published' || !item.publication.replayUrl) return null;
  try { const url = new URL(item.publication.replayUrl); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/replay' && url.searchParams.get('recording') === item.exportId ? url.href : null; }
  catch { return null; }
}
/** Private review state is tied to the capture digest and the dock's source invalidation epoch. */
export class RecordingPanelModel {
  private state: RecordingPanelState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private readGeneration = 0;
  private controllers = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly port: RecordingPort, sourceEpoch = 0, private sessionId: string | null = null) {
    this.state = { sourceEpoch, items: [], activeId: null, loading: false, startEligibility: null, review: null, checks: emptyChecks(), receiptId: null, pending: null, error: null, notice: null };
  }
  activate() { this.disposed = false; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<RecordingPanelState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private async request<T>(path: string, options: Parameters<RecordingPort['request']>[1] = {}): Promise<T> {
    const controller = new AbortController(); this.controllers.add(controller);
    try { return await this.port.request<T>(path, { ...options, signal: controller.signal }); }
    finally { this.controllers.delete(controller); }
  }
  invalidate(sourceEpoch: number) {
    this.generation++; this.readGeneration++;
    for (const controller of this.controllers) controller.abort();
    this.set({ sourceEpoch, startEligibility: null, review: null, checks: emptyChecks(), receiptId: null, pending: null, notice: null, error: null });
    void this.load();
  }
  dispose() { this.disposed = true; this.generation++; for (const controller of this.controllers) controller.abort(); this.listeners.clear(); this.state = { ...this.state, review: null, checks: emptyChecks(), receiptId: null }; }
  async setSession(sessionId: string | null) { if (this.sessionId === sessionId) return; this.sessionId = sessionId; this.readGeneration++; this.set({ startEligibility: null }); await this.load(); }
  async load() {
    if (this.state.pending?.startsWith('media:')) return;
    const generation = this.generation, read = ++this.readGeneration;
    this.set({ loading: true });
    try {
      const list = await this.request<RecordingList>('/recordings' + (this.sessionId ? '?sessionId=' + encodeURIComponent(this.sessionId) : ''));
      if (this.disposed || generation !== this.generation || read !== this.readGeneration) return;
      const review = this.state.review, current = review && list.items.find(item => item.id === review.recording.id);
      const changed = !!review && (!current || current.revision !== review.recording.revision || current.publication?.state === 'revoked' || ['invalidated', 'failed', 'interrupted'].includes(current.status));
      this.set({ items: list.items, activeId: list.activeId, loading: false, startEligibility: list.startEligibility ?? null, ...(changed ? { review: null, checks: emptyChecks(), receiptId: null, notice: 'The recording changed. Open its current contents to review again.' } : {}) });
    } catch (error) { if (!this.disposed && generation === this.generation && read === this.readGeneration) { const status = (error as { status?: number })?.status; this.set({ loading: false, startEligibility: null, error: safeMessage(error), ...([401, 403, 410].includes(status ?? 0) ? { review: null, checks: emptyChecks(), receiptId: null } : {}) }); } }
  }
  private async perform(key: string, action: () => Promise<void>) {
    if (this.disposed || this.state.pending) return;
    const generation = this.generation;
    this.set({ pending: key, error: null, notice: null });
    try { await action(); }
    catch (error) {
      if (!this.disposed && generation === this.generation) {
        const code = (error as { code?: string })?.code;
        const changed = [401, 403, 410].includes((error as { status?: number })?.status ?? 0) || ['recording_review_changed', 'recording_invalidated', 'recording_source_changed', 'privacy_pending', 'recording_media_changed'].includes(code ?? '');
        this.set({ error: safeMessage(error), ...(changed ? { review: null, checks: emptyChecks(), receiptId: null } : {}) });
      }
    } finally { if (!this.disposed && generation === this.generation) this.set({ pending: null }); }
  }
  private current(generation: number) { return !this.disposed && generation === this.generation; }
  async start(sessionId: string | null) {
    const eligibility = this.state.startEligibility;
    if (sessionId && (!eligibility?.canStartCurrent || eligibility.sessionId !== sessionId)) { this.set({ error: eligibility?.reason === 'context_started' ? 'This stream already has context. Arm the next recording instead.' : 'Refresh recordings before starting this session.' }); return; }
    if (!sessionId && eligibility && !eligibility.canArmNext) return;
    await this.perform('start', async () => {
      const generation = this.generation;
      try { await this.request('/recordings/start', { method: 'POST', body: sessionId ? { sessionId } : {} }); }
      catch (error) { if (sessionId && this.current(generation) && (error as { code?: string })?.code === 'recording_prefix_missing') this.set({ startEligibility: { sessionId, canStartCurrent: false, canArmNext: true, reason: 'context_started' } }); throw error; }
      if (!this.current(generation)) return;
      this.set({ notice: sessionId ? 'Private recording started.' : 'Private recording is armed for the next session.' }); await this.load();
    });
  }
  async stop(id: string) {
    await this.perform('stop:' + id, async () => {
      const generation = this.generation;
      await this.request(pathFor(id) + '/stop', { method: 'POST', body: {} });
      if (!this.current(generation)) return;
      this.set({ notice: 'Recording stopped. Review its contents before creating an export.' }); await this.load();
    });
  }
  async remove(id: string) {
    const item = this.state.items.find(recording => recording.id === id);
    if (!item) return;
    if (item.exportId && (item.publication?.state !== 'revoked' || item.publication.removalAllowed !== true)) {
      this.set({ error: 'Withdraw this recording and wait for its public withdrawal to be acknowledged before removing the private capture.' }); return;
    }
    await this.perform('remove:' + id, async () => {
      const generation = this.generation;
      await this.request(pathFor(id), { method: 'DELETE' });
      if (!this.current(generation)) return;
      if (this.state.review?.recording.id === id) this.closeReview();
      this.set({ notice: 'Private recording removed.' }); await this.load();
    });
  }
  async openReview(id: string) {
    if (this.state.pending) return;
    this.generation++;
    const generation = this.generation;
    this.set({ review: null, checks: emptyChecks(), receiptId: null });
    await this.perform('review:' + id, async () => {
      const review = await this.request<RecordingReview>(pathFor(id) + '/review');
      if (this.current(generation)) this.set({ review, checks: emptyChecks(), receiptId: null });
    });
  }
  closeReview() { this.generation++; this.set({ review: null, checks: emptyChecks(), receiptId: null, pending: null, error: null }); }
  check(kind: keyof RecordingChecks, key: string, checked: boolean) {
    if (!this.state.review || this.state.pending) return;
    const checks = { ...this.state.checks };
    if (kind === 'metadata') checks.metadata = checked;
    else checks[kind] = checked ? [...new Set([...checks[kind], key])] : checks[kind].filter(item => item !== key);
    this.set({ checks, receiptId: null, notice: null });
  }
  async selectMedia(mediaId: string, selected: boolean) {
    const review = this.state.review; if (!review) return;
    await this.perform('media:' + mediaId, async () => {
      const generation = this.generation, checked = this.state.checks;
      this.readGeneration++;
      this.set({ receiptId: null });
      try {
        await this.request(pathFor(review.recording.id) + (selected ? '/media' : '/media/' + encodeURIComponent(mediaId)), selected ? { method: 'POST', body: { mediaId } } : { method: 'DELETE' });
        if (!this.current(generation)) return;
        const next = await this.request<RecordingReview>(pathFor(review.recording.id) + '/review');
        if (this.current(generation)) this.set({ review: next, checks: retainedChecks(review, next, checked), receiptId: null, items: this.state.items.map(item => item.id === next.recording.id ? { ...item, ...next.recording } : item), notice: 'Media selection updated. Checks for unchanged content were kept. Approve this version before exporting.' });
      } catch (error) {
        if (this.current(generation)) this.set({ review: null, checks: emptyChecks(), receiptId: null });
        throw error;
      }
    });
  }
  async approve() {
    const review = this.state.review;
    if (!review) return;
    const body = recordingApproval(review, this.state.checks);
    if (!body) { this.set({ error: 'Review the metadata, every source, every text field, and both checks for each selected media asset.' }); return; }
    await this.perform('approve', async () => {
      const generation = this.generation;
      const result = await this.request<{ receiptId: ReviewReceipt['id'] }>(pathFor(review.recording.id) + '/review', { method: 'POST', body });
      if (this.current(generation)) this.set({ receiptId: result.receiptId, notice: 'Review approved. The recording is still private.' });
    });
  }
  async createExport() {
    const review = this.state.review, receiptId = this.state.receiptId;
    if (!review || !receiptId || !recordingApproval(review, this.state.checks)) return;
    await this.perform('export', async () => {
      const generation = this.generation;
      await this.request(pathFor(review.recording.id) + '/export', { method: 'POST', body: { reviewReceiptId: receiptId } });
      if (!this.current(generation)) return;
      this.set({ notice: 'Private export created. Publish is a separate action.' }); await this.load();
    });
  }
  async publish(id: string) {
    if (!this.state.items.some(item => item.id === id && item.status === 'exported' && item.exportId && !['revoked', 'published', 'queued'].includes(item.publication?.state ?? 'staged'))) return;
    await this.perform('publish:' + id, async () => {
      const generation = this.generation;
      await this.request(pathFor(id) + '/publish', { method: 'POST', body: {} });
      if (this.current(generation)) { this.set({ notice: 'Publication requested.' }); await this.load(); }
    });
  }
  async withdraw(id: string) {
    if (!this.state.items.some(item => item.id === id && item.exportId && (item.publication?.state !== 'revoked' || item.publication.revocationPending))) return;
    await this.perform('withdraw:' + id, async () => {
      const generation = this.generation;
      this.readGeneration++;
      this.set({ review: null, checks: emptyChecks(), receiptId: null });
      const result = await this.request<{ exportId: string; publication: RecordingPublication }>(pathFor(id) + '/revoke', { method: 'POST', body: {} });
      if (!this.current(generation)) return;
      this.set({ items: this.state.items.map(item => item.id === id ? { ...item, publication: result.publication } : item), notice: 'Withdrawal saved.' });
      await this.load();
    });
  }
}

export type RecordingPanelStatus = { activeId: string | null; status: 'armed' | 'recording' | null; pending: boolean; stop: () => void };
export interface RecordingPanelProps { port: RecordingPort; sessionId: string | null; sourceEpoch: number; onStatusChange?: (status: RecordingPanelStatus) => void }
const labels: Record<RecordingSummary['status'], string> = { armed: 'Armed for the next session', recording: 'Recording privately', stopped: 'Stopped', interrupted: 'Interrupted', invalidated: 'Removed after a privacy change', failed: 'Recording stopped with an error', exported: 'Private export ready' };
function publicationLabel(publication: RecordingPublication) {
  return { staged: 'Private export ready', queued: 'Publication pending', published: 'Published online', revoked: publication.revocationPending && publication.removalAllowed !== true ? 'Withdrawn locally, public withdrawal pending' : 'Recording withdrawn', error: 'Publication needs attention' }[publication.state];
}
function dateLabel(value: string) { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
export function RecordingPanel({ port, sessionId, sourceEpoch, onStatusChange }: RecordingPanelProps) {
  const model = useMemo(() => new RecordingPanelModel(port, sourceEpoch, sessionId), [port]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [withdrawId, setWithdrawId] = useState<string | null>(null);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadUnderstood, setDownloadUnderstood] = useState(false);
  const [sourcePage, setSourcePage] = useState(0), [outputPage, setOutputPage] = useState(0);
  const epochMatches = state.sourceEpoch === sourceEpoch;
  const review = epochMatches ? state.review : null;
  useEffect(() => { model.activate(); void model.load(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void model.load(); }, 5000); return () => { clearInterval(timer); model.dispose(); }; }, [model]);
  useEffect(() => { if (model.getSnapshot().sourceEpoch !== sourceEpoch) { model.invalidate(sourceEpoch); setDownloadId(null); setRemoveId(null); setWithdrawId(null); } }, [model, sourceEpoch]);
  useEffect(() => { void model.setSession(sessionId); }, [model, sessionId]);
  useEffect(() => { setSourcePage(0); setOutputPage(0); }, [review?.recording.id]);
  useEffect(() => { setSourcePage(page => Math.min(page, Math.max(0, Math.ceil((review?.sources.length ?? 0) / 6) - 1))); setOutputPage(page => Math.min(page, Math.max(0, Math.ceil((review?.outputs.length ?? 0) / 6) - 1))); }, [review?.sources.length, review?.outputs.length]);
  useEffect(() => {
    const active = epochMatches ? state.items.find(item => item.id === state.activeId && (item.status === 'armed' || item.status === 'recording')) : null;
    onStatusChange?.({ activeId: active?.id ?? null, status: active?.status === 'armed' || active?.status === 'recording' ? active.status : null, pending: !epochMatches || !!state.pending, stop: () => { if (epochMatches && model.getSnapshot().sourceEpoch === sourceEpoch && active) void model.stop(active.id); } });
  }, [model, onStatusChange, sourceEpoch, epochMatches, state.activeId, state.items, state.pending]);
  const selected = review && state.items.find(item => item.id === review.recording.id);
  const exported = selected?.status === 'exported' && !!selected.exportId;
  const approval = review ? recordingApproval(review, state.checks) : null;
  const pending = !!state.pending;
  const eligibility = epochMatches && state.startEligibility?.sessionId === sessionId ? state.startEligibility : null;
  const startSessionId = eligibility?.canStartCurrent ? sessionId : null;
  const canStart = !!eligibility && (startSessionId ? eligibility.canStartCurrent : eligibility.canArmNext);
  const download = downloadId && epochMatches && state.items.some(item => item.id === downloadId && item.status === 'exported' && item.publication?.state !== 'revoked') ? recordingAssetUrl(port, downloadId) : null;
  const removing = state.items.find(item => item.id === removeId);
  const withdrawing = state.items.find(item => item.id === withdrawId && item.exportId && (item.publication?.state !== 'revoked' || item.publication.revocationPending));
  return <section className="recording-panel" aria-labelledby="recording-panel-title">
    <h2 id="recording-panel-title">Stream recordings</h2>
    <p>Record stream context privately. Start before any context is collected.</p>
    {eligibility?.reason === 'context_started' && <p className="recording-panel__secondary">This stream already has context. Arm the next recording to capture it from the beginning.</p>}
    {eligibility?.reason === 'session_unavailable' && <p className="recording-panel__secondary">The current session is unavailable. You can arm the next recording.</p>}
    {eligibility?.reason === 'retention_limit' && <p className="recording-panel__secondary">Remove a private recording before starting another.</p>}
    <ActionGroup><QuietButton pending={state.pending === 'start'} disabled={!canStart || !!state.activeId || pending} onClick={() => void model.start(startSessionId)}>{!eligibility && state.loading ? 'Checking recording…' : startSessionId ? 'Start private recording' : 'Arm next recording'}</QuietButton><QuietButton pending={state.loading} disabled={pending} onClick={() => void model.load()}>Refresh recordings</QuietButton></ActionGroup>
    <details className="recording-panel__secondary"><summary>Recording limits</summary><p>A capture stops at 10,000 events or provider results, 100 media entries, or 32 MB. Unchecked or later-redacted wording blocks export because its recorded results cannot be reused for changed inputs.</p></details>
    {state.loading && !state.items.length && <p role="status">Opening private recordings.</p>}
    {!state.loading && !state.items.length && <p className="recording-panel__secondary">No private recordings yet.</p>}
    <ul className="recording-panel__list">{state.items.map(item => <li key={item.id}>
      <h3>Recording from {dateLabel(item.startedAt)}</h3><p>{item.exportId && item.publication ? publicationLabel(item.publication) : labels[item.status]}</p>
      {item.message && <p>{item.message}</p>}
      <ActionGroup>
        {['armed', 'recording'].includes(item.status) && <QuietButton pending={state.pending === 'stop:' + item.id} disabled={pending} onClick={() => void model.stop(item.id)}>Stop recording</QuietButton>}
        {['stopped', 'exported'].includes(item.status) && item.publication?.state !== 'revoked' && <QuietButton pending={state.pending === 'review:' + item.id} disabled={pending} onClick={() => void model.openReview(item.id)}>Review contents</QuietButton>}
        {item.status === 'exported' && item.publication?.state !== 'revoked' && <>
          {(!item.publication || ['staged', 'error'].includes(item.publication.state)) && <QuietButton pending={state.pending === 'publish:' + item.id} disabled={pending} onClick={() => void model.publish(item.id)}>{item.publication?.state === 'error' ? 'Retry publication' : 'Publish recording'}</QuietButton>}
          <QuietButton disabled={pending} onClick={() => { setDownloadUnderstood(false); setDownloadId(item.id); }}>Download offline ZIP</QuietButton>
          <QuietButton tone="danger" disabled={pending} onClick={() => setWithdrawId(item.id)}>Withdraw recording</QuietButton>
        </>}
        {(!item.exportId || item.publication?.state === 'revoked') && <QuietButton tone="danger" disabled={pending || !!item.exportId && item.publication?.removalAllowed !== true} onClick={() => setRemoveId(item.id)}>Remove recording</QuietButton>}
        {item.publication?.state === 'revoked' && item.publication.revocationPending && item.publication.removalAllowed !== true && <QuietButton disabled={pending} onClick={() => setWithdrawId(item.id)}>Retry withdrawal</QuietButton>}
      </ActionGroup>
      {item.publication?.message && <p className="recording-panel__secondary">{item.publication.message}</p>}
      {item.publication?.state === 'staged' && <p className="recording-panel__secondary">Publish uploads this reviewed recording to your public deployment.</p>}
      {item.publication?.state === 'queued' && <p className="recording-panel__secondary">Keep Previously running while this recording is published.</p>}
      {item.publication?.state === 'revoked' && item.publication.revocationPending && item.publication.removalAllowed !== true && <p className="recording-panel__secondary">The local export is unavailable. Its public copy may remain until withdrawal is acknowledged. Keep Previously running; the private capture can be removed after confirmation.</p>}
      {recordingReplayUrl(item) && state.pending !== 'withdraw:' + item.id && <a className="recording-panel__public-link" href={recordingReplayUrl(item)!} target="_blank" rel="noreferrer">Open published recording</a>}
    </li>)}</ul>
    {state.error && <p className="recording-panel__error" role="alert">{state.error}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
    <Sheet open={!!review} onOpenChange={open => { if (!open) model.closeReview(); }} title="Review recording" className="recording-review" description="Read the material that will be included. Approval keeps it private; export and publication are separate actions." footer={<ActionGroup>{!exported && <><Button pending={state.pending === 'approve'} disabled={pending || !approval || !!state.receiptId} onClick={() => void model.approve()}>{state.receiptId ? 'Review approved' : 'Approve reviewed contents'}</Button><QuietButton pending={state.pending === 'export'} disabled={pending || !state.receiptId} onClick={() => void model.createExport()}>Create private export</QuietButton></>}<QuietButton onClick={() => model.closeReview()}>Close review</QuietButton></ActionGroup>}>
      {review && <>
        <section><h3>Stream metadata</h3><dl className="recording-review__metadata"><div><dt>Channel</dt><dd>{review.metadata.channel || 'Not supplied'}</dd></div><div><dt>Title</dt><dd>{review.metadata.title || 'Not supplied'}</dd></div><div><dt>Category</dt><dd>{review.metadata.category || 'Not supplied'}</dd></div></dl><ReviewCheck checked={state.checks.metadata} disabled={pending || exported} onChange={checked => model.check('metadata', '', checked)}>I reviewed this metadata for sharing</ReviewCheck></section>
        <section><h3>Source excerpts</h3>{review.sources.slice(sourcePage * 6, sourcePage * 6 + 6).map(source => <article key={recordingSourceKey(source)} className="recording-review__text"><p className="recording-review__source-time">{source.kind.replaceAll('_', ' ')} at {formatTimecode(source.startMs)} to {formatTimecode(source.endMs)}</p><p>{source.text ?? 'This source contains no text.'}</p>{!source.safe && <p className="recording-panel__error">This source has not passed unchanged text checks. Export is blocked.</p>}<ReviewCheck checked={state.checks.sources.includes(recordingSourceKey(source))} disabled={pending || exported} onChange={checked => model.check('sources', recordingSourceKey(source), checked)}>I reviewed this source excerpt</ReviewCheck></article>)}{!review.sources.length && <p>No source excerpts were captured.</p>}<ReviewPages total={review.sources.length} page={sourcePage} size={6} label="source excerpts" onChange={setSourcePage} /></section>
        <section><h3>Text included in the export</h3><p>Review each saved field, including source wording that appears again in a result.</p>{review.outputs.slice(outputPage * 6, outputPage * 6 + 6).map(output => <article key={output.hash} className="recording-review__text"><p>{output.text}</p><ReviewCheck checked={state.checks.outputs.includes(output.hash)} disabled={pending || exported} onChange={checked => model.check('outputs', output.hash, checked)}>I reviewed this text</ReviewCheck></article>)}<ReviewPages total={review.outputs.length} page={outputPage} size={6} label="text fields" onChange={setOutputPage} /></section>
        <section><h3>Selected media</h3><p>Choose only media you own or may share. Check every visible frame and all audio. Exclude any asset with on-screen secrets; text review cannot make its images safe.</p>
          {!review.media.length && <p>No media is selected. A text-only export includes no source video or audio.</p>}
          {review.media.map(media => { const url = recordingAssetUrl(port, review.recording.id, media.id); return <article key={recordingMediaKey(media)} className="recording-review__media"><h4>{media.kind === 'video' ? 'Video' : 'Audio'} at {formatTimecode(media.startMs)} to {formatTimecode(media.endMs)}</h4>{url && (media.kind === 'video' ? <video controls playsInline preload="none" src={url} aria-label="Selected recording video" /> : <audio controls preload="none" src={url} aria-label="Selected recording audio" />)}<ReviewCheck checked={state.checks.visual.includes(recordingMediaKey(media))} disabled={pending || exported} onChange={checked => model.check('visual', recordingMediaKey(media), checked)}>{media.kind === 'video' ? 'I checked every visible frame for private information' : 'I confirmed this audio asset has no visual content'}</ReviewCheck><ReviewCheck checked={state.checks.audio.includes(recordingMediaKey(media))} disabled={pending || exported} onChange={checked => model.check('audio', recordingMediaKey(media), checked)}>I listened to the complete audio, including any silence</ReviewCheck>{!exported && <QuietButton disabled={pending} onClick={() => void model.selectMedia(media.id, false)}>Exclude this media</QuietButton>}</article>; })}
          {!exported && review.mediaCandidates.filter(candidate => !review.media.some(media => media.id === candidate.id)).map(candidate => <div className="recording-review__candidate" key={candidate.id}><span>{candidate.kind === 'video' ? 'Video' : 'Audio'} at {formatTimecode(candidate.startMs)} to {formatTimecode(candidate.endMs)}</span><QuietButton disabled={pending} onClick={() => void model.selectMedia(candidate.id, true)}>Select for review</QuietButton></div>)}
        </section>
        {review.blockedReasons.length > 0 && <section><h3>Before this recording can be exported</h3><ul>{review.blockedReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></section>}
        {state.error && <p className="recording-panel__error" role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
      </>}
    </Sheet>
    <Dialog open={!!withdrawing && epochMatches} onOpenChange={open => { if (!open) setWithdrawId(null); }} title="Withdraw recording" className="recording-review" footer={<ActionGroup><Button tone="danger" pending={state.pending === 'withdraw:' + withdrawId} onClick={() => { if (withdrawId) void model.withdraw(withdrawId).then(() => setWithdrawId(null)); }}>{withdrawing?.publication?.state === 'revoked' ? 'Retry withdrawal' : 'Withdraw recording'}</Button><QuietButton onClick={() => setWithdrawId(null)}>Cancel</QuietButton></ActionGroup>}>{withdrawing?.publication?.state === 'revoked' ? <p>Local access is already closed. Retry the public withdrawal and keep Previously running until it is acknowledged.</p> : <p>Withdraw the managed export of the recording from {withdrawing && dateLabel(withdrawing.startedAt)}. Its local replay and downloads become unavailable immediately after the withdrawal is saved. Public withdrawal remains pending until the cloud acknowledges it.</p>}<p>Your stream’s published chapters stay in place. Copies that were already downloaded or shared cannot be recalled.</p>{state.error && <p className="recording-panel__error" role="alert">{state.error}</p>}</Dialog>
    <Dialog open={!!removing && epochMatches} onOpenChange={open => { if (!open) setRemoveId(null); }} title="Remove private recording" className="recording-review" footer={<ActionGroup><Button tone="danger" pending={state.pending === 'remove:' + removeId} onClick={() => { if (removeId) void model.remove(removeId).then(() => setRemoveId(null)); }}>Remove recording</Button><QuietButton onClick={() => setRemoveId(null)}>Keep recording</QuietButton></ActionGroup>}><p>Remove the private capture from {removing && dateLabel(removing.startedAt)}. This cannot be undone. Your stream’s published chapters are unchanged.</p></Dialog>
    <Dialog open={!!download} onOpenChange={open => { if (!open) setDownloadId(null); }} title="Download offline recording" className="recording-review"><p>This ZIP contains the reviewed replay data and selected media. Keep it private.</p><p>A downloaded copy cannot be remotely revoked. If you later forget its sources, remove this copy and any files you shared yourself.</p><ReviewCheck checked={downloadUnderstood} onChange={setDownloadUnderstood}>I understand that this copy cannot be recalled</ReviewCheck>{download && downloadUnderstood && <a className="pv-button pv-button--primary" href={download} download>Download offline ZIP</a>}</Dialog>
  </section>;
}
function ReviewCheck({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode; disabled?: boolean }) {
  const id = useId();
  return <label htmlFor={id} className="recording-review__check"><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{children}</span></label>;
}
function ReviewPages({ total, page, size, label, onChange }: { total: number; page: number; size: number; label: string; onChange: (page: number) => void }) {
  if (total <= size) return null;
  return <div className="recording-review__pages"><span>{page * size + 1} to {Math.min(total, (page + 1) * size)} of {total} {label}</span><ActionGroup><QuietButton disabled={page === 0} onClick={() => onChange(page - 1)}>Previous</QuietButton><QuietButton disabled={(page + 1) * size >= total} onClick={() => onChange(page + 1)}>Next</QuietButton></ActionGroup></div>;
}
