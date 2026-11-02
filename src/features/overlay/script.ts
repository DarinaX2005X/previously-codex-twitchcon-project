import type { RecapPlan } from '../../shared/contracts/index.js';
import { timecode } from './motion.js';

/** Everything the scene shows, taken from the captured plan. Missing material shortens the scene honestly. */
export type SceneScript = {
  language: 'en' | 'ru';
  welcomeOnly: boolean;
  greeting: string;           // first word group, on the vermilion plate
  guests: string | null;      // second word group (raiders, or the stream title for a manual show)
  viewers: number | null;     // counted on the small paper plate
  viewersLabel: (n: number) => string;
  titleLead: string;          // "Previously"
  titleRest: string | null;   // "on Foxlight Dev"
  chapters: { id: string; title: string; timecode: string; mediaId: string | null }[];
  moment: { chapterIndex: number; count: number; windowSeconds: number; messages: string[]; mediaId: string | null } | null;
  lore: { term: string; explanation: string | null; stamp: string } | null;
  now: { label: string; text: string; mediaId: string | null } | null;
  command: { before: string; command: string; after: string } | null;
  countLine: (n: number) => { big: string; small: string };
};

/** A single closing full stop reads as punctuation noise on a broadcast plate; keep everything else. */
const plate = (text: string) => text.trim().replace(/(?<![.])\.$/u, '');
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

export function sceneScript(plan: RecapPlan, extra: { channel?: string; title?: string } = {}): SceneScript {
  const ru = plan.language === 'ru';
  const scene = plan.scene;
  const channel = (scene?.channelName || extra.channel || '').trim();
  const streamTitle = (scene?.streamTitle ?? extra.title ?? '').trim() || null;
  const arrivals = plan.arrivals;
  const raids = arrivals.length + plan.overflowArrivals.channels;
  const viewers = arrivals.length ? arrivals.reduce((n, a) => n + a.viewers, 0) + plan.overflowArrivals.viewers : null;
  let guests: string | null;
  if (arrivals.length) {
    const [first, second] = arrivals.map(a => a.fromLogin);
    if (raids > 2) guests = ru ? `рейдеры ${first} и ещё ${raids - 1}` : `${first} and ${raids - 1} more raids`;
    else if (second) guests = ru ? `рейдеры ${first} и ${second}` : `${first} and ${second} raiders`;
    else guests = ru ? `рейдеры ${first}` : `${first} raiders`;
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
    if (chapterIndex >= 0) moment = { chapterIndex, count: scene.moment.count, windowSeconds: scene.moment.windowSeconds, messages: scene.moment.messages.slice(0, 14), mediaId: scene.moment.mediaId };
  }
  const lore = !welcomeOnly && scene?.lore ? { term: scene.lore.term, explanation: scene.lore.explanation || null, stamp: ru ? `с ${timecode(scene.lore.originMs)}` : `since ${timecode(scene.lore.originMs)}` } : null;
  const nowText = welcomeOnly ? (streamTitle ?? nowBeat?.text ?? null) : scene ? scene.now?.text ?? null : nowBeat?.text ?? null;
  const nowMedia = welcomeOnly ? null : scene?.now?.mediaId && plan.media.some(m => m.id === scene.now!.mediaId) ? scene.now.mediaId : null;
  return {
    language: ru ? 'ru' : 'en', welcomeOnly,
    greeting: arrivals.length ? (ru ? 'Добро пожаловать,' : 'Welcome,') : (ru ? 'Добро пожаловать' : 'Welcome in'),
    guests: welcomeOnly && !arrivals.length ? null : guests,
    viewers,
    viewersLabel: n => ru ? `${n} ${plural(n, 'зритель', 'зрителя', 'зрителей')}` : `${n} ${n === 1 ? 'viewer' : 'viewers'}`,
    titleLead: ru ? 'Ранее' : 'Previously',
    titleRest: channel ? (ru ? `на канале ${channel}` : `on ${channel}`) : null,
    chapters, moment, lore,
    now: nowText ? { label: ru ? 'Сейчас' : 'Right now', text: plate(nowText), mediaId: nowMedia } : null,
    command: scene?.command ? (ru ? { before: 'Напишите', command: scene.command, after: 'в чат' } : { before: 'Type', command: scene.command, after: 'in chat' }) : null,
    countLine: n => ru
      ? { big: `${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`, small: `за ${moment?.windowSeconds ?? 0} ${plural(moment?.windowSeconds ?? 0, 'секунду', 'секунды', 'секунд')}` }
      : { big: `${n} ${n === 1 ? 'message' : 'messages'}`, small: `in ${moment?.windowSeconds ?? 0} seconds` },
  };
}
