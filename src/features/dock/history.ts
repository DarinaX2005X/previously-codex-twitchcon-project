import type { Chapter, Lore, OwnerHistoryPage, OwnerHistoryQuery, RecapLanguage } from '../../shared/contracts';
import { errorCode } from './model';

export type HistoryContext = { sessionId: string; privacyEpoch: number; language: RecapLanguage; filter: 'published' | 'draft' | 'held'; resetKey: string };
export function historyKey(context: HistoryContext): string { return JSON.stringify(context); }
export type HistoryState = { key: string; chapters: Chapter[]; lore: Lore[]; chapterLoaded: boolean; loreLoaded: boolean; chapterCursor: string | null; loreCursor: string | null; loading: 'chapter' | 'lore' | null; error: string | null };
const empty = (key = ''): HistoryState => ({ key, chapters: [], lore: [], chapterLoaded: false, loreLoaded: false, chapterCursor: null, loreCursor: null, loading: null, error: null });
export function mergeHistory<T extends { id: string; revision: number }>(older: T[], current: T[]): T[] {
  const values = new Map(older.map(item => [item.id, item]));
  for (const item of current) { const previous = values.get(item.id); if (!previous || previous.revision <= item.revision) values.set(item.id, item); }
  return [...values.values()];
}
/** Pages are requested only by an explicit browse action. Context changes fence late responses. */
export class DockHistoryStore {
  private state = empty();
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(private readonly list?: (query: OwnerHistoryQuery) => Promise<OwnerHistoryPage>, private readonly onContextMismatch?: () => void) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<HistoryState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  reset(context?: HistoryContext) { ++this.generation; this.state = empty(context ? historyKey(context) : ''); this.listeners.forEach(listener => listener()); }
  async load(kind: 'chapter' | 'lore', context: HistoryContext): Promise<void> {
    if (!this.list) return;
    if (this.state.key !== historyKey(context)) this.reset(context);
    if (this.state.loading) return;
    const loaded = kind === 'chapter' ? this.state.chapterLoaded : this.state.loreLoaded;
    const cursor = kind === 'chapter' ? this.state.chapterCursor : this.state.loreCursor;
    if (loaded && !cursor) return;
    const generation = this.generation;
    this.update({ loading: kind, error: null });
    try {
      const page = await this.list({ sessionId: context.sessionId, kind, filter: context.filter, limit: loaded ? 20 : 40, ...(cursor ? { cursor } : {}) });
      if (generation !== this.generation) return;
      if (page.privacyEpoch !== context.privacyEpoch || page.language !== context.language) {
        this.reset(context); this.update({ error: 'History changed. Refresh the dock before browsing again.' }); this.onContextMismatch?.(); return;
      }
      if (kind === 'chapter') this.update({ chapters: mergeHistory(this.state.chapters, page.items.filter((item): item is Chapter => 'publicationState' in item)), chapterLoaded: true, chapterCursor: page.nextCursor, loading: null });
      else this.update({ lore: mergeHistory(this.state.lore, page.items.filter((item): item is Lore => 'status' in item)), loreLoaded: true, loreCursor: page.nextCursor, loading: null });
    } catch (cause) {
      if (generation !== this.generation) return;
      if (['history_changed', 'privacy_recovery_pending', 'invalid_cursor'].includes(errorCode(cause))) {
        this.reset(context); this.onContextMismatch?.();
        this.update({ error: errorCode(cause) === 'privacy_recovery_pending' ? 'History is paused while a source removal is applied.' : 'History changed. Refresh the dock before browsing again.' });
      } else this.update({ loading: null, error: 'Could not load history. Try browsing again.' });
    }
  }
  apply(item: Chapter | Lore, context: HistoryContext) {
    if (this.state.key !== historyKey(context)) return;
    if ('publicationState' in item) {
      const keep = item.publicationState === context.filter;
      this.update({ chapters: keep ? mergeHistory(this.state.chapters, [item]) : this.state.chapters.filter(value => value.id !== item.id) });
    } else {
      const keep = context.filter === 'held' ? ['held', 'observed'].includes(item.status) : item.status === context.filter;
      this.update({ lore: keep ? mergeHistory(this.state.lore, [item]) : this.state.lore.filter(value => value.id !== item.id) });
    }
  }
}
