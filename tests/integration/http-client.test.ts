import {describe, expect, it, vi} from 'vitest';
import {OwnerHttpClient, PublicHttpClient, subscribeUpdates} from '../../src/shared/http-client.js';

describe('browser transport boundaries', () => {
  it('shares the CSRF request and never repeats an ambiguous mutation', async () => {
    const calls: {path: string; init: RequestInit | undefined}[] = [];
    const transport = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      calls.push({path: String(path), init});
      if (String(path).endsWith('/csrf')) return Response.json({csrfToken: 'per-session-csrf'});
      throw new TypeError('Connection interrupted after request was sent');
    }) as typeof fetch;
    const client = new OwnerHttpClient('/api/owner', transport);
    await Promise.all([client.initialize(), client.initialize()]);
    await expect(client.triggerRecap('session')).rejects.toThrow('Connection interrupted');
    expect(calls.map(value => value.path)).toEqual(['/api/owner/csrf', '/api/owner/recaps']);
    expect(calls[1].init?.headers).toMatchObject({'X-CSRF-Token': 'per-session-csrf'});
    expect((calls[1].init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    await expect(client.controlReplay({action: 'reset'})).rejects.toMatchObject({code: 'live_replay_unavailable'});
    expect(calls).toHaveLength(2);
  });

  it('observes heartbeat comments and privacy invalidation across network chunks', async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(controller) {stream = controller;}});
    const updates: unknown[] = [], heartbeat = vi.fn();
    const stop = subscribeUpdates('/api/overlay/updates', {onUpdate: event => updates.push(event), onHeartbeat: heartbeat}, (async () => new Response(body)) as typeof fetch);
    stream.enqueue(encoder.encode(': heart'));
    stream.enqueue(encoder.encode('beat\n\nid: 7\nevent: privacy.invalidated\ndata: {"sessionId":"s","revision":4,"affectedIds":["clip"]}\n\n'));
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({id: 7, event: 'privacy.invalidated', data: {sessionId: 's', revision: 4, affectedIds: ['clip']}});
    expect(heartbeat).toHaveBeenCalledTimes(2);
    stop(); stream.close();
  });

  it('sends read depth to the server and propagates lease expiry', async () => {
    const fetcher = vi.fn(async () => Response.json({error: {code: 'live_lease_expired'}}, {status: 410})) as unknown as typeof fetch;
    const client = new PublicHttpClient('/api/public', fetcher);
    await expect(client.getPublicSnapshot('channel', {episodeId: 'episode:1', untilMs: 45000})).rejects.toMatchObject({status: 410});
    expect(fetcher).toHaveBeenCalledWith('/api/public/sessions/episode%3A1?untilMs=45000', expect.objectContaining({cache: 'no-store'}));
  });
});
