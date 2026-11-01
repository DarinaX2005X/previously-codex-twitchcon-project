import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/runtime/config.js';
import { ApiError } from '../../src/server/runtime/errors.js';
import { createOwnerRouter, type OwnerService } from '../../src/server/runtime/owner-routes.js';
import { csrfToken, type Principal } from '../../src/server/runtime/security.js';
import { StorageError } from '../../src/server/storage/index.js';
import { defaultSettings } from '../../src/shared/contracts/index.js';

const secret = 's'.repeat(32);
const owner: Principal = {role: 'owner', actorId: 'owner', channelId: 'channel-1', runId: 'live', sessionId: 'browser-session', expiresAtMs: 10_000};
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));}
});
function serviceWith(methods: Partial<OwnerService>): OwnerService {
  return new Proxy(methods, {get(target, property) {
    return Reflect.get(target, property) ?? (() => {throw new Error('Unexpected service invocation.');});
  }}) as OwnerService;
}
type Reply = {status: number; headers: IncomingHttpHeaders; body: unknown};
async function harness(service: OwnerService, principal: Principal | null = owner) {
  const config = loadConfig({SESSION_SECRET: secret});
  const app = createApp({config, status: {phase: 'ready', storage: 'ready', mode: 'local'}, now: () => 1000,
    auth: {authenticate: () => principal}, routers: {owner: createOwnerRouter(service)}});
  const server = createServer(app); servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test listener did not start.');
  return (path: string, options: {method?: string; body?: unknown; headers?: Record<string, string>} = {}) => new Promise<Reply>((done, reject) => {
    const request = httpRequest({hostname: '127.0.0.1', port: address.port, path: `/api/owner${path}`, method: options.method ?? 'GET', headers: {
      Host: 'localhost:4317', Origin: config.origin, 'Content-Type': 'application/json',
      'Idempotency-Key': 'owner-test-action', 'X-CSRF-Token': csrfToken(secret, (principal ?? owner).sessionId), ...options.headers,
    }}, response => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {const text = Buffer.concat(chunks).toString('utf8'); done({status: response.statusCode ?? 500, headers: response.headers, body: text ? JSON.parse(text) as unknown : null});});
    });
    request.on('error', reject); request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

describe('owner route authorization and pagination', () => {
  it('rejects absent and wrong-role sessions before calling the service', async () => {
    const bootstrap = vi.fn<OwnerService['bootstrap']>();
    const noSession = await harness(serviceWith({bootstrap}), null);
    const overlay = await harness(serviceWith({bootstrap}), {...owner, role: 'overlay'});
    expect((await noSession('/bootstrap')).status).toBe(401);
    expect((await overlay('/bootstrap')).status).toBe(403);
    expect(bootstrap).not.toHaveBeenCalled();
  });
  it('propagates authenticated scope and bounded source selection', async () => {
    const listSources = vi.fn<OwnerService['listSources']>(() => ({items: [], nextCursor: null}));
    const request = await harness(serviceWith({listSources}));
    const result = await request('/sources?sessionId=stream-1&limit=100&cursor=page-2&fromMs=500&toMs=2000');
    expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    expect(listSources).toHaveBeenCalledWith(owner, {sessionId: 'stream-1', limit: 100, cursor: 'page-2', fromMs: 500, toMs: 2000});
    expect((await request('/sources?sessionId=stream-1&channelId=other')).status).toBe(400);
    expect(listSources).toHaveBeenCalledTimes(1);
  });
  it('rejects unbounded, duplicate, malformed and inverted pagination inputs', async () => {
    const listSources = vi.fn<OwnerService['listSources']>();
    const listSessions = vi.fn<OwnerService['listSessions']>();
    const request = await harness(serviceWith({listSources, listSessions}));
    for (const path of ['/sources?sessionId=s&limit=101', '/sources?sessionId=s&limit=1&limit=2', '/sources?sessionId=s&limit=1e2', '/sources?sessionId=s&fromMs=30&toMs=10', '/sources?sessionId=s&fromMs=10', `/sessions?cursor=${'a'.repeat(513)}`, '/sessions?limit=51']) {
      expect((await request(path)).status).toBe(400);
    }
    expect(listSources).not.toHaveBeenCalled(); expect(listSessions).not.toHaveBeenCalled();
  });
});

describe('revision and idempotency boundaries', () => {
  it('passes If-Match and idempotency with the server-owned principal, separately from the settings patch', async () => {
    const setSettings = vi.fn<OwnerService['setSettings']>(() => ({...defaultSettings, revision: 5, recapLanguage: 'ru'}));
    const request = await harness(serviceWith({setSettings}));
    const reply = await request('/settings', {method: 'PATCH', headers: {'If-Match': '"4"', 'Idempotency-Key': 'change-language-1'}, body: {recapLanguage: 'ru'}});
    expect(reply.status).toBe(200);
    expect(setSettings).toHaveBeenCalledWith({principal: owner, idempotencyKey: 'change-language-1', baseRevision: 4}, {recapLanguage: 'ru'});
  });
  it('rejects forged actor fields, missing revisions, conflicting revisions and invalid keys before side effects', async () => {
    const editChapter = vi.fn<OwnerService['editChapter']>();
    const request = await harness(serviceWith({editChapter}));
    const invalidRequests: {body: unknown; headers?: Record<string, string>}[] = [
      {body: {summary: 'Changed', baseRevision: 2, actorId: 'other'}},
      {body: {summary: 'Changed'}},
      {body: {summary: 'Changed', baseRevision: 2}, headers: {'If-Match': '"3"'}},
      {body: {summary: 'Changed'}, headers: {'If-Match': 'W/"3"'}},
      {body: {summary: 'Changed', baseRevision: 2}, headers: {'Idempotency-Key': 'short'}},
    ];
    for (const options of invalidRequests) expect((await request('/chapters/chapter-1', {method: 'PATCH', ...options})).status).toBe(400);
    expect(editChapter).not.toHaveBeenCalled();
  });
  it('forwards domain conflict as 409 and inaccessible IDs as 404 without swallowing failures', async () => {
    const editChapter = vi.fn<OwnerService['editChapter']>(() => {throw new ApiError(409, 'revision_conflict', 'The chapter changed.');});
    const getSession = vi.fn<OwnerService['getSession']>(() => {throw new StorageError('inaccessible', 'private database details');});
    const request = await harness(serviceWith({editChapter, getSession}));
    const conflict = await request('/chapters/chapter-1', {method: 'PATCH', body: {summary: 'Changed', baseRevision: 2}});
    expect(conflict.status).toBe(409); expect(conflict.body).toMatchObject({error: {code: 'revision_conflict'}});
    expect(editChapter).toHaveBeenCalledWith({principal: owner, idempotencyKey: 'owner-test-action', baseRevision: 2}, 'chapter-1', {summary: 'Changed'});
    const inaccessible = await request('/sessions/other-session');
    expect(inaccessible.status).toBe(404); expect(JSON.stringify(inaccessible.body)).not.toContain('private database details');
    expect(getSession).toHaveBeenCalledWith(owner, 'other-session');
  });
});

describe('privacy and recap commands', () => {
  it('allows a user target for privacy without treating it as the acting owner', async () => {
    const receipt = {revision: 5, privacyEpoch: 2, hiddenEntityIds: [], rebuildStatus: 'none' as const, publicSync: 'pending' as const, externalClipActions: []};
    const privacy = vi.fn<OwnerService['privacy']>(() => receipt);
    const request = await harness(serviceWith({privacy}));
    const input = {target: {kind: 'user', sessionId: 'stream-1', actorId: 'target-user', throughMs: 5000}, reason: 'Remove this participant’s data.'};
    expect((await request('/privacy', {method: 'POST', body: input})).status).toBe(200);
    expect(privacy).toHaveBeenCalledWith({principal: owner, idempotencyKey: 'owner-test-action'}, input);
    expect((await request('/privacy', {method: 'POST', body: {target: {kind: 'interval', sessionId: 'stream-1', fromMs: 500, toMs: 100}, reason: 'Remove'}})).status).toBe(400);
    expect(privacy).toHaveBeenCalledTimes(1);
  });
  it('keeps read-only previews separate from triggers and rejects spoofed raid metadata', async () => {
    const previewRecap = vi.fn<OwnerService['previewRecap']>(() => null);
    const triggerRecap = vi.fn<OwnerService['triggerRecap']>(() => ({id: 'playback-1', status: 'queued', plan: null, startAt: null}));
    const request = await harness(serviceWith({previewRecap, triggerRecap}));
    expect((await request('/recaps/preview?sessionId=stream-1')).body).toBeNull();
    expect(previewRecap).toHaveBeenCalledWith(owner, 'stream-1'); expect(triggerRecap).not.toHaveBeenCalled();
    expect((await request('/recaps', {method: 'POST', body: {sessionId: 'stream-1', reason: 'raid', viewers: 500}})).status).toBe(400);
    const accepted = await request('/recaps', {method: 'POST', body: {sessionId: 'stream-1'}});
    expect(accepted.status).toBe(202); expect(triggerRecap).toHaveBeenCalledWith({principal: owner, idempotencyKey: 'owner-test-action'}, {sessionId: 'stream-1', reason: 'manual'});
  });
  it('returns 204 only after cancellation resolves, and rejects unknown playback acknowledgements', async () => {
    const cancelRecap = vi.fn<OwnerService['cancelRecap']>(async () => {});
    const acknowledgeRecap = vi.fn<OwnerService['acknowledgeRecap']>();
    const request = await harness(serviceWith({cancelRecap, acknowledgeRecap}));
    expect((await request('/recaps/playback-1/cancel', {method: 'POST', body: {}})).status).toBe(204);
    expect(cancelRecap).toHaveBeenCalledWith({principal: owner, idempotencyKey: 'owner-test-action'}, 'playback-1');
    expect((await request('/recaps/playback-1/ack', {method: 'POST', body: {state: 'uploaded', timestamp: '2026-11-02T00:00:00Z'}})).status).toBe(400);
    expect(acknowledgeRecap).not.toHaveBeenCalled();
  });
});
