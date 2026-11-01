import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type ClientRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, SourceStatus } from '../../src/shared/contracts/index.js';
import { createApp } from '../../src/server/app.js';
import { createStorage } from '../../src/server/storage/index.js';
import { loadConfig } from '../../src/server/runtime/config.js';
import { createLiveRuntime } from '../../src/server/runtime/live.js';
import { OverlayPresence } from '../../src/server/runtime/overlay-routes.js';
import { RevisionStream } from '../../src/server/runtime/updates.js';
import { csrfToken, type Principal } from '../../src/server/runtime/security.js';

const scope = {channelId: '123', runId: 'live'}, start = Date.parse('2026-11-02T00:00:00Z');
const principal: Principal = {...scope, role: 'overlay', actorId: 'overlay:1', sessionId: 'authored-overlay-session', expiresAtMs: start + 100_000};
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {for (const action of cleanup.splice(0).reverse()) await action(); vi.useRealTimers();});
function presenceFixture() {
  let now = start;
  const clock: Clock = {now: () => now, iso: () => new Date(now).toISOString()};
  const allowed = new Set([principal.sessionId]);
  const statuses: SourceStatus[] = [];
  const presence = new OverlayPresence({scope, clock, authorized: value => allowed.has(value.sessionId), onStatus: value => statuses.push(value)});
  cleanup.push(() => presence.close());
  return {clock, allowed, statuses, presence, advance(ms: number) {now += ms;}, latest: () => statuses.at(-1)!};
}
async function listen(app: ReturnType<typeof createApp>): Promise<number> {
  const server = createServer(app);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  cleanup.push(async () => {server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));});
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
  return address.port;
}
function request(port: number, path: string, options: {method?: string; headers?: Record<string, string>; body?: unknown} = {}) {
  return new Promise<{status: number}>((done, reject) => {
    const outgoing = httpRequest({hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {Host: 'localhost:4317', Origin: 'https://localhost:4317', 'Content-Type': 'application/json', ...options.headers}}, response => {
      response.resume(); response.on('end', () => done({status: response.statusCode ?? 500}));
    });
    outgoing.on('error', reject); outgoing.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
async function openStream(port: number) {
  let outgoing: ClientRequest;
  const response = await new Promise<import('node:http').IncomingMessage>((done, reject) => {
    outgoing = httpRequest({hostname: '127.0.0.1', port, path: '/api/overlay/updates', headers: {Host: 'localhost:4317'}}, done);
    outgoing.on('error', reject); outgoing.end();
  });
  let body = '';
  response.on('data', (chunk: Buffer) => {body += chunk.toString('utf8');});
  cleanup.push(() => {outgoing.destroy(); response.destroy();});
  const until = (text: string) => new Promise<void>(done => {
    if (body.includes(text)) {done(); return;}
    const onData = () => {if (body.includes(text)) {response.off('data', onData); done();}};
    response.on('data', onData);
  });
  return {until, close: () => {outgoing.destroy(); response.destroy();}, get body() {return body;}};
}

describe('six-second overlay presence leases', () => {
  it('accepts only current overlay capability activity and expires at the lease boundary', () => {
    const fixture = presenceFixture();
    expect(fixture.latest().state).toBe('disconnected');
    fixture.presence.touch({...principal, role: 'owner'});
    fixture.presence.touch({...principal, channelId: 'other'});
    fixture.presence.touch({...principal, sessionId: 'unverified'});
    expect(fixture.latest().state).toBe('disconnected');
    fixture.presence.touch(principal); expect(fixture.latest()).toMatchObject({state: 'ready', lastObservedAt: fixture.clock.iso()});
    fixture.advance(5999); fixture.presence.tick(); expect(fixture.latest().state).toBe('ready');
    fixture.advance(1); fixture.presence.tick(); expect(fixture.latest().state).toBe('disconnected');
  });
  it('coalesces rapid poll observations and preserves another connected capability', () => {
    const fixture = presenceFixture(); fixture.presence.touch(principal);
    const connectedCount = fixture.statuses.length;
    for (let i = 0; i < 20; i++) {fixture.advance(1); fixture.presence.touch(principal);}
    expect(fixture.statuses).toHaveLength(connectedCount);
    fixture.advance(4000);
    const second = {...principal, sessionId: 'second-device'}; fixture.allowed.add(second.sessionId); fixture.presence.touch(second);
    fixture.presence.observe({type: 'revoked', matches: value => value.sessionId === principal.sessionId});
    expect(fixture.latest().state).toBe('ready');
    fixture.advance(6000); fixture.presence.tick(); expect(fixture.latest().state).toBe('disconnected');
  });
  it('revalidates stored sessions and clears polling leases on revoke and shutdown', () => {
    const fixture = presenceFixture(); fixture.presence.touch(principal); fixture.allowed.clear(); fixture.presence.tick();
    expect(fixture.latest().state).toBe('disconnected');
    fixture.allowed.add(principal.sessionId); fixture.presence.touch(principal);
    fixture.presence.observe({type: 'revoked', matches: value => value.role === 'overlay'});
    expect(fixture.latest().state).toBe('disconnected');
    fixture.presence.touch(principal); fixture.presence.close(); fixture.presence.touch(principal);
    expect(fixture.latest().state).toBe('disconnected');
  });
});

describe('authorized SSE connection lifecycle', () => {
  it('renews on actual heartbeats and expires six seconds after transport loss', async () => {
    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
    const fixture = presenceFixture(), updates = new RevisionStream(1000, fixture.clock.now);
    cleanup.push(() => updates.close());
    updates.observeConnections(event => fixture.presence.observe(event)); fixture.presence.start();
    const app = createApp({config: loadConfig({SESSION_SECRET: 's'.repeat(32)}), status: {phase: 'ready', storage: 'ready', mode: 'local'}, now: fixture.clock.now,
      auth: {authenticate: () => principal}, updates, authorizeStream: value => fixture.allowed.has(value.sessionId)});
    const stream = await openStream(await listen(app)); await stream.until('snapshot.reset');
    expect(fixture.latest().state).toBe('ready');
    fixture.advance(2000); await vi.advanceTimersByTimeAsync(2000); await stream.until(': heartbeat');
    expect(fixture.latest().lastObservedAt).toBe(fixture.clock.iso());
    stream.close(); await new Promise<void>(done => setImmediate(done)); await new Promise<void>(done => setImmediate(done));
    fixture.advance(5999); fixture.presence.tick(); expect(fixture.latest().state).toBe('ready');
    fixture.advance(1); fixture.presence.tick(); expect(fixture.latest().state).toBe('disconnected');
    expect(stream.body).not.toContain(principal.sessionId);
  });
  it('does not let late authorization restore a revoked stream', async () => {
    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
    const fixture = presenceFixture(), updates = new RevisionStream(1000, fixture.clock.now);
    cleanup.push(() => updates.close()); updates.observeConnections(event => fixture.presence.observe(event));
    let revalidate: ((value: boolean) => void) | undefined, calls = 0;
    const app = createApp({config: loadConfig({SESSION_SECRET: 's'.repeat(32)}), status: {phase: 'ready', storage: 'ready', mode: 'local'}, now: fixture.clock.now,
      auth: {authenticate: () => principal}, updates, authorizeStream: () => ++calls === 1 ? true : new Promise<boolean>(done => {revalidate = done;})});
    const stream = await openStream(await listen(app)); await stream.until('snapshot.reset'); expect(fixture.latest().state).toBe('ready');
    fixture.advance(2000); await vi.advanceTimersByTimeAsync(2000);
    updates.revoke(value => value.role === 'overlay'); expect(fixture.latest().state).toBe('disconnected');
    revalidate?.(true); await Promise.resolve(); await Promise.resolve();
    expect(fixture.latest().state).toBe('disconnected'); expect(stream.body).not.toContain(': heartbeat');
  });
});

describe('live overlay presence composition', () => {
  it('marks successful authorized polling ready and rotation/shutdown disconnected without providers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'previously-overlay-presence-'));
    cleanup.push(() => rmSync(directory, {recursive: true, force: true}));
    const clock: Clock = {now: () => start, iso: () => new Date(start).toISOString()};
    const storage = createStorage({path: ':memory:', now: clock.now, encryptionKey: Buffer.alloc(32, 7)}); cleanup.push(() => storage.close());
    const updates = new RevisionStream(1000, clock.now); cleanup.push(() => updates.close());
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request')); cleanup.push(() => {fetcher.mockRestore();});
    const config = loadConfig({DATA_DIR: directory, SESSION_SECRET: 's'.repeat(32), TWITCH_CLIENT_ID: 'authored', TWITCH_CLIENT_SECRET: 'authored', TWITCH_CHANNEL_LOGIN: 'fixture', OPENAI_PAID_CALLS_ENABLED: 'false'});
    const live = await createLiveRuntime({config, storage, clock, updates, channel: {id: scope.channelId, login: 'fixture', displayName: 'Authored fixture'}});
    if (!live) throw new Error('Fixture runtime did not initialize'); cleanup.push(() => live.close());
    const app = createApp({config, status: {phase: 'ready', storage: 'ready', mode: 'local'}, now: clock.now, auth: live.auth, updates, authorizeStream: live.authorizeStream, routers: live.routers});
    const port = await listen(app);
    const overlayId = storage.sessions.issue(scope, 'overlay:1', 'overlay');
    expect(live.engine.statuses().overlay.state).toBe('disconnected');
    expect((await request(port, '/api/overlay/state', {headers: {Cookie: `__Host-previously-overlay=${overlayId}`}})).status).toBe(200);
    expect(live.engine.statuses().overlay.state).toBe('ready');
    const ownerId = storage.sessions.issue(scope, scope.channelId, 'owner');
    expect((await request(port, '/api/owner/overlay/rotate', {method: 'POST', headers: {Cookie: `__Host-previously-owner=${ownerId}`, 'X-CSRF-Token': csrfToken(config.sessionSecret!, ownerId), 'Idempotency-Key': 'rotate-authored-overlay'}, body: {}})).status).toBe(200);
    expect(live.engine.statuses().overlay.state).toBe('disconnected');
    const renewed = storage.sessions.issue(scope, 'overlay:2', 'overlay');
    await request(port, '/api/overlay/state', {headers: {Cookie: `__Host-previously-overlay=${renewed}`}});
    expect(live.engine.statuses().overlay.state).toBe('ready');
    updates.close(); expect(live.engine.statuses().overlay.state).toBe('disconnected');
    expect(fetcher).not.toHaveBeenCalled(); expect(storage.budget.status().usedMicroUsd).toBe(0);
  });
});
