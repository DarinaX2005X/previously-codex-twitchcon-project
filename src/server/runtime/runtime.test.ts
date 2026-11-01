import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApp, type AppOptions } from '../app.js';
import { createStorage } from '../storage/index.js';
import { loadConfig, readLocalEnvironment } from './config.js';
import { acquireInstanceLock } from './instance-lock.js';
import { csrfToken, type Principal } from './security.js';
import { RevisionStream } from './updates.js';
import { BoundedScheduler } from './scheduler.js';

const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const temp = () => {const path = mkdtempSync(join(tmpdir(), 'previously-runtime-')); directories.push(path); return path;};
afterEach(async () => {
  for (const server of servers.splice(0)) {server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));}
  for (const path of directories.splice(0)) rmSync(path, {recursive: true, force: true});
});
const principal: Principal = {role: 'owner', actorId: 'owner-1', channelId: 'channel-1', runId: 'live', sessionId: 'opaque-session', expiresAtMs: 100_000};
async function appRequest(options: Partial<AppOptions> = {}) {
  const config = loadConfig({SESSION_SECRET: 's'.repeat(32)}, temp());
  const app = createApp({config, status: {phase: 'ready', storage: 'ready', mode: 'local'}, now: () => 1000, ...options});
  const server = createServer(app); servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  return (path: string, init: RequestInit = {}) => new Promise<Response>((done, reject) => {
    const request = httpRequest({hostname: '127.0.0.1', port: address.port, path, method: init.method ?? 'GET', headers: {Host: 'localhost:4317', ...(init.headers as Record<string, string>)}}, response => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => done(new Response(Buffer.concat(chunks), {status: response.statusCode ?? 500})));
    });
    request.on('error', reject); request.end(typeof init.body === 'string' ? init.body : undefined);
  });
}

describe('safe configuration and instance ownership', () => {
  it('loads without providers and reports names, never secret values', () => {
    const config = loadConfig({OPENAI_API_KEY: 'private-api-value'}, temp());
    expect(config.missing).toContain('TWITCH_CHANNEL_LOGIN');
    expect(config.missing).not.toContain('OPENAI_API_KEY');
    expect(() => loadConfig({TOKEN_ENCRYPTION_KEY: 'never-display-this'}, temp())).toThrow('Invalid configuration: TOKEN_ENCRYPTION_KEY');
  });
  it('reads local environment without overriding process variables or rewriting the file', () => {
    const cwd = temp(); writeFileSync(join(cwd, '.env'), 'SESSION_SECRET=local-value\nOPENAI_API_KEY=local-key\n');
    expect(readLocalEnvironment(cwd, {OPENAI_API_KEY: 'process-value'})).toEqual({SESSION_SECRET: 'local-value', OPENAI_API_KEY: 'process-value'});
  });
  it('refuses a second writer and releases ownership repeatably', () => {
    const cwd = temp(), lock = acquireInstanceLock(cwd);
    expect(() => acquireInstanceLock(cwd, true)).toThrow('Another Previously instance');
    lock.release(); lock.release(); acquireInstanceLock(cwd).release();
  });
  it('requires explicit recovery for a proven stopped instance', () => {
    const cwd = temp(); writeFileSync(join(cwd, 'instance.lock'), JSON.stringify({pid: 2147483647, instanceId: 'old'}));
    expect(() => acquireInstanceLock(cwd)).toThrow('stopped instance left a lock');
    acquireInstanceLock(cwd, true).release();
  });
});

describe('HTTP security and truthful setup', () => {
  it('serves minimal health and safe incomplete setup', async () => {
    const request = await appRequest();
    expect(await (await request('/health')).json()).toEqual({alive: true});
    const setup = await (await request('/api/setup/status')).json();
    expect(setup.configured).toBe(false); expect(setup.twitch.connected).toBe(false); expect(setup.openai.paidCallsEnabled).toBe(false);
    expect(setup.missing).toContain('TWITCH_CHANNEL_LOGIN'); expect(JSON.stringify(setup)).not.toContain('ssssssss');
    expect((await request('/ready')).status).toBe(200);
  });
  it('distinguishes migration from readiness', async () => {
    const request = await appRequest({status: {phase: 'migration', storage: 'unavailable', mode: 'local'}});
    expect((await request('/ready')).status).toBe(503);
  });
  it('fails closed for owner and overlay without a verified session', async () => {
    const request = await appRequest();
    expect((await request('/api/owner/bootstrap')).status).toBe(401);
    expect((await request('/api/overlay/state')).status).toBe(401);
  });
  it('rejects hostile host, cross-origin reads and missing mutation origin', async () => {
    const request = await appRequest();
    expect((await request('/health', {headers: {Host: 'hostile.example'}})).status).toBe(403);
    expect((await request('/api/setup/status', {headers: {Origin: 'https://hostile.example'}})).status).toBe(403);
    expect((await request('/api/owner/settings', {method: 'POST'})).status).toBe(403);
  });
  it('permits a top-level OAuth return to reach the auth adapter, while keeping other cross-site routes closed', async () => {
    const router = express.Router(); router.get('/auth/twitch/callback', (_req, res) => {res.status(400).json({error: {code: 'oauth_state_required'}});});
    const request = await appRequest({routers: {auth: router}});
    const headers = {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate'};
    expect((await request('/auth/twitch/callback', {headers})).status).toBe(400);
    expect((await request('/api/setup/status', {headers})).status).toBe(403);
  });
  it('requires valid role, CSRF and idempotency on owner mutations', async () => {
    const router = express.Router(); router.post('/change', (_req, res) => {res.json({saved: true});});
    const request = await appRequest({auth: {authenticate: () => principal}, routers: {owner: router}});
    const headers = {Origin: 'https://localhost:4317', 'Content-Type': 'application/json', 'Idempotency-Key': 'test-change-1'};
    expect((await request('/api/owner/change', {method: 'POST', headers, body: '{}'})).status).toBe(403);
    expect((await request('/api/owner/change', {method: 'POST', headers: {...headers, 'X-CSRF-Token': csrfToken('s'.repeat(32), principal.sessionId)}, body: '{}'})).status).toBe(200);
    const wrongRole = await appRequest({auth: {authenticate: () => ({...principal, role: 'overlay'})}});
    expect((await wrongRole('/api/owner/bootstrap')).status).toBe(403);
  });
  it('returns safe errors for malformed JSON, oversized bodies and unknown routes', async () => {
    const request = await appRequest();
    const headers = {Origin: 'https://localhost:4317', 'Content-Type': 'application/json'};
    const malformed = await request('/unknown', {method: 'POST', headers, body: '{private-secret'});
    expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain('private-secret');
    expect((await request('/unknown', {method: 'POST', headers, body: JSON.stringify({text: 'x'.repeat(70_000)})})).status).toBe(413);
    expect((await request('/api/nonexistent')).status).toBe(404);
  });
});

describe('bounded identifiers-only updates', () => {
  it('resets expired cursors, bounds history, and isolates channel/run', () => {
    const stream = new RevisionStream(2);
    for (let revision = 1; revision <= 3; revision++) stream.publish({channelId: principal.channelId, runId: 'live', event: 'privacy.invalidated', data: {sessionId: 'session-1', revision, affectedIds: ['source-1']}});
    expect(stream.catchUp(principal, 1)).toEqual({reset: true, records: []});
    expect(stream.catchUp(principal, 2).records.map(record => record.data.revision)).toEqual([3]);
    expect(stream.catchUp({...principal, channelId: 'other'}, 2)).toEqual({reset: true, records: []});
    expect(stream.catchUp({...principal, runId: 'demo'}, 2)).toEqual({reset: true, records: []});
  });
  it('refuses text fields instead of retaining deleted content in the event ring', () => {
    const stream = new RevisionStream();
    expect(() => stream.publish({channelId: 'c', runId: 'live', event: 'snapshot.changed', data: {sessionId: 's', revision: 1, text: 'private'}} as never)).toThrow();
  });
  it('assigns distinct transport cursors to events sharing a publication revision', () => {
    const stream = new RevisionStream();
    stream.publish({channelId: principal.channelId, runId: 'live', event: 'privacy.invalidated', data: {sessionId: null, revision: 4}});
    stream.publish({channelId: principal.channelId, runId: 'live', event: 'snapshot.changed', data: {sessionId: null, revision: 4}});
    const replay = stream.catchUp(principal, 1);
    expect(replay.records.map(event => [event.id, event.data.revision])).toEqual([[2, 4]]);
  });
});

describe('durable bounded scheduler', () => {
  it('requeues interrupted read-only owner review work on shutdown', async () => {
    const store = createStorage({path: join(temp(), 'review.sqlite'), now: () => 1000});
    const scope = {channelId: 'c', runId: 'live'};
    store.repository.ensureChannel(scope, 'channel'); store.repository.createSession(scope, {id: 's', startedAt: '2026-01-01T00:00:00.000Z'});
    store.repository.enqueueJob(scope, {id: 'review', sessionId: 's', kind: 'owner.review', businessKey: 'review-once', payload: {}});
    const scheduler = new BoundedScheduler(store.repository, [{scope, kinds: ['owner.review'], concurrency: 1, retryOnShutdown: true, execute: async (_job, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true})); return {state: 'done'};
    }}], undefined, () => 1000);
    scheduler.tick(); await Promise.resolve(); await scheduler.stop(1); await Promise.resolve();
    expect(store.repository.claimJob(scope, {kinds: ['owner.review']})?.id).toBe('review');
    store.close();
  });
  it('runs only lane capacity and leaves undispatched accepted jobs durable on shutdown', async () => {
    const store = createStorage({path: join(temp(), 'test.sqlite'), now: () => 1000});
    const scope = {channelId: 'c', runId: 'live'};
    store.repository.ensureChannel(scope, 'channel'); store.repository.createSession(scope, {id: 's', startedAt: '2026-01-01T00:00:00.000Z'});
    for (let i = 0; i < 3; i++) store.repository.enqueueJob(scope, {id: `j${i}`, sessionId: 's', kind: 'story', businessKey: `work-${i}`, payload: {}});
    let invoked = 0;
    const scheduler = new BoundedScheduler(store.repository, [{scope, kinds: ['story'], concurrency: 1, execute: async (_job, signal) => {
      invoked++; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true})); return {state: 'done'};
    }}]);
    scheduler.tick(); await Promise.resolve(); scheduler.tick(); expect(invoked).toBe(1);
    await scheduler.stop(1); await Promise.resolve();
    const next = store.repository.claimJob(scope, {kinds: ['story']}); expect(next).not.toBeNull(); expect(next?.id).not.toBe('j0');
    store.close();
  });
});
