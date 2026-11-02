import { describe, expect, it } from 'vitest';
import { compileRecap, narrationScript, type DomainMedia } from '../../src/core/index.js';
import { defaultSettings, RecapPlanSchema, type PublicSnapshot, type RecapTrigger } from '../../src/shared/contracts/index.js';

// Authored public projection: no recorded stream or provider calls.
const at = '2026-11-02T00:03:00.000Z';
const trigger: RecapTrigger = { id: 'raid', sessionId: 'session', reason: 'raid', occurredAt: at };
function snapshot(): PublicSnapshot {
  return {
    schemaVersion: 1, channel: { id: 'channel', login: 'fixture', displayName: 'Fixture' },
    session: { id: 'session', title: 'Persistence test', category: 'Development', startedAt: at, endedAt: null, status: 'live', metadataMaxDependencyEndMs: 0 },
    revision: 3, privacyEpoch: 0, language: 'en', asOf: at, publishedAt: at, liveLeaseUntil: null,
    current: { goal: 'Save the note.', change: 'The note survived one reload.', now: 'Checking another reload.', sourceTimeMs: 90000, maxDependencyEndMs: 90000 },
    chapters: [{ id: 'chapter', revision: 2, title: 'A reload test', summary: 'The note survived one reload.', startMs: 10000, endMs: 90000, mood: '', claimIds: [], momentIds: ['moment'], pinned: false, edited: false, sourceLabels: [], maxDependencyEndMs: 90000 }],
    lore: [], moments: [{ id: 'moment', startMs: 20000, endMs: 40000, label: 'Reload', triggerReasons: ['manual'], clip: null, mediaState: 'ready', maxDependencyEndMs: 40000 }],
    gaps: [], lastSyncedAt: null, vodUrl: null,
  };
}
const visual = (id = 'clip', momentId = 'moment'): DomainMedia => ({ id, revision: 1, momentId, refs: [{ id: `source:${id}`, revision: 1 }], captureStartMs: 20000, captureEndMs: 40000, durationMs: 20000, state: 'ready', kind: 'video', previousSession: false, ownerApproved: true });
const compile = (s = snapshot(), options: Parameters<typeof compileRecap>[3] = {}) => compileRecap(s, defaultSettings.layout, trigger, options);

describe('approved recap selection', () => {
  it('retains a whole qualifying sentence instead of splitting at punctuation', () => {
    const s = snapshot();
    const qualified = 'The note survived once; this does not establish that the persistence bug is fixed.';
    s.current!.change = qualified;
    const plan = compile(s);
    expect(plan.beats.find(beat => beat.kind === 'change')?.text).toBe(qualified);
    expect(plan.beats.some(beat => beat.text === 'The note survived once')).toBe(false);
    expect(RecapPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('uses an approved whole title for a long chapter caption without slicing its meaning', () => {
    const s = snapshot();
    s.current = null;
    s.chapters[0]!.summary = 'The note survived once; this does not establish that the persistence bug is fixed.';
    s.chapters.push({ ...s.chapters[0]!, id: 'earlier', title: 'Starting the reload test', summary: 'Preparing the test.', startMs: 0, endMs: 5000 });
    expect(compile(s).beats[0]?.text).toBe('A reload test');
    expect(compile(s).beats.every(beat => beat.kind === 'context')).toBe(true);
  });

  it('does not claim a stream has just started when reviewed context is missing', () => {
    const s = snapshot(); s.session.title = ''; s.session.category = ''; s.current = null; s.chapters = [];
    const plan = compile(s);
    expect(plan.variant).toBe('welcome');
    expect(plan.beats[0]?.text).toBe('Reviewed stream context is not available yet.');
  });

  it('labels a general approved title as context when replacing a long current field', () => {
    const s = snapshot(), qualified = 'The artist is discussing the harbor composition while waiting for the first watercolor wash to dry.';
    s.current = { goal: null, change: null, now: qualified, sourceTimeMs: 90000, maxDependencyEndMs: 90000 };
    s.chapters[0]!.title = 'Painting the harbor'; s.chapters[0]!.summary = qualified;
    expect(compile(s).beats).toEqual([expect.objectContaining({ kind: 'context', text: 'Painting the harbor' })]);
  });

  it('does not invent a short heading or crash when no whole approved field fits the recap contract', () => {
    const s = snapshot(); s.current = null; s.chapters[0]!.title = ''; s.chapters[0]!.summary = 'A complete qualified statement. '.repeat(12);
    const plan = compile(s);
    expect(plan.variant).toBe('welcome'); expect(plan.beats[0]?.text).toBe(s.session.title);
  });

  it('selects only a relevant published origin and keeps its precise supplied revisions', () => {
    const s = snapshot();
    s.current!.change = 'The brick survived one reload.';
    s.lore = [
      { id: 'unrelated', term: 'banana', explanation: 'An unrelated nickname.', firstSeenMs: 0, originMs: 80000, originKind: 'spoken', momentId: null, maxDependencyEndMs: 80000 },
      { id: 'brick', term: 'brick', explanation: 'The owner named the prototype.', firstSeenMs: 0, originMs: 1000, originKind: 'owner_confirmed', momentId: null, maxDependencyEndMs: 1000 },
    ];
    const loreRefs = { brick: [{ id: 'brick', revision: 7 }, { id: 'brick:en', revision: 3 }], unrelated: [{ id: 'unrelated', revision: 1 }] };
    const plan = compile(s, { loreRefs });
    expect(plan.beats.map(beat => beat.kind)).toEqual(['attempt', 'change', 'origin', 'now']);
    expect(plan.beats.find(beat => beat.kind === 'origin')?.text).toContain('brick');
    expect(plan.dependencyRefs).toEqual(expect.arrayContaining(loreRefs.brick));
    expect(plan.dependencyRefs.some(ref => ref.id === 'unrelated')).toBe(false);
    expect(compile(s).beats.some(beat => beat.kind === 'origin')).toBe(false);
    expect(compile(s, { loreRefs, durationMs: 10000 }).beats.some(beat => beat.kind === 'origin')).toBe(false);
    const qualified = 'The name came from an earlier sketch of the prototype; it does not describe whether the reload succeeded.';
    s.lore[1]!.explanation = qualified;
    expect(compile(s, { loreRefs }).beats.find(beat => beat.kind === 'origin')?.text).toBe(qualified);
  });

  it('does not attach ready footage or dependencies from an unrelated moment', () => {
    const s = snapshot();
    s.moments.push({ ...s.moments[0]!, id: 'other-moment' });
    const plan = compile(s, { currentRefs: [{ id: 'approved-current', revision: 4 }], media: [visual('other', 'other-moment'), visual()] });
    expect(plan.media.map(media => media.id)).toEqual(['clip']);
    expect(plan.dependencyRefs).toEqual(expect.arrayContaining([{ id: 'approved-current', revision: 4 }, { id: 'clip', revision: 1 }, { id: 'source:clip', revision: 1 }]));
    expect(plan.dependencyRefs.some(ref => ref.id.includes('other'))).toBe(false);
  });

  it('does not invent raid identity or viewer counts when the trigger omits them', () => {
    expect(compile().arrivals).toEqual([]);
    const build = (fields: Partial<RecapTrigger>) => compileRecap(snapshot(), defaultSettings.layout, { ...trigger, ...fields });
    expect(build({ fromLogin: 'raider' }).arrivals).toEqual([]);
    expect(build({ viewers: 30 }).arrivals).toEqual([]);
    expect(build({ fromLogin: ' ', viewers: 30 }).arrivals).toEqual([]);
    expect(build({ fromLogin: 'raider', viewers: 0 }).arrivals).toEqual([{ triggerId: 'raid', fromLogin: 'raider', viewers: 0 }]);
    expect(build({ fromLogin: 'raider', viewers: 30 }).arrivals[0]?.viewers).toBe(30);
  });
});

describe('prepared narration selection', () => {
  function audio(): DomainMedia {
    return { ...visual('voice'), kind: 'audio', momentId: null, durationMs: 8000, refs: [{ id: 'voice-input', revision: 2 }], narration: { language: 'en', script: narrationScript(compile()) } };
  }
  it('uses exact approved captions and includes narration lineage only when enabled', () => {
    const media = audio(), plan = compile(snapshot(), { narrationEnabled: true, media: [media] });
    expect(narrationScript(plan)).toBe(plan.beats.map(beat => beat.text).join(' '));
    expect(plan.audio).toEqual({ id: 'voice', startMs: 0, durationMs: 8000 });
    expect(plan.dependencyRefs).toEqual(expect.arrayContaining([{ id: 'voice', revision: 1 }, { id: 'voice-input', revision: 2 }]));
    const silent = compile(snapshot(), { media: [media] });
    expect(silent.audio).toBeNull();
    expect(silent.dependencyRefs.some(ref => ref.id === 'voice')).toBe(false);
  });
  it('rejects stale text, another language, excessive duration, unapproved or revoked audio', () => {
    const valid = audio();
    for (const media of [
      { ...valid, narration: { language: 'en' as const, script: 'An older approved recap.' } },
      { ...valid, narration: { ...valid.narration!, language: 'ru' as const } },
      { ...valid, durationMs: 13000 }, { ...valid, ownerApproved: false }, { ...valid, state: 'revoked' as const },
    ]) expect(compile(snapshot(), { narrationEnabled: true, media: [media] }).audio).toBeNull();
  });
});

describe('broadcast scene material', () => {
  function story(): PublicSnapshot {
    const s = snapshot();
    s.channel.displayName = 'Foxlight Dev'; s.session.title = 'Building a tiny cave platformer';
    const chapter = s.chapters[0]!;
    s.chapters = [
      { ...chapter, id: 'jump', title: 'Fox learns to jump', startMs: 5000, endMs: 90000, momentIds: [], maxDependencyEndMs: 90000 },
      { ...chapter, id: 'moon', title: 'The moon jump', startMs: 100000, endMs: 200000, momentIds: ['moment'], maxDependencyEndMs: 200000 },
      { ...chapter, id: 'spring', title: 'Spring gets a speed limit', startMs: 210000, endMs: 300000, momentIds: [], maxDependencyEndMs: 300000 },
      { ...chapter, id: 'lanterns', title: 'Lanterns light the cave', startMs: 320000, endMs: 400000, momentIds: ['lantern-moment'], maxDependencyEndMs: 400000 },
    ];
    s.current = { goal: 'Make the lanterns light up the cave', change: null, now: 'Making the lantern behind the waterfall reachable', sourceTimeMs: 400000, maxDependencyEndMs: 400000 };
    s.moments = [{ ...s.moments[0]!, id: 'moment', startMs: 101000, endMs: 111000, maxDependencyEndMs: 200000 }, { ...s.moments[0]!, id: 'lantern-moment', startMs: 320000, endMs: 330000, maxDependencyEndMs: 400000 }];
    s.lore = [{ id: 'moon-jump', term: 'moon jump', explanation: 'The spring launched the fox through the ceiling.', firstSeenMs: 101000, originMs: 125000, originKind: 'spoken', momentId: 'moment', maxDependencyEndMs: 125000 }];
    return s;
  }
  const messages = ['MOON JUMP', 'he is gone', 'fox to the moon'].map((text, i) => ({ ref: { id: `chat:${i}`, revision: 1 }, text }));
  const lineage = {
    currentRefs: [{ id: 'approved-current', revision: 2 }],
    loreRefs: { 'moon-jump': [{ id: 'moon-jump', revision: 3 }] },
    moments: { moment: { count: 45, messages } },
  };
  const media = [visual('clip-moon', 'moment'), visual('clip-lanterns', 'lantern-moment')];

  it('carries earlier chapters, the chat moment, its lore and the current statement with their lineage', () => {
    const plan = compile(story(), { ...lineage, media });
    expect(RecapPlanSchema.safeParse(plan).success).toBe(true);
    const scene = plan.scene!;
    expect(scene.channelName).toBe('Foxlight Dev');
    expect(scene.chapters.map(chapter => [chapter.title, chapter.startMs, chapter.mediaId])).toEqual([
      ['Fox learns to jump', 5000, null], ['The moon jump', 100000, 'clip-moon'], ['Spring gets a speed limit', 210000, null]]);
    expect(scene.moment).toEqual({ id: 'moment', chapterId: 'moon', startMs: 101000, windowSeconds: 10, count: 45, mediaId: 'clip-moon', messages: ['MOON JUMP', 'he is gone', 'fox to the moon'] });
    expect(scene.lore).toEqual({ term: 'moon jump', explanation: 'The spring launched the fox through the ceiling.', originMs: 125000 });
    expect(scene.now).toEqual({ text: 'Making the lantern behind the waterfall reachable', mediaId: 'clip-lanterns' });
    expect(plan.media.map(item => item.id).sort()).toEqual(['clip-lanterns', 'clip-moon']);
    expect(plan.dependencyRefs).toEqual(expect.arrayContaining([
      { id: 'jump', revision: 2 }, { id: 'spring', revision: 2 }, { id: 'chat:0', revision: 1 }, { id: 'chat:2', revision: 1 },
      { id: 'moon-jump', revision: 3 }, { id: 'approved-current', revision: 2 }]));
  });

  it('omits chat, lore and the current statement when their lineage is missing', () => {
    const scene = compile(story(), { media }).scene!;
    expect(scene.moment).toBeNull(); expect(scene.lore).toBeNull(); expect(scene.now).toBeNull();
    expect(compile(story(), { ...lineage, moments: { moment: { count: 2, messages: messages.slice(0, 2) } } }).scene!.moment).toBeNull();
  });

  it('keeps a welcome-only cut free of chapters and chat', () => {
    const scene = compile(story(), { ...lineage, media, welcomeOnly: true }).scene!;
    expect(scene).toEqual({ channelName: 'Foxlight Dev', streamTitle: 'Building a tiny cave platformer', chapters: [], moment: null, lore: null, now: null, command: '!previously' });
  });

  it('starts a moment clip just before the reaction, within its capture', () => {
    const plan = compile(story(), { ...lineage, media: [{ ...visual('clip-moon', 'moment'), captureStartMs: 100000, captureEndMs: 112000, durationMs: 12000 }] });
    expect(plan.media[0]).toEqual(expect.objectContaining({ id: 'clip-moon', inMs: 0, outMs: 12000 }));
    const later = compile(story(), { ...lineage, media: [{ ...visual('clip-moon', 'moment'), captureStartMs: 97000, captureEndMs: 109000, durationMs: 12000 }] });
    expect(later.media[0]).toEqual(expect.objectContaining({ inMs: 3000, outMs: 12000 }));
  });
});
