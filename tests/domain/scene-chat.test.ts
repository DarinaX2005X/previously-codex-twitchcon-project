import { describe, expect, it } from 'vitest';
import { createDomainState, reduceDomain, recapLineage, sceneChatMessages, canDispatch, type DomainState } from '../../src/core/index.js';
import { defaultSettings, type Clock, type Source } from '../../src/shared/contracts/index.js';

// AUTHORED DEVELOPMENT FIXTURE. Exercises chat eligibility for the broadcast scene; no recorded stream.
const start = Date.parse('2026-11-02T00:00:00Z');
const clock: Clock = { now: () => start + 200000, iso: () => new Date(start + 200000).toISOString() };
function state(): DomainState {
  const s = createDomainState({ channel: { id: 'channel', login: 'fixture', displayName: 'Fixture' }, session: { channelId: 'channel', runId: 'run', id: 'session', twitchStreamId: null, title: '', category: '', startedAt: new Date(start).toISOString(), endedAt: null, status: 'live', privacyEpoch: 0, publicationRevision: 0, metadataMaxDependencyEndMs: 0, finalizedAt: null, finalSnapshotAckAt: null }, settings: defaultSettings });
  const chat = (id: string, text: string, ms: number, extra: Partial<Source> = {}): Source => ({ channelId: 'channel', runId: 'run', sessionId: 'session', id, revision: 1, kind: 'chat', startMs: ms, endMs: ms, actorId: `viewer:${id}`, languageCodes: ['en'], timePrecision: 'event', text, status: 'active', externalMessageId: `msg:${id}`, moderation: 'allowed', ...extra });
  s.sources = [
    chat('a', 'MOON JUMP', 101000), chat('b', 'he is gone', 101500), chat('c', 'MOON JUMP', 102000), chat('d', 'moon jump', 102500),
    chat('e', 'fox to the moon', 103000), chat('pending', 'unchecked text', 103100, { moderation: 'pending' }),
    chat('redacted', 'partly hidden', 103200, { moderation: 'redacted' }), chat('deleted', 'deleted line', 103300, { status: 'deleted' }),
    chat('mention', '@pixelmoth look', 103400), chat('link', 'see example.com now', 103500),
    chat('long', 'this message is far too long to read in a broadcast slip', 103600),
    chat('banned', 'banned chatter', 103700, { actorId: 'banned-viewer' }), chat('outside', 'before the moment', 90000),
  ];
  s.bannedActors = ['banned-viewer'];
  return s;
}
const window = { startMs: 101000, endMs: 111000 };
const texts = (s: DomainState) => sceneChatMessages(s, window).map(message => message.text);

describe('scene chat eligibility', () => {
  it('uses only short, allowed, active messages from the moment window and caps repeats', () => {
    expect(texts(state())).toEqual(['MOON JUMP', 'he is gone', 'MOON JUMP', 'fox to the moon']);
  });
  it('drops a message as soon as it is deleted, its chatter is forgotten, or a term is blocked', () => {
    const deleted = reduceDomain(state(), { type: 'privacy', target: { kind: 'source', sessionId: 'session', id: 'b' } }, clock).state;
    expect(texts(deleted)).not.toContain('he is gone');
    const forgotten = reduceDomain(state(), { type: 'privacy', target: { kind: 'user', sessionId: 'session', actorId: 'viewer:e', throughMs: 200000 } }, clock).state;
    expect(texts(forgotten)).not.toContain('fox to the moon');
    const blocked = reduceDomain(state(), { type: 'privacy', target: { kind: 'term', sessionId: 'session', term: 'moon jump' } }, clock).state;
    expect(texts(blocked)).toEqual(['he is gone', 'fox to the moon']);
    const cleared = reduceDomain(state(), { type: 'chat.clear', throughMs: 102000 }, clock).state;
    expect(texts(cleared).length).toBeLessThanOrEqual(texts(state()).length);
  });
  it('a plan carrying a chat line can no longer dispatch after that line is deleted', () => {
    const s = state();
    const plan = { sessionId: 'session', privacyEpoch: 0, dependencyRefs: sceneChatMessages(s, window).map(message => message.ref) };
    expect(canDispatch(s, plan)).toBe(true);
    const after = reduceDomain(s, { type: 'privacy', target: { kind: 'source', sessionId: 'session', id: 'a' } }, clock).state;
    expect(canDispatch(after, { ...plan, privacyEpoch: after.session.privacyEpoch })).toBe(false);
  });
  it('lineage exposes no messages for a moment that is not published', () => {
    expect(recapLineage(state()).moments ?? {}).toEqual({});
  });
});
