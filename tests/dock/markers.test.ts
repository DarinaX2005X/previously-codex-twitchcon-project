import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockMarkerLabel, pollDockMarkers } from '../../src/features/dock/DockPage';
import type { DockMarkerSnapshot } from '../../src/features/dock/ports';
import { OwnerHttpClient } from '../../src/shared/http-client';

const result = (patch: Partial<DockMarkerSnapshot> = {}): DockMarkerSnapshot => ({ enabled: true, sessionId: 'stream', items: [{ momentId: 'moment', timecodeMs: 82000, status: 'queued' }], ...patch });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

describe('owner marker results', () => {
  it('uses a scoped read-only HTTP request and passes the cancellation signal', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result()), { status: 200 }));
    const client = new OwnerHttpClient('/api/owner', fetcher), controller = new AbortController();
    expect(await client.listMarkers('stream/one', controller.signal)).toEqual(result());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/api/owner/twitch/markers?sessionId=stream%2Fone', expect.objectContaining({ method: 'GET', signal: controller.signal, cache: 'no-store' }));
  });
  it('reports actual marker outcomes without promising a retry or changing the saved moment time', () => {
    const item = result().items[0];
    expect(dockMarkerLabel(item)).toBe('Twitch marker pending');
    expect(dockMarkerLabel({ ...item, status: 'sent', positionSeconds: 85 })).toBe('Twitch marker saved at 1:25');
    expect(item.timecodeMs).toBe(82000);
    expect(dockMarkerLabel({ ...item, status: 'unknown_outcome' })).toBe('Twitch marker not confirmed. No automatic retry.');
    expect(dockMarkerLabel({ ...item, status: 'cancelled' })).toBe('Twitch marker unavailable. Timecode saved.');
  });
  it('polls enabled result metadata at two-second intervals and stops when disabled', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result({ enabled: false }));
    const value = vi.fn(), failed = vi.fn();
    const stop = pollDockMarkers(read, 'stream', value, failed, () => true);
    await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000); expect(read).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled(); stop();
  });
  it('does not overlap reads and ignores an aborted late result after session/privacy cleanup', async () => {
    vi.useFakeTimers();
    const response = deferred<DockMarkerSnapshot>(), read = vi.fn((_sessionId: string, _signal?: AbortSignal) => response.promise);
    const value = vi.fn(), failed = vi.fn();
    const stop = pollDockMarkers(read, 'stream', value, failed, () => true);
    await vi.advanceTimersByTimeAsync(10000); expect(read).toHaveBeenCalledOnce();
    const signal = read.mock.calls[0][1]!;
    stop(); expect(signal.aborted).toBe(true);
    response.resolve(result()); await vi.advanceTimersByTimeAsync(2000);
    expect(value).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
  });
  it('waits while the dock is hidden and only reports failures through its marker callback', async () => {
    vi.useFakeTimers();
    let visible = false;
    const read = vi.fn().mockRejectedValueOnce(new Error('marker result unavailable')).mockResolvedValue(result());
    const value = vi.fn(), failed = vi.fn();
    const stop = pollDockMarkers(read, 'stream', value, failed, () => visible);
    await vi.advanceTimersByTimeAsync(4000); expect(read).not.toHaveBeenCalled();
    visible = true; await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3999); expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2); expect(value).toHaveBeenCalledOnce(); stop();
  });
  it('rejects another session’s result', async () => {
    vi.useFakeTimers();
    const value = vi.fn(), failed = vi.fn();
    const stop = pollDockMarkers(vi.fn().mockResolvedValue(result({ sessionId: 'another' })), 'stream', value, failed, () => true);
    await vi.advanceTimersByTimeAsync(0); expect(value).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); stop();
  });
});
