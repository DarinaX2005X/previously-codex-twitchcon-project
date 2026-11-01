import {EventEmitter} from 'node:events';
import {afterEach, expect, it, vi} from 'vitest';
import type WebSocket from 'ws';
import {TwitchEventSub} from '../../src/server/twitch/eventsub.js';
import type {TwitchHelix} from '../../src/server/twitch/helix.js';
import {memoryControl} from '../auth/helpers.js';
const at = '2026-11-02T00:00:00Z';
class Socket extends EventEmitter {close() {this.emit('close');} terminate() {this.close();} wire(value: unknown) {this.emit('message', Buffer.from(JSON.stringify(value)));}}
const flush = async () => {for (let i = 0; i < 3000; i++) await Promise.resolve();};
const event = (id: string) => ({metadata: {message_id: id, message_type: 'notification', message_timestamp: at}, payload: {subscription: {type: 'channel.chat.message_delete', version: '1'}, event: {broadcaster_user_id: '123', message_id: `message-${id}`, reason: 'PRIVATE_REASON', message: {text: 'PRIVATE_CHAT'}}}});
afterEach(() => vi.useRealTimers());

it('privacy-only bursts use bounded durable pages and retain every received deletion', async () => {
  const control = memoryControl(), socket = new Socket(), received: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const service = new TwitchEventSub({channelId: '123', runId: 'live', mock: true, control, now: () => Date.parse(at), helix: {subscribe: async () => {}, bannedUsers: async () => {}, currentStream: async () => null} as unknown as TwitchHelix,
    ingest: async value => {received.push(value.externalId); if (value.externalId === '0') await blocked;}, onStream: () => {}, resolveSession: () => ({id: 'episode', startedAt: at}), bans: {begin: () => {}, page: () => {}, finish: () => {}}, socketFactory: () => socket as unknown as WebSocket});
  try {
    await service.start(); socket.wire(event('0')); await flush();
    for (let i = 1; i < 150; i++) socket.wire(event(String(i)));
    for (let n = 0; n < 10; n++) {
      const page = control.get<unknown[]>(`eventsub:privacy:page:${n}`); if (!page) continue;
      expect(page.length).toBeLessThanOrEqual(16); expect(JSON.stringify(page)).not.toContain('PRIVATE_');
    }
    release(); await flush(); expect(received).toEqual(Array.from({length: 150}, (_, i) => String(i)));
  } finally {release(); await service.stop();}
});

it('a failed inbox write retains its control and cannot reconnect quote-ready before storage recovers', async () => {
  vi.useFakeTimers(); const stored = memoryControl(), sockets: Socket[] = [], received: string[] = [];
  let writesFail = true;
  const control = {...stored, put: (...args: Parameters<typeof stored.put>) => {if (writesFail && args[0].startsWith('eventsub:privacy:')) throw new Error('Authored storage failure'); stored.put(...args);}};
  const service = new TwitchEventSub({channelId: '123', runId: 'live', mock: true, control, helix: {subscribe: async () => {}, bannedUsers: async () => {}, currentStream: async () => null} as unknown as TwitchHelix,
    status: state => {if (state === 'gap') control.put('eventsub:privacy:status', {state});},
    ingest: value => {received.push(value.externalId);}, onStream: () => {}, resolveSession: () => ({id: 'episode', startedAt: at}), bans: {begin: () => {}, page: () => {}, finish: () => {}}, socketFactory: () => {const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;}});
  try {
    await service.start(); sockets[0].wire(event('failed-write')); await flush();
    expect(service.status()).toMatchObject({state: 'gap', quotesReady: false, privacyBlocked: true});
    expect(sockets[0].listenerCount('message')).toBe(0);
    // The failed frame is retained; the synchronously detached receiver accepts no additional buffered callbacks.
    for (let i = 0; i < 200; i++) sockets[0].wire(event(`after-close-${i}`));
    await vi.advanceTimersByTimeAsync(1000); expect(sockets).toHaveLength(1); expect(received).toHaveLength(0);
    writesFail = false; await vi.advanceTimersByTimeAsync(2000); await flush();
    expect(received).toEqual(['failed-write']); expect(sockets).toHaveLength(2);
    expect(service.status().privacyBlocked).toBe(false);
    expect(service.status().quotesReady).toBe(false); // No welcome/subscriptions yet.
  } finally {await service.stop();}
});
