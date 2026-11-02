import type { RecapLanguage, RecapPlan } from '../../shared/contracts/index.js';
import { countText, fill, messagesFor } from '../../i18n/index.js';
import { timecode } from './motion.js';

/** Everything the scene shows, taken from the captured plan. Missing material shortens the scene honestly. */
export type SceneScript = {
  language: RecapLanguage;
  welcomeOnly: boolean;
  greeting: string;           // first word group, on the vermilion plate
  guests: string | null;      // second word group (raiders, or the stream title for a manual show)
  viewers: number | null;     // counted on the small paper plate
  viewersLabel: (n: number) => string;
  titleLead: string;          // "Previously"
  titleRest: string | null;   // "on Foxlight Dev"
  chapters: { id: string; title: string; timecode: string; mediaId: string | null }[];
  /** `reactionMs`: where chat peaked, in ms after the clip's in-point (from the plan's burst and capture range); null when unknown. */
  moment: { chapterIndex: number; count: number; windowSeconds: number; messages: string[]; mediaId: string | null; reactionMs: number | null } | null;
  lore: { term: string; explanation: string | null; stamp: string } | null;
  now: { label: string; text: string; mediaId: string | null } | null;
  command: { before: string; command: string; after: string } | null;
  countLine: (n: number) => { big: string; small: string };
};

/** A single closing full stop reads as punctuation noise on a broadcast plate; keep everything else. */
const plate = (text: string) => text.trim().replace(/(?<![.])\.$/u, '');

export function sceneScript(plan: RecapPlan, extra: { channel?: string; title?: string } = {}): SceneScript {
  // Fixed labels come from the recap language's catalog (English when it has none); story text is already in that language.
  const language = plan.language, t = messagesFor(language).scene;
  const scene = plan.scene;
  const channel = (scene?.channelName || extra.channel || '').trim();
  const streamTitle = (scene?.streamTitle ?? extra.title ?? '').trim() || null;
  const arrivals = plan.arrivals;
  const raids = arrivals.length + plan.overflowArrivals.channels;
  const viewers = arrivals.length ? arrivals.reduce((n, a) => n + a.viewers, 0) + plan.overflowArrivals.viewers : null;
  let guests: string | null;
  if (arrivals.length) {
    const [first, second] = arrivals.map(a => a.fromLogin);
    if (raids > 2) guests = countText(language, raids - 1, t.raidMore, { first: first! });
    else if (second) guests = fill(t.raidTwo, { first: first!, second });
    else guests = fill(t.raidOne, { first: first! });
  } else guests = streamTitle ? plate(streamTitle) : null;
  const welcomeOnly = plan.variant === 'welcome';
  const nowBeat = plan.beats.find(beat => beat.kind === 'now');
  const chapters = welcomeOnly ? [] : scene
    ? scene.chapters.map(c => ({ id: c.id, title: plate(c.title), timecode: timecode(c.startMs), mediaId: c.mediaId && plan.media.some(m => m.id === c.mediaId) ? c.mediaId : null }))
    : plan.beats.filter(beat => beat.kind !== 'now' && beat.kind !== 'origin').slice(-3)
      .map(beat => ({ id: beat.id, title: beat.text, timecode: timecode(beat.sourceRange.startMs), mediaId: beat.mediaId }));
  let moment: SceneScript['moment'] = null;
  if (!welcomeOnly && scene?.moment) {
    const chapterIndex = scene.moment.chapterId ? chapters.findIndex(c => c.id === scene.moment!.chapterId) : -1;
    // The clip's in-point is measured from its capture start, so chat's real peak inside the clip follows from the plan.
    const clip = scene.moment.mediaId ? plan.media.find(m => m.id === scene.moment!.mediaId) : undefined;
    const offset = clip && !clip.previousSession && scene.moment.burstMs !== undefined ? scene.moment.burstMs - clip.captureStartMs - clip.inMs : null;
    const reactionMs = clip && offset !== null && offset >= 0 && offset <= clip.outMs - clip.inMs ? offset : null;
    if (chapterIndex >= 0) moment = { chapterIndex, count: scene.moment.count, windowSeconds: scene.moment.windowSeconds, messages: scene.moment.messages.slice(0, 14), mediaId: scene.moment.mediaId, reactionMs };
  }
  const lore = !welcomeOnly && scene?.lore ? { term: scene.lore.term, explanation: scene.lore.explanation || null, stamp: timecode(scene.lore.originMs) } : null;
  const nowText = welcomeOnly ? (streamTitle ?? nowBeat?.text ?? null) : scene ? scene.now?.text ?? null : nowBeat?.text ?? null;
  const nowMedia = welcomeOnly ? null : scene?.now?.mediaId && plan.media.some(m => m.id === scene.now!.mediaId) ? scene.now.mediaId : null;
  return {
    language, welcomeOnly,
    greeting: arrivals.length ? t.welcomeRaid : t.welcomeIn,
    guests: welcomeOnly && !arrivals.length ? null : guests,
    viewers,
    viewersLabel: n => countText(language, n, t.viewers),
    titleLead: t.titleLead,
    titleRest: channel ? fill(t.titleRest, { channel }) : null,
    chapters, moment, lore,
    now: nowText ? { label: t.now, text: plate(nowText), mediaId: nowMedia } : null,
    command: scene?.command ? { before: t.commandBefore, command: scene.command, after: t.commandAfter } : null,
    countLine: n => ({ big: countText(language, n, t.messages), small: countText(language, moment?.windowSeconds ?? 0, t.window) }),
  };
}
