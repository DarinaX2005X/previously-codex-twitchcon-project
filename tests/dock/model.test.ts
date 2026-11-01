import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Chapter, type OwnerSnapshot, type RecapClient, type UpdateEvent } from '../../src/shared/contracts';
import { dockClock, DockStore, forgetWindow, hotkeyMatches, pauseListening, privacyAcknowledged, publicationLabel, saveChapterDraft } from '../../src/features/dock/model';
import { copyValue } from '../../src/features/setup/SetupPage';
import type { DockCapturePort } from '../../src/features/dock/ports';

function snapshot(revision = 1): OwnerSnapshot {
  const status = { state: 'ready' as const, message: null, action: null, lastObservedAt: '2026-11-02T00:03:00.000Z' };
  return {
    channel: { id: 'channel', login: 'channel', displayName: 'Channel' },
    session: { id: 'session', channelId: 'channel', runId: 'test', twitchStreamId: null, title: 'An actual session', category: 'Software', startedAt: '2026-11-02T00:00:00.000Z', endedAt: null, status: 'live', privacyEpoch: 1, publicationRevision: revision, metadataMaxDependencyEndMs: 0, finalizedAt: null, finalSnapshotAckAt: null },
    settings: structuredClone(defaultSettings), status: { mic: status, chat: status, transcription: status, story: status, moderation: status, cloud: status, overlay: status },
    published: null, drafts: [], held: [], lore: [], moments: [], playback: [], sync: { state: 'synced', revision: 500, acknowledgedRevision: 500, pendingPrivacy: false, lastSyncedAt: null }, revision, serverNow: '2026-11-02T00:03:00.000Z', budget: { limitUsd: 0, committedUsd: 0, reservedUsd: 0, paidCallsEnabled: false },
  };
}
function chapter(): Chapter {
  return { id: 'chapter', revision: 2, title: 'Owner wording', summary: 'The owner describes the result.', startMs: 30000, endMs: 60000, mood: 'neutral', claimIds: [], momentIds: [], pinned: false, edited: true, sourceLabels: [], maxDependencyEndMs: 60000, sessionId: 'session', ownerEditRevision: 1, publicationState: 'draft', eligibleAt: '2026-11-02T00:03:52.000Z', safety: { moderation: 'allowed', pii: 'allowed', checkedAt: '2026-11-02T00:03:00.000Z', reason: null }, dependencyRefs: [] };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function port(requests: Promise<OwnerSnapshot>[]) {
  let listener: ((event: UpdateEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const client = { getSnapshot: vi.fn(() => requests.shift()!), subscribe: vi.fn((handler: (event: UpdateEvent) => void) => { listener = handler; return unsubscribe; }) } as unknown as RecapClient;
  return { client, unsubscribe, emit: (event: UpdateEvent) => listener!(event) };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('dock async ownership and privacy', () => {
  it('does not accept an old refresh after a newer update has resolved', async () => {
    const old = deferred<OwnerSnapshot>(), recent = deferred<OwnerSnapshot>();
    const connection = port([old.promise, recent.promise]);
    const store = new DockStore(connection.client), disconnect = store.connect();
    connection.emit({ id: 2, event: 'snapshot.changed', data: { sessionId: 'session', revision: 2 } });
    recent.resolve(snapshot(2)); await tick(); old.resolve(snapshot(1)); await tick();
    expect(store.getSnapshot().snapshot?.revision).toBe(2);
    disconnect(); expect(connection.unsubscribe).toHaveBeenCalledOnce();
  });
  it('clears displayed private collections immediately and fences the pre-invalidation request', async () => {
    const first = snapshot(1); first.drafts = [chapter()];
    const stale = deferred<OwnerSnapshot>(), authoritative = deferred<OwnerSnapshot>();
    const connection = port([Promise.resolve(first), stale.promise, authoritative.promise]);
    const store = new DockStore(connection.client), disconnect = store.connect(); await tick();
    const oldRefresh = store.refresh();
    connection.emit({ id: 3, event: 'privacy.invalidated', data: { sessionId: 'session', revision: 3, affectedIds: ['chapter'] } });
    expect(store.getSnapshot().snapshot?.drafts).toEqual([]);
    expect(store.getSnapshot().sourceEpoch).toBe(1);
    expect(store.getSnapshot().invalidatedIds).toEqual(['chapter']);
    stale.resolve(first); await oldRefresh;
    expect(store.getSnapshot().snapshot?.drafts).toEqual([]);
    const safe = snapshot(3); safe.session!.privacyEpoch = 2;
    authoritative.resolve(safe); await tick();
    expect(store.getSnapshot().snapshot?.revision).toBe(3);
    disconnect();
  });
  it('drops a refresh after the dock disconnects', async () => {
    const request = deferred<OwnerSnapshot>(), connection = port([request.promise]);
    const store = new DockStore(connection.client), disconnect = store.connect(); disconnect();
    request.resolve(snapshot()); await tick(); expect(store.getSnapshot().snapshot).toBeNull();
  });
  it('stops capture before server settings and keeps it stopped when the server save fails', async () => {
    const order: string[] = [];
    const server = deferred<ReturnType<RecapClient['setSettings']> extends Promise<infer T> ? T : never>();
    const client = { setSettings: vi.fn(() => { order.push('server'); return server.promise; }) } as unknown as RecapClient;
    const capture = { pause: vi.fn(() => { order.push('tracks stopped'); return Promise.resolve(); }) } as unknown as DockCapturePort;
    const action = pauseListening(client, snapshot(), capture);
    expect(order).toEqual(['tracks stopped', 'server']);
    server.resolve(defaultSettings); await action;
    const failing = { setSettings: vi.fn().mockRejectedValue(new Error('disk full')) } as unknown as RecapClient;
    await expect(pauseListening(failing, snapshot(), capture)).rejects.toThrow('disk full');
    expect(capture.pause).toHaveBeenCalledTimes(2);
  });
  it('does not mistake the cloud publish sequence for a privacy acknowledgment', () => {
    const receipt = { revision: 2, privacyEpoch: 2, hiddenEntityIds: ['chapter'], rebuildStatus: 'queued' as const, publicSync: 'pending' as const, externalClipActions: [] };
    const stale = snapshot(); // Cloud sequence 500 is larger than session publication revision 2.
    expect(privacyAcknowledged(receipt, stale)).toBe(false);
    stale.session!.privacyEpoch = 2; stale.sync.pendingPrivacy = true;
    expect(privacyAcknowledged(receipt, stale)).toBe(false);
    stale.sync.pendingPrivacy = false; stale.sync.state = 'pending';
    expect(privacyAcknowledged(receipt, stale)).toBe(false);
    stale.sync.state = 'synced'; expect(privacyAcknowledged(receipt, stale)).toBe(true);
  });
});
describe('dock publication and interactions', () => {
  it('keeps paused virtual Forget intervals and countdowns fixed as wall time passes', () => {
    const paused = snapshot(); paused.serverNow = '2026-11-02T00:01:22.000Z';
    const draft = chapter(); draft.eligibleAt = '2026-11-02T00:02:14.000Z';
    const before = dockClock(paused.serverNow, 1000, 1000, 'snapshot');
    const after = dockClock(paused.serverNow, 1000, 35000, 'snapshot');
    expect(after).toEqual(before);
    expect(forgetWindow(paused, after.elapsed)).toMatchObject({ fromMs: 0, toMs: 82000 });
    expect(publicationLabel(draft, before.now)).toBe('Publishes in 52 s');
    expect(publicationLabel(draft, after.now)).toBe('Publishes in 52 s');
  });
  it('advances the live dock clock between server observations', () => {
    const live = snapshot(); live.serverNow = '2026-11-02T00:01:22.000Z';
    const draft = chapter(); draft.eligibleAt = '2026-11-02T00:02:14.000Z';
    const after = dockClock(live.serverNow, 1000, 35000);
    expect(after.elapsed).toBe(34000);
    expect(forgetWindow(live, after.elapsed)).toMatchObject({ fromMs: 0, toMs: 116000 });
    expect(publicationLabel(draft, after.now)).toBe('Publishes in 18 s');
  });
  it.each(['revision_conflict', 'save_failed'])('retains owner wording after %s without adopting a newer audio-derived chapter', async code => {
    const request = deferred<Chapter>();
    const editChapter = vi.fn(() => request.promise);
    const client = { editChapter } as unknown as RecapClient;
    const draft = { id: 'chapter', title: 'The owner’s exact title', summary: 'Keep this correction despite the new audio.', baseRevision: 2 };
    const action = saveChapterDraft(client, draft);
    // A newer owner projection arriving during save must not change the submitted wording.
    const newAudio = { ...chapter(), revision: 3, title: 'A later generated title' };
    expect(newAudio.title).not.toBe(draft.title);
    request.reject({ code });
    const failed = await action;
    expect(failed).toMatchObject({ ok: false, draft, conflict: code === 'revision_conflict' });
    expect(editChapter).toHaveBeenCalledWith('chapter', { title: draft.title, summary: draft.summary, baseRevision: 2 });
  });
  it('counts from the authoritative eligibility time and never counts an unchecked candidate', () => {
    const draft = chapter();
    expect(publicationLabel(draft, Date.parse('2026-11-02T00:03:00Z'))).toBe('Publishes in 52 s');
    expect(publicationLabel(draft, Date.parse('2026-11-02T00:03:30Z'))).toBe('Publishes in 22 s');
    draft.safety.moderation = 'pending'; expect(publicationLabel(draft, Date.parse(draft.eligibleAt))).toBe('Waiting for a safety check');
    draft.safety.reason = 'fixture_missing'; expect(publicationLabel(draft, 0)).toBe('This recording has no safety check for this edit');
  });
  it('confirms a fixed 120 second interval rather than recomputing after the dialog opens', () => {
    const target = forgetWindow(snapshot(), 4000)!;
    expect(target).toMatchObject({ fromMs: 64000, toMs: 184000 });
    expect(target.toMs - target.fromMs).toBe(120000);
    const early = snapshot(); early.serverNow = '2026-11-02T00:00:30.000Z';
    expect(forgetWindow(early)).toMatchObject({ fromMs: 0, toMs: 30000 });
  });
  it('requires the exact configured modifier combination', () => {
    const event = { key: 'p', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false };
    expect(hotkeyMatches(event, 'Alt+P')).toBe(true);
    expect(hotkeyMatches({ ...event, shiftKey: true }, 'Alt+P')).toBe(false);
    expect(hotkeyMatches(event, '')).toBe(false);
  });
  it('only reports clipboard success when the clipboard write succeeds', async () => {
    expect(await copyValue('url')).toBe(false);
    expect(await copyValue('url', { writeText: vi.fn().mockRejectedValue(new Error('denied')) })).toBe(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyValue('url', { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('url');
  });
});
