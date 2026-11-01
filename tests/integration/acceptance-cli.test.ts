import {describe, it, expect} from 'vitest';
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {TwitchEventSub, type ConnectionState} from '../../src/server/twitch/eventsub.js';
import {TwitchHelix} from '../../src/server/twitch/helix.js';
import {bindControlStore} from '../../src/server/auth/control.js';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import type {EventEnvelope} from '../../src/shared/contracts/index.js';

const exec = promisify(execFile);
async function until(test: () => boolean, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!test()) {if (Date.now() > end) throw new Error('Acceptance condition timed out'); await new Promise(resolve => setTimeout(resolve, 25));}
}
async function freePort(requested = 0) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(requested, '127.0.0.1', resolve);});
  const port = (server.address() as {port: number}).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited;
}

describe.skipIf(!process.env.TWITCH_CLI_PATH)('acceptance: official CLI mock to durable playback', () => {
  it('deduplicates a captured CLI raid through restart, migrates without resubscribing, and recovers real keepalive/close/server gaps', async () => {
    await freePort(44747); const port = await freePort();
    const executable = process.env.TWITCH_CLI_PATH!;
    const directory = mkdtempSync(join(tmpdir(), 'previously-cli-acceptance-'));
    const scope = {channelId: '123', runId: 'acceptance-cli'};
    const channel = {id: '123', login: 'authored_cli', displayName: 'Authored CLI'};
    const clock = {now: Date.now, iso: () => new Date().toISOString()};
    const startedAt = new Date(Date.now() - 60000).toISOString();
    const path = join(directory, 'state.sqlite');
    let storage = createStorage({path});
    const updates = new RevisionStream();
    const safety = new SafetyService({classify: async () => ({decision: 'allow', spans: []})}, {moderate: async () => 'allowed'});
    const engineFactory = () => new StoryEngine({scope, channel, storage, clock, updates, safety, story: {propose: async () => {throw new Error('No provider calls in CLI acceptance');}}});
    let engine = engineFactory(); storage.repository.createSession(scope, {id: 'episode', startedAt});
    storage.repository.updateSettings(scope, 0, {listeningPaused: false});
    const received: EventEnvelope[] = [], states: {state: ConnectionState; reason?: string; quotesReady: boolean; gapSince: string | null}[] = [];
    let subscriptions = 0, sessionId = '', currentSocket: WebSocket, raidWire: Buffer | undefined;
    let output = '', child: ChildProcess | undefined;
    const cli = (...args: string[]) => exec(executable, args, {windowsHide: true, timeout: 10000});
    const startServer = async () => {
      output = '';
      child = spawn(executable, ['event', 'websocket', 'start-server', '--ip=127.0.0.1', `--port=${port}`, '--require-subscription'], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      child.stdout!.on('data', value => {output += value;}); child.stderr!.on('data', value => {output += value;});
      await until(() => /Listening|listening|WebSocket server/.test(output), 5000);
    };
    const helix = new TwitchHelix('123', {authorizedFetch: async (url, init) => {
      if (url.includes('/eventsub/subscriptions')) {
        subscriptions++;
        // Official CLI 1.1.24 cannot create these newer subscriptions. They are fixture-covered separately.
        if (JSON.parse(String(init?.body)).type.startsWith('channel.chat.')) return Response.json({data: []}, {status: 202});
        return fetch(`http://127.0.0.1:${port}/eventsub/subscriptions`, {...init, headers: {'Client-Id': 'acceptance-cli', Authorization: 'Bearer mock', 'Content-Type': 'application/json'}});
      }
      if (url.includes('/streams?')) return Response.json({data: []});
      if (url.includes('/moderation/banned?')) return Response.json({data: [], pagination: {}});
      throw new Error(`Unexpected request outside CLI subscription boundary`);
    }});
    const makeService = () => new TwitchEventSub({channelId: scope.channelId, runId: scope.runId, mock: true, url: `ws://127.0.0.1:${port}/ws`, helix, control: bindControlStore(storage.repository, scope),
      ingest: async event => {received.push(event); await engine.ingest(event);}, resolveSession: () => ({id: 'episode', startedAt}), onStream: () => {},
      bans: {begin: () => {}, page: () => {}, finish: () => {}}, status: (state, detail) => states.push({state, ...detail}),
      socketFactory: url => {
        const socket = new WebSocket(url); currentSocket = socket;
        socket.on('message', raw => {
          const value = JSON.parse(raw.toString());
          if (value.metadata.message_type === 'session_welcome') sessionId = value.payload.session.id;
          if (value.metadata.message_type === 'notification' && value.payload.subscription?.type === 'channel.raid') raidWire ??= Buffer.from(raw.toString());
        });
        return socket;
      },
    });
    let service = makeService();
    try {
      await startServer(); await service.start(); await until(() => service.status().state === 'active');
      await cli('event', 'trigger', 'channel.raid', '--transport=websocket', '--from-user=456', '--to-user=123', '--no-config');
      await until(() => engine.state('episode').playbacks.length === 1);
      const first = engine.state('episode').playbacks[0];
      expect(first.status).toBe('preparing'); expect(first.plan!.arrivals).toMatchObject([{viewers: (received[0].payload as {viewers: number}).viewers}]);
      expect(received[0].origin).toBe('mock'); expect(received[0].runId).toBe(scope.runId);
      // This is exact-byte redelivery of a CLI-produced frame at the client boundary, not a CLI-generated duplicate.
      currentSocket!.emit('message', raidWire!); await new Promise(resolve => setTimeout(resolve, 100));
      expect(received).toHaveLength(1); expect(engine.state('episode').playbacks).toHaveLength(1);
      expect(subscriptions).toBe(10);
      const previousSession = sessionId;
      await cli('event', 'websocket', 'reconnect');
      await until(() => sessionId !== previousSession && service.status().state === 'active');
      expect(subscriptions).toBe(10); expect(states.some(item => item.state === 'reconnecting')).toBe(true);
      // CLI rejects other control RPCs for 30 seconds during migration. Restart its process to test a separate hard gap.
      await stop(child!); await until(() => service.status().state === 'gap');
      await startServer(); await until(() => service.status().state === 'active'); expect(subscriptions).toBe(20);
      const beforeKeepalive = states.length;
      await cli('event', 'websocket', 'keepalive', `--session=${sessionId}`, '--enabled=false');
      await until(() => states.slice(beforeKeepalive).some(item => item.reason === 'keepalive_timeout'), 25000);
      expect(states.slice(beforeKeepalive).find(item => item.state === 'gap')).toMatchObject({quotesReady: false});
      await until(() => service.status().state === 'active'); expect(subscriptions).toBe(30); expect(service.status().gapSince).not.toBeNull();
      const beforeClose = states.length;
      await cli('event', 'websocket', 'close', `--session=${sessionId}`, '--reason=4006');
      await until(() => states.slice(beforeClose).some(item => item.state === 'gap'));
      await until(() => service.status().state === 'active'); expect(subscriptions).toBe(40);
      await service.stop(); storage.close(); storage = createStorage({path}); engine = engineFactory(); service = makeService();
      await service.start(); await until(() => service.status().state === 'active');
      currentSocket!.emit('message', raidWire!); await new Promise(resolve => setTimeout(resolve, 100));
      expect(received).toHaveLength(1); expect(engine.state('episode').playbacks).toHaveLength(1);
      expect(engine.state('episode').playbacks[0].id).toBe(first.id);
      expect(storage.budget.status().usedMicroUsd).toBe(0);
    } catch (error) {throw new Error(`${String(error)}; states=${JSON.stringify(states)}; subscriptions=${subscriptions}; CLI=${output.slice(-5000)}`);}
    finally {await service.stop(); if (child) await stop(child); updates.close(); storage.close(); rmSync(directory, {recursive: true, force: true});}
  }, 60000);
});
