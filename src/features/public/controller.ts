import { PublicPoller } from '../../cloud/public-poller';
import { PublicSnapshotSchema, type PublicSnapshot } from '../../shared/contracts';
import { ReadingHistory } from './reading-history';

export interface PublicRecapClient {
  getPublicSnapshot(login: string, options?: { episodeId?: string; untilMs?: number; signal?: AbortSignal }): Promise<PublicSnapshot>;
}
export type PublicViewState = { status: 'loading' | 'ready' | 'unavailable'; snapshot: PublicSnapshot | null; untilMs: number | undefined };
type PublicDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
/** The only ready state is an authoritative public response. Cutoff changes clear old content before requesting a new server-filtered snapshot. */
export class PublicRecapController {
  private state: PublicViewState = { status: 'loading', snapshot: null, untilMs: undefined };
  private poller?: PublicPoller<PublicSnapshot>;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private session?: string;
  private stopped = true;
  constructor(private readonly options: { client: PublicRecapClient; login: string; episodeId?: string; history: ReadingHistory; onState: (state: PublicViewState) => void; document?: PublicDocument; now?: () => number }) {}
  private emit(state: PublicViewState) { this.state = state; this.options.onState(state); }
  private unavailable = () => { clearTimeout(this.leaseTimer); this.emit({ ...this.state, status: 'unavailable', snapshot: null }); };
  start() { if (!this.stopped) return; this.stopped = false; this.open(); }
  stop() { this.stopped = true; this.generation++; this.poller?.stop(); clearTimeout(this.leaseTimer); }
  revalidate() { if (!this.stopped) this.open(); }
  setUntil(time: number | undefined) {
    if (time !== undefined && (!Number.isSafeInteger(time) || time < 0 || time > 172_800_000)) return;
    if (this.session) this.options.history.set(this.options.login, this.session, time);
    this.emit({ status: 'loading', snapshot: null, untilMs: time });
    this.open();
  }
  clearHistory() { this.options.history.clear(); this.setUntil(undefined); }
  private open() {
    const generation = ++this.generation;
    // A replacement poller owns new deadlines. Withdraw live content before cancelling the old deadlines.
    if (this.state.snapshot && this.state.snapshot.session.status !== 'finalized') this.emit({ ...this.state, status: 'loading', snapshot: null });
    this.poller?.stop(); clearTimeout(this.leaseTimer);
    const current = () => !this.stopped && generation === this.generation;
    const fetcher: typeof fetch = async (_url, init) => {
      try {
        let untilMs = this.state.untilMs;
        // Resolve the current session before restoring its limit, without putting the unfiltered response in the DOM.
        let snapshot = PublicSnapshotSchema.parse(await this.options.client.getPublicSnapshot(this.options.login, { episodeId: this.options.episodeId, untilMs, signal: init?.signal ?? undefined }));
        if (!current()) throw new DOMException('Obsolete request', 'AbortError');
        if (snapshot.channel.login !== this.options.login || (this.options.episodeId && snapshot.session.id !== this.options.episodeId)) throw new Error('Public session mismatch');
        if (snapshot.session.id !== this.session) {
          this.session = snapshot.session.id;
          const restored = this.options.history.get(this.options.login, this.session);
          if (restored !== untilMs) {
            untilMs = restored;
            snapshot = PublicSnapshotSchema.parse(await this.options.client.getPublicSnapshot(this.options.login, { episodeId: this.options.episodeId, untilMs, signal: init?.signal ?? undefined }));
          }
          if (current()) this.state = { ...this.state, untilMs };
        }
        if (snapshot.channel.login !== this.options.login || snapshot.session.id !== this.session) throw new Error('Public session changed during revalidation');
        if (untilMs !== undefined && (
          (snapshot.current && snapshot.current.maxDependencyEndMs > untilMs) ||
          snapshot.chapters.some(item => item.maxDependencyEndMs > untilMs) ||
          snapshot.lore.some(item => item.maxDependencyEndMs > untilMs) ||
          snapshot.moments.some(item => item.maxDependencyEndMs > untilMs) ||
          ((snapshot.session.title || snapshot.session.category) && snapshot.session.metadataMaxDependencyEndMs > untilMs)
        )) throw new Error('Public response exceeds its requested reading limit');
        return new Response(JSON.stringify(snapshot), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        if (current() && !init?.signal?.aborted) {
          const status = (error as { status?: number })?.status;
          if (!this.state.snapshot || status === 404 || status === 409 || status === 410 || status === 503) this.unavailable();
        }
        throw error;
      }
    };
    this.poller = new PublicPoller({ url: '/public-reader', fetch: fetcher, document: this.options.document, isFinalized: snapshot => snapshot.session.status === 'finalized', onUnavailable: () => { if (current()) this.unavailable(); }, onValue: snapshot => {
      if (!current()) return;
      clearTimeout(this.leaseTimer);
      if (snapshot.session.status !== 'finalized') {
        const remaining = snapshot.liveLeaseUntil ? Date.parse(snapshot.liveLeaseUntil) - (this.options.now?.() ?? Date.now()) : 0;
        if (!Number.isFinite(remaining) || remaining <= 0) { this.unavailable(); return; }
        this.leaseTimer = setTimeout(() => { if (current()) this.unavailable(); }, remaining);
      }
      this.emit({ ...this.state, status: 'ready', snapshot });
    } });
    this.poller.start();
  }
}

export function sourceAge(snapshot: PublicSnapshot, now: number): string {
  const offset = snapshot.current?.sourceTimeMs ?? Math.max(0, ...snapshot.chapters.map(chapter => chapter.endMs));
  const age = Math.max(0, now - (Date.parse(snapshot.session.startedAt) + offset));
  if (age < 60_000) return 'less than a minute ago';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} min ago`;
  return `${Math.floor(age / 3_600_000)} h ago`;
}
export function twitchClipEmbed(id: string, hostname: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !/^[a-zA-Z0-9.-]+$/.test(hostname)) return null;
  const url = new URL('https://clips.twitch.tv/embed');
  url.searchParams.set('clip', id); url.searchParams.set('parent', hostname); url.searchParams.set('autoplay', 'false');
  return url.toString();
}
