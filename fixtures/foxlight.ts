import { stateHash, type DomainEvent, type GenerationRequest } from '../src/core/index.js';
import { defaultSettings, type CurrentState, type GroundedClaim, type PublicSnapshot, type RecapLanguage, type RecapPlan, type Safety, type Source, type StoryPatch } from '../src/shared/contracts/index.js';
import { PROVIDER_VERSIONS, validateBundle, type CaptureBundle, type RecordedOutcome, type StoryOutcome, type WordingOutcome } from '../src/replay/contracts.js';
import { ReplayDriver } from '../src/replay/driver.js';
import { FixtureMissing, RecordedProviders, providerKey } from '../src/replay/providers.js';

/**
 * Foxlight: an authored example recording of a small game development stream.
 * The speech, chat, raid and provider outcomes are written for this example. The video clips are real
 * footage of our own small game. Nothing here is a recording of a real streamer, chatter or model call.
 */
export const FOXLIGHT_ID = 'foxlight';
export const FOXLIGHT_LOGIN = 'foxlight_dev';
export const FOXLIGHT_SESSION_ID = 'foxlight-session';
export const FOXLIGHT_DURATION_MS = 480_000;
export const FOXLIGHT_RAID_AT_MS = 430_000;
/** The raid scene is playing at this offset: trigger, 0.3 s preparation and start. */
export const FOXLIGHT_RAID_MILESTONE_MS = FOXLIGHT_RAID_AT_MS + 300;
const STARTED_AT = '2026-11-02T00:00:00.000Z';
const STORY_DELAY_MS = 900;
/** One virtual second per scheduler tick keeps a full 8 minute replay fast; holds still end within a second. */
const TICK_MS = 1000;

export type FoxlightMedia = { id: string; assetId: string; file: string; poster: string; captureStartMs: number; captureEndMs: number; sourceIds: string[] };
/** Media ids used by the domain and RecapPlan, mapped to their example files under public/. Capture ranges match the clip lengths (10, 10.5, 9.5 and 11 s). */
export const FOXLIGHT_MEDIA: FoxlightMedia[] = [
  { id: 'fx-media-run', assetId: 'clip-run', file: '/demo/foxlight/clip-run.mp4', poster: '/demo/foxlight/clip-run.jpg', captureStartMs: 20_000, captureEndMs: 30_000, sourceIds: [] },
  { id: 'fx-media-moon', assetId: 'clip-moon', file: '/demo/foxlight/clip-moon.mp4', poster: '/demo/foxlight/clip-moon.jpg', captureStartMs: 100_000, captureEndMs: 110_500, sourceIds: ['fx-speech-03'] },
  { id: 'fx-media-fixed', assetId: 'clip-fixed', file: '/demo/foxlight/clip-fixed.mp4', poster: '/demo/foxlight/clip-fixed.jpg', captureStartMs: 210_000, captureEndMs: 219_500, sourceIds: ['fx-speech-05'] },
  { id: 'fx-media-lanterns', assetId: 'clip-lanterns', file: '/demo/foxlight/clip-lanterns.mp4', poster: '/demo/foxlight/clip-lanterns.jpg', captureStartMs: 320_000, captureEndMs: 331_000, sourceIds: ['fx-speech-06'] },
];
export const FOXLIGHT_BACKGROUND = { video: '/demo/foxlight/stream-full.mp4', poster: '/demo/foxlight/stream-full-poster.jpg' };

type Speech = { id: string; startMs: number; endMs: number; segment: 1 | 2 | 3 | 4; text: string };
/** Authored speech of the example streamer. Segment = the chapter the speech belongs to. */
const SPEECH: Speech[] = [
  { id: 'fx-speech-01', startMs: 5_000, endMs: 13_000, segment: 1, text: 'Today I am building a tiny cave platformer. The fox can run and jump, and the goal tonight is to make the lanterns light up the cave.' },
  { id: 'fx-speech-02', startMs: 50_000, endMs: 55_000, segment: 1, text: 'I added a spring pad so the fox can reach the high ledge.' },
  { id: 'fx-speech-03', startMs: 100_000, endMs: 103_000, segment: 2, text: 'Okay, let me try the spring.' },
  { id: 'fx-speech-04', startMs: 125_000, endMs: 133_000, segment: 2, text: 'Chat is calling it the moon jump. The spring has no speed limit, so the fox flies through the ceiling.' },
  { id: 'fx-speech-05', startMs: 210_000, endMs: 219_000, segment: 3, text: 'I capped the spring speed and the fox lands on the ledge now. The moon jump is fixed, but I am keeping it as a secret cheat.' },
  { id: 'fx-speech-06', startMs: 320_000, endMs: 330_000, segment: 4, text: 'Next, lanterns. The spring no longer launches the fox to the moon, so the fox can reach them. Each lantern you collect lights part of the cave. Right now the cave stays dark until every lantern is lit.' },
  // With the 75 s publication hold, this must end before 5:55 to be public at the 7:10 raid.
  { id: 'fx-speech-07', startMs: 340_000, endMs: 347_000, segment: 4, text: 'Two lanterns work. The third one is behind the waterfall and I am making that path reachable.' },
];
/** Speech that starts a new chapter. The boundary is a topic event that cites this speech. */
const TOPIC_STARTS = ['fx-speech-03', 'fx-speech-05', 'fx-speech-06'];

type Chat = { atMs: number; actor: number; text: string; emote?: boolean };
/** Sparse chat before and after the burst. Each 10 s window has at most one message. */
const SPARSE_CHAT: Chat[] = [
  { atMs: 15_200, actor: 24, text: 'hello, the fox is cute' },
  { atMs: 27_400, actor: 25, text: 'what engine is this' },
  { atMs: 38_100, actor: 3, text: 'love the lantern idea' },
  { atMs: 52_600, actor: 26, text: 'a spring pad, nice' },
  { atMs: 64_300, actor: 7, text: 'the cave colors are so warm' },
  { atMs: 77_900, actor: 24, text: 'is it canvas or webgl' },
  { atMs: 91_200, actor: 11, text: 'spring time' },
  { atMs: 116_400, actor: 5, text: 'still laughing at that' },
  { atMs: 128_300, actor: 14, text: 'he named it' },
  { atMs: 141_700, actor: 12, text: 'moon jump should stay in the game' },
  { atMs: 156_200, actor: 2, text: 'please keep the moon jump' },
  { atMs: 171_500, actor: 19, text: 'the ceiling never stood a chance' },
  { atMs: 186_000, actor: 8, text: 'what does the spring code look like' },
  { atMs: 201_300, actor: 25, text: 'speed limit time' },
  { atMs: 226_800, actor: 9, text: 'secret cheat, love it' },
  { atMs: 241_100, actor: 16, text: 'nice landing' },
  { atMs: 256_400, actor: 4, text: 'the ledge works now' },
  { atMs: 271_900, actor: 21, text: 'can we see the lanterns' },
  { atMs: 287_200, actor: 1, text: 'this game looks cozy' },
  { atMs: 302_600, actor: 13, text: 'lantern time' },
  { atMs: 324_100, actor: 6, text: 'the cave is lighting up' },
  { atMs: 335_800, actor: 26, text: 'so pretty' },
  { atMs: 344_500, actor: 10, text: 'where is the third one' },
];
/** The moon jump reaction: 45 messages from 23 example chatters inside one 10 s window (1:40.8 to 1:49.6). */
const BURST_TEXT = [
  'MOON JUMP', "he's gone", 'fox to the moon', 'LUL', 'o7 fox', 'the fox has left the cave', 'MOON JUMP MOON JUMP', 'clip it',
  'where did he go', 'LUL LUL', 'bye fox', 'lol', 'moon jump any%', 'o7', 'that spring is strong', 'the ceiling was a suggestion',
  'clip that', 'MOON JUMP', 'he is in orbit now', 'fox astronaut', 'LUL', 'see you on the moon', 'speedrun strat',
  'MOON JUMP', 'lol what', 'o7', 'the fox is free', 'clip it', 'gone forever', 'MOON JUMP MOON JUMP', 'LUL',
  'too much spring', 'he went to space', 'moon jump is canon', 'byeee', 'lmao', 'one small jump for fox', 'MOON JUMP',
  'o7 fox', 'that was perfect', 'LUL', 'the fox has left the cave', 'clip it', 'fox to the moon', 'MOON JUMP',
];
const EMOTES = /^(?:LUL(?: LUL)*|o7(?: fox)?)$/;
const BURST: Chat[] = BURST_TEXT.map((text, i) => ({ atMs: 100_800 + i * 200, actor: i % 23 + 1, text, emote: EMOTES.test(text) }));

/** The example recording was authored with English and Russian outcomes only. */
type FoxlightLanguage = 'en' | 'ru';
type ClaimSpec = { key: string; role: GroundedClaim['role']; support: string[]; en: string; ru: string };
type Version = { segment: number; needs: string[]; title: { en: string; ru: string }; claims: ClaimSpec[] };
const GOAL: ClaimSpec = { key: 'goal', role: 'goal', support: ['fx-speech-01'], en: 'Make the lanterns light up the cave.', ru: 'Сделать так, чтобы фонари освещали пещеру.' };
/**
 * Recorded story wording. For each request, the newest version of its chapter whose required speech is
 * present in the request packet is used. Claims cite only the speech they paraphrase.
 */
const VERSIONS: Version[] = [
  { segment: 1, needs: ['fx-speech-01'], title: { en: 'Fox learns to jump', ru: 'Лиса учится прыгать' }, claims: [
    { key: 'build', role: 'attempt', support: ['fx-speech-01'], en: 'Building a tiny cave platformer.', ru: 'Делает маленький платформер в пещере.' },
    { key: 'moves', role: 'outcome', support: ['fx-speech-01'], en: 'The fox can run and jump.', ru: 'Лиса уже бегает и прыгает.' },
    GOAL,
  ] },
  { segment: 1, needs: ['fx-speech-01', 'fx-speech-02'], title: { en: 'Fox learns to jump', ru: 'Лиса учится прыгать' }, claims: [
    { key: 'build', role: 'attempt', support: ['fx-speech-01'], en: 'Building a tiny cave platformer.', ru: 'Делает маленький платформер в пещере.' },
    { key: 'moves', role: 'outcome', support: ['fx-speech-01'], en: 'The fox can run and jump.', ru: 'Лиса уже бегает и прыгает.' },
    GOAL,
    { key: 'spring', role: 'state', support: ['fx-speech-02'], en: 'Added a spring pad so the fox can reach the high ledge.', ru: 'Появилась пружина, чтобы лиса допрыгнула до высокого уступа.' },
  ] },
  { segment: 2, needs: ['fx-speech-03'], title: { en: 'Testing the spring pad', ru: 'Проверка пружины' }, claims: [
    { key: 'try', role: 'state', support: ['fx-speech-03'], en: 'Testing the new spring pad.', ru: 'Проверяет новую пружину.' },
  ] },
  { segment: 2, needs: ['fx-speech-04'], title: { en: 'The moon jump', ru: 'Лунный прыжок' }, claims: [
    { key: 'launch', role: 'change', support: ['fx-speech-04'], en: 'The spring has no speed limit, so it launched the fox through the ceiling.', ru: 'У пружины не было ограничения скорости, и она запустила лису сквозь потолок.' },
    { key: 'named', role: 'state', support: ['fx-speech-04'], en: 'Chat named it the moon jump.', ru: 'Чат назвал это лунным прыжком.' },
  ] },
  { segment: 3, needs: ['fx-speech-05'], title: { en: 'Spring gets a speed limit', ru: 'Пружине ограничили скорость' }, claims: [
    { key: 'capped', role: 'change', support: ['fx-speech-05'], en: 'Capped the spring speed, so the fox lands on the ledge now.', ru: 'Скорость пружины ограничена, и теперь лиса приземляется на уступ.' },
    { key: 'cheat', role: 'state', support: ['fx-speech-05'], en: 'The moon jump is fixed, but it stays in the game as a secret cheat.', ru: 'Лунный прыжок исправлен, но остался в игре как секретный чит.' },
  ] },
  { segment: 4, needs: ['fx-speech-06'], title: { en: 'Lanterns light the cave', ru: 'Фонари освещают пещеру' }, claims: [
    GOAL,
    { key: 'lanterns', role: 'outcome', support: ['fx-speech-06'], en: 'Each lantern the fox collects lights part of the cave.', ru: 'Каждый собранный фонарь освещает часть пещеры.' },
    { key: 'no-moon', role: 'change', support: ['fx-speech-06'], en: 'The spring no longer launches the fox to the moon.', ru: 'Пружина больше не отправляет лису на Луну.' },
    { key: 'dark', role: 'state', support: ['fx-speech-06'], en: 'The cave stays dark until every lantern is lit.', ru: 'Пока не горят все фонари, в пещере темно.' },
  ] },
  { segment: 4, needs: ['fx-speech-06', 'fx-speech-07'], title: { en: 'Lanterns light the cave', ru: 'Фонари освещают пещеру' }, claims: [
    GOAL,
    { key: 'lanterns', role: 'outcome', support: ['fx-speech-06'], en: 'Each lantern the fox collects lights part of the cave.', ru: 'Каждый собранный фонарь освещает часть пещеры.' },
    { key: 'two', role: 'outcome', support: ['fx-speech-07'], en: 'Two lanterns work, and the third one is behind the waterfall.', ru: 'Два фонаря уже работают, а третий спрятан за водопадом.' },
    { key: 'no-moon', role: 'change', support: ['fx-speech-06'], en: 'The spring no longer launches the fox to the moon.', ru: 'Пружина больше не отправляет лису на Луну.' },
    { key: 'waterfall', role: 'state', support: ['fx-speech-07'], en: 'Making the lantern behind the waterfall reachable.', ru: 'Прокладывает путь к фонарю за водопадом.' },
  ] },
];
const LORE = {
  id: 'fx-lore-moon-jump', term: 'moon jump', originSpeech: 'fx-speech-04', atMs: 134_000,
  en: 'When the spring had no speed limit, it launched the fox through the ceiling, and chat named it the moon jump.',
  ru: { term: 'лунный прыжок', explanation: 'Когда у пружины не было ограничения скорости, она запускала лису сквозь потолок. Так это назвал чат.' },
};
const CORRECTION = {
  en: { title: 'Moon jump becomes a cheat code', summary: 'The spring speed is capped, so the fox lands on the ledge. The moon jump stays in the game as a secret cheat code.' },
  ru: { title: 'Лунный прыжок стал чит-кодом', summary: 'Скорость пружины ограничена, и лиса приземляется на уступ. Лунный прыжок остался в игре как секретный чит-код.' },
};
/** Owner-saved moments, each later attached to its clip. The chat burst creates the moon moment by itself. */
const SAVED_MOMENTS = [{ atMs: 32_000, media: 'fx-media-run' }, { atMs: 221_000, media: 'fx-media-fixed' }, { atMs: 333_000, media: 'fx-media-lanterns' }];
/** When each clip is ready: a few seconds after both its capture and its moment exist. */
const MEDIA_READY_AT: Record<string, number> = { 'fx-media-run': 34_000, 'fx-media-moon': 113_000, 'fx-media-fixed': 223_000, 'fx-media-lanterns': 335_000 };

const iso = (offsetMs: number) => new Date(Date.parse(STARTED_AT) + offsetMs).toISOString();
const allowed = (atMs: number): Safety => ({ moderation: 'allowed', pii: 'allowed', checkedAt: iso(atMs), reason: null });
const actorId = (n: number) => `fx-viewer-${String(n).padStart(2, '0')}`;

function initial(): CaptureBundle['initial'] {
  return {
    channel: { id: 'foxlight-channel', login: FOXLIGHT_LOGIN, displayName: 'Foxlight Dev' },
    session: { channelId: 'foxlight-channel', runId: 'logical', id: FOXLIGHT_SESSION_ID, twitchStreamId: null, title: 'Building a tiny cave platformer', category: 'Software and Game Development', startedAt: STARTED_AT, endedAt: null, status: 'live', privacyEpoch: 0, publicationRevision: 0, metadataMaxDependencyEndMs: 0, finalizedAt: null, finalSnapshotAckAt: null },
    settings: { ...defaultSettings, listeningPaused: false, autoClips: true },
  };
}
function source(input: Pick<Source, 'id' | 'kind' | 'startMs' | 'endMs' | 'actorId' | 'text'> & { externalMessageId?: string }): Source {
  return { channelId: 'foxlight-channel', runId: 'logical', sessionId: FOXLIGHT_SESSION_ID, revision: 1, languageCodes: ['en'], timePrecision: input.kind === 'chat' ? 'event' : 'chunk', status: 'active', moderation: 'allowed', externalMessageId: null, ...input };
}

type MomentIds = Record<string, string>;
/** The complete input timeline. Media events need the moment ids that the reducer assigns. */
const PENDING_MOMENT = 'fx-pending-moment:';
function timeline(moments: MomentIds | null = null): CaptureBundle['events'] {
  const events: CaptureBundle['events'] = [];
  const add = (atMs: number, event: DomainEvent) => events.push({ atMs, event });
  add(0, { type: 'metadata', title: 'Building a tiny cave platformer', category: 'Software and Game Development', atMs: 0, safety: allowed(0) });
  for (const speech of SPEECH) {
    const at = speech.endMs + 600;
    add(at, { type: 'source', source: source({ id: speech.id, kind: 'speech', startMs: speech.startMs, endMs: speech.endMs, actorId: null, text: speech.text }) });
    if (TOPIC_STARTS.includes(speech.id)) add(at, { type: 'topic', sourceRefs: [{ id: speech.id, revision: 1 }] });
  }
  const chats = [...SPARSE_CHAT, ...BURST].sort((a, b) => a.atMs - b.atMs);
  chats.forEach((chat, i) => {
    const id = `fx-chat-${String(i + 1).padStart(3, '0')}`, phrase = /moon jump/i.test(chat.text) ? LORE.term : undefined;
    add(chat.atMs, { type: 'source', source: source({ id, kind: 'chat', startMs: chat.atMs, endMs: chat.atMs, actorId: actorId(chat.actor), text: chat.text, externalMessageId: `fx-message-${String(i + 1).padStart(3, '0')}` }), ...(chat.emote ? { signals: { emote: true } } : {}), ...(phrase ? { phrase } : {}) });
  });
  const lorePrep = { originRefs: [{ id: LORE.originSpeech, revision: 1 }] };
  add(LORE.atMs, { type: 'lore.propose', id: LORE.id, term: LORE.term, explanation: LORE.en, ...lorePrep, safety: allowed(LORE.atMs), grounding: { acceptedClaimIds: [LORE.id], acceptedRelationKeys: [] }, language: 'en' });
  add(LORE.atMs, { type: 'lore.presentation', id: LORE.id, baseRevision: 1, privacyEpoch: 0, language: 'ru', term: LORE.ru.term, explanation: LORE.ru.explanation, safety: allowed(LORE.atMs), inputRefs: [] });
  for (const saved of SAVED_MOMENTS) add(saved.atMs, { type: 'moment.save', atMs: saved.atMs });
  for (const media of FOXLIGHT_MEDIA) {
    const momentId = moments ? moments[media.id] : PENDING_MOMENT + media.id;
    if (!momentId) throw new Error(`foxlight_moment_missing:${media.id}`);
    add(MEDIA_READY_AT[media.id]!, { type: 'media', privacyEpoch: 0, media: { id: media.id, revision: 1, momentId, refs: media.sourceIds.map(id => ({ id, revision: 1 })), captureStartMs: media.captureStartMs, captureEndMs: media.captureEndMs, durationMs: media.captureEndMs - media.captureStartMs, state: 'ready', kind: 'video', previousSession: false, ownerApproved: true } });
  }
  add(FOXLIGHT_RAID_AT_MS, { type: 'recap.trigger', trigger: { id: 'fx-raid-pixelmoth', sessionId: FOXLIGHT_SESSION_ID, reason: 'raid', occurredAt: iso(FOXLIGHT_RAID_AT_MS), fromLogin: 'pixelmoth', viewers: 37 } });
  return events.sort((a, b) => a.atMs - b.atMs);
}

type Wording = { title: string; summary: string; current: CurrentState };
function wording(title: string, claims: { text: string; role: GroundedClaim['role'] }[]): Wording {
  const role = (name: string) => claims.find(c => c.role === name && c.text.length <= 300)?.text ?? null;
  const summary = claims.reduce((text, claim) => { const next = text ? `${text} ${claim.text}` : claim.text; return next.length <= 700 ? next : text; }, '');
  return { title, summary, current: { goal: role('goal'), change: role('change'), now: role('state') ?? role('attempt') ?? role('outcome'), sourceTimeMs: 0, maxDependencyEndMs: 0 } };
}

type StoryInput = { packet: GenerationRequest['packet']; baseRevision: number; ownerEditRevision: number };
/** Writes the recorded story outcome for one request in both recap languages. */
function authorStory(request: GenerationRequest, input: StoryInput, segments: Map<string, number>) {
  const available = new Set([...input.packet.sources.map(s => s.id), ...input.packet.memory.flatMap(m => m.refs.map(r => r.id))]);
  const speeches = input.packet.sources.filter(s => s.kind === 'speech').map(s => SPEECH.find(x => x.id === s.id)!).filter(Boolean);
  const newest = Math.max(0, ...speeches.map(s => s.segment));
  const segment = segments.get(request.entityId) ?? newest;
  const version = request.reason === 'metadata' || newest > segment ? undefined
    : [...VERSIONS].reverse().find(v => v.segment === segment && v.needs.every(id => available.has(id)) && v.claims.every(c => c.support.every(id => available.has(id))));
  const hold = (language: FoxlightLanguage): StoryOutcome => ({ patch: { sessionId: FOXLIGHT_SESSION_ID, baseRevision: input.baseRevision, action: 'hold', title: null, claims: [], relations: [], currentAttemptId: null, language, missingContext: [] }, safety: allowed(request.requestedAtMs), grounding: { acceptedClaimIds: [], acceptedRelationKeys: [] } });
  if (!version) return { en: hold('en'), ru: hold('ru'), version: null };
  if (!segments.has(request.entityId)) segments.set(request.entityId, segment);
  const outcome = (language: FoxlightLanguage): StoryOutcome => {
    const claims = version.claims.map(c => ({ id: `c-${c.key}`, text: c[language], role: c.role, support: c.support.map(id => ({ id, revision: 1 })), attribution: 'streamer' as const, epistemic: 'supported_inference' as const }));
    const patch: StoryPatch = { sessionId: FOXLIGHT_SESSION_ID, baseRevision: input.baseRevision, action: input.baseRevision === 0 ? 'new_chapter' : 'update', title: version.title[language], claims, relations: [], currentAttemptId: null, language, missingContext: [] };
    return { patch, safety: allowed(request.requestedAtMs), grounding: { acceptedClaimIds: claims.map(c => c.id), acceptedRelationKeys: [] } };
  };
  return { en: outcome('en'), ru: outcome('ru'), version };
}

type AuthoringResult = { providers: RecordedOutcome[]; wordings: { en: Wording; ru: Wording }[]; momentIds: MomentIds; entities: Map<string, number>; lastStoryAtMs: number; firstPublishedAtMs: number; packets: StoryInput['packet'][] };
const versionsOf = (operation: RecordedOutcome['operation']) => ({ ...PROVIDER_VERSIONS, operation });

/** Runs the production reducer through the real ReplayDriver and records an outcome for each request it makes. */
function author(events: CaptureBundle['events']): AuthoringResult {
  const draft: CaptureBundle = { schemaVersion: 1, origin: 'authored', id: FOXLIGHT_ID, revision: 1, durationMs: FOXLIGHT_DURATION_MS, tickIntervalMs: TICK_MS, initial: initial(), events, providers: [], media: [], milestones: [], correction: null, assertions: [] };
  // Same length as a browser worker scope (UUID plus run number): packet byte limits see the same sizes.
  const driver = new ReplayDriver(draft, '00000000-0000-4000-8000-000000000000-1');
  const providers: RecordedOutcome[] = [], keys = new Set<string>(), segments = new Map<string, number>(), wordings: AuthoringResult['wordings'] = [], packets: StoryInput['packet'][] = [];
  let lastStoryAtMs = 0;
  const record = (operation: RecordedOutcome['operation'], input: unknown, output: unknown, delayMs = 0) => {
    const key = providerKey(operation, input);
    if (keys.has(key)) return;
    keys.add(key); providers.push({ ...versionsOf(operation), input, delayMs, output } as RecordedOutcome);
  };
  (driver as unknown as { providers: Pick<RecordedProviders, 'lookup' | 'clear'> }).providers = {
    clear() {},
    lookup(operation, input) {
      if (operation !== 'story') throw new FixtureMissing();
      const pending = driver.state.pendingGeneration;
      if (!pending) throw new FixtureMissing();
      const request = driver.ids.map(pending, 'logical'), story = input as StoryInput;
      if (story.packet.chapters.length || story.packet.lore.length) throw new Error('foxlight_packet_has_language_dependent_context');
      const {en, ru, version} = authorStory(request, story, segments);
      record('story', story, en, STORY_DELAY_MS);
      record('story', { ...story, packet: { ...story.packet, recapLanguage: 'ru' } }, ru, STORY_DELAY_MS);
      if (version) wordings.push({ en: wording(en.patch.title!, en.patch.claims), ru: wording(ru.patch.title!, ru.patch.claims) });
      packets.push(story.packet);
      lastStoryAtMs = driver.atMs + STORY_DELAY_MS;
      return { ...versionsOf('story'), input, delayMs: STORY_DELAY_MS, output: en };
    },
  };
  // Each clip is attached to the moment the reducer creates for it. Media events are queued later than their
  // moment, so the moment id is filled into the not yet executed event as soon as the moment exists.
  const internal = (driver as unknown as { bundle: CaptureBundle }).bundle.events;
  const momentIds: MomentIds = {};
  let firstPublishedAtMs = -1;
  for (let at = 0; at <= FOXLIGHT_DURATION_MS; at += TICK_MS) {
    driver.advanceTo(at);
    if (firstPublishedAtMs < 0 && driver.state.published?.chapters.length) firstPublishedAtMs = at;
    for (const moment of driver.state.moments) {
      const media = FOXLIGHT_MEDIA.find(m => !momentIds[m.id] && m.captureStartMs <= moment.endMs && m.captureEndMs >= moment.startMs && moment.startMs >= m.captureStartMs - 2_000);
      if (!media) continue;
      momentIds[media.id] = driver.ids.map(moment.id, 'logical');
      for (const list of [events, internal]) for (const item of list) if (item.event.type === 'media' && item.event.media.id === media.id) {
        if (item.atMs <= at) throw new Error('foxlight_media_before_moment');
        item.event.media.momentId = list === internal ? moment.id : momentIds[media.id]!;
      }
    }
  }
  if (driver.error) throw new Error(`foxlight_authoring_failed:${driver.error}`);
  const entities = new Map([...segments].map(([id, segment]) => [driver.ids.map(id, 'logical'), segment]));
  return { providers, wordings, momentIds, entities, lastStoryAtMs, firstPublishedAtMs, packets };
}

let cached: { bundle: CaptureBundle; packets: StoryInput['packet'][] } | null = null;
function build() {
  if (cached) return cached;
  const events = timeline(null), second = author(events);
  if (Object.keys(second.momentIds).length !== FOXLIGHT_MEDIA.length || events.some(e => e.event.type === 'media' && e.event.media.momentId?.startsWith(PENDING_MOMENT))) throw new Error('foxlight_moments_missing');
  const providers = [...second.providers], keys = new Set(providers.map(p => providerKey(p.operation, p.input)));
  const add = (operation: RecordedOutcome['operation'], input: unknown, output: unknown) => {
    const key = providerKey(operation, input);
    if (!keys.has(key)) { keys.add(key); providers.push({ ...versionsOf(operation), input, delayMs: 0, output } as RecordedOutcome); }
  };
  const checked = allowed(0);
  const translate = (from: Omit<Wording, 'current'>, to: Omit<Wording, 'current'> & { current?: CurrentState }, language: RecapLanguage) =>
    add('translation', { title: from.title, summary: from.summary, language }, { title: to.title, summary: to.summary, safety: checked, ...to.current ? { current: to.current } : {} } satisfies WordingOutcome);
  for (const { en, ru } of second.wordings) { translate(en, ru, 'ru'); translate(ru, en, 'en'); }
  const chapter3 = [...second.entities].find(([, segment]) => segment === 3)?.[0];
  if (!chapter3) throw new Error('foxlight_chapter_missing');
  add('owner_review', CORRECTION.en, { ...CORRECTION.en, safety: checked } satisfies WordingOutcome);
  translate(CORRECTION.en, CORRECTION.ru, 'ru'); translate(CORRECTION.ru, CORRECTION.en, 'en');
  const published = Math.ceil(second.firstPublishedAtMs / 1000) * 1000;
  const bundle = validateBundle({
    schemaVersion: 1, origin: 'authored', id: FOXLIGHT_ID, revision: 1, durationMs: FOXLIGHT_DURATION_MS, tickIntervalMs: TICK_MS, initial: initial(), events, providers,
    media: FOXLIGHT_MEDIA.map(m => ({ id: m.id, assetId: m.assetId, sourceRefs: m.sourceIds.map(id => ({ id, revision: 1 })), startMs: m.captureStartMs, endMs: m.captureEndMs })),
    milestones: [{ id: 'published', label: 'First published context', atMs: published }, { id: 'raid', label: 'Incoming raid', atMs: FOXLIGHT_RAID_MILESTONE_MS }],
    correction: { ...CORRECTION.en, targetId: chapter3, language: 'en', availableAtMs: Math.ceil(second.lastStoryAtMs / 1000) * 1000 },
    assertions: [{ atMs: published, kind: 'published', value: true }, { atMs: FOXLIGHT_DURATION_MS, kind: 'no-live-effects', value: true }],
  } satisfies CaptureBundle);
  cached = { bundle, packets: second.packets };
  return cached;
}

/** The Foxlight example as a replay bundle. Built deterministically from the authored timeline above. */
export function createFoxlightBundle(): CaptureBundle { return structuredClone(build().bundle); }
/** Request packets seen while authoring, for tests of packet stability. */
export function foxlightAuthoringPackets() { return structuredClone(build().packets); }

export type FoxlightRaid = { atMs: number; plan: RecapPlan; snapshot: PublicSnapshot; media: FoxlightMedia[]; background: typeof FOXLIGHT_BACKGROUND };
/**
 * The exact raid RecapPlan and published snapshot from a replay run, with logical ids
 * (media ids match FOXLIGHT_MEDIA). Deterministic: every call returns identical data.
 */
export function foxlightRaid(): FoxlightRaid {
  const driver = new ReplayDriver(createFoxlightBundle(), FOXLIGHT_ID);
  driver.advanceTo(FOXLIGHT_RAID_MILESTONE_MS);
  const playback = driver.state.playbacks.find(p => p.id.endsWith('fx-raid-pixelmoth') && p.plan);
  if (!playback?.plan || !driver.state.published) throw new Error('foxlight_raid_unavailable');
  return { atMs: FOXLIGHT_RAID_MILESTONE_MS, plan: driver.ids.map(playback.plan, 'logical'), snapshot: driver.ids.map(driver.state.published, 'logical'), media: structuredClone(FOXLIGHT_MEDIA), background: { ...FOXLIGHT_BACKGROUND } };
}
/** A stable digest of the example bundle, useful for cache keys. */
export const foxlightDigest = () => stateHash(createFoxlightBundle());
