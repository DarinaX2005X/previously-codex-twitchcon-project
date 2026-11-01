// Authored acceptance subprocess: every Twitch and media method below is a deterministic fixture.
// This file never reads .env, tokens or a live channel configuration.
import {createStorage} from '../../src/server/storage/index.js';
import {bindControlStore} from '../../src/server/auth/control.js';
import {TwitchEffects, type EffectContext} from '../../src/server/twitch/effects.js';
import type {TwitchHelix, TwitchClip} from '../../src/server/twitch/helix.js';

const [path, phase] = process.argv.slice(2);
if (!path || !['enqueue', 'recover'].includes(phase)) throw new Error('Expected an isolated SQLite path and enqueue|recover');
globalThis.fetch = async () => {throw new Error('Network prohibited in authored outbox acceptance');};
const now = phase === 'enqueue' ? 100000 : 101000;
const scope = {channelId: '123', runId: 'live'};
const storage = createStorage({path, now: () => now});
const context: EffectContext = {sessionId: 'authored-episode', privacyEpoch: 0, dependencyRefs: [], captureStartMs: 0, captureEndMs: 90000};
const clip: TwitchClip = {id: 'authored-clip', broadcaster_id: '123', creator_id: '123', created_at: '2026-11-02T00:00:00Z', duration: 12, video_id: '', vod_offset: null, url: 'https://clips.twitch.tv/authored-clip', embed_url: 'https://clips.twitch.tv/embed?clip=authored-clip', title: 'Authored acceptance'};
let sends = 0, creates = 0, polls = 0, prepares = 0;
const clipStates: string[] = [];
try {
  storage.repository.ensureChannel(scope, 'authored_outbox');
  if (phase === 'enqueue') storage.repository.createSession(scope, {id: context.sessionId, startedAt: '2026-11-02T00:00:00Z'});
  const service = new TwitchEffects({scope, repository: storage.repository, control: bindControlStore(storage.repository, scope), now: () => now, allowed: () => true,
    helix: {
      sendChat: async () => {sends++; return {message_id: 'authored-outgoing', is_sent: true};},
      createClip: async () => {creates++; return {id: clip.id, edit_url: clip.url + '/edit'};},
      getClip: async () => {polls++; return clip;}, downloadUrl: async () => 'https://authored.invalid/fixture.mp4',
    } as unknown as TwitchHelix,
    prepareMedia: async () => {prepares++;}, onClip: value => {clipStates.push(value.status);},
  });
  const chat = service.enqueueChat({...context, key: 'authored-command-id', actorId: '456', message: 'Authored safe recap'});
  service.enqueueClip({...context, key: 'authored-moment-id', auto: false, autoEnabled: false});
  await service.tick(); await service.tick(); await service.tick();
  process.stdout.write(JSON.stringify({phase, pid: process.pid, chat, sends, creates, polls, prepares, clipStates, ownEcho: service.isOwnEcho('authored-outgoing'), pendingPolls: storage.repository.pendingJobCount(scope, context.sessionId, ['clip.poll']), paidMicroUsd: storage.budget.status().usedMicroUsd}));
} finally {storage.close();}
