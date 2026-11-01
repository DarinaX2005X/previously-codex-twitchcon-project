import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AudioIntakeService, encodeWav} from '../../src/server/audio/index.js';
import {createStorage} from '../../src/server/storage/index.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';
import {RevisionStream} from '../../src/server/runtime/updates.js';
import {RuntimeOwnerService} from '../../src/server/runtime/owner-service.js';
import {SafetyService, OpenAITranscriptionProvider, OpenAIStoryProvider, ProviderTransport} from '../../src/server/providers/index.js';
import type {StoryProvider, StoryPatch, TranscriptionProvider} from '../../src/shared/contracts/index.js';
import type {Principal} from '../../src/server/runtime/security.js';

const cleanup: (() => void)[] = [];
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close();});
const start = Date.parse('2026-11-02T00:00:00Z');
const scope = {channelId: '123', runId: 'live'};
const text = {en: 'The note disappeared after reload.', ru: 'После перезагрузки заметка исчезла.'};
const title = {en: 'Checking the saved note', ru: 'Проверка сохранённой заметки'};

function harness(language: 'en' | 'ru' = 'en') {
  const directory = mkdtempSync(join(tmpdir(), 'previously-speech-acceptance-'));
  cleanup.push(() => rmSync(directory, {recursive: true, force: true}));
  let now = start, moderation: 'allowed' | 'blocked' | 'unavailable' = 'allowed';
  const clock = {now: () => now, iso: () => new Date(now).toISOString()};
  const storage = createStorage({path: join(directory, 'state.sqlite'), now: clock.now}); cleanup.push(storage.close);
  const updates = new RevisionStream(); cleanup.push(() => updates.close());
  const safety = new SafetyService({classify: async () => ({decision: 'allow', spans: []})}, {moderate: async () => moderation}, clock.now);
  const propose = vi.fn<StoryProvider['propose']>(async (packet, ticket) => {
    const source = packet.sources.at(-1)!;
    const value: StoryPatch = {sessionId: ticket.sessionId, baseRevision: ticket.baseEntityRevision, action: ticket.baseEntityRevision ? 'update' : 'new_chapter', title: title[ticket.recapLanguage], claims: [{id: 'note', text: text[ticket.recapLanguage], role: 'state', support: [{id: source.id, revision: source.revision}], attribution: 'streamer', epistemic: 'explicit'}], relations: [], currentAttemptId: null, language: ticket.recapLanguage, missingContext: []};
    return {value, model: 'authored-acceptance', requestId: 'authored', usage: {chargedMicroUsd: 0}};
  });
  const present: OpenAIStoryProvider['present'] = async (_claims, input) => {
    const make = (language: 'en' | 'ru') => ({id: `${input.entityId}:${language}`, entityId: input.entityId, revision: input.revision, language, title: title[language], summary: text[language], current: {goal: null, change: null, now: text[language]}, claimRefs: input.claimRefs!, eligibleAt: input.eligibleAt, safety: {moderation: 'allowed' as const, pii: 'allowed' as const, checkedAt: clock.iso(), reason: null}});
    return {en: make('en'), ru: make('ru')};
  };
  const review: OpenAIStoryProvider['review'] = async (_packet, _ticket, patch) => ({value: {acceptedClaimIds: patch.claims.map(claim => claim.id), acceptedRelationKeys: [], issues: []}, model: 'authored-review', requestId: 'authored', usage: {chargedMicroUsd: 0}});
  const engine = new StoryEngine({scope, channel: {id: '123', login: 'authored_acceptance', displayName: 'Authored acceptance'}, storage, clock, updates, safety, story: {propose, present, review}});
  storage.repository.updateSettings(scope, 0, {listeningPaused: false, recapLanguage: language});
  storage.repository.createSession(scope, {id: 'episode', startedAt: new Date(start).toISOString()});
  const transcribe = vi.fn<TranscriptionProvider['transcribe']>(async () => ({value: {text: text.ru, languageCodes: ['ru'], confidence: null}, model: 'authored', requestId: 'authored', usage: {chargedMicroUsd: 0}}));
  const audio = new AudioIntakeService({repository: storage.repository, secret: 's'.repeat(32), directory: join(directory, 'raw'), safety, now: clock.now, transcription: {transcribe}, onSource: source => engine.drain(source.sessionId)});
  const principal: Principal = {...scope, role: 'owner', actorId: '123', sessionId: 'authored-cookie', expiresAtMs: start + 1_000_000};
  let lease = audio.acquire(principal, {sessionId: 'episode', browserId: 'acceptance-browser'});
  const bytes = encodeWav(new Float32Array(8000).fill(0.1), 8000);
  async function upload(data = bytes, sequence = 0, begin = 0) {
    now = start + begin + 1000;
    if (begin) lease = audio.renew(principal, lease.token, 'acceptance-browser');
    return audio.accept(principal, {sessionId: 'episode', leaseEpoch: lease.epoch, captureEpoch: lease.captureEpoch, sequence, startMs: begin, endMs: begin + 1000, sampleRate: 8000, sha256: createHash('sha256').update(data).digest('hex'), token: lease.token, browserId: 'acceptance-browser'}, data);
  }
  async function run(kind: 'stt' | 'story') {
    const job = storage.repository.claimJob(scope, {kinds: [kind]}); expect(job).not.toBeNull();
    const result = await (kind === 'stt' ? audio.execute(scope, job!, new AbortController().signal) : engine.executeStory(job!, new AbortController().signal));
    storage.repository.finishJob(scope, job!.id, job!.leaseToken, result.state, result.retryAtMs); return result;
  }
  const owner = new RuntimeOwnerService(engine);
  return {storage, engine, audio, principal, transcribe, propose, upload, run, owner, directory, lease: () => lease,
    set: (ms: number) => {now = start + ms;}, moderation: (value: typeof moderation) => {moderation = value;},
    async publish() {now = start + 76000; await engine.tick(); return engine.state('episode').published;},
    async renew() {lease = audio.renew(principal, lease.token, 'acceptance-browser');},
  };
}

describe('acceptance: authored audio/provider outcomes across runtime and SQLite', () => {
  it.each([{speech: 'ru' as const, output: 'en' as const}, {speech: 'en' as const, output: 'ru' as const}])('$speech evidence publishes $output independently at source end + 75 seconds', async ({speech, output}) => {
    const h = harness(output);
    h.transcribe.mockResolvedValueOnce({value: {text: text[speech], languageCodes: [speech], confidence: null}, model: 'authored', requestId: 'authored', usage: {chargedMicroUsd: 0}});
    const accepted = await h.upload(); expect(await h.run('stt')).toEqual({state: 'done'}); expect(await h.run('story')).toEqual({state: 'done'});
    h.set(75999); await h.engine.tick(); expect(h.engine.state('episode').published?.chapters ?? []).toHaveLength(0);
    const published = await h.publish(); expect(published?.language).toBe(output); expect(published?.chapters[0].summary).toBe(text[output]);
    expect(h.storage.repository.getSource(scope, accepted.sourceId)).toMatchObject({text: text[speech], languageCodes: [speech]});
    expect(h.propose.mock.calls[0][0].recapLanguage).toBe(output);
    expect(h.storage.budget.status().usedMicroUsd).toBe(0);
  });

  it.each(['silence', 'music'] as const)('%s creates no source, chapter or story job', async kind => {
    const h = harness(); const network = vi.fn<typeof fetch>();
    if (kind === 'silence') {
      const provider = new OpenAITranscriptionProvider(new ProviderTransport({apiKey: 'unused', runId: 'live', externalCallsEnabled: false, budget: h.storage.budget, fetch: network}));
      h.transcribe.mockImplementation((...args) => provider.transcribe(...args));
    } else {
      // Authored musical tone with deterministic empty STT outcome; this does not measure model music recognition.
      h.transcribe.mockResolvedValueOnce({value: {text: '', languageCodes: [], confidence: 1}, model: 'authored-music-outcome', requestId: 'authored', usage: {chargedMicroUsd: 0}});
    }
    const pcm = Float32Array.from({length: 8000}, (_, n) => kind === 'silence' ? 0 : Math.sin(n * Math.PI * 2 * 440 / 8000) * 0.1);
    await h.upload(encodeWav(pcm, 8000)); expect(await h.run('stt')).toEqual({state: 'done'}); await h.publish();
    expect(h.engine.state('episode').sources).toHaveLength(0); expect(h.engine.state('episode').chapters).toHaveLength(0);
    expect(h.storage.repository.pendingJobCount(scope, 'episode', ['story'])).toBe(0); expect(h.propose).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    expect(readdirSync(join(h.directory, 'raw'))).toHaveLength(0);
  });

  it.each(['blocked', 'unavailable'] as const)('holds %s moderation before evidence reaches story generation', async decision => {
    const h = harness(); h.moderation(decision); await h.upload(); expect(await h.run('stt')).toEqual({state: 'failed'}); await h.publish();
    expect(h.engine.state('episode').sources).toHaveLength(0); expect(h.engine.state('episode').published?.chapters ?? []).toHaveLength(0);
    expect(h.propose).not.toHaveBeenCalled(); expect(readdirSync(join(h.directory, 'raw'))).toHaveLength(0);
  });

  it('redacts sensitive transcript spans before SQLite and the story evidence packet', async () => {
    const h = harness(); const privateText = 'The note disappeared. Contact alex@example.com or +7 (777) 123-45-67 in secret-keys.json';
    h.transcribe.mockResolvedValueOnce({value: {text: privateText, languageCodes: ['en'], confidence: null}, model: 'authored', requestId: 'authored', usage: {chargedMicroUsd: 0}});
    const accepted = await h.upload(); await h.run('stt'); await h.run('story'); const published = await h.publish();
    const persisted = h.storage.repository.getSource(scope, accepted.sourceId)!; expect(persisted.moderation).toBe('redacted');
    for (const secret of ['alex@example.com', '777', 'secret-keys.json']) {
      expect(JSON.stringify(persisted)).not.toContain(secret); expect(JSON.stringify(h.propose.mock.calls[0][0])).not.toContain(secret); expect(JSON.stringify(published)).not.toContain(secret);
    }
  });

  it.each(['pause', 'takeover'] as const)('%s during STT fences the late source and all downstream generation', async action => {
    const h = harness(); let release!: () => void, began!: () => void;
    const entered = new Promise<void>(resolve => {began = resolve;});
    h.transcribe.mockImplementationOnce(async () => {began(); await new Promise<void>(resolve => {release = resolve;}); return {value: {text: text.ru, languageCodes: ['ru'], confidence: null}, model: 'authored', requestId: 'authored', usage: {chargedMicroUsd: 0}};});
    await h.upload(); const pending = h.run('stt'); await entered;
    if (action === 'pause') h.audio.pause(h.principal, h.lease().token, 'acceptance-browser');
    else h.audio.acquire(h.principal, {sessionId: 'episode', browserId: 'replacement-browser', takeover: true});
    release(); expect(await pending).toEqual({state: 'failed'}); await h.publish();
    expect(h.engine.state('episode').sources).toHaveLength(0); expect(h.propose).not.toHaveBeenCalled(); expect(readdirSync(join(h.directory, 'raw'))).toHaveLength(0);
  });

  it('rejects a late model result after the owner forgets its input source', async () => {
    const h = harness(); const accepted = await h.upload(); await h.run('stt');
    const original = h.propose.getMockImplementation()!; let release!: () => void, began!: () => void;
    const entered = new Promise<void>(resolve => {began = resolve;});
    h.propose.mockImplementationOnce(async (...args) => {began(); await new Promise<void>(resolve => {release = resolve;}); return original(...args);});
    const pending = h.run('story'); await entered;
    await h.owner.privacy({principal: h.principal, idempotencyKey: 'acceptance-forget'}, {target: {kind: 'source', sessionId: 'episode', id: accepted.sourceId}, reason: 'Authored privacy race'});
    release(); await pending; await h.publish();
    expect(h.engine.state('episode').chapters).toHaveLength(0); expect(h.engine.state('episode').published?.chapters ?? []).toHaveLength(0);
    expect(h.storage.repository.getSource(scope, accepted.sourceId)?.text).toBeNull();
  });

  it.each(['unavailable', 'malformed'] as const)('%s next provider response retains the last safe published context', async failure => {
    const h = harness(); await h.upload(); await h.run('stt'); await h.run('story'); const before = await h.publish(); expect(before?.chapters).toHaveLength(1);
    const fetcher = vi.fn<typeof fetch>(async () => {if (failure === 'unavailable') throw new Error('Authored transport failure'); return Response.json({status: 'completed', output: [{content: [{type: 'output_text', text: '{"action":"invented"}'}]}]});});
    const provider = new OpenAIStoryProvider(new ProviderTransport({apiKey: 'authored-not-live', runId: 'live', externalCallsEnabled: true, fetch: fetcher, budget: {status: () => ({enabled: true}), reserve: () => true, settle: () => {}}}));
    h.propose.mockImplementation((...args) => provider.propose(...args));
    h.set(100000); await h.engine.dispatch('episode', {type: 'source', source: {...scope, id: 'authored-next', sessionId: 'episode', revision: 1, kind: 'speech', startMs: 99000, endMs: 100000, actorId: null, languageCodes: ['en'], timePrecision: 'chunk', text: 'I am checking the note again.', status: 'active', externalMessageId: null, moderation: 'allowed'}});
    expect(await h.run('story')).toEqual({state: 'failed'}); h.set(180000); await h.engine.tick();
    expect(h.engine.state('episode').published?.chapters).toEqual(before!.chapters);
    expect(h.engine.statuses().story.state).toBe('delayed'); expect(fetcher).toHaveBeenCalledTimes(failure === 'malformed' ? 2 : 1);
    expect(h.storage.budget.status().usedMicroUsd).toBe(0);
  });

  it('an owner edit made during a model request wins over the late generated update', async () => {
    const h = harness(); await h.upload(); await h.run('stt'); await h.run('story'); await h.publish();
    const chapter = h.engine.state('episode').chapters[0];
    h.set(100000); await h.engine.dispatch('episode', {type: 'source', source: {...scope, id: 'edit-race-source', sessionId: 'episode', revision: 1, kind: 'speech', startMs: 99000, endMs: 100000, actorId: null, languageCodes: ['en'], timePrecision: 'chunk', text: 'I am checking the note again.', status: 'active', externalMessageId: null, moderation: 'allowed'}});
    const original = h.propose.getMockImplementation()!; let release!: () => void, began!: () => void;
    const entered = new Promise<void>(resolve => {began = resolve;});
    h.propose.mockImplementationOnce(async (...args) => {began(); await new Promise<void>(resolve => {release = resolve;}); return original(...args);});
    const pending = h.run('story'); await entered;
    await h.owner.editChapter({principal: h.principal, idempotencyKey: 'acceptance-owner-edit', baseRevision: chapter.revision}, chapter.id, {summary: 'The owner is checking the reload behavior.'});
    release(); await pending;
    expect(h.engine.state('episode').chapters[0]).toMatchObject({summary: 'The owner is checking the reload behavior.', edited: true});
    expect(h.engine.state('episode').published?.chapters).toHaveLength(0);
    const review = h.storage.repository.claimJob(scope, {kinds: ['owner.review']})!;
    expect(await h.owner.executeReview(review, new AbortController().signal)).toEqual({state: 'done'});
    h.storage.repository.finishJob(scope, review.id, review.leaseToken, 'done'); await h.engine.tick();
    expect(h.engine.state('episode').published?.chapters[0].summary).toBe('The owner is checking the reload behavior.');
  });
});
