import {EventEmitter} from 'node:events';
import type WebSocket from 'ws';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine, type EngineOptions} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import {createTwitchRuntime} from '../../src/server/runtime/twitch-runtime.js';
import {TwitchEventSub, type EventSubOptions} from '../../src/server/twitch/eventsub.js';
import type {TwitchHelix} from '../../src/server/twitch/helix.js';
import {TWITCH_SCOPES} from '../../src/server/auth/index.js';

export class IntakeSocket extends EventEmitter {
  close() {this.emit('close');} terminate() {this.close();}
  wire(value: unknown) {this.emit('message', Buffer.from(JSON.stringify(value)));}
}
export const flushIntake = async () => {for (let i = 0; i < 3000; i++) await Promise.resolve();};
/** Actual transport/runtime/engine/storage with authored sockets, Helix and no paid providers. */
export async function chatIntakeFixture(options: {path?: string; onCommitted?: EngineOptions['onCommittedTransition']; now?: () => number; publicOrigin?: string; autoWelcome?: boolean; externalSocketFactory?: () => WebSocket} = {}) {
  const now = options.now ?? Date.now, at = new Date(now() - 60000).toISOString();
  const clock = {now, iso: () => new Date(now()).toISOString()};
  const scope = {channelId: '123', runId: 'live'}, channel = {id: '123', login: 'authored_batch', displayName: 'Authored batch'};
  const storage = createStorage({path: options.path ?? ':memory:', now, encryptionKey: Buffer.alloc(32, 7)});
  const updates = new RevisionStream();
  const safety = new SafetyService({classify: async () => ({decision: 'allow', spans: []})}, {moderate: async () => 'allowed'});
  const engine = new StoryEngine({scope, channel, storage, updates, safety, clock, story: {propose: async () => {throw new Error('No provider work in intake fixture');}}, onCommittedTransition: options.onCommitted});
  const settings = storage.repository.getSettings(scope); if (settings.listeningPaused) storage.repository.updateSettings(scope, settings.revision, {listeningPaused: false});
  storage.tokenVault!.put(scope, 'twitch', {accessToken: 'authored', refreshToken: 'authored', expiresAtMs: now() + 3600000, scopes: TWITCH_SCOPES});
  const sockets: IntakeSocket[] = [], states: string[] = []; let sends = 0, transport!: TwitchEventSub, transportOptions!: EventSubOptions;
  const helix = {subscribe: async () => {}, bannedUsers: async (page: (rows: unknown[]) => void) => page([]), currentStream: async () => ({id: 'batch', user_id: '123', started_at: at, title: '', game_name: ''}), previousClips: async () => [], sendChat: async () => {sends++; return {message_id: 'authored-outgoing', is_sent: true};}} as unknown as TwitchHelix;
  const runtime = createTwitchRuntime({scope, channel, storage, engine, updates, clock, helix,
    config: {origin: 'https://localhost:4317', publicOrigin: options.publicOrigin, sessionSecret: 's'.repeat(32), twitch: {clientId: 'authored-client', clientSecret: 'authored-secret', channelLogin: channel.login, redirectUri: 'https://localhost:4317/auth/twitch/callback', markerEnabled: false}},
    fetch: async url => {if (String(url) !== 'https://id.twitch.tv/oauth2/validate') throw new Error('Network prohibited'); return Response.json({client_id: 'authored-client', user_id: '123', scopes: TWITCH_SCOPES, expires_in: 3600});},
    eventSubFactory: input => {
      transportOptions = input;
      transport = new TwitchEventSub({...input, status: (state, detail) => {states.push(state); input.status?.(state, detail);}, socketFactory: () => {
        if(options.externalSocketFactory)return options.externalSocketFactory();
        const socket = new IntakeSocket(); sockets.push(socket);
        if(options.autoWelcome&&sockets.length>1)queueMicrotask(()=>socket.wire({metadata:{message_id:`welcome-${sockets.length}`,message_type:'session_welcome',message_timestamp:clock.iso()},payload:{session:{id:`session-${sockets.length}`,keepalive_timeout_seconds:60}}}));
        return socket as unknown as WebSocket;
      }});
      return transport;
    },
  });
  const welcome = async (socket = sockets.at(-1)!) => {
    socket.wire({metadata: {message_id: `welcome-${sockets.length}`, message_type: 'session_welcome', message_timestamp: clock.iso()}, payload: {session: {id: `session-${sockets.length}`, keepalive_timeout_seconds: 60}}});
    await flushIntake();
  };
  const wire = (id: string, kind = 'channel.chat.message', extra: Record<string, unknown> = {}) => ({metadata: {message_id: id, message_type: 'notification', message_timestamp: clock.iso()}, payload: {subscription: {type: kind, version: '1'}, event: {broadcaster_user_id: '123', chatter_user_id: '456', message_id: id, message: {text: `Authored source ${id}`}, ...extra}}});
  try {
    await runtime.start();
    if(options.externalSocketFactory){const deadline=Date.now()+15000;while(transport.status().state!=='active'){if(Date.now()>deadline)throw new Error('Authored WebSocket welcome timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
    else await welcome();
  }
  catch (error) {await runtime.stop(); updates.close(); storage.close(); throw error;}
  return {scope, storage, engine, runtime, transport, transportOptions, sockets, states, welcome, wire, sends: () => sends,
    close: async () => {await runtime.stop(); updates.close(); storage.close();},
  };
}
