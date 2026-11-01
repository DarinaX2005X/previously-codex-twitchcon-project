import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterSnapshotAt, type PublicSnapshot } from '../../src/shared/contracts/index.js';
import { PublicRecapController, sourceAge, twitchClipEmbed, type PublicRecapClient, type PublicViewState } from '../../src/features/public/controller.js';
import { ReadingHistory, parseReadingTime } from '../../src/features/public/reading-history.js';
import { NOW, snapshot } from '../publication/helpers.js';

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const readers: PublicRecapController[] = [];
afterEach(() => { readers.splice(0).forEach(reader => reader.stop()); vi.useRealTimers(); });
function reader(client: PublicRecapClient, options: { history?: ReadingHistory; episodeId?: string; document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> } = {}) {
  const states: PublicViewState[] = [];
  const controller = new PublicRecapController({ client, login: 'authored_channel', history: options.history ?? new ReadingHistory(), onState: value => states.push(value), now: () => Date.now(), ...options });
  readers.push(controller); controller.start();
  return { controller, states, latest: () => states.at(-1)! };
}
const tick = () => vi.advanceTimersByTimeAsync(0);
function timing() { vi.useFakeTimers(); vi.setSystemTime(NOW); }

describe('public reading boundaries', () => {
  it('restores only this session’s server-filtered reading limit without displaying the unfiltered bootstrap', async () => {
    timing();
    const history = new ReadingHistory(storage()); history.set('authored_channel', 'episode1', 50);
    const full = snapshot(); full.chapters[0].title = 'The experiment eventually succeeded'; full.chapters[0].maxDependencyEndMs = 100;
    const getPublicSnapshot = vi.fn(async (_login: string, options?: { untilMs?: number }) => options?.untilMs === undefined ? full : filterSnapshotAt(full, options.untilMs));
    const view = reader({ getPublicSnapshot }, { history }); await tick();
    expect(getPublicSnapshot.mock.calls.map(call => call[1]?.untilMs)).toEqual([undefined, 50]);
    expect(view.latest().untilMs).toBe(50);
    expect(view.states.some(state => state.snapshot?.chapters.some(chapter => chapter.title.includes('succeeded')))).toBe(false);
    expect(view.latest().snapshot?.current).toBeNull();
    expect(view.latest().snapshot?.moments).toEqual([]);
  });
  it('clears the old story immediately when a reader chooses an earlier time and requests the server cutoff', async () => {
    timing();
    const full = snapshot();
    const getPublicSnapshot = vi.fn(async (_login: string, options?: { untilMs?: number }) => options?.untilMs === undefined ? full : filterSnapshotAt(full, options.untilMs));
    const view = reader({ getPublicSnapshot }); await tick();
    expect(view.latest().snapshot?.chapters).toHaveLength(1);
    view.controller.setUntil(50);
    expect(view.latest().snapshot).toBeNull(); expect(view.latest().status).toBe('loading');
    await tick();
    expect(getPublicSnapshot.mock.calls.at(-1)?.[1]?.untilMs).toBe(50);
    expect(view.latest().snapshot?.chapters).toEqual([]);
  });
  it('rejects an incorrectly unfiltered server response instead of exposing late titles or media', async () => {
    timing();
    const history = new ReadingHistory(storage()); history.set('authored_channel', 'episode1', 50);
    const view = reader({ getPublicSnapshot: async () => snapshot() }, { history }); await tick();
    expect(view.latest().status).toBe('unavailable'); expect(view.latest().snapshot).toBeNull();
  });
  it('does not inherit another episode’s limit and does not replace a requested episode with a current stream', async () => {
    timing();
    const history = new ReadingHistory(storage()); history.set('authored_channel', 'episode1', 50);
    const getPublicSnapshot = vi.fn(async () => snapshot('episode2', 1, 'finalized'));
    const view = reader({ getPublicSnapshot }, { history, episodeId: 'episode2' }); await tick();
    expect(view.latest().untilMs).toBeUndefined(); expect(view.latest().snapshot?.session.id).toBe('episode2');
    const wrong = reader({ getPublicSnapshot: async () => snapshot('new_live') }, { episodeId: 'episode1' }); await tick();
    expect(wrong.latest().status).toBe('unavailable'); expect(wrong.latest().snapshot).toBeNull();
  });
  it('clears reading history without retaining story content in storage', async () => {
    timing();
    const saved = storage(), history = new ReadingHistory(saved);
    history.set('authored_channel', 'episode1', 50);
    const full = snapshot();
    const view = reader({ getPublicSnapshot: async (_login, options) => options?.untilMs === undefined ? full : filterSnapshotAt(full, options.untilMs) }, { history }); await tick();
    expect([...saved.data.values()].join('')).toBe('[{"channel":"authored_channel","session":"episode1","time":50}]');
    view.controller.clearHistory(); await tick();
    expect(history.get('authored_channel', 'episode1')).toBeUndefined();
    expect(view.latest().snapshot?.chapters).toHaveLength(1);
  });
});

describe('story and player lease state', () => {
  it('withdraws live story before focus revalidation replaces its lease timers', async () => {
    timing(); const value = snapshot(); value.liveLeaseUntil = new Date(NOW + 1000).toISOString(); let calls = 0;
    const view = reader({ getPublicSnapshot: async () => { if (++calls === 1) return value; throw new Error('Network offline'); } }); await tick();
    expect(view.latest().snapshot).not.toBeNull();
    view.controller.revalidate();
    expect(view.latest().snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(6200);
    expect(view.latest()).toMatchObject({ status: 'unavailable', snapshot: null });
  });
  it('removes the entire live snapshot when the server lease expires before the next poll', async () => {
    timing(); const value = snapshot(); value.liveLeaseUntil = new Date(NOW + 1500).toISOString();
    const view = reader({ getPublicSnapshot: async () => value }); await tick();
    expect(view.latest().status).toBe('ready');
    await vi.advanceTimersByTimeAsync(1500);
    expect(view.latest()).toMatchObject({ status: 'unavailable', snapshot: null });
  });
  it('expires the client visibility lease after failed revalidation and never refreshes source age on error', async () => {
    timing(); const value = snapshot(); let calls = 0;
    const view = reader({ getPublicSnapshot: async () => { if (++calls === 1) return value; throw new Error('Network offline'); } }); await tick();
    const age = sourceAge(value, NOW);
    await vi.advanceTimersByTimeAsync(5999); expect(view.latest().snapshot).toEqual(value);
    expect(sourceAge(view.latest().snapshot!, NOW)).toBe(age);
    await vi.advanceTimersByTimeAsync(1); expect(view.latest().snapshot).toBeNull();
  });
  it('clears story eligibility as soon as the tab hides, then revalidates when visible', async () => {
    timing(); let changed = () => {};
    const document = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { changed = listener as () => void; }, removeEventListener: () => {} };
    const getPublicSnapshot = vi.fn(async () => snapshot());
    const view = reader({ getPublicSnapshot }, { document }); await tick();
    document.visibilityState = 'hidden'; changed();
    expect(view.latest().snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000); expect(getPublicSnapshot).toHaveBeenCalledTimes(1);
    document.visibilityState = 'visible'; changed(); await tick();
    expect(getPublicSnapshot).toHaveBeenCalledTimes(2); expect(view.latest().status).toBe('ready');
  });
  it('keeps a finalized episode readable after the collector is gone but clears an explicit revocation', async () => {
    timing(); const value = snapshot('episode1', 1, 'finalized'); let failure: Error | undefined;
    const view = reader({ getPublicSnapshot: async () => { if (failure) throw failure; return value; } }, { episodeId: 'episode1' }); await tick();
    failure = new Error('Local collector is offline');
    await vi.advanceTimersByTimeAsync(10_000); expect(view.latest().snapshot?.session.status).toBe('finalized');
    failure = Object.assign(new Error('Revoked'), { status: 410 });
    view.controller.revalidate(); await tick(); expect(view.latest().snapshot).toBeNull();
  });
  it('ignores an old in-flight response after the reading limit changes', async () => {
    timing(); const full = snapshot(); let resolveOld: (value: PublicSnapshot) => void = () => {};
    let calls = 0;
    const view = reader({ getPublicSnapshot: async (_login, options) => {
      if (++calls === 2) return new Promise<PublicSnapshot>(resolve => { resolveOld = resolve; });
      return options?.untilMs === undefined ? full : filterSnapshotAt(full, options.untilMs);
    } }); await tick(); await vi.advanceTimersByTimeAsync(2000);
    view.controller.setUntil(50); await tick();
    resolveOld(full); await tick();
    expect(view.latest().untilMs).toBe(50); expect(view.latest().snapshot?.chapters).toEqual([]);
  });
});

describe('reading input and official media', () => {
  it('parses explicit stream time and rejects ambiguous or invalid input', () => {
    expect(parseReadingTime('24:18')).toBe(1_458_000); expect(parseReadingTime('1:24:18')).toBe(5_058_000);
    expect(parseReadingTime('0:00')).toBe(0); expect(parseReadingTime('24')).toBeNull();
    expect(parseReadingTime('1:99')).toBeNull(); expect(parseReadingTime('-1:20')).toBeNull(); expect(parseReadingTime('99:00:00')).toBeNull();
  });
  it('constructs an official Twitch embed only from a real clip identifier and the current parent hostname', () => {
    const url = new URL(twitchClipEmbed('ActualClipSlug', 'localhost')!);
    expect(url.origin).toBe('https://clips.twitch.tv'); expect(url.pathname).toBe('/embed');
    expect(url.searchParams.get('clip')).toBe('ActualClipSlug'); expect(url.searchParams.get('parent')).toBe('localhost');
    expect(url.searchParams.get('autoplay')).toBe('false');
    expect(twitchClipEmbed('https://example.com/movie', 'localhost')).toBeNull();
    expect(twitchClipEmbed('', 'localhost')).toBeNull();
  });
});
