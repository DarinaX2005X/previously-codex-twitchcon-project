import type { SceneScript } from './script.js';

/** One chapter's turn on the hero card. Times are scene milliseconds. */
export type Slot = {
  chapter: number;          // index into script.chapters
  focusAt: number;          // hero starts carrying this chapter (lift for the first, swap for the rest)
  openAt: number | null;    // card starts opening into its clip frame
  openedAt: number | null;  // frame fully open (shutter latch)
  endAt: number;            // next swap or the merge
  mediaId: string | null;
  chat: { burstAt: number; collapseAt: number; loreAt: number } | null;
};
export type Timeline = {
  duration: number;
  welcomeOnly: boolean;
  aAt: number; bAt: number | null; viewersAt: number | null;
  raidersOutAt: number;
  morphAt: number | null;     // greeting plate becomes the title
  dockAt: number;             // title shrinks to its corner label
  stackAt: number | null;     // chapter cards fly in
  liftAt: number | null;      // first card comes to front
  slots: Slot[];
  shownChapters: number[];    // chapters that appear at all (others were dropped for time)
  mergeAt: number;            // everything draws into the now card
  groupsAt: number[];         // now word groups land
  settleAt: number;
  exitAt: number;
  leaveAt: number;
  goneAt: number;
};

export const SWAP = 380, LIFT = 350, OPEN = 300, CHAT = 1900, CHAT_MIN = 1500, MERGE_TO_EXIT = 2600;

export function buildTimeline(script: SceneScript, duration: number, groupCount: number): Timeline {
  const welcomeOnly = script.welcomeOnly;
  const aAt = 0, bAt = script.guests ? 300 : null, viewersAt = script.viewers !== null && bAt !== null ? 620 : null;
  const raidersOutAt = welcomeOnly ? 1250 : 1020;
  const morphAt = welcomeOnly ? null : 1100;
  const dockAt = welcomeOnly ? 1250 : 2120;
  if (welcomeOnly) {
    const mergeAt = 1300;
    const groupsAt = Array.from({ length: groupCount }, (_, i) => mergeAt + 380 + i * 220);
    const exitAt = Math.max((groupsAt.at(-1) ?? mergeAt) + 1200, duration - 1600);
    return { duration, welcomeOnly, aAt, bAt, viewersAt, raidersOutAt, morphAt, dockAt, stackAt: null, liftAt: null, slots: [], shownChapters: [],
      mergeAt, groupsAt, settleAt: (groupsAt.at(-1) ?? mergeAt) + 260, exitAt, leaveAt: exitAt + 1250, goneAt: exitAt + 1550 };
  }
  const n = script.chapters.length;
  const stackAt = n ? 2250 : null, liftAt = n ? 2620 : null;
  const latestMerge = duration - 2000 - MERGE_TO_EXIT;
  // Decide which chapters fit, then hand spare time to clip playback.
  let chosen = script.chapters.map((_, i) => i);
  const momentIndex = script.moment?.chapterIndex ?? -1;
  let chat = momentIndex >= 0 ? CHAT : 0;
  const cost = (list: number[], chatMs: number) => list.reduce((sum, index, order) => {
    const media = !!script.chapters[index]!.mediaId, moment = index === momentIndex;
    const fixed = (order === 0 ? LIFT : SWAP) + (media ? OPEN : 0) + (moment ? chatMs : 0);
    const minimum = media ? (moment ? 150 : 350) : (moment ? 0 : 450);
    return sum + fixed + minimum;
  }, 0);
  const available = latestMerge - (liftAt ?? 2400);
  while (chosen.length && cost(chosen, chat) > available) {
    const drop = chosen.find(index => index !== momentIndex);
    if (drop !== undefined && chosen.length > 1) { chosen = chosen.filter(index => index !== drop); continue; }
    if (chat > CHAT_MIN) { chat = CHAT_MIN; continue; }
    if (chat) { chat = 0; continue; }
    chosen = chosen.slice(1);
  }
  let spare = Math.max(0, available - cost(chosen, chat));
  const extra = chosen.map(index => {
    const media = !!script.chapters[index]!.mediaId, moment = index === momentIndex && chat > 0;
    return media ? (moment ? 350 : 1250) : 450;
  });
  const extraTotal = Math.max(1, extra.reduce((a, b) => a + b, 0));
  const adds = extra.map(value => Math.round(Math.min(value, spare * value / extraTotal)));
  spare -= adds.reduce((a, b) => a + b, 0);
  const play = chosen.map((index, order) => {
    const media = !!script.chapters[index]!.mediaId, moment = index === momentIndex && chat > 0;
    return (media ? (moment ? 150 : 350) : (moment ? 0 : 450)) + adds[order]!;
  });
  const slots: Slot[] = [];
  let cursor = liftAt ?? 2400;
  chosen.forEach((index, order) => {
    const chapter = script.chapters[index]!;
    const focusAt = cursor;
    cursor += order === 0 ? LIFT : SWAP;
    let openAt: number | null = null, openedAt: number | null = null;
    if (chapter.mediaId) { openAt = cursor; cursor += OPEN; openedAt = cursor; }
    cursor += play[order]!;
    let slotChat: Slot['chat'] = null;
    if (index === momentIndex && chat > 0) {
      const burstAt = cursor, collapseAt = burstAt + chat - 650;
      slotChat = { burstAt, collapseAt, loreAt: collapseAt + 280 };
      cursor += chat;
    }
    slots.push({ chapter: index, focusAt, openAt, openedAt, endAt: 0, mediaId: chapter.mediaId, chat: slotChat });
  });
  slots.forEach((slot, i) => { slot.endAt = slots[i + 1]?.focusAt ?? cursor; });
  // Spare time first lengthens the readable hold on the now card, then the scene ends early rather than idling.
  const mergeAt = slots.length ? cursor : 2400;
  const hold = script.now ? Math.min(800, spare) : 0;
  const groupsAt = Array.from({ length: groupCount }, (_, i) => mergeAt + 520 + i * 240);
  const settleAt = (groupsAt.at(-1) ?? mergeAt + 400) + 280;
  const exitAt = script.now ? Math.min(duration - 2000, mergeAt + MERGE_TO_EXIT + hold) : Math.min(duration - 2000, mergeAt + 700);
  return { duration, welcomeOnly, aAt, bAt, viewersAt, raidersOutAt, morphAt, dockAt, stackAt, liftAt, slots, shownChapters: chosen,
    mergeAt, groupsAt, settleAt, exitAt, leaveAt: exitAt + 1450, goneAt: exitAt + 1800 };
}
