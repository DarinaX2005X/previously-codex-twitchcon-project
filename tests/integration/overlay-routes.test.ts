import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createDomainState, reduceDomain, type DomainEffect, type DomainState } from '../../src/core/index.js';
import type { Clock, PlaybackRef } from '../../src/shared/contracts/index.js';
import { createApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/runtime/config.js';
import { createOverlayRouter, type OverlayEnginePort } from '../../src/server/runtime/overlay-routes.js';
import { csrfToken, type Principal } from '../../src/server/runtime/security.js';

const start = Date.parse('2026-11-02T00:00:00Z'), secret = 's'.repeat(32);
const overlay: Principal = {role: 'overlay', actorId: 'overlay-device', channelId: 'channel', runId: 'live', sessionId: 'overlay-cookie', expiresAtMs: start + 100_000};
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {for (const server of servers.splice(0)) {server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));}});

// Authored local fixture. The real reducer supplies playback transitions; no providers or live effects.
function engineFixture() {
  let now = start, connected = true;
  const clock: Clock = {now: () => now, iso: () => new Date(now).toISOString()};
  let state = createDomainState({channel: {id: 'channel', login: 'fixture', displayName: 'Authored fixture'}, session: {
    id: 'stream', channelId: 'channel', runId: 'live', twitchStreamId: null, title: 'PRIVATE_OWNER_TITLE', category: '',
    startedAt: clock.iso(), endedAt: null, status: 'live', privacyEpoch: 0, publicationRevision: 0,
    metadataMaxDependencyEndMs: 0, finalizedAt: null, finalSnapshotAckAt: null,
  }});
  const effects: DomainEffect[] = [];
  const dispatch = vi.fn<OverlayEnginePort['dispatch']>(async (sessionId, event) => {
    if (sessionId !== 'stream') throw new Error('Wrong session');
    const transition = reduceDomain(state, event, clock); state = transition.state; effects.push(...transition.effects); return structuredClone(state);
  });
  const engine: OverlayEnginePort = {scope: {channelId: 'channel', runId: 'live'}, activeSessionId: () => connected ? 'stream' : null, state: () => structuredClone(state), dispatch};
  function trigger(id: string) {
    state = reduceDomain(state, {type: 'recap.trigger', trigger: {id, sessionId: 'stream', reason: 'manual', occurredAt: clock.iso()}}, clock).state;
    return `playback:${id}`;
  }
  return {engine, clock, dispatch, effects, trigger, advance(ms: number) {now += ms;}, disconnect() {connected = false;}, get state() {return state;}, set state(value: DomainState) {state = value;}};
}
type Fixture = ReturnType<typeof engineFixture>;
type Reply = {status: number; body: unknown; headers: IncomingHttpHeaders};
async function harness(fixture: Fixture, principal: Principal | null = overlay) {
  const config = loadConfig({SESSION_SECRET: secret});
  const app = createApp({config, status: {phase: 'ready', storage: 'ready', mode: 'local'}, now: fixture.clock.now,
    auth: {authenticate: () => principal}, routers: {overlay: createOverlayRouter({engine: fixture.engine, clock: fixture.clock})}});
  const server = createServer(app); servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test listener did not start.');
  return (path: string, options: {method?: string; body?: unknown; headers?: Record<string, string>} = {}) => new Promise<Reply>((done, reject) => {
    const request = httpRequest({hostname: '127.0.0.1', port: address.port, path: `/api/overlay${path}`, method: options.method ?? 'GET', headers: {
      Host: 'localhost:4317', Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken(secret, (principal ?? overlay).sessionId), ...options.headers,
    }}, response => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); done({status: response.statusCode ?? 500, body: text ? JSON.parse(text) as unknown : null, headers: response.headers});
      });
    });
    request.on('error', reject); request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
const ack = (fixture: Fixture, state: string) => ({method: 'POST', body: {state, timestamp: fixture.clock.iso()}});

describe('overlay projection and capability boundaries', () => {
  it('returns an empty valid state without a stream and does not fabricate a recap', async () => {
    const fixture = engineFixture(); fixture.disconnect(); const request = await harness(fixture);
    const result = await request('/state');
    expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual({sessionId: null, privacyEpoch: 0, revision: 0, serverNow: fixture.clock.iso(), active: null, queued: []});
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it('rejects absent, owner, expired and cross-channel capability sessions', async () => {
    const fixture = engineFixture(); fixture.trigger('one');
    for (const [principal, expected] of [[null, 401], [{...overlay, role: 'owner'}, 403], [{...overlay, channelId: 'other'}, 403], [{...overlay, expiresAtMs: start}, 401]] as const) {
      const request = await harness(fixture, principal); expect((await request('/state')).status).toBe(expected);
    }
    const request = await harness(fixture); expect((await request('/state?channelId=other')).status).toBe(400);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it('projects at most one active and one queued plan without private state or extra playback fields', async () => {
    const fixture = engineFixture(); fixture.trigger('one'); fixture.trigger('two');
    fixture.state.settings.channelContext = 'PRIVATE_OWNER_CONTEXT';
    fixture.state.sources.push({id: 'private-source', channelId: 'channel', runId: 'live', sessionId: 'stream', revision: 1, kind: 'speech', startMs: 0, endMs: 100, actorId: null, languageCodes: ['en'], timePrecision: 'chunk', text: 'PRIVATE_TRANSCRIPT', status: 'active', externalMessageId: null, moderation: 'pending'});
    Object.assign(fixture.state.playbacks[0]!, {ownerNotes: 'PRIVATE_PLAYBACK_NOTE'});
    fixture.state.playbacks.push({...fixture.state.playbacks[1]!, id: 'extra-queued'});
    const request = await harness(fixture), result = await request('/state');
    expect(result.status).toBe(200); expect(result.body).toMatchObject({active: {id: 'playback:one', status: 'preparing'}, queued: [{id: 'playback:two', status: 'queued'}]});
    expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE_|ownerNotes|sources|settings/);
  });
  it('withdraws revoked plans on reads and acknowledgements, with no dispatch', async () => {
    const fixture = engineFixture(), id = fixture.trigger('one');
    fixture.state.session.privacyEpoch++;
    const request = await harness(fixture);
    expect((await request('/state')).body).toMatchObject({active: null, queued: [], privacyEpoch: 1});
    expect((await request(`/recaps/${id}`)).status).toBe(410);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'prepared'))).status).toBe(410);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it('rejects stale dependency revisions and unknown plan fields instead of exposing them', async () => {
    const fixture = engineFixture(), id = fixture.trigger('one');
    fixture.state.playbacks[0]!.plan!.dependencyRefs = [{id: 'missing-private-source', revision: 1}];
    const request = await harness(fixture); expect((await request(`/recaps/${id}`)).status).toBe(410);
    fixture.state.playbacks[0]!.plan!.dependencyRefs = [];
    Object.assign(fixture.state.playbacks[0]!.plan!, {rawTranscript: 'PRIVATE_TRANSCRIPT'});
    const result = await request('/state'); expect(result.body).toMatchObject({active: null}); expect(JSON.stringify(result.body)).not.toContain('PRIVATE_TRANSCRIPT');
  });
});

describe('overlay playback acknowledgements', () => {
  it('prepares once, follows the scheduled clock, and never restarts a completed ID', async () => {
    const fixture = engineFixture(), id = fixture.trigger('one'), request = await harness(fixture);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'prepared'))).status).toBe(204);
    expect(fixture.effects.some(effect => effect.type === 'playback.start')).toBe(true);
    const startAt = fixture.state.playbacks[0]!.startAt;
    fixture.advance(100);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'prepared'))).status).toBe(204);
    expect(fixture.state.playbacks[0]!.startAt).toBe(startAt); expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'started'))).status).toBe(409);
    fixture.advance(200);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'started'))).status).toBe(204);
    expect((await request('/state')).body).toMatchObject({active: {status: 'playing'}});
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'started'))).status).toBe(204);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'ended'))).status).toBe(204);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'started'))).status).toBe(404);
    expect((await request('/state')).body).toMatchObject({active: null}); expect(fixture.dispatch).toHaveBeenCalledTimes(3);
  });
  it('serializes simultaneous prepared acknowledgements without moving the start time', async () => {
    const fixture = engineFixture(), id = fixture.trigger('one'), request = await harness(fixture);
    const results = await Promise.all([request(`/recaps/${id}/ack`, ack(fixture, 'prepared')), request(`/recaps/${id}/ack`, ack(fixture, 'prepared'))]);
    expect(results.map(result => result.status)).toEqual([204, 204]); expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });
  it('marks a missed scheduled start skipped and hides it from reconnection', async () => {
    const fixture = engineFixture(), id = fixture.trigger('one'), request = await harness(fixture);
    await request(`/recaps/${id}/ack`, ack(fixture, 'prepared')); fixture.advance(3301);
    expect((await request('/state')).body).toMatchObject({active: null});
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'started'))).status).toBe(410);
    expect(fixture.state.playbacks).toHaveLength(0);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'prepared'))).status).toBe(404);
  });
  it('validates timestamps, status, JSON shape and CSRF before dispatch', async () => {
    const fixture = engineFixture(), id = fixture.trigger('one'); fixture.trigger('two'); const request = await harness(fixture);
    const invalidBodies = [
      {state: 'prepared', timestamp: 'not-a-date'},
      {state: 'prepared', timestamp: new Date(start - 30_001).toISOString()},
      {state: 'prepared', timestamp: fixture.clock.iso(), sessionId: 'other-stream'},
      {state: 'start', timestamp: fixture.clock.iso()},
    ];
    for (const body of invalidBodies) expect((await request(`/recaps/${id}/ack`, {method: 'POST', body})).status).toBe(400);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'ended'))).status).toBe(409);
    expect((await request('/recaps/playback:two/ack', ack(fixture, 'prepared'))).status).toBe(409);
    expect((await request(`/recaps/${id}/ack`, {...ack(fixture, 'prepared'), headers: {'X-CSRF-Token': 'invalid'}})).status).toBe(403);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it('never returns terminal playback bodies even if a storage implementation retains them', async () => {
    const fixture = engineFixture(), id = fixture.trigger('one'); fixture.state.playbacks[0]!.status = 'ended';
    const request = await harness(fixture); expect((await request(`/recaps/${id}`)).status).toBe(410);
    expect((await request(`/recaps/${id}/ack`, ack(fixture, 'prepared'))).status).toBe(410);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
