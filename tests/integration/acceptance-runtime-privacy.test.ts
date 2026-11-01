import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import type WebSocket from 'ws';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {createTwitchRuntime} from '../../src/server/runtime/twitch-runtime.js';
import {TwitchEventSub} from '../../src/server/twitch/eventsub.js';
import type {TwitchHelix} from '../../src/server/twitch/helix.js';
import {TWITCH_SCOPES} from '../../src/server/auth/index.js';

class Socket extends EventEmitter {close() {this.emit('close');} terminate() {this.close();} wire(value: unknown) {this.emit('message', Buffer.from(JSON.stringify(value)));}}
const flush = async () => {for (let i = 0; i < 3000; i++) await Promise.resolve();};
it('real runtime privacy callback fires before failed SQLite status persistence and recovery applies the deletion', async () => {
  vi.useFakeTimers();
  const now = Date.parse('2026-11-02T00:01:00Z'), at = new Date(now).toISOString();
  const scope = {channelId: '123', runId: 'live'}, channel = {id: '123', login: 'authored_acceptance', displayName: 'Authored acceptance'};
  const clock = {now: () => now, iso: () => at};
  const storage = createStorage({path: ':memory:', now: clock.now, encryptionKey: Buffer.alloc(32, 7)});
  const updates = new RevisionStream();
  const safety = new SafetyService({classify: async () => ({decision: 'allow', spans: []})}, {moderate: async () => 'allowed'});
  const engine = new StoryEngine({scope, channel, storage, updates, safety, clock, story: {propose: async () => {throw new Error('No provider calls');}}});
  storage.repository.updateSettings(scope, 0, {listeningPaused: false});
  storage.tokenVault!.put(scope, 'twitch', {accessToken: 'authored', refreshToken: 'authored', expiresAtMs: now + 3600000, scopes: TWITCH_SCOPES});
  const sockets: Socket[] = [], gates: boolean[] = [], writes: string[] = [];
  const helix = {subscribe: async () => {}, bannedUsers: async (page: (users: unknown[]) => void) => page([]), currentStream: async () => ({id: 'fixture', user_id: '123', started_at: '2026-11-02T00:00:00Z', title: '', game_name: ''}), previousClips: async () => []} as unknown as TwitchHelix;
  let transport!: TwitchEventSub, failWrites = false;
  const put = storage.repository.controlPut.bind(storage.repository);
  const spy = vi.spyOn(storage.repository, 'controlPut').mockImplementation((s, key, value, expires) => {
    if (failWrites) {writes.push(key); if (key.startsWith('eventsub:privacy:') || key === 'ban:snapshot' || key === 'twitch:gap') throw new Error('Authored disk full');}
    return put(s, key, value, expires);
  });
  const runtime = createTwitchRuntime({scope, channel, storage, engine, updates, clock, helix,
    config: {origin: 'https://localhost:4317', publicOrigin: undefined, sessionSecret: 's'.repeat(32), twitch: {clientId: 'authored-client', clientSecret: 'authored-secret', channelLogin: channel.login, redirectUri: 'https://localhost:4317/auth/twitch/callback'}},
    fetch: async url => {if (String(url) !== 'https://id.twitch.tv/oauth2/validate') throw new Error('Unexpected network'); return Response.json({client_id: 'authored-client', user_id: '123', scopes: TWITCH_SCOPES, expires_in: 3600});},
    onPrivacyBlocked: blocked => {gates.push(blocked); if (blocked) expect(writes).not.toContain('ban:snapshot');},
    eventSubFactory: options => {transport = new TwitchEventSub({...options, socketFactory: () => {const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;}}); return transport;},
  });
  try {
    await runtime.start();
    const welcome = (socket: Socket, id: string) => socket.wire({metadata: {message_id: `welcome-${id}`, message_type: 'session_welcome', message_timestamp: at}, payload: {session: {id, keepalive_timeout_seconds: 10}}});
    welcome(sockets[0], 'first'); await flush(); expect(runtime.status().connection.quotesReady).toBe(true);
    await runtime.ingest({...scope, schemaVersion: 1, eventId: 'authored-source', externalId: 'authored-source', origin: 'twitch', kind: 'channel.chat.message', occurredAt: at, receivedAt: at, sessionId: 'stream_fixture', sessionOffsetMs: 60000, payload: {message_id: 'to-delete', chatter_user_id: '456', message: {text: 'Authored source that must disappear.'}, quotesReady: true}});
    expect(storage.repository.getSource(scope, 'chat:to-delete')?.text).toBeTruthy();
    // Persisted marker from a process interrupted inside the runtime callback, before its domain deletion ACK.
    const interruptedKey = `twitch:ingest:${createHash('sha256').update(JSON.stringify('delete-with-disk-full')).digest('hex')}`;
    storage.repository.controlPut(scope, interruptedKey, 'processing');
    failWrites = true;
    sockets[0].wire({metadata: {message_id: 'delete-with-disk-full', message_type: 'notification', message_timestamp: at}, payload: {subscription: {type: 'channel.chat.message_delete', version: '1'}, event: {broadcaster_user_id: '123', message_id: 'to-delete'}}});
    await flush();
    expect(gates).toEqual([true]); expect(runtime.privacyBlocked()).toBe(true); expect(transport.status()).toMatchObject({state: 'gap', quotesReady: false, privacyBlocked: true});
    expect(sockets[0].listenerCount('message')).toBe(0); expect(writes).toContain('ban:snapshot');
    await vi.advanceTimersByTimeAsync(7000); expect(sockets).toHaveLength(1);
    failWrites = false; await vi.advanceTimersByTimeAsync(8000); await flush();
    expect(storage.repository.getSource(scope, 'chat:to-delete')?.text).toBeNull(); expect(gates).toEqual([true, false]); expect(runtime.privacyBlocked()).toBe(false);
    expect(storage.repository.controlGet(scope, interruptedKey)).toBe('done');
    welcome(sockets[1], 'second'); await flush(); expect(runtime.status().connection.quotesReady).toBe(true);
  } finally {failWrites = false; await runtime.stop(); spy.mockRestore(); updates.close(); storage.close(); vi.useRealTimers();}
});
