import { safetyAllowsPublication, type Chapter, type InvalidationReceipt, type OwnerSnapshot, type RecapClient, type UpdateEvent } from '../../shared/contracts';
import type { DockCapturePort } from './ports';

export function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: string; status?: number; error?: { code?: string } };
  return value.code ?? value.error?.code ?? (value.status === 409 ? 'revision_conflict' : '');
}
export function publicationLabel(chapter: Chapter, serverNowMs: number): string {
  if (!safetyAllowsPublication(chapter.safety)) {
    if (chapter.safety.reason === 'fixture_missing') return 'This recording has no safety check for this edit';
    if (chapter.safety.pii === 'review') return 'Needs review: may include personal information';
    if (chapter.safety.moderation === 'blocked') return 'Needs review: publication blocked by the safety check';
    if (chapter.safety.moderation === 'unavailable') return 'Waiting for the safety check to become available';
    return chapter.safety.reason === 'owner_review_pending' ? 'Your wording is saved. Waiting for its safety check' : 'Waiting for a safety check';
  }
  const seconds = Math.ceil((Date.parse(chapter.eligibleAt) - serverNowMs) / 1000);
  return seconds > 0 ? `Publishes in ${seconds} s` : 'Ready for the next publication';
}
export function forgetWindow(snapshot: OwnerSnapshot, elapsedMs = 0) {
  if (!snapshot.session) return null;
  const toMs = Math.min(172_800_000, Math.max(0, Date.parse(snapshot.serverNow) + elapsedMs - Date.parse(snapshot.session.startedAt)));
  return { kind: 'interval' as const, sessionId: snapshot.session.id, fromMs: Math.max(0, toMs - 120_000), toMs };
}
export type DockClockMode = 'server' | 'snapshot';
/** A replay owns its virtual clock; browser wall time must never advance it. */
export function dockClock(serverNow: string, observedAtMs: number, wallNowMs: number, mode: DockClockMode = 'server') {
  const elapsed = mode === 'snapshot' ? 0 : Math.max(0, wallNowMs - observedAtMs);
  return { elapsed, now: Date.parse(serverNow) + elapsed };
}
export function privacyAcknowledged(receipt: InvalidationReceipt, snapshot: OwnerSnapshot | null): boolean {
  return receipt.publicSync === 'synced' || Boolean(snapshot?.session && snapshot.session.privacyEpoch >= receipt.privacyEpoch && !snapshot.sync.pendingPrivacy && snapshot.sync.state === 'synced');
}
export type ChapterEditDraft = { id: string; title: string; summary: string; baseRevision: number };
export async function saveChapterDraft(client: RecapClient, value: ChapterEditDraft) {
  const draft = { ...value };
  try {
    const chapter = await client.editChapter(draft.id, { title: draft.title, summary: draft.summary, baseRevision: draft.baseRevision });
    return { ok: true as const, chapter };
  } catch (cause) {
    const conflict = errorCode(cause) === 'revision_conflict';
    return { ok: false as const, draft, conflict, error: conflict ? 'This chapter changed. Your edit is still here. Compare the latest wording before saving.' : 'Could not save. Your edit is still here. Try Save chapter again.' };
  }
}
export function hotkeyMatches(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey'>, binding: string): boolean {
  const parts = binding.toLowerCase().split('+').map(part => part.trim());
  const key = parts.pop();
  return Boolean(key) && event.key.toLowerCase() === key && event.altKey === parts.includes('alt') && event.ctrlKey === parts.includes('ctrl') && event.shiftKey === parts.includes('shift') && event.metaKey === parts.includes('meta');
}

/** Stops local hardware before awaiting either of the independent server operations. */
export async function pauseListening(client: RecapClient, snapshot: OwnerSnapshot, capture?: DockCapturePort): Promise<void> {
  const stopped = capture?.pause();
  const saved = client.setSettings({ listeningPaused: true, baseRevision: snapshot.settings.revision });
  const results = await Promise.allSettled([stopped, saved]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  if(capture?.getSnapshot().status==='pause_failed')throw new Error('Microphone stopped, but the server pause was not confirmed. Retry pause.');
}

export type DockState = { snapshot: OwnerSnapshot | null; error: string | null; loading: boolean; sourceEpoch: number; invalidatedIds: string[] | null };

/** Request generations fence delayed refreshes, including requests predating a privacy event. */
export class DockStore {
  private state: DockState = { snapshot: null, error: null, loading: true, sourceEpoch: 0, invalidatedIds: [] };
  private listeners = new Set<() => void>();
  private generation = 0;
  private stop?: () => void;
  private active = false;
  constructor(readonly client: RecapClient) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<DockState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  connect() {
    this.active = true;
    this.stop = this.client.subscribe(this.onEvent);
    void this.refresh();
    return () => { this.active = false; ++this.generation; this.stop?.(); };
  }
  invalidate(affectedIds?: string[]) {
    ++this.generation;
    const snapshot = this.state.snapshot;
    this.update({ sourceEpoch: this.state.sourceEpoch + 1, invalidatedIds: affectedIds ?? null,
      snapshot: snapshot ? { ...snapshot, published: null, drafts: [], held: [], lore: [], moments: [], playback: [] } : null });
  }
  private onEvent = (event: UpdateEvent) => {
    if (event.event === 'privacy.invalidated' || event.event === 'snapshot.reset') {
      // Never keep forgotten source text visible while waiting for the authoritative refresh.
      this.invalidate(event.data.affectedIds);
    }
    void this.refresh();
  };
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const snapshot = await this.client.getSnapshot();
      if (this.active && generation === this.generation) this.update({ snapshot, loading: false, error: null });
    } catch (error) {
      if (this.active && generation === this.generation) this.update({ loading: false, error: ['session_required', 'role_forbidden'].includes(errorCode(error)) ? 'Connect the configured Twitch account to open this dock.' : 'Could not refresh the dock. Your current edit is still here.' });
    }
  }
}
