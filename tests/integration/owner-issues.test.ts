import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorage } from '../../src/server/storage/index.js';
import { StoryEngine } from '../../src/server/runtime/engine.js';
import { RuntimeOwnerService } from '../../src/server/runtime/owner-service.js';
import { SafetyService } from '../../src/server/providers/safety.js';
import { ProviderTransport } from '../../src/server/providers/transport.js';
import { RevisionStream } from '../../src/server/runtime/updates.js';
import { IssueBoard, twitchIssues } from '../../src/server/runtime/issues.js';
import type { Principal } from '../../src/server/runtime/security.js';

// Authored adapters only; no Twitch or paid provider requests.
const start = Date.parse('2026-11-02T00:00:00Z');
const resources: ReturnType<typeof createStorage>[] = [];
afterEach(() => {for (const storage of resources.splice(0)) storage.close();});
const twitchOk = {connected: true, missingPermissions: [], connection: {state: 'active'}, lastFailure: null};

function harness() {
  let now = start;
  const clock = {now: () => now, iso: () => new Date(now).toISOString()};
  const storage = createStorage({path: ':memory:', now: clock.now}); resources.push(storage);
  const scope = {channelId: 'channel', runId: 'live'}, channel = {id: 'channel', login: 'fixture', displayName: 'Fixture'};
  const updates = new RevisionStream(); const published = vi.spyOn(updates, 'publish');
  const safety = new SafetyService({classify: async () => ({decision: 'allow', spans: []})}, {moderate: async () => 'allowed'}, clock.now);
  const engine = new StoryEngine({scope, channel, storage, clock, updates, safety, story: {propose: async () => {throw new Error('No provider calls.');}}});
  let twitch: Parameters<typeof twitchIssues>[0] = twitchOk;
  const shown = new Map<string, string>();
  const board = new IssueBoard(clock.iso, () => twitchIssues(twitch), (component, issue) => {
    if (component === 'narration') {engine.notifyStatus(); return;}
    if (issue) {shown.set(component, issue.reason); engine.setStatus(component, {state: 'error', lastObservedAt: clock.iso(), message: issue.reason, action: issue.recovery}); return;}
    if (engine.statuses()[component].message === shown.get(component)) engine.setStatus(component, {state: 'ready', lastObservedAt: clock.iso(), message: null, action: null});
  });
  engine.setIssueSource(() => board.list());
  const principal: Principal = {...scope, role: 'owner', actorId: 'owner', sessionId: 'auth', expiresAtMs: start + 1_000_000};
  return {engine, board, published, service: new RuntimeOwnerService(engine), principal, advance: (ms: number) => {now += ms;}, setTwitch: (value: typeof twitch) => {twitch = value;}};
}

describe('owner snapshot integration issues', () => {
  it('shows a rejected OpenAI key on the transcription status and in issues, then clears it after success', async () => {
    const h = harness();
    let status = 401;
    const fetcher = vi.fn(async () => status === 200 ? Response.json({text: 'ok', languages: []}) : Response.json({error: {code: 'invalid_api_key', message: 'Incorrect API key provided: sk-abc***xyz'}}, {status}));
    const options = (apiKey: string) => ({apiKey, runId: 'live', externalCallsEnabled: true, budget: {status: () => ({enabled: true}), reserve: () => true, settle: () => {}}, fetch: fetcher as unknown as typeof fetch, log: () => {}, onIssue: (component: Parameters<typeof h.board.setProvider>[0], issue: Parameters<typeof h.board.setProvider>[1]) => h.board.setProvider(component, issue)});
    let transport = new ProviderTransport(options('sk-abc-secret'));
    const form = () => {const data = new FormData(); data.set('model', 'gpt-transcribe'); return data;};
    await expect(transport.post('audio/transcriptions', form(), 10000)).rejects.toMatchObject({httpStatus: 401});
    const snapshot = h.service.bootstrap(h.principal);
    expect(snapshot.issues).toEqual([{source: 'openai', component: 'transcription', code: 'openai_key_rejected', reason: 'OpenAI rejected the API key.', recovery: 'Check OPENAI_API_KEY in .env (no quotes or spaces) and restart.', since: '2026-11-02T00:00:00.000Z'}]);
    expect(snapshot.status.transcription).toMatchObject({state: 'error', message: 'OpenAI rejected the API key.'});
    expect(JSON.stringify(snapshot)).not.toContain('sk-abc');expect(JSON.stringify(snapshot)).not.toContain('Incorrect');
    // A rejected key is not retried until the configuration changes (restart with a corrected key).
    status = 200; h.advance(1000);
    await expect(transport.post('audio/transcriptions', form(), 10000)).rejects.toMatchObject({httpStatus: 401}); expect(fetcher).toHaveBeenCalledOnce();
    transport = new ProviderTransport(options('sk-corrected'));
    await transport.post('audio/transcriptions', form(), 10000);
    const recovered = h.service.bootstrap(h.principal);
    expect(recovered.issues).toEqual([]); expect(recovered.status.transcription).toMatchObject({state: 'ready', message: null});
  });
  it('names the missing model and out-of-credit accounts with fixed wording', async () => {
    const h = harness();
    const transport = (body: unknown, status: number) => new ProviderTransport({apiKey: 'k', runId: 'live', externalCallsEnabled: true, budget: {status: () => ({enabled: true}), reserve: () => true, settle: () => {}}, fetch: (async () => Response.json(body, {status})) as unknown as typeof fetch, log: () => {}, onIssue: (component, issue) => h.board.setProvider(component, issue)});
    await expect(transport({error: {code: 'model_not_found'}}, 404).post('audio/transcriptions', (() => {const f = new FormData(); f.set('model', 'gpt-transcribe'); return f;})(), 10000)).rejects.toBeTruthy();
    await expect(transport({error: {code: 'insufficient_quota', type: 'insufficient_quota'}}, 429).post('responses', JSON.stringify({model: 'gpt-6-luna'}), 2000)).rejects.toMatchObject({retryable: false});
    const issues = h.service.bootstrap(h.principal).issues!;
    expect(issues.find(issue => issue.component === 'transcription')).toMatchObject({code: 'openai_model_unavailable', reason: 'This OpenAI project has no access to gpt-transcribe.'});
    expect(issues.find(issue => issue.component === 'story')).toMatchObject({code: 'openai_no_credit', reason: 'The OpenAI account is out of credit or reached a spend limit.'});
  });
  it('derives Twitch reconnect problems from runtime status and notifies owner streams for narration', () => {
    const h = harness();
    h.setTwitch({connected: false, missingPermissions: [], connection: {state: 'disconnected'}, lastFailure: null});
    expect(h.service.bootstrap(h.principal).issues).toMatchObject([{source: 'twitch', component: 'chat', code: 'twitch_not_connected'}]);
    h.setTwitch({connected: true, missingPermissions: [], connection: {state: 'revoked'}, lastFailure: 'Twitch permissions changed. Reconnect Twitch.'});
    expect(h.service.bootstrap(h.principal).issues).toMatchObject([{code: 'twitch_revoked', recovery: 'Reconnect Twitch to receive new chat.'}]);
    h.setTwitch({connected: false, missingPermissions: ['user:write:chat'], connection: {state: 'disconnected'}, lastFailure: null});
    expect(h.service.bootstrap(h.principal).issues![0].reason).toBe('Twitch did not grant: user:write:chat.');
    h.setTwitch(twitchOk); expect(h.service.bootstrap(h.principal).issues).toEqual([]);
    h.published.mockClear(); h.board.setProvider('narration', {code: 'openai_narration_failed', reason: 'r', recovery: 'x'});
    expect(h.published).toHaveBeenCalledWith(expect.objectContaining({event: 'source.status'}));
  });
});
