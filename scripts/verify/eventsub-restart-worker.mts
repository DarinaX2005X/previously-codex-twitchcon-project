// Authored wire fixture and deliberate process crash. No network or real Twitch session.
import {EventEmitter} from 'node:events';
import type WebSocket from 'ws';
import {createStorage} from '../../src/server/storage/index.js';
import {bindControlStore} from '../../src/server/auth/control.js';
import {TwitchEventSub} from '../../src/server/twitch/eventsub.js';
import type {TwitchHelix} from '../../src/server/twitch/helix.js';
const [path, phase] = process.argv.slice(2);
if (!path || !['crash', 'recover'].includes(phase)) throw new Error('Expected isolated SQLite path and crash|recover');
globalThis.fetch = async () => {throw new Error('Network prohibited');};
const scope = {channelId: '123', runId: 'live'}, at = '2026-11-02T00:00:00Z';
const storage = createStorage({path}); storage.repository.ensureChannel(scope, 'authored_restart');
const control = bindControlStore(storage.repository, scope), received: string[] = [];
class Socket extends EventEmitter {close() {this.emit('close');} terminate() {this.close();} wire(value: unknown) {this.emit('message', Buffer.from(JSON.stringify(value)));}}
const socket = new Socket(); let entered!: () => void;
const blocked = new Promise<void>(resolve => {entered = resolve;});
const service = new TwitchEventSub({...scope, mock: true, control, helix: {subscribe: async () => {}, bannedUsers: async () => {}, currentStream: async () => null} as unknown as TwitchHelix,
  ingest: async value => {received.push(value.externalId); if (phase === 'crash') {entered(); await new Promise<void>(() => {});}}, resolveSession: () => ({id: 'episode', startedAt: at}), onStream: () => {}, bans: {begin: () => {}, page: () => {}, finish: () => {}}, socketFactory: () => socket as unknown as WebSocket});
await service.start();
if (phase === 'crash') {
  for (let i = 0; i < 3; i++) socket.wire({metadata: {message_id: `durable-${i}`, message_type: 'notification', message_timestamp: at}, payload: {subscription: {type: 'channel.chat.message_delete', version: '1'}, event: {broadcaster_user_id: '123', message_id: `private-${i}`}}});
  await blocked;
  process.stdout.write(JSON.stringify({pid: process.pid, phase, started: received, pending: control.get<unknown[]>('eventsub:privacy:page:0')?.length, claim: control.get('eventsub:durable-0')}));
  // SQLite controls have committed, but the first downstream ingest has not returned and no graceful stop runs.
  process.exit(0);
}
process.stdout.write(JSON.stringify({pid: process.pid, phase, received, pending: control.get<unknown[]>('eventsub:privacy:page:0')?.length, claim: control.get('eventsub:durable-0')}));
await service.stop(); storage.close();
