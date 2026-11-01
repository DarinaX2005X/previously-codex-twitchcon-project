import { describe, expect, it, vi } from 'vitest';
import type { Chapter, OwnerHistoryPage } from '../../src/shared/contracts';
import { DockHistoryStore, mergeHistory, type HistoryContext } from '../../src/features/dock/history';

const context: HistoryContext = { sessionId: 'stream', privacyEpoch: 3, language: 'en', filter: 'published', resetKey: '0:en' };
function chapter(id: string, revision = 1): Chapter {
  return { id, revision, title: id, summary: 'Recorded summary', startMs: 1000, endMs: 2000, mood: 'neutral', claimIds: [], momentIds: [], pinned: false, edited: false, sourceLabels: [], maxDependencyEndMs: 2000, sessionId: 'stream', ownerEditRevision: 0, publicationState: 'published', eligibleAt: '2026-11-02T00:00:00Z', safety: { moderation: 'allowed', pii: 'allowed', checkedAt: '2026-11-02T00:00:00Z', reason: null }, dependencyRefs: [] };
}
function page(items: Chapter[], nextCursor: string | null = null): OwnerHistoryPage { return { items, nextCursor, privacyEpoch: 3, language: 'en' }; }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }

describe('bounded owner history', () => {
  it('requests no data on mount or reset, then follows one bounded page per action', async () => {
    const list = vi.fn().mockResolvedValueOnce(page([chapter('first')], 'opaque-cursor')).mockResolvedValueOnce(page([chapter('second')]));
    const history = new DockHistoryStore(list); history.reset(context);
    expect(list).not.toHaveBeenCalled();
    await history.load('chapter', context);
    expect(list).toHaveBeenNthCalledWith(1, { sessionId: 'stream', kind: 'chapter', filter: 'published', limit: 40 });
    expect(list).toHaveBeenCalledTimes(1);
    await history.load('chapter', context);
    expect(list).toHaveBeenNthCalledWith(2, { sessionId: 'stream', kind: 'chapter', filter: 'published', limit: 20, cursor: 'opaque-cursor' });
    expect(history.getSnapshot().chapters.map(item => item.id)).toEqual(['first', 'second']);
    expect(history.getSnapshot().chapterCursor).toBeNull();
    await history.load('chapter', context); expect(list).toHaveBeenCalledTimes(2);
  });
  it('deduplicates loaded records against the current projection by authoritative revision', () => {
    const old = chapter('same', 1), current = { ...chapter('same', 2), title: 'Owner correction' };
    expect(mergeHistory([old], [current])).toEqual([current]);
    expect(mergeHistory([current], [old])).toEqual([current]);
  });
  it.each([
    { ...context, privacyEpoch: 4 }, { ...context, resetKey: '1:en' },
    { ...context, sessionId: 'another-stream' }, { ...context, language: 'ru' as const },
    { ...context, filter: 'held' as const },
  ])('clears cache and rejects a late old-context page after a context reset', async next => {
    const response = deferred<OwnerHistoryPage>();
    const history = new DockHistoryStore(vi.fn(() => response.promise));
    const loading = history.load('chapter', context);
    history.reset(next);
    expect(history.getSnapshot().chapters).toEqual([]);
    response.resolve(page([chapter('forgotten')])); await loading;
    expect(history.getSnapshot().chapters).toEqual([]);
    expect(history.getSnapshot().chapterLoaded).toBe(false);
  });
  it('does not accept a page with mismatched privacy epoch or language', async () => {
    const list = vi.fn().mockResolvedValueOnce({ ...page([chapter('private')]), privacyEpoch: 4 }).mockResolvedValueOnce({ ...page([chapter('other-language')]), language: 'ru' });
    const history = new DockHistoryStore(list);
    await history.load('chapter', context);
    expect(history.getSnapshot().chapters).toEqual([]);
    expect(history.getSnapshot().error).toContain('History changed');
    await history.load('chapter', context);
    expect(history.getSnapshot().chapters).toEqual([]);
  });
  it('clears previously loaded pages when the server reports pending privacy recovery', async () => {
    const recover = vi.fn();
    const list = vi.fn().mockResolvedValueOnce(page([chapter('withdrawn')], 'cursor')).mockRejectedValueOnce({ code: 'privacy_recovery_pending' });
    const history = new DockHistoryStore(list, recover);
    await history.load('chapter', context); await history.load('chapter', context);
    expect(history.getSnapshot().chapters).toEqual([]);
    expect(recover).toHaveBeenCalledOnce();
    expect(history.getSnapshot().error).toContain('source removal');
  });
  it('keeps old history editable and removes a corrected record from its prior collection', async () => {
    const history = new DockHistoryStore(vi.fn().mockResolvedValue(page([chapter('old')])));
    await history.load('chapter', context);
    history.apply({ ...chapter('old', 2), pinned: true }, context);
    expect(history.getSnapshot().chapters[0].pinned).toBe(true);
    history.apply({ ...chapter('old', 3), publicationState: 'held', edited: true, title: 'Owner wording' }, context);
    expect(history.getSnapshot().chapters).toEqual([]);
  });
  it('does not create a live request capability for replay clients', async () => {
    const history = new DockHistoryStore();
    await history.load('chapter', context);
    expect(history.getSnapshot().chapterLoaded).toBe(false);
  });
});
