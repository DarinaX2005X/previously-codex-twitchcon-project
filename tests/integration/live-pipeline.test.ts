import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import {createStorage} from '../../src/server/storage/index.js';
import {AudioIntakeService, encodeWav} from '../../src/server/audio/index.js';
import {SafetyService} from '../../src/server/providers/safety.js';
import type {OpenAIStoryProvider} from '../../src/server/providers/story.js';
import {PrivateMediaCache} from '../../src/server/media/cache.js';
import {createMediaRouter} from '../../src/server/media/router.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {createCloudRuntime, type CloudRuntime} from '../../src/server/runtime/cloud-runtime.js';
import {createCloudHandler} from '../../src/cloud/http.js';
import {createPublicationService} from '../../src/cloud/service.js';
import {MemoryBlobStore} from '../publication/helpers.js';
import {apiErrorHandler} from '../../src/server/runtime/errors.js';
import type {StoryProvider, StoryPatch} from '../../src/shared/contracts/index.js';
import type {Principal} from '../../src/server/runtime/security.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {for (const action of cleanup.splice(0).reverse()) await action();});

describe('authored WAV through the assembled live pipeline', () => {
  it('holds a real accepted WAV, publishes grounded bilingual text, then revokes its public and local derivatives', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'previously-pipeline-'));
    cleanup.push(() => rmSync(directory, {recursive: true, force: true}));
    const start = Date.parse('2026-11-02T00:00:00.000Z'); let now = start;
    const clock = {now: () => now, iso: () => new Date(now).toISOString()};
    const scope = {channelId: '123456', runId: 'live'}, channel = {id: scope.channelId, login: 'authored_fixture', displayName: 'Authored fixture'};
    const storage = createStorage({path: join(directory, 'state.sqlite'), now: clock.now}); cleanup.push(storage.close);
    const updates = new RevisionStream(); cleanup.push(() => updates.close());
    const safety = new SafetyService({classify: async () => ({decision: 'allow', spans: []})}, {moderate: async () => 'allowed'}, clock.now);
    const propose = vi.fn<StoryProvider['propose']>(async (packet, ticket) => {
      const source = packet.sources[0];
      const value: StoryPatch = {sessionId: ticket.sessionId, baseRevision: ticket.baseEntityRevision, action: 'new_chapter', title: 'Testing the saved note', claims: [
        {id: 'title', text: 'The note disappeared after a reload.', role: 'state', support: [{id: source.id, revision: source.revision}], attribution: 'streamer', epistemic: 'explicit'},
      ], relations: [], currentAttemptId: null, language: 'en', missingContext: []};
      return {value, model: 'authored', requestId: 'authored', usage: {chargedMicroUsd: 0}};
    });
    const present = vi.fn<OpenAIStoryProvider['present']>(async (claims, input) => {
      expect(claims[0].id).toMatch(/^claim:/);
      expect(input.claimRefs).toEqual([{id: claims[0].id, revision: 1}]);
      const make = (language: 'en'|'ru') => ({id: `${input.entityId}:${language}`, entityId: input.entityId, revision: input.revision, language, title: language === 'en' ? 'Testing the saved note' : 'Проверка сохранения заметки', summary: language === 'en' ? claims[0].text : 'После перезагрузки заметка исчезла.', claimRefs: input.claimRefs!, safety: {moderation: 'allowed' as const, pii: 'allowed' as const, checkedAt: clock.iso(), reason: null}, eligibleAt: input.eligibleAt, current: {goal: null, change: null, now: language === 'en' ? claims[0].text : 'После перезагрузки заметка исчезла.'}});
      return {en: make('en'), ru: make('ru')};
    });
    let cloud: CloudRuntime | undefined;
    const engine = new StoryEngine({scope, channel, storage, clock, updates, safety, story: {propose, present}, onEffects: (...args) => cloud?.onEffects(...args)});
    storage.repository.createSession(scope, {id: 'stream_fixture', startedAt: new Date(start).toISOString()});
    storage.repository.updateSettings(scope, 0, {listeningPaused: false});
    const cloudService = createPublicationService({store: new MemoryBlobStore(), channelLogin: channel.login, now: clock.now});
    const handler = createCloudHandler({service: cloudService, secret: 's'.repeat(32), channelLogin: channel.login, now: clock.now});
    cloud = createCloudRuntime({scope, channel, engine, storage, clock, publicOrigin: 'https://authored-cloud.test', sharedSecret: 's'.repeat(32), fetch: async (input, init) => handler(new Request(input, init))}); cleanup.push(() => cloud!.close());
    const audio = new AudioIntakeService({repository: storage.repository, secret: 's'.repeat(32), directory: join(directory, 'raw'), safety, now: clock.now,
      transcription: {transcribe: async () => ({value: {text: 'The note disappeared after a reload.', languageCodes: ['en'], confidence: null}, model: 'authored', requestId: 'authored', usage: {chargedMicroUsd: 0}})},
      onSource: source => engine.drain(source.sessionId),
    });
    const principal: Principal = {...scope, role: 'owner', actorId: scope.channelId, sessionId: 'owner-cookie', expiresAtMs: start + 1_000_000};
    let lease = audio.acquire(principal, {sessionId: 'stream_fixture', browserId: 'fixture-browser'});
    const bytes = encodeWav(new Float32Array(20 * 8000).fill(0.1), 8000);
    now += 10_000; lease = audio.renew(principal, lease.token, 'fixture-browser');
    now += 10_000; lease = audio.renew(principal, lease.token, 'fixture-browser');
    const accepted = await audio.accept(principal, {sessionId: 'stream_fixture', leaseEpoch: lease.epoch, captureEpoch: lease.captureEpoch, sequence: 0, startMs: 0, endMs: 20_000, sampleRate: 8000, sha256: createHash('sha256').update(bytes).digest('hex'), token: lease.token, browserId: 'fixture-browser'}, bytes);
    const stt = storage.repository.claimJob(scope, {kinds: ['stt']})!;
    expect(await audio.execute(scope, stt, new AbortController().signal)).toEqual({state: 'done'});
    storage.repository.finishJob(scope, stt.id, stt.leaseToken, 'done');
    const generation = storage.repository.claimJob(scope, {kinds: ['story']})!;
    expect(generation).toBeTruthy();
    expect(await engine.executeStory(generation, new AbortController().signal)).toEqual({state: 'done'});
    storage.repository.finishJob(scope, generation.id, generation.leaseToken, 'done');
    expect(propose).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledOnce();
    const generated = engine.state('stream_fixture');
    expect(generated.chapters[0].summary).toBe('The note disappeared after a reload.');
    expect(generated.chapters[0].title).toBe('Testing the saved note');
    const dependencyRefs = [{id: accepted.sourceId, revision: 1}];
    const media = new PrivateMediaCache({directory: join(directory, 'media'), allowedHosts: ['authored-media.test'], now: clock.now,
      visible: value => value.sessionId !== null && engine.allowed(value), fetch: async () => new Response(new Uint8Array(bytes)), probe: async () => ({durationMs: 20_000, mimeType: 'audio/wav'}),
    });
    await media.prepare({id: 'authored-wav', url: 'https://authored-media.test/sample', kind: 'audio', sessionId: 'stream_fixture', privacyEpoch: 0, dependencyRefs, captureStartMs: 0, captureEndMs: 20_000});
    const app = express(); app.use('/media', createMediaRouter(media, (_req, _res, next) => next())); app.use(apiErrorHandler);
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
    cleanup.push(() => new Promise<void>(done => {server.closeAllConnections(); server.close(() => done());}));
    const port = (server.address() as {port: number}).port;
    expect((await fetch(`http://127.0.0.1:${port}/media/authored-wav`)).status).toBe(200);
    now = start + 94_999; await engine.tick();
    expect(engine.state('stream_fixture').published?.chapters ?? []).toHaveLength(0);
    now = start + 95_000; await engine.tick();
    expect(engine.state('stream_fixture').published?.chapters).toHaveLength(1);
    for (let n = 0; n < 10 && await cloud.tick() !== 'idle'; n++) { /* Drain durable fixture effects. */ }
    expect((await cloudService.readSnapshot(scope.channelId)).chapters[0].summary).toContain('disappeared');
    const russian = await engine.dispatch('stream_fixture', {type: 'language', language: 'ru'});
    expect(russian.published?.language).toBe('ru');
    expect(russian.published?.current?.now).toBe('После перезагрузки заметка исчезла.');
    expect(russian.published?.chapters[0].summary).toBe('После перезагрузки заметка исчезла.');
    const forgotten = await engine.dispatch('stream_fixture', {type: 'privacy', target: {kind: 'interval', sessionId: 'stream_fixture', fromMs: 0, toMs: 20_000}});
    expect(forgotten.sources.find(source => source.id === accepted.sourceId)?.text).toBeNull();
    expect(forgotten.published?.chapters).toHaveLength(0);
    expect((await fetch(`http://127.0.0.1:${port}/media/authored-wav`, {headers: {Range: 'bytes=0-43'}})).status).toBe(410);
    for (let n = 0; n < 10 && await cloud.tick() !== 'idle'; n++) { /* Privacy has priority. */ }
    expect((await cloudService.readSnapshot(scope.channelId)).chapters).toHaveLength(0);
    const recovered = new StoryEngine({scope, channel, storage, clock, updates, safety, story: {propose}}).state('stream_fixture');
    expect(JSON.stringify(recovered)).not.toContain('The note disappeared after a reload.');
    expect(JSON.stringify(recovered)).not.toContain('После перезагрузки заметка исчезла.');
    expect(storage.budget.status().usedMicroUsd).toBe(0);
  });
});
