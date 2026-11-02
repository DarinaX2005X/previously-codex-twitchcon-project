import type { RecapPlan, Rect } from '../../shared/contracts/index.js';
import { FRAME, conservativeMeasure, intersects, protectedBounds, wrapCaption, type MeasureText, type SceneLayout } from './geometry.js';
import { clamp, enter, exitIn, expoOut, glide, mix, pulse, quadIn, rand, seg, springAt } from './motion.js';
import { sceneScript, type SceneScript } from './script.js';
import { buildTimeline, type Slot, type Timeline } from './timeline.js';

/** Brand material: ink stage, paper cards, vermilion for the present and the mark, lime only for chat. */
export const COLORS = { ink: '#14171B', raised: '#1E232A', high: '#272D35', deep: '#0C0E11', paper: '#F4EFE6', paperShade: '#E4DDD0', paperSide: '#CFC5B3', vermilion: '#FF5A36', vermilionSide: '#C93F22', vermilionBack: '#8F2F1C', lime: '#C8F560', limeSide: '#86A833', mutedInk: '#A9B1BC', mutedPaper: '#4A4F57' } as const;
export type Tone = 'vermilion' | 'ink' | 'paper' | 'lime' | 'raised' | 'slip' | 'clear' | 'notch';
export type Run = { key: string; text: string; x: number; y: number; size: number; weight: number; color: string; opacity: number; blur: number; dy: number; dx?: number; scale: number; tabular?: boolean };
export type SceneObject = {
  key: string; kind: 'plate' | 'card' | 'slip' | 'tab' | 'mark' | 'line' | 'stamp';
  tone: Tone; x: number; y: number; w: number; h: number; rot: number; sx: number; sy: number; opacity: number; z: number; radius: number;
  runs: Run[]; mask?: boolean; fill?: string; side?: string; wipe?: number; origin?: 'tl'; lift?: number; rotX?: number; rotY?: number; sheen?: number;
  /** A notch cut into the top edge of a card (timecode or "Right now"), in local coordinates. */
  notch?: { x: number; w: number; h: number; runs: Run[]; opacity: number };
  media?: { id: string; x: number; y: number; w: number; h: number; radius: number; opacity: number; timeMs: number; playing: boolean };
  mark?: { glyph: number; back: number };
  blurX?: number; blurY?: number;
};
export type ScenePhase = 'welcome' | 'title' | 'chapters' | 'chat' | 'now' | 'return' | 'clear';
export type CaptionFrame = { text: string; lines: string[]; kind: RecapPlan['beats'][number]['kind']; sourceMs: number; reveal: number; outgoing: number; page: number; pages: number };
export type SceneFrame = {
  visible: boolean; phase: ScenePhase; timeMs: number;
  /** Clip envelope in 1920×1080 frame coordinates; objects are positioned relative to `band`. */
  clip: Rect; band: Rect; objects: SceneObject[];
  caption: CaptionFrame | null; nextCaption: CaptionFrame | null; openingExit: number;
};
export type SceneSoundEvent = { id: string; kind: string; atMs: number; gain: number; durationMs?: number };
export type RenderOptions = { reducedMotion?: boolean; measure?: MeasureText; hasMedia?: boolean; availableMedia?: (id: string) => boolean; channel?: string; title?: string };

type Box = { x: number; y: number; w: number; h: number };
type Words = { text: string; x: number; line: number; w: number }[];
type ChapterLayout = { closed: Words; open: Words; closedLines: number; openLines: number; closedSize: number; openSize: number };
type Geo = {
  W: number; H: number; compact: boolean; script: SceneScript; timeline: Timeline; measure: MeasureText;
  big: number; plateH: number; padX: number; welcomeY: number; greetW: number;
  guests: { text: string; size: number; w: number; h: number } | null;
  viewers: { size: number; h: number; w: number } | null;
  tile: number; lead: { x: number; w: number }; rest: { text: string; size: number; w: number; h: number; x: number; y: number } | null;
  closed: Box; open: Box; video: Box; notchH: number; notchSize: number; closedSize: number; openSize: number; stripH: number;
  chapters: ChapterLayout[];
  rx: number; rw: number; stripY: number;
  slips: { text: string; size: number; w: number; h: number; tx: number; ty: number; rot: number; fromY: number }[];
  counter: Box & { big: number; small: number } | null;
  lore: Box & { term: string; termSize: number; termW: number; expl: string[]; explSize: number; stampW: number; chipW: number } | null;
  now: { card: Box; size: number; words: Words; groups: number[][]; window: Box | null; notchW: number; textX: number; textY: number; lineH: number } | null;
  mark: { size: number; x: number; y: number };
  command: { w: number; h: number; size: number; parts: { text: string; weight: number; x: number }[] } | null;
};

const PAD = 0.3;
export const REACTION_LEAD_MS = 2900;
const lineH = (size: number) => Math.round(size * 1.04);
const NOTCH = 48;

function layoutWords(text: string, width: number, size: number, measure: MeasureText, weight: number): Words | null {
  const space = measure(' ', size, weight);
  const out: Words = [];
  let x = 0, line = 0;
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const w = measure(word, size, weight);
    if (w > width) return null;
    if (x > 0 && x + w > width) { line++; x = 0; }
    out.push({ text: word, x, line, w });
    x += w + space;
  }
  return out;
}
const lineCount = (words: Words) => words.length ? Math.max(...words.map(w => w.line)) + 1 : 0;
const ELLIPSIS = '…';
/** Lay text out within `maxLines` at `size`; if it cannot fit, keep the first words that do and end with an ellipsis.
 * A single word wider than the line is cut by characters. Nothing is ever dropped entirely. */
export function clampWords(text: string, width: number, size: number, maxLines: number, measure: MeasureText, weight: number): { words: Words; truncated: boolean } {
  const all = text.trim().split(/\s+/).filter(Boolean);
  for (let n = all.length; n >= 1; n--) {
    const candidate = n === all.length ? all.join(' ') : `${all.slice(0, n).join(' ').replace(/[\s,.;:!?-]+$/u, '')}${ELLIPSIS}`;
    const laid = layoutWords(candidate, width, size, measure, weight);
    if (laid && lineCount(laid) <= maxLines) return { words: laid, truncated: n < all.length };
  }
  let head = Array.from(all[0] ?? '');
  while (head.length > 1 && measure(head.join('') + ELLIPSIS, size, weight) > width) head = head.slice(0, -1);
  const word = head.join('') + ELLIPSIS;
  return { words: [{ text: word, x: 0, line: 0, w: measure(word, size, weight) }], truncated: true };
}
/** Largest size from `sizes` (descending) at which the whole text fits; otherwise the smallest size, clamped. */
export function fitText(text: string, width: number, sizes: number[], maxLines: number, measure: MeasureText, weight = 800): { size: number; words: Words; truncated: boolean; text: string } {
  for (const size of sizes) {
    const words = layoutWords(text, width, size, measure, weight);
    if (words && lineCount(words) <= maxLines) return { size, words, truncated: false, text };
  }
  const size = sizes.at(-1)!, clamped = clampWords(text, width, size, maxLines, measure, weight);
  return { size, ...clamped, text: clamped.words.map(w => w.text).join(' ') };
}
const plateText = (text: string, width: number, sizes: number[], measure: MeasureText) => {
  const fit = fitText(text, width, sizes, 1, measure);
  return { size: fit.size, text: fit.text };
};
/** Split a statement into 2–3 kinetic groups that never cross a line. */
function wordGroups(words: Words): number[][] {
  const groups: number[][] = [];
  const lines = lineCount(words);
  for (let line = 0; line < lines; line++) {
    const ids = words.map((w, i) => w.line === line ? i : -1).filter(i => i >= 0);
    if (ids.length >= 4 && lines < 3) { const half = Math.ceil(ids.length / 2); groups.push(ids.slice(0, half), ids.slice(half)); }
    else groups.push(ids);
  }
  while (groups.length > 3) { const last = groups.pop()!; groups[groups.length - 1]!.push(...last); }
  return groups;
}
const notchWidth = (measure: MeasureText, text: string, size: number) => Math.round(measure(text, size, 700) + 40);

const geoCache = new WeakMap<RecapPlan, Map<string, Geo>>();
function geometry(plan: RecapPlan, layout: SceneLayout, options: RenderOptions): Geo {
  const measure = options.measure ?? conservativeMeasure;
  const key = `${layout.bounds.x},${layout.bounds.y},${layout.bounds.width},${layout.bounds.height}|${options.channel ?? ''}|${options.title ?? ''}|${options.measure ? 'm' : 'c'}|${options.reducedMotion ? 'r' : ''}|${options.availableMedia ? plan.media.filter(m => options.availableMedia!(m.id)).map(m => m.id).join(',') : '*'}`;
  let cache = geoCache.get(plan);
  if (!cache) { cache = new Map(); geoCache.set(plan, cache); }
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = sceneScript(plan, { channel: options.channel, title: options.title });
  const W = layout.bounds.width, H = layout.bounds.height, compact = layout.mode === 'compact';
  const available = (id: string | null) => !!id && (!options.availableMedia || options.availableMedia(id));
  const script: SceneScript = { ...raw, chapters: raw.chapters.map(c => ({ ...c, mediaId: available(c.mediaId) ? c.mediaId : null })), now: raw.now ? { ...raw.now, mediaId: available(raw.now.mediaId) ? raw.now.mediaId : null } : null };
  // Welcome and title type scale with the band: 96–150 px.
  const big = Math.round(clamp(H * .235, 96, 150));
  const plateH = Math.round(big * 1.16), padX = Math.round(big * PAD);
  const greetW = measure(script.greeting, big, 800) + padX * 2;
  let guests: Geo['guests'] = null;
  if (script.guests) {
    const sizes = Array.from({ length: Math.floor((big - 64) / 4) + 1 }, (_, i) => big - i * 4);
    const fit = plateText(script.guests, W - 16 - 2 * Math.round(64 * PAD), sizes, measure);
    guests = { text: fit.text, size: fit.size, w: measure(fit.text, fit.size, 800) + 2 * Math.round(fit.size * PAD), h: Math.round(fit.size * 1.16) };
  }
  const vSize = Math.round(clamp(big * .42, 44, 60));
  const viewers = script.viewers !== null ? { size: vSize, h: Math.round(vSize * 1.4), w: Math.round(measure(script.viewersLabel(script.viewers), vSize, 700) + vSize * .9) } : null;
  const welcomeH = plateH + (guests ? 14 + guests.h : 0) + (viewers ? 14 + viewers.h : 0);
  const welcomeY = Math.max(10, Math.round((H - welcomeH) / 2));
  // Title lockup: the brand tile, "Previously" on the plate, "on Foxlight Dev" beside or under it.
  const tile = plateH;
  const leadX = tile + 18, leadW = measure(script.titleLead, big, 800) + padX * 2;
  let rest: Geo['rest'] = null;
  if (script.titleRest) {
    const top = Math.round(big * .74), sizes = Array.from({ length: Math.max(1, Math.floor((top - 56) / 4) + 1) }, (_, i) => top - i * 4);
    const fit = plateText(script.titleRest, W - leadX - 16 - 2 * Math.round(56 * PAD), sizes, measure);
    const size = fit.size, restText = fit.text;
    const w = measure(restText, size, 800) + 2 * Math.round(size * PAD), h = Math.round(size * 1.16);
    const beside = leadX + leadW + 16 + w <= W - 8;
    rest = { text: restText, size, w, h, x: beside ? leadX + leadW + 16 : leadX, y: beside ? welcomeY + (plateH - h) : welcomeY + plateH + 14 };
  }
  // Hero card: closed it is a paper title card; open it is a clip frame whose bottom strip carries the title.
  const closedSize = compact ? 76 : 88, openSize = compact ? 56 : 64;
  const x0 = compact ? 10 : 40;
  const fitOpen = (stripLines: number) => {
    const strip = stripLines * lineH(openSize) + 40;
    let openH = H - 24, videoH = openH - 18 - strip, videoW = Math.round(videoH * 16 / 9);
    const maxCw = W - x0 - (compact ? Math.max(380, W * .38) : 470);
    if (videoW + 36 > maxCw) { videoW = Math.round(maxCw - 36); videoH = Math.round(videoW * 9 / 16); openH = videoH + 18 + strip; }
    return { strip, openH, videoW, videoH, cw: videoW + 36 };
  };
  const chapterLayouts: ChapterLayout[] = [];
  const kept: SceneScript['chapters'] = [];
  let dims = fitOpen(1);
  const closedSizes = compact ? [76, 72, 68, 64] : [88, 84, 80, 76, 72, 68, 64], openSizes = compact ? [56] : [64, 60, 56];
  const layoutChapter = (title: string, cw: number): ChapterLayout => {
    // Fit each state; when either must be clamped, both carry the same shortened words so they can morph word by word.
    let c = fitText(title, cw - 96, closedSizes, 2, measure), o = fitText(title, cw - 64, openSizes, 2, measure);
    for (let pass = 0; pass < 4 && c.text !== o.text; pass++) {
      const shorter = c.words.length <= o.words.length ? c.text : o.text;
      c = fitText(shorter, cw - 96, closedSizes, 2, measure); o = fitText(shorter, cw - 64, openSizes, 2, measure);
    }
    return { closed: c.words, open: o.words, closedLines: lineCount(c.words), openLines: lineCount(o.words), closedSize: c.size, openSize: o.size };
  };
  if (script.chapters.some(c => layoutChapter(c.title, dims.cw).openLines > 1)) dims = fitOpen(2);
  for (const chapter of script.chapters) { kept.push(chapter); chapterLayouts.push(layoutChapter(chapter.title, dims.cw)); }
  const momentChapter = raw.moment ? script.chapters[raw.moment.chapterIndex] : undefined;
  script.chapters = kept;
  script.moment = raw.moment && momentChapter && kept.includes(momentChapter) ? { ...raw.moment, chapterIndex: kept.indexOf(momentChapter) } : null;
  const cw = dims.cw, closedH = NOTCH + 2 * lineH(closedSize) + 64;
  const open = { x: x0, y: Math.round((H - dims.openH) / 2), w: cw, h: dims.openH };
  // The closed card stands on the open frame's floor, so opening raises its top edge and the title never crosses the picture.
  const closed = { x: x0, y: open.y + open.h - closedH, w: cw, h: closedH };
  const video = { x: 18, y: 18, w: dims.videoW, h: dims.videoH };
  // Reaction column to the right of the hero: counter, slip pile, lore plate and the timeline strip.
  const rx = x0 + cw + 44, rw = W - rx - 10, stripY = H - 58;
  let counter: Geo['counter'] = null; const slips: Geo['slips'] = [];
  if (script.moment) {
    const line = script.countLine(script.moment.count);
    const bigC = compact ? 56 : 72, smallC = compact ? 38 : 44;
    const cwid = Math.max(measure(line.big, bigC, 800), measure(line.small, smallC, 700)) + 56;
    counter = { x: rx, y: 8, w: Math.min(cwid, rw), h: Math.round(bigC * 1.05 + smallC * 1.2 + 34), big: bigC, small: smallC };
    const size = compact ? 38 : 44, h = Math.round(size * 1.55), pitch = h - 6;
    const left = rx - 30, right = W - 8, top = counter.y + counter.h + 6;
    let rowY = stripY - h - 6, x = left, row = 0;
    script.moment.messages.forEach((text, i) => {
      const shown = fitText(text, right - left - size * 1.1, [size], 1, measure, 700).text;
      const w = Math.round(measure(shown, size, 700) + size * 1.1);
      if (x > left && x + w > right) { row++; rowY = Math.max(top, rowY - pitch); x = left + (row % 2) * 30; }
      const jitter = (rand(text, i) - .5) * 26;
      slips.push({ text: shown, size, w, h, tx: clamp(x + jitter, left - 10, right - w), ty: rowY + (rand(text, i + 9) - .5) * 12, rot: (rand(text, i + 3) - .5) * 10, fromY: open.y + video.y + video.h * (.15 + .6 * rand(text, i + 5)) });
      x += w + 10;
    });
  }
  let lore: Geo['lore'] = null;
  if (script.lore) {
    const w = Math.min(rw, compact ? rw : 780);
    const termFit = plateText(script.lore.term, w - 56, Array.from({ length: (compact ? 4 : 11) }, (_, i) => (compact ? 72 : 96) - i * 4), measure);
    const termSize = termFit.size, termText = termFit.text;
    const explSize = compact ? 36 : 40;
    const explanation = script.lore.explanation;
    const fit = explanation ? fitText(explanation, w - 56, [explSize, explSize - 4].filter(v => v >= 36), 3, measure, 700) : null;
    const lines = fit ? Array.from({ length: lineCount(fit.words) }, (_, i) => fit.words.filter(word => word.line === i).map(word => word.text).join(' ')) : [];
    const h = Math.round(28 + termSize * 1.02 + (lines.length ? 16 + lines.length * explSize * 1.22 : 0) + 30);
    const termW = measure(termText, termSize, 800);
    const plateW = Math.min(w, Math.max(termW + 56, ...lines.map(l => measure(l, explSize, 700) + 56)));
    lore = { term: termText, x: rx, y: Math.max(8, Math.round((stripY - h) / 2)), w: plateW, h, termSize, termW, expl: lines, explSize, stampW: measure(script.lore.stamp, 36, 700) + 28, chipW: Math.min(measure(termText, 36, 800) + 36, rw) };
  }
  // The now card: the largest object and the present, in vermilion. A corner window keeps the last clip playing.
  let now: Geo['now'] = null;
  if (script.now) {
    const cardW = W - 2 * x0;
    const wantsWindow = options.reducedMotion ? kept.length > 0 : !!(script.now.mediaId ?? [...kept].reverse().find(c => c.mediaId)?.mediaId);
    let chosen: { size: number; words: Words; ww: number } | null = null;
    const sizes = compact ? [88, 84, 80] : [112, 104, 96, 92, 88, 84, 80];
    const windows = wantsWindow ? (compact ? [Math.round(cardW * .3), 0] : [560, 500, 440, 380, 0]) : [0];
    // Prefer keeping the clip window at a large size; give up the window only when the statement cannot fit beside it.
    outer: for (const ww of windows) for (const size of sizes) {
      if (ww && size < (compact || options.reducedMotion ? 80 : 92)) continue;
      const words = layoutWords(script.now.text, cardW - 104 - (ww ? ww + 56 : 0), size, measure, 800);
      if (words && lineCount(words) <= 2) { chosen = { size, words, ww }; break outer; }
    }
    if (!chosen) { const fit = fitText(script.now.text, cardW - 104, [sizes.at(-1)!], 2, measure); chosen = { size: fit.size, words: fit.words, ww: 0 }; }
    if (chosen) {
      const lh = lineH(chosen.size), lines = lineCount(chosen.words), wh = Math.round(chosen.ww * 9 / 16);
      const cardH = Math.min(H - 16, NOTCH + Math.max(lines * lh + 120, wh + 80));
      const card = { x: x0, y: Math.round((H - cardH) / 2), w: cardW, h: cardH };
      now = { card, size: chosen.size, words: chosen.words, groups: wordGroups(chosen.words),
        window: chosen.ww ? { x: cardW - chosen.ww - 40, y: NOTCH + Math.round((cardH - NOTCH - wh) / 2) - 6, w: chosen.ww, h: wh } : null,
        notchW: notchWidth(measure, script.now.label, 36), textX: 52, textY: NOTCH + Math.round((cardH - NOTCH - lines * lh) / 2) - 8, lineH: lh };
    } else script.now = null;
  }
  const markSize = Math.round(clamp(H * .3, 120, 196));
  let command: Geo['command'] = null;
  if (script.command) {
    const size = compact ? 40 : 46, parts: { text: string; weight: number; x: number }[] = [];
    let x = 28;
    for (const [text, weight] of [[script.command.before, 700], [script.command.command, 800], [script.command.after, 700]] as const) { parts.push({ text, weight, x }); x += measure(text, size, weight) + measure(' ', size, 700); }
    command = { w: Math.round(x - measure(' ', size, 700) + 28), h: Math.round(size * 1.6), size, parts };
  }
  const timeline = buildTimeline(script, plan.durationMs, now ? now.groups.length : 0);
  const geo: Geo = { W, H, compact, script, timeline, measure, big, plateH, padX, welcomeY, greetW, guests, viewers, tile, lead: { x: leadX, w: leadW }, rest,
    closed, open, video, notchH: NOTCH, notchSize: 36, closedSize, openSize, stripH: dims.strip, chapters: chapterLayouts,
    rx, rw, stripY, slips, counter, lore, now, mark: { size: markSize, x: x0, y: H - markSize - 22 }, command };
  cache.set(key, geo);
  return geo;
}

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
function mixColor(a: string, b: string, p: number): string {
  const x = hex(a), y = hex(b), q = clamp(p);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i]! - v) * q)).join(',')})`;
}
const lerpBox = (a: Box, b: Box, p: number): Box => ({ x: mix(a.x, b.x, p), y: mix(a.y, b.y, p), w: mix(a.w, b.w, p), h: mix(a.h, b.h, p) });
function obj(partial: Partial<SceneObject> & Pick<SceneObject, 'key' | 'kind' | 'tone' | 'x' | 'y' | 'w' | 'h'>): SceneObject {
  return { rot: 0, sx: 1, sy: 1, opacity: 1, z: 1, radius: 16, runs: [], ...partial };
}
function run(key: string, text: string, x: number, y: number, size: number, weight: number, color: string, extra: Partial<Run> = {}): Run {
  return { key, text, x, y, size, weight, color, opacity: 1, blur: 0, dy: 0, scale: 1, ...extra };
}
/** Word that rises out of a mask with blur resolving to sharp. p: 0 hidden below → 1 settled; q: 0 settled → 1 gone above. */
function kinetic(r: Run, p: number, q = 0, travel = 1): Run {
  const a = enter(clamp(p)), b = quadIn(clamp(q));
  return { ...r, dy: ((1 - a) * r.size * .9 - b * r.size * 1.1) * travel, blur: (1 - a) * 12 + b * 10, opacity: Math.min(clamp(p * 3), 1 - clamp(q * 1.4 - .4)), scale: 1.08 - .08 * a };
}

export function sceneClip(layout: SceneLayout): Rect {
  // Let travel reach the true frame edge where the band already touches the safe margin and nothing is protected there.
  const b = layout.bounds;
  let clip: Rect = { ...b };
  const grow = (next: Rect) => { if (!layout.protected.some(p => intersects(next, p))) clip = next; };
  if (b.x <= FRAME.margin) grow({ ...clip, x: 0, width: clip.width + clip.x });
  if (b.y + b.height >= FRAME.height - FRAME.margin) grow({ ...clip, height: FRAME.height - clip.y });
  return clip;
}

/** Order in which things land on the timeline strip: finished chapters, and the lore chip after its chapter. */
function stripItems(g: Geo): { key: string; at: number; w: number; lore: boolean; chapter: number }[] {
  const T = g.timeline, items: { key: string; at: number; w: number; lore: boolean; chapter: number }[] = [];
  T.slots.forEach((slot, i) => {
    const next = T.slots[i + 1];
    if (next) items.push({ key: `strip:${slot.chapter}`, at: next.focusAt, w: notchWidth(g.measure, g.script.chapters[slot.chapter]!.timecode, 36), lore: false, chapter: slot.chapter });
    if (slot.chat && g.lore) items.push({ key: 'strip:lore', at: next ? next.focusAt + 120 : T.mergeAt, w: g.lore.chipW, lore: true, chapter: slot.chapter });
  });
  let x = g.rx;
  return items.map(item => { const out = { ...item, x }; x += item.w + 12; return out; }) as never;
}

function compute(t: number, g: Geo): SceneObject[] {
  const { script, timeline: T } = g;
  const objects: SceneObject[] = [];
  const ink = COLORS.ink, paper = COLORS.paper;
  const plateRadius = Math.round(g.big * .14);
  const exitAt = T.exitAt;
  const markCentre = { x: g.mark.x + g.mark.size / 2, y: g.mark.y + g.mark.size / 2 };
  // ── Beat 1: greeting plates. Beat 2: the greeting plate becomes "Previously", the brand tile arrives. ──
  const titleOut = T.welcomeOnly ? 0 : exitIn(seg(t, (T.stackAt ?? T.mergeAt) - 120, (T.stackAt ?? T.mergeAt) + 200));
  const welcomeDock = T.welcomeOnly ? glide(seg(t, T.mergeAt - 160, T.mergeAt + 260)) : 0;
  const titleGone = T.welcomeOnly ? (g.now ? exitIn(seg(t, T.mergeAt + 200, T.mergeAt + 480)) : exitIn(seg(t, exitAt, exitAt + 300))) : titleOut;
  const leadRuns: Run[] = [];
  const greetY = Math.round((g.plateH - g.big) / 2) - 2;
  const greet = run('greet', script.greeting, g.padX, greetY, g.big, 800, ink);
  if (T.welcomeOnly) leadRuns.push(greet);
  else {
    const m = T.morphAt!;
    leadRuns.push(kinetic(greet, 1, seg(t, m + 20, m + 190)));
    leadRuns.push(kinetic(run('lead', script.titleLead, g.padX, greetY, g.big, 800, ink), seg(t, m + 140, m + 420)));
  }
  const aIn = springAt(t, T.aAt, .58, 13), aLand = pulse(t, T.aAt + 170, 260);
  const morphP = T.welcomeOnly ? 0 : glide(seg(t, T.morphAt! + 20, T.morphAt! + 320));
  const aW = mix(g.greetW, g.lead.w, morphP);
  const aX = mix(-aW - 160, 0, aIn) + (T.welcomeOnly ? 0 : g.lead.x * glide(seg(t, T.morphAt! + 160, T.morphAt! + 520)));
  const squash = T.welcomeOnly ? 0 : pulse(t, T.morphAt! + 120, 380);
  if (titleGone < 1) objects.push(obj({ key: 'title-lead', kind: 'plate', tone: 'vermilion', origin: 'tl', x: aX, y: g.welcomeY - titleGone * (g.welcomeY + g.plateH + 60) - welcomeDock * 40,
    w: aW, h: g.plateH, radius: plateRadius, z: 30, mask: true, sx: 1 + aLand * .07 - squash * .06, sy: 1 - aLand * .06 + squash * .08,
    rot: mix(-3, 0, enter(seg(t, T.aAt, T.aAt + 400))) - titleGone * 3, runs: leadRuns }));
  // The brand tile: the rewind card slides out from behind the play-notch P (the same object that ends the scene).
  if (!T.welcomeOnly && t >= T.morphAt! + 200 && titleGone < 1) {
    const pop = springAt(t, T.morphAt! + 200, .5, 15);
    objects.push(obj({ key: 'title-tile', kind: 'mark', tone: 'vermilion', origin: 'tl', x: 0, y: g.welcomeY - titleGone * (g.welcomeY + g.plateH + 60), w: g.tile, h: g.tile, radius: g.tile * .26, z: 31,
      sx: mix(.3, 1, pop), sy: mix(.3, 1, pop), rot: mix(-12, 0, pop) - titleGone * 4, mark: { glyph: springAt(t, T.morphAt! + 330, .5, 16), back: glide(seg(t, T.morphAt! + 380, T.morphAt! + 640)) } }));
  }
  // Second word group: the raiders on an ink plate; leaves upward behind the lead plate.
  if (g.guests && T.bAt !== null) {
    const bIn = springAt(t, T.bAt, .6, 14), out = exitIn(seg(t, T.raidersOutAt + 60, T.raidersOutAt + 320));
    const y0 = g.welcomeY + g.plateH + 14;
    if (out < 1) objects.push(obj({ key: 'guests', kind: 'plate', tone: 'raised', x: mix(-g.guests.w - 160, 0, bIn), y: y0 + mix(40, 0, bIn) - out * (y0 + g.guests.h + 40), w: g.guests.w, h: g.guests.h,
      radius: plateRadius, z: 28, rot: mix(-5, 0, enter(seg(t, T.bAt, T.bAt + 450))) - out * 2, sx: 1 + pulse(t, T.bAt + 190, 240) * .06, sy: 1 - pulse(t, T.bAt + 190, 240) * .05,
      runs: [run('g', g.guests.text, Math.round(g.guests.size * PAD), Math.round((g.guests.h - g.guests.size) / 2) - 2, g.guests.size, 800, paper)] }));
    if (g.viewers && T.viewersAt !== null && script.viewers !== null) {
      const vIn = springAt(t, T.viewersAt, .5, 16), vOut = exitIn(seg(t, T.raidersOutAt, T.raidersOutAt + 240));
      const count = Math.round(script.viewers * expoOut(seg(t, T.viewersAt, T.viewersAt + 520)));
      const vy = y0 + g.guests.h + 14;
      if (vOut < 1) objects.push(obj({ key: 'viewers', kind: 'plate', tone: 'paper', origin: 'tl', x: 0, y: vy - vOut * (vy + 140), w: g.viewers.w, h: g.viewers.h, radius: 14, z: 27,
        sx: mix(.4, 1, vIn), sy: mix(.4, 1, vIn), opacity: clamp(seg(t, T.viewersAt, T.viewersAt + 80)), rot: mix(4, 0, vIn),
        runs: [run('v', script.viewersLabel(count), Math.round(g.viewers.size * .45), Math.round((g.viewers.h - g.viewers.size) / 2) - 1, g.viewers.size, 700, ink, { tabular: true })] }));
    }
  }
  // "on Foxlight Dev" slides out from under the lead plate.
  if (g.rest && !T.welcomeOnly && titleOut < 1) {
    const m = T.morphAt!, outP = springAt(t, m + 380, .7, 13);
    const hidden = { x: g.lead.x + Math.max(0, g.lead.w - g.rest.w), y: g.rest.y };
    if (t >= m + 360) objects.push(obj({ key: 'title-rest', kind: 'plate', tone: 'paper', origin: 'tl', x: mix(hidden.x, g.rest.x, outP), y: g.rest.y - titleOut * (g.rest.y + g.rest.h + 60), w: g.rest.w, h: g.rest.h,
      radius: Math.round(g.rest.size * .14), z: 29, sx: mix(Math.min(1, g.lead.w * .9 / g.rest.w), 1, clamp(outP)), rot: -titleOut * 2,
      runs: [run('r', g.rest.text, Math.round(g.rest.size * PAD), Math.round((g.rest.h - g.rest.size) / 2) - 2, g.rest.size, 800, ink)] }));
  }
  // ── Beat 3: the deck, the hero card and its clip frame ──
  objects.push(...heroState(t, g));
  // Timeline strip on the reaction column's floor: finished chapters and the lore chip, all quiet.
  const items = stripItems(g) as unknown as { key: string; at: number; w: number; lore: boolean; chapter: number; x: number }[];
  if (items.length && T.stackAt !== null) {
    const lineIn = enter(seg(t, items[0]!.at - 200, items[0]!.at + 300));
    const absorb = g.now ? glide(seg(t, T.mergeAt + 40, T.mergeAt + 460)) : exitIn(seg(t, exitAt, exitAt + 300));
    if (absorb < 1 && lineIn > 0) objects.push(obj({ key: 'strip', kind: 'line', tone: 'paper', x: g.rx - 30, y: g.stripY + g.notchH / 2, w: (g.W - g.rx + 22) * lineIn * (1 - absorb), h: 3, radius: 2, z: 3, opacity: .55 }));
    items.forEach((item, i) => {
      if (item.lore || t < item.at) return;
      const drop = glide(seg(t, item.at, item.at + 420));
      const from = { x: g.open.x + 28, y: g.open.y };
      const into = g.now ? enter(seg(t, T.mergeAt + i * 50, T.mergeAt + 420 + i * 50)) : 0;
      if (into >= 1) return;
      const target = g.now ? { x: g.now.card.x + 28, y: g.now.card.y } : { x: item.x, y: g.stripY };
      const arc = Math.sin(drop * Math.PI) * -70;
      const tc = script.chapters[item.chapter]!.timecode;
      objects.push(obj({ key: item.key, kind: 'tab', tone: 'notch', x: mix(mix(from.x, item.x, drop), target.x, into), y: mix(mix(from.y, g.stripY, drop) + arc, target.y, into), w: item.w, h: g.notchH, radius: 12, z: 4,
        rot: mix(-8, 0, drop) * (1 - into), sx: 1 - into * .4, sy: 1 - into * .4, opacity: 1 - seg(into, .7, 1),
        runs: [run('tc', tc, 20, Math.round((g.notchH - 36) / 2) - 1, 36, 700, paper, { tabular: true })] }));
    });
  }
  // ── Beat 4: chat slips burst out of the frame, the counter counts, the slips collapse into the lore plate ──
  const chatSlot = T.slots.find(slot => slot.chat);
  if (chatSlot?.chat && script.moment) {
    const { burstAt, collapseAt, loreAt } = chatSlot.chat;
    const m = g.slips.length, gap = Math.min(80, 900 / Math.max(1, m));
    const L = g.lore;
    const gather = L ? { x: L.x + L.w / 2, y: L.y + L.h / 2 } : { x: g.rx + 200, y: g.H / 2 };
    g.slips.forEach((slip, i) => {
      const at = burstAt + i * gap;
      if (t < at) return;
      const fly = expoOut(seg(t, at, at + 520)), settle = springAt(t, at + 320, .45, 18);
      const back = (m - 1 - i) * 16, col = glide(seg(t, collapseAt + back, collapseAt + back + 360));
      if (col >= 1) return;
      const fromX = g.open.x + g.open.w - slip.w * .5;
      const x = mix(mix(fromX, slip.tx, fly), gather.x - slip.w / 2, col);
      const y = mix(mix(slip.fromY, slip.ty, fly) - Math.sin(fly * Math.PI) * 70, gather.y - slip.h / 2, col);
      const s = mix(mix(.5, 1, fly) * (1 + (1 - settle) * .05), .3, col);
      objects.push(obj({ key: `slip:${i}`, kind: 'slip', tone: 'slip', x, y, w: slip.w, h: slip.h, radius: 14, z: 60 + i, rot: mix(mix(-24, slip.rot, fly), 0, col), sx: s, sy: s,
        opacity: clamp(seg(t, at, at + 50)) * (1 - seg(col, .75, 1)), runs: [run('m', slip.text, Math.round(slip.size * .55), Math.round((slip.h - slip.size) / 2) - 2, slip.size, 700, paper)] }));
    });
    if (g.counter) {
      const c = g.counter, inP = springAt(t, burstAt + 60, .55, 15), outP = exitIn(seg(t, collapseAt + 40, collapseAt + 300));
      if (t >= burstAt + 60 && outP < 1) {
        const n = Math.round(script.moment.count * Math.pow(seg(t, burstAt + 80, burstAt + 1150), .7));
        const line = script.countLine(n), fin = script.countLine(script.moment.count);
        const bump = pulse(t, burstAt + 1150, 260);
        objects.push(obj({ key: 'counter', kind: 'plate', tone: 'lime', origin: 'tl', x: c.x, y: mix(-c.h - 30, c.y, inP) - outP * (c.h + 90), w: c.w, h: c.h, radius: 18, z: 80, rot: mix(-6, -1.5, inP), sx: 1 + bump * .06, sy: 1 + bump * .06,
          runs: [run('n', n === script.moment.count ? fin.big : line.big, 28, 16, c.big, 800, ink, { tabular: true }), run('s', fin.small, 28, 16 + Math.round(c.big * 1.05), c.small, 700, ink)] }));
      }
    }
    if (L && script.lore) objects.push(...loreState(t, g, chatSlot, items as never));
  }
  // ── Beat 6: the mark and the real chat command, then everything leaves ──
  objects.push(...markState(t, g));
  void markCentre;
  return objects;
}

/** The lore plate: forms from the collapsed slips, holds, then shrinks into a vermilion chip on the strip. */
function loreState(t: number, g: Geo, slot: Slot, items: { key: string; lore: boolean; x: number; w: number; at: number }[]): SceneObject[] {
  const L = g.lore!, T = g.timeline, s = g.script, out: SceneObject[] = [];
  const loreAt = slot.chat!.loreAt;
  if (t < loreAt) return out;
  const chip = items.find(item => item.lore);
  const recedeAt = chip?.at ?? T.mergeAt;
  const recede = glide(seg(t, recedeAt, recedeAt + 440));
  const absorb = g.now ? enter(seg(t, T.mergeAt + 80, T.mergeAt + 480)) : exitIn(seg(t, T.exitAt, T.exitAt + 300));
  if (absorb >= 1) return out;
  const pop = springAt(t, loreAt, .5, 15);
  const chipBox = { x: chip?.x ?? L.x, y: g.stripY, w: L.chipW, h: g.notchH };
  const nowTarget = g.now ? { x: g.now.card.x + 40, y: g.now.card.y, w: L.chipW, h: g.notchH } : chipBox;
  const box = lerpBox(lerpBox(L, chipBox, recede), nowTarget, absorb);
  const termSize = mix(L.termSize, 36, recede);
  const scale = mix(.35, 1, pop);
  const runs: Run[] = [run('t', L.term, mix(28, 18, recede), mix(24, Math.round((g.notchH - 36) / 2) - 1, recede), termSize, 800, COLORS.ink)];
  const explOut = clamp(recede * 3);
  L.expl.forEach((line, i) => {
    const p = seg(t, loreAt + 160 + i * 70, loreAt + 480 + i * 70);
    runs.push({ ...kinetic(run(`e${i}`, line, 28, Math.round(24 + L.termSize * 1.02 + 16 + i * L.explSize * 1.22), L.explSize, 700, COLORS.ink), p), opacity: Math.min(clamp(p * 3), 1 - explOut) });
  });
  out.push(obj({ key: 'lore', kind: 'plate', tone: 'vermilion', origin: 'tl', ...box, radius: mix(20, 12, recede), z: absorb > 0 ? 45 : 56, sx: scale * (1 - absorb * .4), sy: scale * (1 - absorb * .4), rot: mix(mix(5, -1.2, pop), 0, recede), mask: true,
    opacity: 1 - seg(absorb, .7, 1), runs }));
  const stamp = springAt(t, loreAt + 380, .4, 20);
  if (t >= loreAt + 380 && recede < 1) out.push(obj({ key: 'lore-stamp', kind: 'stamp', tone: 'ink', origin: 'tl', x: box.x + box.w - L.stampW + 10, y: box.y - 22, w: L.stampW, h: 54, radius: 10, z: 57,
    sx: mix(1.7, 1, stamp), sy: mix(1.7, 1, stamp), rot: 4, opacity: clamp(seg(t, loreAt + 380, loreAt + 430)) * (1 - clamp(recede * 2.5)),
    runs: [run('st', s.lore!.stamp, 14, 8, 36, 700, COLORS.paper, { tabular: true })] }));
  return out;
}

function heroState(t: number, g: Geo): SceneObject[] {
  const { script, timeline: T } = g;
  const out: SceneObject[] = [];
  const ink = COLORS.ink, paper = COLORS.paper;
  const C = g.closed, F = g.open, N = g.now, V = g.video;
  const slots = T.slots, exitAt = T.exitAt;
  if (t >= exitAt + 560) return out;
  let slotIndex = -1;
  if (slots.length && T.stackAt !== null && t >= T.stackAt) slotIndex = 0;
  for (let i = 1; i < slots.length; i++) if (t >= slots[i]!.focusAt) slotIndex = i;
  const slot = slotIndex >= 0 ? slots[slotIndex]! : undefined;
  const mergeP = N && slots.length ? glide(seg(t, T.mergeAt, T.mergeAt + 650)) : 0;
  let box: Box, rot = 0, open = 0;
  if (!slot) {
    if (!N || t < T.mergeAt - 160) return out;
    // Without chapters the now card enters from the left edge on its own.
    const inP = springAt(t, T.mergeAt - 160, .7, 12);
    box = { ...N.card, x: mix(-N.card.w - 200, N.card.x, inP) };
    rot = mix(-4, 0, enter(seg(t, T.mergeAt - 160, T.mergeAt + 420)));
  } else {
    if (slotIndex === 0) {
      const arrive = enter(seg(t, T.stackAt!, T.stackAt! + 520));
      box = { ...C, x: mix(-C.w - 200, C.x, arrive), y: C.y + (1 - arrive) * 80 };
      rot = mix(-14, 0, arrive);
    } else box = { ...C };
    const openP = slot.openAt !== null ? glide(seg(t, slot.openAt, slot.openedAt!)) : 0;
    open = openP;
    if (slotIndex > 0 && openP === 0) {
      const prev = slots[slotIndex - 1]!, fold = glide(seg(t, slot.focusAt, slot.focusAt + 240));
      box = lerpBox(prev.openAt !== null ? F : C, C, fold);
      open = prev.openAt !== null ? 1 - fold : 0;
    } else box = lerpBox(box, F, openP);
  }
  let scale = 1;
  if (slot?.openedAt != null) scale *= 1 + pulse(t, slot.openedAt, 240) * .018;
  if (N) scale *= 1 + .025 * glide(seg(t, T.settleAt - 300, exitAt + 100));
  if (mergeP > 0) box = lerpBox(box, N!.card, mergeP);
  const contract = glide(seg(t, exitAt + 40, exitAt + 480));
  const markBox = { x: g.mark.x, y: g.mark.y, w: g.mark.size, h: g.mark.size };
  if (contract > 0) box = lerpBox(box, markBox, contract);
  const breathe = N && t > T.mergeAt + 300 ? Math.sin((t - T.mergeAt - 300) / 1500 * Math.PI) : 0;
  const settled = N ? seg(t, T.mergeAt + 300, T.mergeAt + 900) * (1 - contract) : 0;
  const rotY = breathe * 2 * settled, rotX = (Math.cos((t - T.mergeAt) / 1900 * Math.PI) - 1) * .8 * settled;
  // Paper while it carries chapters; the present is vermilion.
  const presentP = N ? (slots.length ? mergeP : 1) : contract;
  const fill = N ? undefined : presentP > 0 ? mixColor(COLORS.paper, COLORS.vermilion, presentP) : undefined;
  const wipe = N ? clamp(presentP * 1.3) : undefined;
  const side = presentP > 0 ? mixColor(COLORS.paperSide, COLORS.vermilionSide, presentP) : undefined;
  const radius = mix(mix(24, 28, open), g.mark.size * .26, contract);
  // ── Deck: waiting cards sit behind the hero, each a little higher and further right ──
  if (slots.length && T.stackAt !== null && mergeP < 1) slots.forEach((s0, order) => {
    if (order === 0) return;
    const arrive = enter(seg(t, T.stackAt! + order * 90, T.stackAt! + order * 90 + 520));
    const taken = seg(t, s0.focusAt - 60, s0.focusAt + 200);
    if (taken >= 1) return;
    const waiting = slots.filter((s1, k) => k > 0 && s1.focusAt - 60 > t);
    const k = Math.max(0, waiting.indexOf(s0)) + 1;
    const base = slotIndex >= 0 ? box : C;
    const offset = { x: 26 * k, y: -18 * k };
    const deckBox = { x: base.x + offset.x * (1 - taken), y: base.y + offset.y * (1 - taken), w: base.w, h: base.h };
    const flyIn = { x: mix(-C.w - 200, deckBox.x, arrive), y: deckBox.y + (1 - arrive) * 80 };
    const words = g.chapters[s0.chapter]!.closed, lines = g.chapters[s0.chapter]!.closedLines;
    out.push(obj({ key: `deck:${s0.chapter}`, kind: 'card', tone: 'paper', x: flyIn.x, y: flyIn.y, w: deckBox.w, h: deckBox.h, radius: mix(24, 28, open), z: 40 - k,
      rot: mix(-14 - k * 3, k * 1.4, arrive) * (1 - taken), fill: mixColor(COLORS.paperShade, '#C9C1B3', (k - 1) * .5), opacity: 1 - seg(taken, .7, 1) - mergeP, lift: .3,
      notch: { x: 28 + k * 18, w: notchWidth(g.measure, script.chapters[s0.chapter]!.timecode, 36), h: g.notchH, opacity: 1, runs: [] },
      runs: words.map((w, i) => { const cs = g.chapters[s0.chapter]!.closedSize; return run(`d${i}`, w.text, 48 + w.x, NOTCH + 32 + (2 - lines) * lineH(cs) / 2 + w.line * lineH(cs), cs, 800, COLORS.mutedPaper); }) }));
  });
  // ── Media: the slot's clip fills the frame's window; after the merge the last clip keeps playing in a corner window ──
  let media: SceneObject['media'] | undefined;
  const lastMedia = [...slots].reverse().find(s => s.mediaId)?.mediaId ?? null;
  const nowMedia = script.now?.mediaId ?? lastMedia;
  const frameMedia = slot?.mediaId && open > 0 ? slot.mediaId : null;
  const mediaId = mergeP > .55 ? nowMedia : frameMedia ?? (mergeP > 0 ? lastMedia : null);
  if (mediaId) {
    const win = N?.window ?? { x: box.w / 2, y: box.h / 2, w: 0, h: 0 };
    const anchored = { ...V, y: box.h - (F.h - V.y) };
    const inner = mergeP > 0 ? lerpBox(V, win, mergeP) : anchored;
    const collapse = exitIn(seg(t, exitAt, exitAt + 220));
    const momentStart = slot?.chat ? slot.chat.burstAt - REACTION_LEAD_MS : null;
    const mediaStart = mergeP > .55 && script.now?.mediaId ? T.mergeAt : (momentStart ?? slot?.openAt ?? T.mergeAt);
    const folding = !!slot && slotIndex > 0 && slot.openAt !== null && t < slot.openAt || !!slot && slot.openAt === null && open > 0;
    // The frame opens as a shutter: the picture is revealed from its centre line outward.
    const reveal = 1;
    media = { id: mediaId, x: mix(inner.x, inner.x + inner.w / 2, collapse), y: mix(inner.y + inner.h / 2 * (1 - reveal), inner.y + inner.h / 2, collapse), w: inner.w * (1 - collapse), h: inner.h * reveal * (1 - collapse),
      radius: 14, opacity: (1 - collapse) * (mergeP > 0 ? 1 : clamp(open * 2.2 - .15)) * (folding ? clamp(open * 1.8 - .3) : 1) * (N && !N.window ? 1 - clamp(mergeP * 2.5) : 1), timeMs: Math.max(0, t - mediaStart), playing: collapse < 1 };
  }
  // ── Words: chapter title (closed 88 px → open 64 px in the frame's strip), swaps word by word; the now statement lands in groups ──
  const runs: Run[] = [];
  const titleRuns = (index: number, s0: Slot, enterP: number, exitQ: number) => {
    const L = g.chapters[index]!, ride = s0.openAt !== null ? glide(seg(t, s0.openAt + 30, s0.openedAt! + 60)) * (s0 === slot ? clamp(open * 4) : 1) : 0;
    const closedTop = box.h - (C.h - (NOTCH + 32 + (2 - L.closedLines) * lineH(L.closedSize) / 2));
    const openTop = V.y + V.h + Math.round((g.stripH - L.openLines * lineH(L.openSize)) / 2) - 2;
    // Open-state positions are measured against the card's actual height so the words stay on the strip.
    const openTopNow = box.h - (F.h - openTop);
    return L.closed.map((w, i) => {
      const o = L.open[i]!;
      const r = run(`w${index}:${i}`, w.text, mix(48 + w.x, 32 + o.x, ride), mix(closedTop + w.line * lineH(L.closedSize), openTopNow + o.line * lineH(L.openSize), ride), mix(L.closedSize, L.openSize, ride), 800, ink);
      return kinetic(r, clamp(enterP * (L.closed.length + 4) / 4 - i * .25), clamp(exitQ * (L.closed.length + 3) / 3 - i * .33));
    });
  };
  if (slot && contract <= 0 && mergeP < 1) {
    const L = g.chapters[slot.chapter]!;
    const swapIn = slotIndex > 0 ? seg(t, slot.focusAt + 220, slot.focusAt + 220 + 200 + L.closed.length * 55) : 1;
    runs.push(...titleRuns(slot.chapter, slot, swapIn, N ? seg(t, T.mergeAt - 40, T.mergeAt + 220) : 0));
    const prev = slots[slotIndex - 1];
    if (prev && t < slot.focusAt + 420) runs.push(...titleRuns(prev.chapter, prev, 1, seg(t, slot.focusAt, slot.focusAt + 300)));
  }
  if (N && (mergeP > 0 || !slots.length)) {
    const textOut = seg(t, exitAt - 20, exitAt + 240);
    N.groups.forEach((group, gi) => {
      const at = T.groupsAt[gi] ?? T.mergeAt;
      group.forEach((wi, k) => {
        const w = N.words[wi]!;
        const textY = box.h - (N.card.h - N.textY);
        runs.push(kinetic(run(`now${wi}`, w.text, N.textX + w.x, textY + w.line * N.lineH, N.size, 800, ink), seg(t, at - 380 + k * 45, at + k * 45), clamp(textOut * 1.7 - (N.groups.length - 1 - gi) * .15)));
      });
    });
  }
  // ── Notch cut into the top edge: timecode, a new one rising on each swap, then "Right now" ──
  let notch: SceneObject['notch'];
  const notchOut = enter(seg(t, exitAt, exitAt + 200));
  if ((slot || N) && notchOut < 1) {
    const toNow = N ? (slots.length ? seg(t, T.mergeAt + 120, T.mergeAt + 420) : 1) : 0;
    const ty = Math.round((g.notchH - 36) / 2) - 1;
    const nruns: Run[] = [];
    let w = N?.notchW ?? 120;
    if (slot) {
      const tc = script.chapters[slot.chapter]!.timecode;
      const rise = slotIndex > 0 ? enter(seg(t, slot.focusAt + 160, slot.focusAt + 420)) : 1;
      w = mix(notchWidth(g.measure, tc, 36), N?.notchW ?? 0, enter(toNow));
      nruns.push({ ...kinetic(run('tc' + slot.chapter, tc, 20, ty, 36, 700, paper, { tabular: true }), rise, toNow, 1.4) });
    }
    if (N) nruns.push(kinetic(run('now-label', script.now!.label, 20, ty, 36, 700, paper), toNow, notchOut, 1.4));
    notch = { x: 28, w: Math.max(40, w), h: g.notchH * (1 - notchOut), runs: nruns, opacity: 1 };
  }
  const sheen = N && t > T.settleAt - 200 && contract <= 0 ? seg(t, T.settleAt - 200, T.settleAt + 1800) : undefined;
  out.push(obj({ key: 'hero', kind: 'card', tone: 'paper', x: box.x, y: box.y, w: box.w, h: box.h, radius, z: 50, rot, sx: scale, sy: scale,
    lift: .5 + Math.sin(open * Math.PI) * .4, rotX, rotY, fill, side, wipe, runs, media, sheen, mask: true, notch, opacity: 1 - seg(t, exitAt + 500, exitAt + 560) }));
  return out;
}

function markState(t: number, g: Geo): SceneObject[] {
  const T = g.timeline, X = T.exitAt, out: SceneObject[] = [];
  if (t < X + 440 || t >= T.goneAt) return out;
  const s = g.mark.size;
  const glyph = springAt(t, X + 400, .5, 16), back = glide(seg(t, X + 440, X + 700));
  const leave = exitIn(seg(t, T.leaveAt, T.leaveAt + 330));
  const settleBounce = pulse(t, X + 470, 260);
  const drift = seg(t, X + 700, T.leaveAt) * 10;
  out.push(obj({ key: 'mark', kind: 'mark', tone: 'vermilion', x: g.mark.x - leave * (g.mark.x + s + 900) + drift, y: g.mark.y, w: s, h: s, radius: s * .26, z: 70, sx: 1 - settleBounce * .05, sy: 1 + settleBounce * .05, rot: -leave * 6,
    mark: { glyph, back } }));
  if (g.command) {
    const c = g.command, inP = springAt(t, X + 640, .7, 14);
    if (t >= X + 640) out.push(obj({ key: 'command', kind: 'plate', tone: 'paper', origin: 'tl', x: mix(g.mark.x + s * .3, g.mark.x + s + 26, inP) - leave * (g.mark.x + s + c.w + 900) + drift, y: g.mark.y + (s - c.h) / 2, w: c.w, h: c.h, radius: 16, z: 69, mask: true,
      sx: mix(.5, 1, inP), sy: 1, opacity: clamp(inP * 2),
      runs: c.parts.map((p, i) => kinetic(run(`c${i}`, p.text, p.x, Math.round((c.h - c.size) / 2) - 2, c.size, p.weight, p.weight > 700 ? COLORS.ink : COLORS.mutedPaper), seg(t, X + 640 + i * 90, X + 920 + i * 90))) }));
  }
  return out;
}

function reducedObjects(t: number, plan: RecapPlan, g: Geo): SceneObject[] {
  const { script } = g, out: SceneObject[] = [];
  const end = Math.min(plan.durationMs, g.timeline.goneAt);
  const o = Math.min(seg(t, 0, 200), 1 - seg(t, end - 200, end));
  const ink = COLORS.ink, paper = COLORS.paper;
  const N = g.now;
  const last = g.timeline.shownChapters.at(-1) ?? (script.chapters.length ? script.chapters.length - 1 : undefined);
  if (N) out.push(obj({ key: 'now', kind: 'card', tone: 'vermilion', x: N.card.x, y: N.card.y, w: N.card.w, h: N.card.h, radius: 28, z: 25, opacity: o,
    notch: { x: 28, w: N.notchW, h: g.notchH, opacity: 1, runs: [run('l', script.now!.label, 20, Math.round((g.notchH - 36) / 2) - 1, 36, 700, paper)] },
    runs: N.words.map((w, i) => run(`n${i}`, w.text, N.textX + w.x, N.textY + w.line * N.lineH, N.size, 800, ink)) }));
  if (last !== undefined) {
    const chapter = script.chapters[last]!, size = 44;
    const area = N?.window ? { x: N.card.x + N.window.x, y: N.card.y + N.window.y, w: N.window.w, h: N.window.h } : N ? null : { ...g.closed };
    if (area) {
      const words = layoutWords(chapter.title, area.w - 64, size, g.measure, 800) ?? [];
      const h = Math.max(area.h, NOTCH + Math.max(1, lineCount(words)) * lineH(size) + 50);
      out.push(obj({ key: 'chapter', kind: 'card', tone: 'paper', x: area.x, y: area.y + (area.h - h) / 2, w: area.w, h, radius: 20, z: 26, opacity: o,
        notch: { x: 24, w: notchWidth(g.measure, chapter.timecode, 36), h: g.notchH, opacity: 1, runs: [run('tc', chapter.timecode, 20, Math.round((g.notchH - 36) / 2) - 1, 36, 700, paper, { tabular: true })] },
        runs: words.map((w, i) => run(`w${i}`, w.text, 32 + w.x, NOTCH + 22 + w.line * lineH(size), size, 800, ink)) }));
    }
  }
  if (!N && last === undefined) out.push(obj({ key: 'title-lead', kind: 'plate', tone: 'vermilion', x: 0, y: g.welcomeY, w: g.greetW, h: g.plateH, radius: 18, z: 30, opacity: o,
    runs: [run('g', script.greeting, g.padX, Math.round((g.plateH - g.big) / 2) - 2, g.big, 800, ink)] }));
  return out;
}

/** Pure frame calculation: no DOM reads, timers or accumulated state. Seeking is order independent. */
export function renderAt(timeMs: number, plan: RecapPlan, layout: SceneLayout, options: RenderOptions = {}): SceneFrame {
  const g = geometry(plan, layout, options);
  const T = g.timeline;
  const end = Math.min(plan.durationMs, options.reducedMotion ? plan.durationMs : T.goneAt);
  const visible = timeMs >= 0 && timeMs < plan.durationMs;
  const clip = sceneClip(layout), band = layout.bounds;
  const live = visible && timeMs < end;
  let objects: SceneObject[] = [];
  if (live) {
    if (options.reducedMotion) objects = reducedObjects(timeMs, plan, g);
    else {
      objects = compute(timeMs, g);
      // Motion blur proportional to screen velocity, measured against the previous 60 fps frame.
      const before = new Map(compute(timeMs - 1000 / 60, g).map(o => [o.key, o]));
      for (const o of objects) {
        const p = before.get(o.key);
        if (!p) continue;
        const vx = (o.x + o.w * o.sx / 2) - (p.x + p.w * p.sx / 2), vy = (o.y + o.h * o.sy / 2) - (p.y + p.h * p.sy / 2);
        const bx = Math.min(26, Math.abs(vx) * .34), by = Math.min(26, Math.abs(vy) * .34);
        if (bx > .8 || by > .8) { o.blurX = bx > .8 ? bx : 0; o.blurY = by > .8 ? by : 0; }
      }
    }
  }
  objects.sort((a, b) => a.z - b.z);
  const S = g.script;
  const phase: ScenePhase = !live ? 'clear' : timeMs < (T.morphAt ?? T.raidersOutAt) ? 'welcome' : timeMs < (T.stackAt ?? T.mergeAt) ? 'title'
    : T.slots.some(s => s.chat && timeMs >= s.chat.burstAt && timeMs < s.endAt) ? 'chat' : timeMs < T.mergeAt ? 'chapters' : timeMs < T.exitAt ? 'now' : 'return';
  // Plain-text equivalent of the focal statement, for assistive and summary surfaces.
  let caption: CaptionFrame | null = null;
  const focal = phase === 'now' || phase === 'return' || options.reducedMotion ? S.now?.text
    : phase === 'chapters' || phase === 'chat' ? S.chapters[[...T.slots].reverse().find(s => timeMs >= s.focusAt)?.chapter ?? 0]?.title
    : phase === 'welcome' ? [S.greeting, S.guests].filter(Boolean).join(' ') : phase === 'title' ? [S.titleLead, S.titleRest].filter(Boolean).join(' ') : undefined;
  if (live && focal) caption = { text: focal, lines: [focal], kind: phase === 'now' || phase === 'return' ? 'now' : 'context', sourceMs: 0, reveal: 1, outgoing: 0, page: 0, pages: 1 };
  return { visible, phase, timeMs, clip, band, objects, caption, nextCaption: null, openingExit: phase === 'welcome' ? 0 : 1 };
}

/** Sound cues come from the same timeline as the picture. */
export function sceneSoundEvents(plan: RecapPlan, layout?: SceneLayout | null, options: RenderOptions = {}): SceneSoundEvent[] {
  if (plan.soundEvents.length) return plan.soundEvents;
  const fallback: SceneLayout = layout ?? { bounds: { x: 64, y: 376, width: 1792, height: 640 }, mode: 'full', captionSize: 96, openingSize: 152, protected: [] };
  const g = geometry(plan, fallback, options), T = g.timeline;
  const cues: [string, number, number, number?][] = [];
  cues.push(['swoosh', 0, .5], ['thump', T.aAt + 170, .8]);
  if (T.bAt !== null) cues.push(['thump', T.bAt + 190, .65]);
  if (T.viewersAt !== null) cues.push(['tap', T.viewersAt + 120, .35]);
  if (T.morphAt !== null) cues.push(['rewind', T.morphAt + 40, .55], ['tap2', T.morphAt + 330, .35], ['slide', T.morphAt + 380, .3]);
  else cues.push(['swoosh', T.raidersOutAt, .3]);
  if (T.stackAt !== null) T.slots.forEach((_, i) => cues.push(['flick', T.stackAt! + i * 90 + 260, .45]));
  T.slots.forEach((slot, i) => {
    if (i > 0) cues.push(['slide', slot.focusAt + 40, .4]);
    if (slot.openedAt !== null) cues.push(['latch', slot.openedAt - 10, .6]);
    if (slot.chat) cues.push(['chatter', slot.chat.burstAt, .5, slot.chat.collapseAt - slot.chat.burstAt + 150], ['tap', slot.chat.loreAt + 20, .55], ['tap2', slot.chat.loreAt + 390, .5]);
  });
  if (g.now) cues.push(['felt', T.mergeAt, .55, 1100], ['resolve', T.settleAt, .5]);
  cues.push(['release', T.exitAt + 60, .45], ['tap', T.exitAt + 450, .4], ['release', T.leaveAt, .5]);
  return cues.filter(([, at]) => at >= 0 && at < plan.durationMs).sort((a, b) => a[1] - b[1])
    .map(([kind, atMs, gain, durationMs], i) => ({ id: `${plan.id}:sfx:${i}:${kind}`, kind, atMs: Math.round(atMs), gain, ...(durationMs ? { durationMs: Math.round(durationMs) } : {}) }));
}

/** The now statement must fit two lines at 80 px or larger; chapter titles that do not fit are left out instead. */
export function sceneTextFits(plan: RecapPlan, layout: SceneLayout, options: RenderOptions = {}): boolean {
  const g = geometry(plan, layout, options);
  const raw = sceneScript(plan, { channel: options.channel, title: options.title });
  if (raw.now && !g.now) return false;
  return true;
}

export { protectedBounds };
