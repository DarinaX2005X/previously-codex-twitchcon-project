import { describe, expect, it, vi } from 'vitest';
import type { RecordingReview, RecordingSummary } from '../../src/server/replay/recording-types';
import { HttpClient } from '../../src/shared/http-client';
import { RecordingPanelModel, recordingApproval, recordingAssetUrl, recordingMediaKey, recordingReplayUrl, recordingSourceKey, type RecordingChecks, type RecordingPort } from '../../src/features/dock/RecordingPanel';

const id = '67bdff05-08ea-4a5b-b9a3-a484a2fd3e39';
function summary(patch: Partial<RecordingSummary> = {}): RecordingSummary {
  return { id, status: 'stopped', revision: 4, sessionId: 'session', startedAt: '2026-11-02T01:00:00.000Z', stoppedAt: '2026-11-02T01:10:00.000Z', eventCount: 12, providerCount: 4, message: null, exportId: null, ...patch };
}
function review(): RecordingReview {
  return { recording: summary(), digest: 'a'.repeat(64), sources: [
    { id: 'speech', revision: 1, textHash: 'b'.repeat(64), kind: 'speech', startMs: 0, endMs: 1000, text: 'A permitted source excerpt.', safe: true },
    { id: 'owner', revision: 2, textHash: 'c'.repeat(64), kind: 'owner_statement', startMs: 4000, endMs: 4000, text: 'The owner correction.', safe: true },
  ], outputs: [{ hash: 'd'.repeat(64), text: 'The generated context.' }, { hash: 'e'.repeat(64), text: 'The checked translation.' }], metadata: { channel: 'Actual channel', title: 'Actual title', category: 'Actual category' }, blockedReasons: [], mediaPolicy: 'owner-selected', mediaCandidates: [{ id: 'clip', kind: 'video', startMs: 0, endMs: 1000 }], media: [{ id: 'selected', kind: 'video', hash: 'f'.repeat(64), bytes: 1234, mime: 'video/mp4', startMs: 0, endMs: 1000, sourceRefs: [{ id: 'speech', revision: 1 }], previewUrl: '/api/owner/recordings/' + id + '/media/selected' }] };
}
function checks(value: RecordingReview): RecordingChecks {
  return { metadata: true, sources: value.sources.map(recordingSourceKey), outputs: value.outputs.map(item => item.hash), visual: value.media.map(recordingMediaKey), audio: value.media.map(recordingMediaKey) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function harness(initial = review()) {
  let current = structuredClone(initial), item = structuredClone(initial.recording), removed = false;
  const calls: { path: string; options: Parameters<RecordingPort['request']>[1] }[] = [];
  const request = vi.fn(async <T,>(path: string, options?: Parameters<RecordingPort['request']>[1]): Promise<T> => {
    calls.push({ path, options });
    let result: unknown;
    if (path === '/recordings') result = { items: removed ? [] : [item], activeId: ['armed', 'recording'].includes(item.status) ? id : null, automaticUpload: false, boundary: 'Start before context.' };
    else if (path.endsWith('/start')) { item = summary({ status: options?.body && 'sessionId' in (options.body as object) ? 'recording' : 'armed' }); result = item; }
    else if (path.endsWith('/stop')) { item = summary(); result = item; }
    else if (path.endsWith('/review') && options?.method === 'POST') result = { receiptId: 'receipt' };
    else if (path.endsWith('/review')) result = current;
    else if (path.endsWith('/export')) { item = summary({ status: 'exported', exportId: 'recording-' + id, publication: { state: 'staged' } }); result = { exportId: item.exportId, status: 'staged', uploaded: false }; }
    else if (path.endsWith('/publish')) { item = { ...item, publication: { state: 'queued' } }; result = { status: 'queued', exportId: item.exportId }; }
    else if (path.endsWith('/revoke')) { item = { ...item, publication: { state: 'revoked', revocationPending: true, removalAllowed: false } }; result = { exportId: item.exportId, publication: item.publication }; }
    else if (path.endsWith('/media') && options?.method === 'POST') { current = { ...current, digest: '9'.repeat(64), recording: summary({ revision: 5 }) }; item = current.recording; result = { id, captureRevision: 5 }; }
    else if (path === '/recordings/' + id && options?.method === 'DELETE') { removed = true; result = { removed: true }; }
    else throw new Error('Unexpected request: ' + path);
    return structuredClone(result) as T;
  });
  const model = new RecordingPanelModel({ request: request as RecordingPort['request'] });
  return { model, request, calls, setItem: (next: RecordingSummary) => { item = next; }, setReview: (next: RecordingReview) => { current = next; } };
}
function markAll(model: RecordingPanelModel, value: RecordingReview) {
  model.check('metadata', '', true);
  value.sources.forEach(source => model.check('sources', recordingSourceKey(source), true));
  value.outputs.forEach(output => model.check('outputs', output.hash, true));
  value.media.forEach(media => { model.check('visual', recordingMediaKey(media), true); model.check('audio', recordingMediaKey(media), true); });
}

describe('recording review confirmations', () => {
  it('requires each exact source, every output, metadata, and visual plus audio checks for every selected asset', () => {
    const value = review(), complete = checks(value);
    expect(recordingApproval(value, complete)).toMatchObject({ captureRevision: 4, digest: value.digest, metadataReviewed: true });
    expect(recordingApproval(value, { ...complete, metadata: false })).toBeNull();
    expect(recordingApproval(value, { ...complete, sources: complete.sources.slice(1) })).toBeNull();
    expect(recordingApproval(value, { ...complete, outputs: complete.outputs.slice(1) })).toBeNull();
    expect(recordingApproval(value, { ...complete, visual: [] })).toBeNull();
    expect(recordingApproval(value, { ...complete, audio: [] })).toBeNull();
    const changed = structuredClone(value); changed.sources[0].revision++;
    expect(recordingApproval(changed, complete)).toBeNull();
    changed.sources[0] = value.sources[0]; changed.media[0].hash = '0'.repeat(64);
    expect(recordingApproval(changed, complete)).toBeNull();
  });
  it('does not approve a blocked capture even when every checkbox is checked', () => {
    const value = review(); value.blockedReasons = ['A source is awaiting review.'];
    expect(recordingApproval(value, checks(value))).toBeNull();
  });
  it('does not request any mutation while listing or opening review', async () => {
    const test = harness(); await test.model.load(); await test.model.openReview(id);
    expect(test.calls.every(call => !call.options?.method)).toBe(true);
    expect(test.model.getSnapshot().checks).toEqual({ metadata: false, sources: [], outputs: [], visual: [], audio: [] });
    expect(test.model.getSnapshot().receiptId).toBeNull();
    await test.model.approve();
    expect(test.calls.some(call => call.options?.method === 'POST')).toBe(false);
  });
  it('keeps approval, private export and public publication as three separate explicit operations', async () => {
    const value = review(), test = harness(value); await test.model.load(); await test.model.openReview(id); markAll(test.model, value);
    await test.model.approve();
    expect(test.model.getSnapshot().receiptId).toBe('receipt');
    expect(test.calls.filter(call => call.options?.method === 'POST').map(call => call.path)).toEqual(['/recordings/' + id + '/review']);
    const approval = test.calls.at(-1)!.options!.body;
    expect(approval).toEqual(recordingApproval(value, checks(value)));
    await test.model.createExport();
    expect(test.calls.filter(call => call.path.endsWith('/publish'))).toHaveLength(0);
    expect(test.model.getSnapshot().items[0].status).toBe('exported');
    await test.model.publish(id);
    expect(test.calls.filter(call => call.path.endsWith('/publish'))).toHaveLength(1);
    expect(test.model.getSnapshot().notice).toBe('Publication requested.');
    expect(test.model.getSnapshot().notice).not.toContain('published online');
  });
  it('clears the approval receipt when a reviewer unchecks content or changes media selection', async () => {
    const value = review(), test = harness(value); await test.model.openReview(id); markAll(test.model, value); await test.model.approve();
    test.model.check('outputs', value.outputs[0].hash, false);
    expect(test.model.getSnapshot().receiptId).toBeNull();
    await test.model.createExport(); expect(test.calls.some(call => call.path.endsWith('/export'))).toBe(false);
    markAll(test.model, value); await test.model.approve(); await test.model.selectMedia('clip', true);
    expect(test.model.getSnapshot().review?.digest).toBe('9'.repeat(64));
    expect(test.model.getSnapshot().receiptId).toBeNull();
    expect(test.model.getSnapshot().checks.sources).toEqual([]);
    expect(test.model.getSnapshot().checks.metadata).toBe(false);
    expect(test.calls.slice(-2).map(call => call.path)).toEqual(['/recordings/' + id + '/review', '/recordings']);
  });
});

describe('managed recording publication and withdrawal', () => {
  const exportId = 'recording-' + id;
  const replayUrl = 'https://previously.example/replay?recording=' + exportId;
  it('shows a stable public link only for this recording’s authoritative published state', () => {
    const item = summary({ status: 'exported', exportId });
    expect(recordingReplayUrl({ ...item, publication: { state: 'queued', replayUrl } })).toBeNull();
    expect(recordingReplayUrl({ ...item, publication: { state: 'error', replayUrl } })).toBeNull();
    expect(recordingReplayUrl({ ...item, publication: { state: 'revoked', replayUrl } })).toBeNull();
    expect(recordingReplayUrl({ ...item, publication: { state: 'published', replayUrl } })).toBe(replayUrl);
    expect(recordingReplayUrl({ ...item, publication: { state: 'published', replayUrl: replayUrl + '-other' } })).toBeNull();
    expect(recordingReplayUrl({ ...item, publication: { state: 'published', replayUrl: 'javascript:alert(1)' } })).toBeNull();
  });
  it('follows authoritative staged, queued, published and failed states without treating another sync as this export’s ACK', async () => {
    const test = harness();
    test.setItem(summary({ status: 'exported', exportId, publication: { state: 'staged' } })); await test.model.load();
    await test.model.publish(id);
    expect(test.model.getSnapshot().items[0].publication?.state).toBe('queued');
    expect(recordingReplayUrl(test.model.getSnapshot().items[0])).toBeNull();
    test.setItem(summary({ status: 'exported', exportId, publication: { state: 'published', replayUrl } })); await test.model.load();
    expect(recordingReplayUrl(test.model.getSnapshot().items[0])).toBe(replayUrl);
    await test.model.publish(id);
    expect(test.calls.filter(call => call.path.endsWith('/publish'))).toHaveLength(1);
    test.setItem(summary({ status: 'exported', exportId, publication: { state: 'error' } })); await test.model.load();
    await test.model.publish(id);
    expect(test.calls.filter(call => call.path.endsWith('/publish'))).toHaveLength(2);
  });
  it('withdraws only this export, clears private review and preserves the capture until its exact public withdrawal is acknowledged', async () => {
    const test = harness();
    test.setItem(summary({ status: 'exported', exportId, publication: { state: 'published', replayUrl } })); await test.model.load();
    await test.model.openReview(id);
    await test.model.withdraw(id);
    expect(test.model.getSnapshot().review).toBeNull();
    expect(test.model.getSnapshot().items[0].publication).toEqual({ state: 'revoked', revocationPending: true, removalAllowed: false });
    expect(recordingReplayUrl(test.model.getSnapshot().items[0])).toBeNull();
    expect(test.calls.some(call => call.path.includes('/privacy') || call.path.includes('/chapters'))).toBe(false);
    expect(test.model.getSnapshot().notice).toBe('Withdrawal saved.');
    await test.model.remove(id);
    expect(test.calls.some(call => call.path === '/recordings/' + id && call.options?.method === 'DELETE')).toBe(false);
    test.setItem(summary({ status: 'exported', exportId, publication: { state: 'revoked', revocationPending: false, removalAllowed: true } })); await test.model.load();
    await test.model.remove(id);
    expect(test.model.getSnapshot().items).toEqual([]);
  });
  it('allows a staged-only revoked capture to be removed when the server explicitly grants it', async () => {
    const test = harness();
    test.setItem(summary({ status: 'exported', exportId, publication: { state: 'revoked', revocationPending: true, removalAllowed: true } })); await test.model.load();
    await test.model.remove(id);
    expect(test.calls.some(call => call.path === '/recordings/' + id && call.options?.method === 'DELETE')).toBe(true);
  });
  it('offers an explicit retry for a withdrawal still pending and never republishes a withdrawn export', async () => {
    const test = harness();
    test.setItem(summary({ status: 'exported', exportId, publication: { state: 'revoked', revocationPending: true } })); await test.model.load();
    await test.model.withdraw(id);
    expect(test.calls.filter(call => call.path.endsWith('/revoke'))).toHaveLength(1);
    await test.model.publish(id);
    expect(test.calls.filter(call => call.path.endsWith('/publish'))).toHaveLength(0);
  });
});

describe('private recording lifetime', () => {
  it('clears source text and receipt immediately on invalidation and ignores the old review response', async () => {
    const pending = deferred<RecordingReview>(), value = review();
    const port: RecordingPort = { request: vi.fn(async <T,>(path: string) => path.endsWith('/review') ? await pending.promise as T : { items: [], activeId: null } as T) as RecordingPort['request'] };
    const model = new RecordingPanelModel(port, 1), opening = model.openReview(id);
    model.invalidate(2);
    expect(model.getSnapshot().review).toBeNull(); expect(model.getSnapshot().receiptId).toBeNull();
    pending.resolve(value); await opening;
    expect(model.getSnapshot().review).toBeNull(); expect(model.getSnapshot().sourceEpoch).toBe(2);
  });
  it('withdraws an open review when authoritative list state changes or access is revoked', async () => {
    const test = harness(); await test.model.load(); await test.model.openReview(id);
    test.setItem(summary({ revision: 5, status: 'invalidated' })); await test.model.load();
    expect(test.model.getSnapshot().review).toBeNull();
    await test.model.openReview(id);
    test.request.mockRejectedValueOnce(Object.assign(new Error('Sign in again.'), { status: 401 }));
    await test.model.load(); expect(test.model.getSnapshot().review).toBeNull();
  });
  it('starts only after an explicit action and sends the chosen live-session boundary', async () => {
    const test = harness(); expect(test.calls).toEqual([]);
    await test.model.start(null);
    expect(test.calls[0]).toMatchObject({ path: '/recordings/start', options: { method: 'POST', body: {} } });
    expect(test.model.getSnapshot().items[0].status).toBe('armed');
    const live = harness(); await live.model.start('session');
    expect(live.calls[0].options?.body).toEqual({ sessionId: 'session' });
    expect(live.model.getSnapshot().items[0].status).toBe('recording');
    expect(live.calls.some(call => call.path.endsWith('/publish'))).toBe(false);
  });
  it('deduplicates an in-flight explicit mutation', async () => {
    const wait = deferred<unknown>(), request = vi.fn(async <T,>(path: string) => path.endsWith('/start') ? await wait.promise as T : { items: [], activeId: null } as T);
    const model = new RecordingPanelModel({ request: request as RecordingPort['request'] });
    const first = model.start(null), duplicate = model.start(null);
    expect(request).toHaveBeenCalledTimes(1);
    wait.resolve({}); await Promise.all([first, duplicate]);
    expect(request.mock.calls.filter(call => call[0].endsWith('/start'))).toHaveLength(1);
  });
  it('can reconnect its read lifecycle after a StrictMode cleanup without accepting the old response', async () => {
    const old = deferred<unknown>(); let calls = 0;
    const model = new RecordingPanelModel({ request: async <T,>() => (++calls === 1 ? await old.promise : { items: [summary()], activeId: null }) as T });
    const first = model.load(); model.dispose(); model.activate(); await model.load();
    old.resolve({ items: [], activeId: null }); await first;
    expect(model.getSnapshot().items).toHaveLength(1);
  });
});

describe('owner request and download boundary', () => {
  it('uses the injected owner request credentials, CSRF and idempotency contract', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(String(url).endsWith('/csrf') ? { csrfToken: 'csrf' } : String(url).endsWith('/start') ? summary({ status: 'armed' }) : { items: [], activeId: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const model = new RecordingPanelModel(new HttpClient('/api/owner', fetcher)); await model.start(null);
    const start = requests.find(item => item.url.endsWith('/recordings/start'))!;
    expect(start.init?.credentials).toBe('same-origin'); expect(start.init?.cache).toBe('no-store');
    expect(new Headers(start.init?.headers).get('X-CSRF-Token')).toBe('csrf');
    expect(new Headers(start.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(requests.some(item => item.url.endsWith('/publish'))).toBe(false);
  });
  it('constructs only owner-local media and download links, never an arbitrary export URL', () => {
    const port: RecordingPort = { request: async <T,>() => undefined as T };
    expect(recordingAssetUrl(port, id)).toBe('/api/owner/recordings/' + id + '/download');
    expect(recordingAssetUrl(port, id, 'clip/one')).toBe('/api/owner/recordings/' + id + '/media/clip%2Fone');
    expect(recordingAssetUrl({ ...port, base: 'https://outside.example' }, id)).toBeNull();
    expect(recordingAssetUrl({ ...port, base: '//outside.example' }, id)).toBeNull();
  });
});
