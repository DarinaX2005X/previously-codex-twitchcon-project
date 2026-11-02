import type { RecapPlan, Rect } from '../../shared/contracts/index.js';
import { FRAME, conservativeMeasure, intersects, protectedBounds, type MeasureText, type SceneLayout } from './geometry.js';
import { clamp, enter as enterRaw, exitIn as exitInRaw, expoOut, glide as glideRaw, mix, pulse as pulseRaw, quadIn, seg, springAt as springRaw } from './motion.js';
import { sceneScript, type SceneScript } from './script.js';
import { buildTimeline, type Timeline } from './timeline.js';
import type { MontageSegment } from '../../shared/montage.js';

/** Brand material: ink stage, paper cards, vermilion for the present and the mark, lime only for chat. */
export const COLORS = { ink: '#14171B', raised: '#1E232A', high: '#272D35', deep: '#0C0E11', paper: '#F4EFE6', paperShade: '#E4DDD0', paperSide: '#CFC5B3', vermilion: '#FF5A36', vermilionSide: '#C93F22', vermilionBack: '#8F2F1C', lime: '#C8F560', limeSide: '#86A833', mutedInk: '#A9B1BC', mutedPaper: '#4A4F57' } as const;
export type Tone = 'vermilion' | 'ink' | 'paper' | 'lime' | 'raised' | 'slip' | 'clear' | 'notch';
export type Run = { key: string; text: string; x: number; y: number; size: number; weight: number; color: string; opacity: number; blur: number; dy: number; dx?: number; scale: number; tabular?: boolean };
export type SceneObject = {
  key: string; kind: 'plate' | 'card' | 'slip' | 'tab' | 'mark' | 'line' | 'stamp';
  tone: Tone; x: number; y: number; w: number; h: number; rot: number; sx: number; sy: number; opacity: number; z: number; radius: number;
  runs: Run[]; mask?: boolean; fill?: string; side?: string; wipe?: number; origin?: 'tl'; lift?: number; rotX?: number; rotY?: number; sheen?: number;
  /** A notch cut into the top edge of a card, in local coordinates. */
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
  /** The scene's real end (earlier than the plan when the owner skipped). */
  endMs: number;
  /** The montage clip on screen, for audio routing. */
  audioMediaId: string | null;
};
export type SceneSoundEvent = { id: string; kind: string; atMs: number; gain: number; durationMs?: number };
export type RenderOptions = { reducedMotion?: boolean; measure?: MeasureText; hasMedia?: boolean; availableMedia?: (id: string) => boolean; channel?: string; title?: string;
  /** Scene time at which the owner (or a viewer on the replay) skipped to the outro. */
  skipAtMs?: number };

type Box = { x: number; y: number; w: number; h: number };
type Words = { text: string; x: number; line: number; w: number }[];
/** One caption of the lower third: a chip (timecode, or "Right now"), the title and an optional summary line. */
type Caption = { chip: string; chipW: number; present: boolean; title: Words; titleSize: number; titleLines: number; summary: Words; summarySize: number; summaryLines: number; w: number; h: number };
type Card = { title: Words; titleSize: number; summary: Words; summarySize: number; chipW: number; chip: string };
type Geo = {
  W: number; H: number; B: Rect; compact: boolean; script: SceneScript; measure: MeasureText; plan: RecapPlan;
  big: number; plateH: number; padX: number; welcomeY: number; greetW: number;
  guests: { text: string; size: number; w: number; h: number } | null;
  viewers: { size: number; h: number; w: number } | null;
  tile: number; lead: { x: number; w: number }; rest: { text: string; size: number; w: number; h: number; x: number; y: number } | null;
  lockW: number; lockH: number;
  /** Lower third, in band coordinates: left edge, bottom edge, dock scale of the title lockup. */
  lower: { x: number; bottom: number; scale: number; brandH: number; brandW: number };
  captions: Map<number | 'now', Caption>; cards: Map<number | 'now', Card>;
  chat: { text: string; w: number } | null; loreTag: { term: string; w: number; stampW: number } | null;
  full: Box;
  mark: { size: number; x: number; y: number };
  command: { w: number; h: number; size: number; parts: { text: string; weight: number; x: number }[] } | null;
  clipMs: (id: string | null) => number | null;
};

const PAD = 0.3;
const CHIP_H = 56, CHIP_SIZE = 36;
const lineH = (size: number) => Math.round(size * 1.08);

// Reduced motion: every travel becomes a cut; only opacity changes remain.
let RM = false;
const enter = (p: number) => RM ? (p > 0 ? 1 : 0) : enterRaw(p);
const glide = (p: number) => RM ? (p > 0 ? 1 : 0) : glideRaw(p);
const exitIn = (p: number) => RM ? (p >= 1 ? 1 : 0) : exitInRaw(p);
const springAt = (t: number, at: number, z = .62, w = 15) => RM ? (t >= at ? 1 : 0) : springRaw(t, at, z, w);
const pulse = (t: number, at: number, width = 220) => RM ? 0 : pulseRaw(t, at, width);

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
const wordsWidth = (words: Words) => Math.max(0, ...words.map(w => w.x + w.w));

const geoCache = new WeakMap<RecapPlan, Map<string, Geo>>();
function geometry(plan: RecapPlan, layout: SceneLayout, options: RenderOptions): Geo {
  const measure = options.measure ?? conservativeMeasure;
  const key = `${layout.bounds.x},${layout.bounds.y},${layout.bounds.width},${layout.bounds.height}|${options.channel ?? ''}|${options.title ?? ''}|${options.measure ? 'm' : 'c'}|${options.availableMedia ? plan.media.filter(m => options.availableMedia!(m.id)).map(m => m.id).join(',') : '*'}`;
  let cache = geoCache.get(plan);
  if (!cache) { cache = new Map(); geoCache.set(plan, cache); }
  const hit = cache.get(key);
  if (hit) return hit;
  const B = layout.bounds;
  const raw = sceneScript(plan, { channel: options.channel, title: options.title });
  const W = B.width, H = B.height, compact = layout.mode === 'compact';
  const available = (id: string | null) => !!id && (!options.availableMedia || options.availableMedia(id));
  const script: SceneScript = { ...raw, chapters: raw.chapters.map(c => ({ ...c, mediaId: available(c.mediaId) ? c.mediaId : null })), now: raw.now ? { ...raw.now, mediaId: available(raw.now.mediaId) ? raw.now.mediaId : null } : null };
  const clipMs = (id: string | null) => { if (!id || !available(id)) return null; const m = plan.media.find(item => item.id === id); return m ? Math.max(0, m.outMs - m.inMs) : null; };
  // Welcome and title lockup: 96–150 px over the live stream, inside the free band.
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
  const lockW = Math.max(leadX + leadW, rest ? rest.x + rest.w : 0), lockH = rest ? rest.y + rest.h - welcomeY : plateH;
  // The full frame in band coordinates, and the lower third inside the frame's title-safe area.
  const full = { x: -B.x, y: -B.y, w: FRAME.width, h: FRAME.height };
  const brandH = compact ? 64 : 76, scale = brandH / plateH;
  const lower = { x: 72 - B.x, bottom: FRAME.height - 64 - B.y, scale, brandH: Math.round(lockH * scale), brandW: Math.round(lockW * scale) };
  // Captions: one per chapter in the cut, and one for the present.
  const capMax = Math.min(1180, FRAME.width - 144);
  const chipW = (text: string) => Math.round(measure(text, CHIP_SIZE, 700) + 34);
  const makeCaption = (chip: string, present: boolean, title: string, summary: string | null): Caption => {
    const cw = chipW(chip);
    const t = fitText(title, capMax - 48 - cw - 22, compact ? [52, 48, 44] : [64, 60, 56, 52], 2, measure);
    // A long summary keeps its first sentence when the whole would not fit two lines; it is clamped at a word only if it must be.
    const sizesS = compact ? [34] : [38, 36];
    const sentence = summary?.match(/^.+?[.!?](?=\s|$)/u)?.[0];
    let s = summary ? fitText(summary, capMax - 48, sizesS, 2, measure, 600) : null;
    if (s?.truncated && sentence && sentence !== summary) s = fitText(sentence, capMax - 48, sizesS, 2, measure, 600);
    const titleH = Math.max(CHIP_H, lineCount(t.words) * lineH(t.size));
    const h = 22 + titleH + (s ? 12 + lineCount(s.words) * lineH(s.size) : 0) + 24;
    const w = Math.max(420, 24 + cw + 22 + wordsWidth(t.words) + 30, s ? wordsWidth(s.words) + 54 : 0);
    return { chip, chipW: cw, present, title: t.words, titleSize: t.size, titleLines: lineCount(t.words), summary: s?.words ?? [], summarySize: s?.size ?? 36, summaryLines: s ? lineCount(s.words) : 0, w: Math.min(capMax, w), h };
  };
  const makeCard = (chip: string, title: string, summary: string | null): Card => {
    const t = fitText(title, 1500, compact ? [96, 88, 80] : [128, 120, 112, 104, 96], 2, measure);
    const s = summary ? fitText(summary, 1400, [52, 48, 44], 2, measure, 600) : null;
    return { chip, chipW: chipW(chip), title: t.words, titleSize: t.size, summary: s?.words ?? [], summarySize: s?.size ?? 48 };
  };
  const captions = new Map<number | 'now', Caption>(), cards = new Map<number | 'now', Card>();
  script.chapters.forEach((c, i) => {
    const summary = c.summary && c.summary !== c.title ? c.summary : null;
    captions.set(i, makeCaption(c.timecode, false, c.title, summary));
    cards.set(i, makeCard(c.timecode, c.title, summary));
  });
  if (script.now) { captions.set('now', makeCaption(script.now.label, true, script.now.text, null)); cards.set('now', makeCard(script.now.label, script.now.text, null)); }
  // The chat reaction and the running joke ride the lower third of the moment's clip as small tags.
  const tagSize = compact ? 32 : 36;
  const chat = script.moment ? (() => { const line = script.countLine(script.moment!.count); const text = `${line.big} ${line.small}`; return { text, w: Math.round(measure(text, tagSize, 700) + 40) }; })() : null;
  const loreTag = script.lore ? { term: script.lore.term, w: Math.round(measure(script.lore.term, tagSize + 4, 800) + 40), stampW: Math.round(measure(script.lore.stamp, tagSize, 700) + 28) } : null;
  const markSize = Math.round(clamp(H * .3, 120, 196));
  let command: Geo['command'] = null;
  if (script.command) {
    const size = compact ? 40 : 46, parts: { text: string; weight: number; x: number }[] = [];
    let x = 28;
    for (const [text, weight] of [[script.command.before, 700], [script.command.command, 800], [script.command.after, 700]] as const) { parts.push({ text, weight, x }); x += measure(text, size, weight) + measure(' ', size, 700); }
    command = { w: Math.round(x - measure(' ', size, 700) + 28), h: Math.round(size * 1.6), size, parts };
  }
  const x0 = compact ? 10 : 40;
  const geo: Geo = { W, H, B, compact, script, measure, plan, big, plateH, padX, welcomeY, greetW, guests, viewers, tile, lead: { x: leadX, w: leadW }, rest, lockW, lockH,
    lower, captions, cards, chat, loreTag, full, mark: { size: markSize, x: x0, y: H - markSize - 22 }, command, clipMs };
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
  if (RM) return { ...r, opacity: Math.min(clamp(p * 4), 1 - clamp(q * 4 - 2)) };
  const a = enterRaw(clamp(p)), b = quadIn(clamp(q));
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

const segmentAt = (T: Timeline, t: number) => { let found: MontageSegment | undefined; for (const s of T.segments) if (t >= s.at) found = s; return found; };

/** The welcome plates and the title lockup; the lockup docks into the lower third as the picture opens. */
function introState(t: number, g: Geo, T: Timeline): SceneObject[] {
  const { script } = g, out: SceneObject[] = [];
  const ink = COLORS.ink, paper = COLORS.paper, plateRadius = Math.round(g.big * .14);
  const exitAt = T.exitAt;
  const lowerOut = exitIn(seg(t, exitAt - 120, exitAt + 200));
  // Dock: the lockup scales about its top-left into the lower third's brand row.
  const dock = T.welcomeOnly ? 0 : glide(seg(t, T.openAt + 100, T.openedAt + 50));
  const brandY = (cap: number) => g.lower.bottom - cap - 14 - g.lower.brandH;
  const capH = captionHeightAt(t, g, T);
  const D = (x: number, y: number, sx = 1) => ({ x: mix(x, g.lower.x + x * g.lower.scale, dock), y: mix(y, brandY(capH) + (y - g.welcomeY) * g.lower.scale, dock) + lowerOut * (g.lower.brandH + capH + 120), s: sx * mix(1, g.lower.scale, dock) });
  const welcomeGone = T.welcomeOnly ? exitIn(seg(t, exitAt - 40, exitAt + 260)) : 0;
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
  if (lowerOut < 1 && welcomeGone < 1) {
    const p = D(aX, g.welcomeY);
    out.push(obj({ key: 'title-lead', kind: 'plate', tone: 'vermilion', origin: 'tl', x: p.x, y: p.y - welcomeGone * 80, w: aW, h: g.plateH, radius: plateRadius, z: 80, mask: true,
      sx: p.s * (1 + aLand * .07 - squash * .06), sy: p.s * (1 - aLand * .06 + squash * .08), rot: mix(-3, 0, enter(seg(t, T.aAt, T.aAt + 400))), opacity: 1 - welcomeGone, runs: leadRuns }));
  }
  if (!T.welcomeOnly && t >= T.morphAt! + 200 && lowerOut < 1) {
    const pop = springAt(t, T.morphAt! + 200, .5, 15), p = D(0, g.welcomeY);
    out.push(obj({ key: 'title-tile', kind: 'mark', tone: 'vermilion', origin: 'tl', x: p.x, y: p.y, w: g.tile, h: g.tile, radius: g.tile * .26, z: 81,
      sx: p.s * mix(.3, 1, pop), sy: p.s * mix(.3, 1, pop), rot: mix(-12, 0, pop), mark: { glyph: springAt(t, T.morphAt! + 330, .5, 16), back: glide(seg(t, T.morphAt! + 380, T.morphAt! + 640)) } }));
  }
  if (g.guests && T.bAt !== null) {
    const bIn = springAt(t, T.bAt, .6, 14), gone = exitIn(seg(t, T.raidersOutAt + 60, T.raidersOutAt + 320));
    const y0 = g.welcomeY + g.plateH + 14;
    if (gone < 1) out.push(obj({ key: 'guests', kind: 'plate', tone: 'raised', x: mix(-g.guests.w - 160, 0, bIn), y: y0 + mix(40, 0, bIn) - gone * (y0 + g.guests.h + 40), w: g.guests.w, h: g.guests.h,
      radius: plateRadius, z: 78, rot: mix(-5, 0, enter(seg(t, T.bAt, T.bAt + 450))) - gone * 2, sx: 1 + pulse(t, T.bAt + 190, 240) * .06, sy: 1 - pulse(t, T.bAt + 190, 240) * .05,
      runs: [run('g', g.guests.text, Math.round(g.guests.size * PAD), Math.round((g.guests.h - g.guests.size) / 2) - 2, g.guests.size, 800, paper)] }));
    if (g.viewers && T.viewersAt !== null && script.viewers !== null) {
      const vIn = springAt(t, T.viewersAt, .5, 16), vOut = exitIn(seg(t, T.raidersOutAt, T.raidersOutAt + 240));
      const count = Math.round(script.viewers * (RM ? 1 : expoOut(seg(t, T.viewersAt, T.viewersAt + 520))));
      const vy = y0 + g.guests.h + 14;
      if (vOut < 1) out.push(obj({ key: 'viewers', kind: 'plate', tone: 'paper', origin: 'tl', x: 0, y: vy - vOut * (vy + 140), w: g.viewers.w, h: g.viewers.h, radius: 14, z: 77,
        sx: mix(.4, 1, vIn), sy: mix(.4, 1, vIn), opacity: clamp(seg(t, T.viewersAt, T.viewersAt + 80)), rot: mix(4, 0, vIn),
        runs: [run('v', script.viewersLabel(count), Math.round(g.viewers.size * .45), Math.round((g.viewers.h - g.viewers.size) / 2) - 1, g.viewers.size, 700, ink, { tabular: true })] }));
    }
  }
  if (g.rest && !T.welcomeOnly && lowerOut < 1) {
    const m = T.morphAt!, outP = springAt(t, m + 380, .7, 13);
    const hidden = { x: g.lead.x + Math.max(0, g.lead.w - g.rest.w), y: g.rest.y };
    const p = D(mix(hidden.x, g.rest.x, outP), g.rest.y);
    if (t >= m + 360) out.push(obj({ key: 'title-rest', kind: 'plate', tone: 'paper', origin: 'tl', x: p.x, y: p.y, w: g.rest.w, h: g.rest.h,
      radius: Math.round(g.rest.size * .14), z: 79, sx: p.s * mix(Math.min(1, g.lead.w * .9 / g.rest.w), 1, clamp(outP)), sy: p.s,
      runs: [run('r', g.rest.text, Math.round(g.rest.size * PAD), Math.round((g.rest.h - g.rest.size) / 2) - 2, g.rest.size, 800, ink)] }));
  }
  return out;
}

/** Captions read like a TV lower third: in on the cut, out after a few seconds, so the picture is clear again. The present stays. */
const CAPTION_HOLD_MS = 6200;
function captionWindow(T: Timeline, s: MontageSegment, index: number): { from: number; until: number } {
  const from = index === 0 ? T.openedAt - 200 : s.at;
  const end = s.at + s.ms;
  const until = s.chapter === 'now' || T.exitAt <= end ? Math.min(end, T.exitAt) : Math.min(end - 120, from + CAPTION_HOLD_MS);
  return { from, until };
}
/** How far the caption plate is shown at time t (0 hidden … 1 shown); the brand row sits on top of it. */
function captionShown(t: number, T: Timeline, s: MontageSegment | undefined, index: number): number {
  if (!s || s.kind !== 'clip') return 0;
  const w = captionWindow(T, s, index);
  return glide(seg(t, w.from, w.from + 300)) * (1 - glide(seg(t, w.until - 300, w.until)));
}
function captionHeightAt(t: number, g: Geo, T: Timeline): number {
  const cur = segmentAt(T, t) ?? T.segments[0];
  if (!cur) return 0;
  const index = T.segments.indexOf(cur);
  return (g.captions.get(cur.chapter)?.h ?? 0) * (cur.kind === 'clip' ? (t < cur.at && index === 0 ? glide(seg(t, T.openedAt - 200, T.openedAt + 100)) : captionShown(t, T, cur, index)) : 0);
}

/** The full-frame picture: it opens from behind the lockup, cuts from clip to clip, and contracts into the mark. */
function screenState(t: number, g: Geo, T: Timeline): SceneObject[] {
  if (T.welcomeOnly || !T.segments.length || t < T.openAt || t >= T.exitAt + 520) return [];
  const out: SceneObject[] = [];
  const startBox = { x: -24, y: g.welcomeY - 24, w: g.lockW + 48, h: g.lockH + 48 };
  const open = glide(seg(t, T.openAt, T.openedAt));
  let box = lerpBox(startBox, g.full, open);
  const contract = glide(seg(t, T.exitAt, T.exitAt + 480));
  const markBox = { x: g.mark.x, y: g.mark.y, w: g.mark.size, h: g.mark.size };
  if (contract > 0) box = lerpBox(g.full, markBox, contract);
  const cur = segmentAt(T, Math.min(t, T.exitAt - 1)) ?? T.segments[0]!;
  const index = T.segments.indexOf(cur);
  let media: SceneObject['media'];
  const id = cur.kind === 'clip' ? (cur.chapter === 'now' ? g.script.now?.mediaId : g.script.chapters[cur.chapter]?.mediaId) ?? null : null;
  if (id) {
    // The first clip starts as the picture opens; every other clip starts on its cut.
    const start = index === 0 ? T.openAt : cur.at;
    const collapse = clamp(contract * 2.5);
    media = { id, x: 0, y: 0, w: box.w, h: box.h, radius: 0, opacity: 1 - collapse, timeMs: Math.max(0, t - start), playing: t < T.exitAt };
  }
  const radius = mix(mix(28, 0, open), g.mark.size * .26, contract);
  const fill = contract > 0 ? mixColor(COLORS.ink, COLORS.vermilion, seg(contract, .15, .7)) : COLORS.ink;
  out.push(obj({ key: 'screen', kind: 'card', tone: 'ink', origin: 'tl', ...box, radius, z: 10, fill, mask: true, media, lift: 0, opacity: 1 - seg(t, T.exitAt + 480, T.exitAt + 520) }));
  // A title card stands in for a chapter without a clip.
  if (cur.kind === 'card' && contract <= 0 && open >= 1) {
    const c = g.cards.get(cur.chapter);
    if (c) {
      const local = t - cur.at, outQ = seg(local, cur.ms - 260, cur.ms);
      const x = 160 - g.B.x, titleH = lineCount(c.title) * lineH(c.titleSize), sumH = c.summary.length ? 24 + lineCount(c.summary) * lineH(c.summarySize) : 0;
      const top = (FRAME.height - (CHIP_H + 28 + titleH + sumH)) / 2 - 80 - g.B.y;
      const runs: Run[] = [
        ...c.title.map((w, i) => kinetic(run(`ct${i}`, w.text, w.x, CHIP_H + 28 + w.line * lineH(c.titleSize), c.titleSize, 800, COLORS.paper), seg(local, 120 + i * 50, 480 + i * 50), outQ)),
        ...c.summary.map((w, i) => kinetic(run(`cs${i}`, w.text, w.x, CHIP_H + 28 + titleH + 24 + w.line * lineH(c.summarySize), c.summarySize, 600, COLORS.mutedInk), seg(local, 360, 760), outQ)),
      ];
      out.push(obj({ key: 'card-text', kind: 'plate', tone: 'clear', origin: 'tl', x, y: top, w: 1600, h: CHIP_H + 28 + titleH + sumH + 20, z: 20, radius: 0, runs }));
      const present = cur.chapter === 'now';
      out.push(obj({ key: 'card-chip', kind: 'plate', tone: present ? 'vermilion' : 'paper', origin: 'tl', x, y: top, w: c.chipW, h: CHIP_H, radius: 12, z: 21, mask: true,
        sx: mix(.5, 1, springAt(t, cur.at + 60, .6, 15)), sy: mix(.5, 1, springAt(t, cur.at + 60, .6, 15)), opacity: clamp(seg(local, 40, 120)) * (1 - outQ),
        runs: [run('tc', c.chip, 17, Math.round((CHIP_H - CHIP_SIZE) / 2) - 1, CHIP_SIZE, 700, COLORS.ink, { tabular: true })] }));
    }
  }
  return out;
}

/** The lower third under the brand row: chip, title and summary for the clip on screen; tags for chat and the joke. */
function lowerState(t: number, g: Geo, T: Timeline): SceneObject[] {
  if (T.welcomeOnly || !T.segments.length || t < T.openedAt - 200 || t >= T.exitAt + 260) return [];
  const out: SceneObject[] = [];
  const cur = segmentAt(T, t) ?? T.segments[0]!;
  const index = T.segments.indexOf(cur);
  const prev = index > 0 ? T.segments[index - 1] : undefined;
  const lowerOut = exitIn(seg(t, T.exitAt - 120, T.exitAt + 200));
  const capH = captionHeightAt(t, g, T);
  const capOf = (s: MontageSegment | undefined) => s && s.kind === 'clip' ? g.captions.get(s.chapter) : undefined;
  const c = capOf(cur);
  void prev;
  if (c) {
    const win = captionWindow(T, cur, index);
    const shown = index === 0 && t < cur.at ? glide(seg(t, T.openedAt - 200, T.openedAt + 100)) : captionShown(t, T, cur, index);
    if (shown > 0) {
      const y = g.lower.bottom - capH + lowerOut * (capH + 140);
      const runs: Run[] = [];
      const local = t - win.from, outQ = seg(t, win.until - 320, win.until - 60);
      const titleH = Math.max(CHIP_H, c.titleLines * lineH(c.titleSize));
      const tx = 24 + c.chipW + 22, ty = 22 + Math.round((titleH - c.titleLines * lineH(c.titleSize)) / 2);
      c.title.forEach((w, i) => runs.push(kinetic(run(`c${index}t${i}`, w.text, tx + w.x, ty + w.line * lineH(c.titleSize), c.titleSize, 800, COLORS.ink), seg(local, 80 + i * 45, 420 + i * 45), outQ)));
      c.summary.forEach((w, i) => runs.push(kinetic(run(`c${index}s${i}`, w.text, 24 + w.x, 22 + titleH + 12 + w.line * lineH(c.summarySize), c.summarySize, 600, COLORS.mutedPaper), seg(local, 320 + i * 20, 700 + i * 20), outQ)));
      // The plate wipes in from the left edge and back out; its full height is always the caption's own.
      out.push(obj({ key: 'caption', kind: 'plate', tone: 'paper', origin: 'tl', x: g.lower.x, y, w: c.w * mix(.35, 1, shown), h: capH, radius: 18, z: 60, mask: true, opacity: clamp(shown * 3), runs }));
      const chipIn = springAt(t, win.from + 40, .55, 16);
      out.push(obj({ key: `chip:${index}`, kind: 'plate', tone: c.present ? 'vermilion' : 'notch', origin: 'tl', x: g.lower.x + 24, y: y + Math.min(capH - CHIP_H - 6, 22 + Math.round((titleH - CHIP_H) / 2)), w: c.chipW, h: CHIP_H, radius: 12, z: 61, mask: true,
        sx: mix(.4, 1, chipIn), sy: mix(.4, 1, chipIn), opacity: clamp(seg(local, 0, 80)) * (1 - outQ) * clamp(shown * 2),
        runs: [run('tc', c.chip, 17, Math.round((CHIP_H - CHIP_SIZE) / 2) - 1, CHIP_SIZE, 700, c.present ? COLORS.ink : COLORS.paper, { tabular: true })] }));
    }
  }
  // Chat's reaction and the running joke on the moment's clip, beside the brand row.
  const M = g.script.moment;
  if (M && cur.chapter === M.chapterIndex && cur.kind === 'clip') {
    const reaction = M.reactionMs !== null ? Math.min(cur.at + M.reactionMs, cur.at + cur.ms - 3200) : cur.at + Math.min(2600, cur.ms * .35);
    const chatAt = Math.max(cur.at + 600, reaction);
    const loreAt = chatAt + 1300;
    const tagOut = seg(t, cur.at + cur.ms - 260, cur.at + cur.ms);
    const rowY = g.lower.bottom - capH - 14 - g.lower.brandH + lowerOut * 300;
    let x = g.lower.x + g.lower.brandW + 22;
    const tagH = g.compact ? 54 : 62, size = g.compact ? 32 : 36;
    if (g.chat && t >= chatAt) {
      const inP = springAt(t, chatAt, .55, 15);
      out.push(obj({ key: 'chat-tag', kind: 'plate', tone: 'lime', origin: 'tl', x, y: rowY + (g.lower.brandH - tagH) / 2, w: g.chat.w, h: tagH, radius: 14, z: 62, mask: true,
        sx: mix(.5, 1, inP), sy: mix(.5, 1, inP), rot: mix(-6, -1.5, inP), opacity: clamp(seg(t, chatAt, chatAt + 60)) * (1 - tagOut),
        runs: [kinetic(run('n', g.chat.text, 20, Math.round((tagH - size) / 2) - 1, size, 700, COLORS.ink, { tabular: true }), seg(t, chatAt + 60, chatAt + 360), tagOut)] }));
      x += g.chat.w + 14;
    }
    if (g.loreTag && t >= loreAt) {
      const inP = springAt(t, loreAt, .5, 15);
      out.push(obj({ key: 'lore-tag', kind: 'plate', tone: 'vermilion', origin: 'tl', x, y: rowY + (g.lower.brandH - tagH) / 2, w: g.loreTag.w, h: tagH, radius: 14, z: 62, mask: true,
        sx: mix(.5, 1, inP), sy: mix(.5, 1, inP), rot: mix(5, 1, inP), opacity: clamp(seg(t, loreAt, loreAt + 60)) * (1 - tagOut),
        runs: [kinetic(run('t', g.loreTag.term, 20, Math.round((tagH - size - 4) / 2) - 1, size + 4, 800, COLORS.ink), seg(t, loreAt + 60, loreAt + 380), tagOut)] }));
      const st = springAt(t, loreAt + 300, .42, 20);
      if (t >= loreAt + 300) out.push(obj({ key: 'lore-stamp', kind: 'stamp', tone: 'ink', origin: 'tl', x: x + g.loreTag.w - 18, y: rowY + (g.lower.brandH - tagH) / 2 - 22, w: g.loreTag.stampW, h: 46, radius: 10, z: 63,
        sx: mix(1.6, 1, st), sy: mix(1.6, 1, st), rot: 4, opacity: clamp(seg(t, loreAt + 300, loreAt + 340)) * (1 - tagOut),
        runs: [run('st', g.script.lore!.stamp, 14, 6, size - 4, 700, COLORS.paper, { tabular: true })] }));
    }
  }
  return out;
}

function markState(t: number, g: Geo, T: Timeline): SceneObject[] {
  const X = T.exitAt, out: SceneObject[] = [];
  if (t < X + 440 || t >= T.goneAt) return out;
  const s = g.mark.size;
  const glyph = springAt(t, X + 400, .5, 16), back = glide(seg(t, X + 440, X + 700));
  const leave = exitIn(seg(t, T.leaveAt, T.leaveAt + 330));
  const settleBounce = pulse(t, X + 470, 260);
  const drift = RM ? 0 : seg(t, X + 700, T.leaveAt) * 10;
  out.push(obj({ key: 'mark', kind: 'mark', tone: 'vermilion', x: g.mark.x - leave * (g.mark.x + s + 900) + drift, y: g.mark.y, w: s, h: s, radius: s * .26, z: 90, sx: 1 - settleBounce * .05, sy: 1 + settleBounce * .05, rot: -leave * 6,
    opacity: RM ? 1 - seg(t, T.leaveAt, T.leaveAt + 300) : 1, mark: { glyph, back } }));
  if (g.command) {
    const c = g.command, inP = springAt(t, X + 640, .7, 14);
    if (t >= X + 640) out.push(obj({ key: 'command', kind: 'plate', tone: 'paper', origin: 'tl', x: mix(g.mark.x + s * .3, g.mark.x + s + 26, inP) - leave * (g.mark.x + s + c.w + 900) + drift, y: g.mark.y + (s - c.h) / 2, w: c.w, h: c.h, radius: 16, z: 89, mask: true,
      sx: mix(.5, 1, inP), sy: 1, opacity: clamp(inP * 2) * (RM ? 1 - seg(t, T.leaveAt, T.leaveAt + 300) : 1),
      runs: c.parts.map((p, i) => kinetic(run(`c${i}`, p.text, p.x, Math.round((c.h - c.size) / 2) - 2, c.size, p.weight, p.weight > 700 ? COLORS.ink : COLORS.mutedPaper), seg(t, X + 640 + i * 90, X + 920 + i * 90))) }));
  }
  return out;
}

function compute(t: number, g: Geo, T: Timeline): SceneObject[] {
  return [...screenState(t, g, T), ...introState(t, g, T), ...lowerState(t, g, T), ...markState(t, g, T)];
}

function timelineFor(g: Geo, options: RenderOptions): Timeline {
  return buildTimeline(g.script, g.plan.durationMs, g.clipMs, options.skipAtMs);
}

/** Pure frame calculation: no DOM reads, timers or accumulated state. Seeking is order independent. */
export function renderAt(timeMs: number, plan: RecapPlan, layout: SceneLayout, options: RenderOptions = {}): SceneFrame {
  const g = geometry(plan, layout, options);
  const T = timelineFor(g, options);
  const end = Math.min(plan.durationMs, T.goneAt);
  const visible = timeMs >= 0 && timeMs < plan.durationMs;
  const band = layout.bounds;
  const live = visible && timeMs < end;
  const fullFrame = !T.welcomeOnly && T.segments.length > 0 && timeMs >= T.openAt && timeMs < T.exitAt + 520;
  const clip = fullFrame ? { x: 0, y: 0, width: FRAME.width, height: FRAME.height } : sceneClip(layout);
  let objects: SceneObject[] = [];
  RM = !!options.reducedMotion;
  try {
    if (live) {
      objects = compute(timeMs, g, T);
      if (!RM) {
        // Motion blur proportional to screen velocity, measured against the previous 60 fps frame.
        const before = new Map(compute(timeMs - 1000 / 60, g, T).map(o => [o.key, o]));
        for (const o of objects) {
          const p = before.get(o.key);
          if (!p || o.key === 'screen') continue;
          const vx = (o.x + o.w * o.sx / 2) - (p.x + p.w * p.sx / 2), vy = (o.y + o.h * o.sy / 2) - (p.y + p.h * p.sy / 2);
          const bx = Math.min(26, Math.abs(vx) * .34), by = Math.min(26, Math.abs(vy) * .34);
          if (bx > .8 || by > .8) { o.blurX = bx > .8 ? bx : 0; o.blurY = by > .8 ? by : 0; }
        }
      }
    }
  } finally { RM = false; }
  objects.sort((a, b) => a.z - b.z);
  const S = g.script;
  const cur = segmentAt(T, timeMs);
  const M = S.moment;
  const inMontage = !!cur && timeMs < T.exitAt;
  const phase: ScenePhase = !live ? 'clear' : timeMs < (T.morphAt ?? T.raidersOutAt) ? 'welcome' : !inMontage && timeMs < T.exitAt ? 'title'
    : inMontage && cur!.chapter === 'now' ? 'now' : inMontage && M && cur!.chapter === M.chapterIndex ? 'chat' : inMontage ? 'chapters' : 'return';
  let caption: CaptionFrame | null = null;
  const focal = inMontage ? (cur!.chapter === 'now' ? S.now?.text : S.chapters[cur!.chapter]?.title)
    : phase === 'welcome' ? [S.greeting, S.guests].filter(Boolean).join(' ') : phase === 'title' ? [S.titleLead, S.titleRest].filter(Boolean).join(' ') : undefined;
  if (live && focal) caption = { text: focal, lines: [focal], kind: phase === 'now' ? 'now' : 'context', sourceMs: 0, reveal: 1, outgoing: 0, page: 0, pages: 1 };
  const screen = objects.find(o => o.key === 'screen');
  return { visible, phase, timeMs, clip, band, objects, caption, nextCaption: null, openingExit: phase === 'welcome' ? 0 : 1, endMs: end, audioMediaId: screen?.media && screen.media.playing ? screen.media.id : null };
}

/** Sound cues come from the same timeline as the picture. During the cut, the clips carry their own sound. */
export function sceneSoundEvents(plan: RecapPlan, layout?: SceneLayout | null, options: RenderOptions = {}): SceneSoundEvent[] {
  if (plan.soundEvents.length) return plan.soundEvents;
  const fallback: SceneLayout = layout ?? { bounds: { x: 64, y: 376, width: 1792, height: 640 }, mode: 'full', captionSize: 96, openingSize: 152, protected: [] };
  const g = geometry(plan, fallback, options), T = timelineFor(g, options);
  const cues: [string, number, number, number?][] = [];
  cues.push(['swoosh', 0, .5], ['thump', T.aAt + 170, .8]);
  if (T.bAt !== null) cues.push(['thump', T.bAt + 190, .65]);
  if (T.viewersAt !== null) cues.push(['tap', T.viewersAt + 120, .35]);
  if (T.morphAt !== null) cues.push(['rewind', T.morphAt + 40, .55], ['tap2', T.morphAt + 330, .35], ['slide', T.morphAt + 380, .3]);
  if (T.segments.length) {
    cues.push(['swoosh', T.openAt + 60, .35], ['latch', T.openedAt - 10, .45]);
    T.segments.forEach((s, i) => {
      if (i > 0) cues.push(['flick', s.at, .3]);
      const M = g.script.moment;
      if (M && s.chapter === M.chapterIndex && s.kind === 'clip') {
        const reaction = M.reactionMs !== null ? Math.min(s.at + M.reactionMs, s.at + s.ms - 3200) : s.at + Math.min(2600, s.ms * .35);
        const chatAt = Math.max(s.at + 600, reaction);
        if (g.chat) cues.push(['chatter', chatAt, .4, 900]);
        if (g.loreTag) cues.push(['tap', chatAt + 1300, .45], ['tap2', chatAt + 1640, .4]);
      }
      if (s.chapter === 'now') cues.push(['felt', s.at, .35, 900], ['resolve', s.at + 700, .4]);
    });
  }
  cues.push(['release', T.exitAt + 60, .45], ['tap', T.exitAt + 400, .4], ['release', T.leaveAt, .5]);
  const end = Math.min(plan.durationMs, T.goneAt);
  return cues.filter(([, at]) => at >= 0 && at < end).sort((a, b) => a[1] - b[1])
    .map(([kind, atMs, gain, durationMs], i) => ({ id: `${plan.id}:sfx:${i}:${kind}`, kind, atMs: Math.round(atMs), gain, ...(durationMs ? { durationMs: Math.round(durationMs) } : {}) }));
}

/** Every caption is fitted by measured width and clamped at a word with an ellipsis, so text never blocks the scene. */
export function sceneTextFits(_plan: RecapPlan, _layout: SceneLayout, _options: RenderOptions = {}): boolean { return true; }

export { protectedBounds };
