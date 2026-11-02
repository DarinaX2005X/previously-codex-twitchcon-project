import type { SceneScript } from './script.js';

/**
 * The middle of the scene tells one idea at a time:
 * the chapter list (what happened so far) → the one chapter that matters opens into its clip →
 * chat's reaction to it (a counted number and three real lines) → the running joke it became → the now card.
 */
export type Middle = {
  focus: number;               // chapter index carried into the clip frame
  listAt: number | null;       // the chapter list arrives (null when the cut is too short for it)
  rowsAt: number[];            // each chapter row lands
  litAt: number | null;        // the focus row lights, the other rows dim
  extractAt: number;           // the focus row lifts out; the list recedes
  openAt: number;              // the row grows into a clip frame (or a large title card without media)
  openedAt: number;
  mediaStart: number;          // scene time at which the clip plays from its pre-roll point
  counterAt: number | null;    // chat reaction: the counted number lands
  messagesAt: number[];        // real chat lines, one after another, stacked
  loreAt: number | null;       // the chat panel becomes the lore plate
  explAt: number | null;
  stampAt: number | null;
  end: number;
};
export type Timeline = {
  duration: number;
  welcomeOnly: boolean;
  aAt: number; bAt: number | null; viewersAt: number | null;
  raidersOutAt: number;
  morphAt: number | null;
  middleAt: number;            // the title lockup leaves
  middle: Middle | null;
  mergeAt: number;             // the frame becomes the now card
  groupsAt: number[];
  settleAt: number;
  exitAt: number;
  leaveAt: number;
  goneAt: number;
};

/** Footage shown before chat's measured peak (plan.scene.moment.burstMs), so what chat reacted to plays first. */
export const REACTION_LEAD_MS = 1000;
const NOW_HOLD = 2500, END = 2000;

type Shape = { list: boolean; messages: number; scale: number };

function middleFor(script: SceneScript, start: number, shape: Shape, hasMoment: boolean, hasLore: boolean, focusHasMedia: boolean): Middle {
  const k = (ms: number) => Math.round(ms * shape.scale);
  const n = script.chapters.length;
  const focus = script.moment ? script.moment.chapterIndex : Math.max(0, [...script.chapters.keys()].reverse().find(i => script.chapters[i]!.mediaId) ?? n - 1);
  let t = start;
  let listAt: number | null = null, litAt: number | null = null;
  const rowsAt: number[] = [];
  if (shape.list && n > 1) {
    listAt = t;
    for (let i = 0; i < n; i++) rowsAt.push(t + k(180) * i);
    t = rowsAt.at(-1)! + k(420);           // last row settled
    litAt = t + k(150);                    // a breath to read the list, then the focus row lights
    t = litAt + k(420);
  }
  const extractAt = t;
  const openAt = extractAt + k(80), openedAt = openAt + k(560);
  const mediaStart = openAt;
  t = openedAt;
  let counterAt: number | null = null;
  const messagesAt: number[] = [];
  if (hasMoment) {
    // The count lands on chat's measured peak in the footage (REACTION_LEAD_MS after the clip starts, sooner when the peak is earlier).
    counterAt = Math.max(openedAt + k(200), mediaStart + Math.min(REACTION_LEAD_MS, script.moment?.reactionMs ?? REACTION_LEAD_MS));
    for (let i = 0; i < shape.messages; i++) messagesAt.push(counterAt + k(240) + i * k(260));
    t = (messagesAt.at(-1) ?? counterAt) + k(380);
  } else t = openedAt + (focusHasMedia ? k(1100) : k(800));
  let loreAt: number | null = null, explAt: number | null = null, stampAt: number | null = null;
  if (hasLore) {
    loreAt = t; explAt = loreAt + k(220); stampAt = loreAt + k(460);
    t = explAt + k(1700);
  }
  return { focus, listAt, rowsAt, litAt, extractAt, openAt, openedAt, mediaStart, counterAt, messagesAt, loreAt, explAt, stampAt, end: t };
}

export function buildTimeline(script: SceneScript, duration: number, groupCount: number, focusHasMedia = true): Timeline {
  const welcomeOnly = script.welcomeOnly;
  const aAt = 0, bAt = script.guests ? 300 : null, viewersAt = script.viewers !== null && bAt !== null ? 620 : null;
  const raidersOutAt = welcomeOnly ? 1250 : 1020;
  const morphAt = welcomeOnly ? null : 1100;
  const finish = (mergeAt: number, middle: Middle | null, middleAt: number, hold = NOW_HOLD): Timeline => {
    const groupsAt = Array.from({ length: groupCount }, (_, i) => mergeAt + 480 + i * 240);
    const settleAt = (groupsAt.at(-1) ?? mergeAt + 400) + 280;
    const exitAt = script.now ? Math.min(duration - END, Math.max(mergeAt + hold, duration - END)) : Math.min(duration - END, mergeAt + 700);
    return { duration, welcomeOnly, aAt, bAt, viewersAt, raidersOutAt, morphAt, middleAt, middle, mergeAt, groupsAt, settleAt, exitAt, leaveAt: exitAt + 1450, goneAt: exitAt + 1800 };
  };
  if (welcomeOnly) {
    const mergeAt = 1300;
    const groupsAt = Array.from({ length: groupCount }, (_, i) => mergeAt + 380 + i * 220);
    const exitAt = Math.max((groupsAt.at(-1) ?? mergeAt) + 1200, duration - 1600);
    return { duration, welcomeOnly, aAt, bAt, viewersAt, raidersOutAt, morphAt, middleAt: mergeAt, middle: null, mergeAt, groupsAt, settleAt: (groupsAt.at(-1) ?? mergeAt) + 260, exitAt, leaveAt: exitAt + 1250, goneAt: exitAt + 1550 };
  }
  const start = 2250;
  if (!script.chapters.length) return finish(2400, null, 2250);
  const hasMoment = !!script.moment, hasLore = !!script.lore;
  const latestMerge = duration - END - (duration <= 10000 ? 2200 : NOW_HOLD);
  // Richest shape that fits; shorter cuts drop the list and a chat line before anything speeds up.
  const shapes: Shape[] = [{ list: true, messages: 3, scale: 1 }, { list: true, messages: 2, scale: 1 }, { list: false, messages: 3, scale: 1 }, { list: false, messages: 2, scale: 1 }];
  let middle = middleFor(script, start, shapes[0]!, hasMoment, hasLore, focusHasMedia);
  for (const shape of shapes) { middle = middleFor(script, start, shape, hasMoment, hasLore, focusHasMedia); if (middle.end <= latestMerge) break; }
  if (middle.end > latestMerge) {
    const shape = { list: false, messages: 2, scale: 1 };
    const span = middle.end - start;
    shape.scale = Math.max(.6, (latestMerge - start - (hasMoment ? REACTION_LEAD_MS : 0) * .2) / span);
    middle = middleFor(script, start, shape, hasMoment, hasLore, focusHasMedia);
  } else if (middle.end < latestMerge - 600) {
    // Longer cuts give each idea more reading time, up to a quarter more.
    const rich = middle.listAt !== null ? { list: true, messages: 3, scale: 1 } : { list: false, messages: 3, scale: 1 };
    rich.scale = Math.min(1.25, 1 + (latestMerge - middle.end) / Math.max(1, middle.end - start));
    const longer = middleFor(script, start, rich, hasMoment, hasLore, focusHasMedia);
    if (longer.end <= latestMerge) middle = longer;
  }
  return finish(middle.end, middle, start);
}
