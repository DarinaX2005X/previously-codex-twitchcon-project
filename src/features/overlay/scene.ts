import type { RecapPlan, Rect } from '../../shared/contracts/index.js';
import { FRAME, conservativeMeasure, intersects, protectedBounds, wrapCaption, type MeasureText, type SceneLayout } from './geometry.js';
import { clamp, enter, exitIn, expoOut, glide, mix, pulse, quadIn, rand, seg, springAt } from './motion.js';
import { sceneScript, type SceneScript } from './script.js';
import { buildTimeline, REACTION_LEAD_MS, type Timeline } from './timeline.js';

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
type Row = { chipW: number; words: Words; size: number; lines: number; h: number };
type Geo = {
  W: number; H: number; compact: boolean; script: SceneScript; timeline: Timeline; measure: MeasureText;
  big: number; plateH: number; padX: number; welcomeY: number; greetW: number;
  guests: { text: string; size: number; w: number; h: number } | null;
  viewers: { size: number; h: number; w: number } | null;
  tile: number; lead: { x: number; w: number }; rest: { text: string; size: number; w: number; h: number; x: number; y: number } | null;
  notchH: number; x0: number;
  /** The chapter list: one paper card, a row per chapter (timecode chip and title). */
  list: { box: Box; pad: number; rows: (Row & { y: number })[] } | null;
  /** The focus chapter's row grows into this clip frame (or a large title card when there is no clip). */
  frame: Box; stripH: number; focusMedia: string | null; preroll: number;
  bigTitle: { words: Words; size: number; lines: number } | null;
  column: { x: number; w: number };
  counter: (Box & { big: number; small: number }) | null;
  panel: (Box & { size: number; lh: number; lines: string[] }) | null;
  lore: (Box & { term: string; termSize: number; expl: string[]; explSize: number; stampW: number }) | null;
  now: { card: Box; size: number; words: Words; groups: number[][]; window: Box | null; notchW: number; textX: number; textY: number; lineH: number } | null;
  mark: { size: number; x: number; y: number };
  command: { w: number; h: number; size: number; parts: { text: string; weight: number; x: number }[] } | null;
};

const PAD = 0.3;
const CHIP_H = 58, CHIP_SIZE = 40;
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
  const x0 = compact ? 10 : 40;
  const notchH = NOTCH;
  const chipW = (tc: string) => Math.round(measure(tc, CHIP_SIZE, 700) + 36);
  const layRow = (title: string, tc: string, width: number, size: number, clampText: boolean): Row | null => {
    const cw = chipW(tc), tw = width - 48 - cw - 22;
    const words = layoutWords(title, tw, size, measure, 800);
    if (words && lineCount(words) <= 2) return { chipW: cw, words, size, lines: lineCount(words), h: Math.max(CHIP_H, lineCount(words) * lineH(size)) + 34 };
    if (!clampText) return null;
    const fit = fitText(title, tw, [size], 2, measure);
    return { chipW: cw, words: fit.words, size, lines: lineCount(fit.words), h: Math.max(CHIP_H, lineCount(fit.words) * lineH(size)) + 34 };
  };
  const n = script.chapters.length;
  const focusIndex = script.moment ? script.moment.chapterIndex : Math.max(0, [...script.chapters.keys()].reverse().find(i => script.chapters[i]!.mediaId) ?? n - 1);
  const focus = script.chapters[focusIndex];
  const focusMedia = focus?.mediaId ?? null;
  // The list and the frame share their width, so the focus row is the same object in the list and on the frame.
  const columnMin = compact ? Math.max(360, W * .36) : 680;
  let fw = Math.min(W - x0 - columnMin, Math.round((H - 24) * 1.6));
  const rowSizes = compact ? [56, 52, 48, 44] : [64, 60, 56, 52, 48];
  const pad = 20;
  let rowSize = rowSizes.at(-1)!;
  for (const size of rowSizes) {
    const rows = script.chapters.map(c => layRow(c.title, c.timecode, fw - 2 * pad, size, false));
    const total = rows.reduce((sum, r) => sum + (r?.h ?? 0), 0) + pad * 2 + (n - 1) * 8;
    if (rows.every(Boolean) && total <= H - 20) { rowSize = size; break; }
  }
  const layRows = (width: number) => { let y = pad; return script.chapters.map(c => { const r = layRow(c.title, c.timecode, width - 2 * pad, rowSize, true)!; const out = { ...r, y }; y += r.h + 8; return out; }); };
  let rows = layRows(fw);
  const stripH = rows[focusIndex]?.h ?? 100;
  let fh = H - 24, vh = fh - 18 - stripH, vw = Math.round(vh * 16 / 9);
  if (vw + 36 > fw) { vw = fw - 36; vh = Math.round(vw * 9 / 16); fh = vh + 18 + stripH; } else { fw = vw + 36; rows = layRows(fw); }
  let list: Geo['list'] = null;
  if (n) { const h = rows.reduce((sum, r) => sum + r.h, 0) + (n - 1) * 8 + pad * 2; list = { box: { x: x0, y: Math.round((H - h) / 2), w: fw, h }, pad, rows }; }
  let bigTitle: Geo['bigTitle'] = null;
  if (focus && !focusMedia) {
    const fit = fitText(focus.title, fw - 96, compact ? [76, 72, 68, 64] : [96, 88, 80, 72, 64], 2, measure);
    bigTitle = { words: fit.words, size: fit.size, lines: lineCount(fit.words) };
    fh = Math.min(H - 24, 40 + CHIP_H + 24 + bigTitle.lines * lineH(fit.size) + 44);
    // A title card is as wide as its title, leaving the reaction column more room.
    fw = Math.min(fw, Math.max(...fit.words.map(w => w.x + w.w), 300) + 96);
  }
  const frame = { x: x0, y: Math.round((H - fh) / 2), w: fw, h: fh };
  const spec = focusMedia ? plan.media.find(m => m.id === focusMedia) : undefined;
  // The clip starts REACTION_LEAD_MS of footage before chat's measured peak, so what chat reacted to plays first
  // (within canonical bounds). Without a measured peak it plays from its in-point.
  const preroll = script.moment && spec ? Math.max(0, Math.min((script.moment.reactionMs ?? 0) - REACTION_LEAD_MS, spec.outMs - spec.inMs - 6000)) : 0;
  // Reaction column to the right of the frame: the counted number over a short chat feed, later the lore plate.
  const rx = x0 + fw + 44, rw = W - rx - 10;
  let counter: Geo['counter'] = null, panel: Geo['panel'] = null;
  if (script.moment) {
    const line = script.countLine(script.moment.count);
    const bigC = compact ? 60 : 84, smallC = compact ? 36 : 44;
    const cwid = Math.min(rw, Math.max(measure(line.big, bigC, 800), measure(line.small, smallC, 700)) + 60);
    const ch = Math.round(bigC * 1.04 + smallC * 1.2 + 40);
    const size = compact ? 38 : 46, lh = Math.round(size * 1.42);
    const seen = new Set<string>(); const lines: string[] = [];
    for (const m of script.moment.messages) { const k = m.toLowerCase(); if (seen.has(k)) continue; seen.add(k); lines.push(fitText(m, rw - 64, [size], 1, measure, 700).text); if (lines.length === 3) break; }
    const ph = lines.length ? 26 + lines.length * lh + 16 : 0;
    const top = Math.max(6, Math.round((H - ch - (ph ? 18 + ph : 0)) / 2));
    counter = { x: rx, y: top, w: cwid, h: ch, big: bigC, small: smallC };
    if (lines.length) panel = { x: rx, y: top + ch + 18, w: Math.min(rw, Math.max(...lines.map(l => measure(l, size, 700))) + 64), h: ph, size, lh, lines };
  }
  let lore: Geo['lore'] = null;
  if (script.lore) {
    // The lore plate may reach over the dimmed frame so its explanation reads in at most three lines.
    const w = Math.min(W - x0 - (compact ? 40 : 300), 1080);
    const termFit = plateText(script.lore.term, w - 60, Array.from({ length: compact ? 5 : 11 }, (_, i) => (compact ? 72 : 96) - i * 4), measure);
    const explSize = compact ? 36 : 44;
    const explanation = script.lore.explanation;
    const sentence = explanation?.match(/^.+?[.!?](?=\s|$)/u)?.[0];
    const whole = explanation ? layoutWords(explanation, w - 60, explSize, measure, 700) : null;
    const chosen = explanation ? (whole && lineCount(whole) <= 2 ? explanation : sentence ?? explanation) : null;
    const fit = chosen ? fitText(chosen, w - 60, [explSize, explSize - 4].filter(v => v >= 36), 3, measure, 700) : null;
    const lines = fit ? Array.from({ length: lineCount(fit.words) }, (_, i) => fit.words.filter(word => word.line === i).map(word => word.text).join(' ')) : [];
    const h = Math.round(30 + termFit.size * 1.02 + (lines.length ? 18 + lines.length * explSize * 1.24 : 0) + 34);
    const pw = Math.min(w, Math.max(measure(termFit.text, termFit.size, 800) + 60, ...lines.map(l => measure(l, explSize, 700) + 60)));
    lore = { term: termFit.text, x: pw <= rw ? rx : Math.max(x0, W - 10 - pw), y: Math.round((H - h) / 2), w: pw, h, termSize: termFit.size, expl: lines, explSize, stampW: measure(script.lore.stamp, 36, 700) + 28 };
  }
  // The now card: the largest object and the present, in vermilion. A corner window keeps the last clip playing.
  let now: Geo['now'] = null;
  if (script.now) {
    const cardW = W - 2 * x0;
    const wantsWindow = options.reducedMotion ? n > 0 : !!(script.now.mediaId ?? focusMedia);
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
  const timeline = buildTimeline(script, plan.durationMs, now ? now.groups.length : 0, !!focusMedia);
  const geo: Geo = { W, H, compact, script, timeline, measure, big, plateH, padX, welcomeY, greetW, guests, viewers, tile, lead: { x: leadX, w: leadW }, rest,
    notchH, x0, list, frame, stripH, focusMedia, preroll, bigTitle, column: { x: rx, w: rw }, counter, panel, lore, now,
    mark: { size: markSize, x: x0, y: H - markSize - 22 }, command };
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

/** A chapter row: timecode chip and title words, in the row's local coordinates (row padding 24). */
function rowRuns(g: Geo, index: number, prefix: string, rowH: number, enterP: number, exitQ: number, dim = 1): { chip: Run[]; title: Run[]; chipW: number } {
  const row = g.list!.rows[index]!, c = g.script.chapters[index]!;
  const lh = lineH(row.size);
  const ty = Math.round((rowH - row.lines * lh) / 2) + 2;
  const title = row.words.map((w, i) => {
    const r = kinetic(run(`${prefix}w${i}`, w.text, 24 + row.chipW + 22 + w.x, ty + w.line * lh, row.size, 800, COLORS.ink), clamp(enterP * (row.words.length + 4) / 4 - i * .25), clamp(exitQ * (row.words.length + 3) / 3 - i * .3));
    return { ...r, opacity: r.opacity * dim };
  });
  const chip = [kinetic(run(`${prefix}tc`, c.timecode, 18, Math.round((CHIP_H - CHIP_SIZE) / 2) - 1, CHIP_SIZE, 700, COLORS.paper, { tabular: true }), enterP, exitQ)];
  return { chip, title, chipW: row.chipW };
}

/** The middle of the scene: chapter list → the focus chapter opens into its clip → chat reacts → the joke it became. */
function middleState(t: number, g: Geo): SceneObject[] {
  const T = g.timeline, M = T.middle, out: SceneObject[] = [];
  if (!M || !g.list) return out;
  const L = g.list, N = g.now, F = g.frame;
  const mergeP = N ? glide(seg(t, T.mergeAt, T.mergeAt + 650)) : 0;
  // ── The list: a paper card; rows land one after another; the focus row lights while the others dim ──
  if (M.listAt !== null && t >= M.listAt - 80) {
    const arrive = enter(seg(t, M.listAt - 80, M.listAt + 460));
    const leave = glide(seg(t, M.extractAt, M.extractAt + 420));
    if (leave < 1) {
      const lit = M.litAt !== null ? glide(seg(t, M.litAt, M.litAt + 280)) : 0;
      const box = { x: L.box.x, y: L.box.y + (1 - arrive) * 90 + leave * 70, w: L.box.w, h: L.box.h };
      const drift = Math.sin(seg(t, M.listAt, M.extractAt) * Math.PI) * 4;
      out.push(obj({ key: 'list', kind: 'card', tone: 'paper', ...box, x: box.x + drift, radius: 24, z: 20, rot: mix(-4, 0, arrive) - leave * 1.5, sx: 1 - leave * .04, sy: 1 - leave * .04,
        opacity: clamp(arrive * 3) * (1 - leave), lift: .4 }));
      L.rows.forEach((row, i) => {
        if (i === M.focus && M.litAt !== null && t >= M.litAt) return; // the lit row is carried by the frame card
        const at = M.rowsAt[i] ?? M.listAt!;
        const dim = 1 - lit * .62;
        const r = rowRuns(g, i, `r${i}`, row.h, seg(t, at, at + 360), 0, i === M.focus ? 1 : dim);
        const rowBox = { x: box.x + L.pad + drift, y: box.y + row.y, w: box.w - 2 * L.pad, h: row.h };
        out.push(obj({ key: `row:${i}`, kind: 'plate', tone: 'clear', origin: 'tl', ...rowBox, radius: 0, z: 21, opacity: (1 - leave) * clamp(seg(t, at - 40, at + 60)), sx: 1 - leave * .04, sy: 1 - leave * .04, runs: r.title }));
        out.push(obj({ key: `chip:${i}`, kind: 'plate', tone: 'notch', origin: 'tl', x: rowBox.x + 24, y: rowBox.y + (row.h - CHIP_H) / 2, w: r.chipW, h: CHIP_H, radius: 12, z: 22, mask: true,
          sx: mix(.4, 1, springAt(t, at, .6, 16)), sy: mix(.4, 1, springAt(t, at, .6, 16)), opacity: (1 - leave) * clamp(seg(t, at, at + 90)) * (i === M.focus ? 1 : dim), runs: r.chip }));
      });
    }
  }
  return out;
}

/** The hero card: the lit row, the clip frame it grows into, then the now card, then the mark. */
function heroState(t: number, g: Geo): SceneObject[] {
  const { script, timeline: T } = g, M = T.middle, N = g.now, F = g.frame;
  const out: SceneObject[] = [];
  const ink = COLORS.ink, paper = COLORS.paper;
  const exitAt = T.exitAt;
  if (t >= exitAt + 560) return out;
  const mergeP = N && M ? glide(seg(t, T.mergeAt, T.mergeAt + 650)) : 0;
  let box: Box, rot = 0, open = 0, scale = 1, lift = .5;
  const L = g.list;
  const row = M && L ? L.rows[M.focus]! : null;
  const start = M ? (M.litAt ?? M.extractAt) : T.mergeAt;
  if (!M || !row || t < start) {
    if (!N || M || t < T.mergeAt - 160) return out;
    // Without chapters the now card enters from the left edge on its own.
    const inP = springAt(t, T.mergeAt - 160, .7, 12);
    box = { ...N.card, x: mix(-N.card.w - 200, N.card.x, inP) };
    rot = mix(-4, 0, enter(seg(t, T.mergeAt - 160, T.mergeAt + 420)));
  } else {
    // The row box inside the list, or (without a list) a row standing on the frame's floor that enters from the left.
    const listRow = M.listAt !== null ? { x: L!.box.x + L!.pad, y: L!.box.y + row.y, w: L!.box.w - 2 * L!.pad, h: row.h } : null;
    let rowBox: Box;
    if (listRow) {
      const lit = glide(seg(t, M.litAt!, M.litAt! + 280));
      scale = 1 + lit * .035 + pulse(t, M.litAt! + 120, 260) * .02;
      lift = .3 + lit * .7;
      rowBox = listRow;
    } else {
      const inP = springAt(t, M.extractAt, .7, 13);
      rowBox = { x: mix(-F.w - 200, F.x, inP), y: F.y + F.h - row.h, w: F.w, h: row.h };
      rot = mix(-6, 0, enter(seg(t, M.extractAt, M.extractAt + 420)));
    }
    open = glide(seg(t, M.openAt, M.openedAt));
    // The row grows upward into the frame: its bottom edge stays put while the picture opens above it.
    box = lerpBox(rowBox, F, open);
    if (open > 0) scale = mix(scale, 1, open) * (1 + pulse(t, M.openedAt, 240) * .015);
    // A slow push-in while the clip plays keeps the hold alive.
    scale *= 1 + .02 * glide(seg(t, M.openedAt, T.mergeAt));
  }
  if (N) scale *= 1 + .025 * glide(seg(t, T.settleAt - 300, exitAt + 100));
  // While the joke is told, the frame steps back: it dims a little and slides left (one focus at a time).
  const dim = M && M.loreAt !== null && g.lore && g.lore.x < g.frame.x + g.frame.w ? glide(seg(t, M.loreAt, M.loreAt + 420)) * (1 - glide(seg(t, T.mergeAt - 100, T.mergeAt + 300))) : 0;
  if (dim > 0) { box = { ...box, x: box.x - dim * 40 }; scale *= 1 - dim * .06; }
  if (mergeP > 0) box = lerpBox(box, N!.card, mergeP);
  const contract = glide(seg(t, exitAt + 40, exitAt + 480));
  if (contract > 0) box = lerpBox(box, { x: g.mark.x, y: g.mark.y, w: g.mark.size, h: g.mark.size }, contract);
  const breathe = N && t > T.mergeAt + 300 ? Math.sin((t - T.mergeAt - 300) / 1500 * Math.PI) : 0;
  const settled = N ? seg(t, T.mergeAt + 300, T.mergeAt + 900) * (1 - contract) : 0;
  const rotY = breathe * 2 * settled, rotX = (Math.cos((t - T.mergeAt) / 1900 * Math.PI) - 1) * .8 * settled;
  const presentP = N ? (M ? mergeP : 1) : contract;
  const fill = N ? undefined : presentP > 0 ? mixColor(COLORS.paper, COLORS.vermilion, presentP) : undefined;
  const wipe = N ? (M ? clamp(glide(seg(t, T.mergeAt - 40, T.mergeAt + 280))) : 1) : undefined;
  const side = presentP > 0 ? mixColor(COLORS.paperSide, COLORS.vermilionSide, presentP) : undefined;
  const radius = mix(mix(18, 28, open), g.mark.size * .26, contract);
  // ── Media: the focus clip fills the frame above the strip; after the merge the last clip keeps playing in a corner window ──
  let media: SceneObject['media'] | undefined;
  const nowMedia = script.now?.mediaId ?? g.focusMedia;
  const mediaId = mergeP > .55 ? nowMedia : (open > 0 ? g.focusMedia : null) ?? (mergeP > 0 ? g.focusMedia : null);
  if (mediaId && M) {
    const videoNow = { x: 18, y: 18, w: box.w - 36, h: Math.max(0, box.h - 18 - g.stripH) };
    const win = N?.window ?? { x: box.w / 2, y: box.h / 2, w: 0, h: 0 };
    const inner = mergeP > 0 ? lerpBox({ x: 18, y: 18, w: F.w - 36, h: F.h - 18 - g.stripH }, win, mergeP) : videoNow;
    const collapse = exitIn(seg(t, exitAt, exitAt + 220));
    const usesNowClip = mergeP > .55 && script.now?.mediaId && script.now.mediaId !== g.focusMedia;
    const timeMs = usesNowClip ? Math.max(0, t - T.mergeAt) : Math.max(0, t - M.mediaStart) + g.preroll;
    media = { id: mediaId, x: mix(inner.x, inner.x + inner.w / 2, collapse), y: mix(inner.y, inner.y + inner.h / 2, collapse), w: inner.w * (1 - collapse), h: inner.h * (1 - collapse),
      radius: 14, opacity: (1 - collapse) * (mergeP > 0 ? 1 : clamp((open - .35) * 2.6)) * (N && !N.window ? 1 - clamp(mergeP * 2.5) : 1), timeMs, playing: collapse < 1 };
  }
  // ── Words on the card: the focus chapter (chip + title on the strip, or large on a title card); then the now statement ──
  const runs: Run[] = [];
  let chip: SceneObject | null = null;
  if (M && row && t >= start && contract <= 0) {
    const out0 = N ? seg(t, T.mergeAt - 60, T.mergeAt + 200) : 0;
    const lh = lineH(row.size);
    if (g.bigTitle) {
      // No clip: the row's title grows into a large title card.
      const B = g.bigTitle, bl = lineH(B.size);
      row.words.forEach((w, i) => {
        const b = B.words[i] ?? { ...w, x: w.x * B.size / row.size, line: 0 };
        const x = mix(24 + row.chipW + 22 + w.x, 48 + b.x, open), y = mix(box.h - row.h + Math.round((row.h - row.lines * lh) / 2) + 2 + w.line * lh, 40 + CHIP_H + 24 + b.line * bl, open);
        runs.push(kinetic(run(`fw${i}`, w.text, x, y, mix(row.size, B.size, open), 800, ink), 1, clamp(out0 * (row.words.length + 3) / 3 - i * .3)));
      });
    } else {
      const ty = box.h - row.h + Math.round((row.h - row.lines * lh) / 2) + 2;
      row.words.forEach((w, i) => runs.push(kinetic(run(`fw${i}`, w.text, 24 + row.chipW + 22 + w.x, ty + w.line * lh, row.size, 800, ink), 1, clamp(out0 * (row.words.length + 3) / 3 - i * .3))));
    }
    const chipLocal = g.bigTitle ? { x: mix(24, 48, open), y: mix(box.h - row.h + (row.h - CHIP_H) / 2, 40, open) } : { x: 24, y: box.h - row.h + (row.h - CHIP_H) / 2 };
    const p = attach(box, scale, rot, chipLocal.x, chipLocal.y);
    const c = script.chapters[M.focus]!;
    if (out0 < 1) chip = obj({ key: 'hero-chip', kind: 'plate', tone: 'notch', origin: 'tl', x: p.x, y: p.y + out0 * 30, w: row.chipW, h: CHIP_H, radius: 12, z: 52, mask: true, sx: scale, sy: scale, rot, opacity: 1 - out0,
      runs: [run('tc', c.timecode, 18, Math.round((CHIP_H - CHIP_SIZE) / 2) - 1, CHIP_SIZE, 700, paper, { tabular: true })] });
  }
  if (N && (mergeP > 0 || !M)) {
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
  // ── "Right now" is cut into the now card's top edge ──
  let notch: SceneObject['notch'];
  const notchOut = enter(seg(t, exitAt, exitAt + 200));
  if (N && notchOut < 1 && (mergeP > 0 || !M)) {
    const rise = M ? enter(seg(t, T.mergeAt + 160, T.mergeAt + 460)) : 1;
    const ty = Math.round((g.notchH - 36) / 2) - 1;
    notch = { x: 28, w: N.notchW, h: g.notchH * (1 - notchOut) * rise, runs: [kinetic(run('now-label', script.now!.label, 20, ty, 36, 700, paper), rise, notchOut, 1.4)], opacity: 1 };
  }
  const sheen = N && t > T.settleAt - 200 && contract <= 0 ? seg(t, T.settleAt - 200, T.settleAt + 1800) : undefined;
  out.push(obj({ key: 'hero', kind: 'card', tone: 'paper', x: box.x, y: box.y, w: box.w, h: box.h, radius, z: 50, rot, sx: scale, sy: scale,
    lift, rotX, rotY, fill, side, wipe, runs, media, sheen, mask: true, notch, opacity: 1 - seg(t, exitAt + 500, exitAt + 560) }));
  if (chip) out.push(chip);
  return out;
}

/** Chat's reaction: the counted number, then real lines stacking in a short feed; the feed becomes the lore plate. */
function reactionState(t: number, g: Geo): SceneObject[] {
  const T = g.timeline, M = T.middle, s = g.script, out: SceneObject[] = [];
  if (!M) return out;
  const ink = COLORS.ink, paper = COLORS.paper, N = g.now;
  const loreAt = M.loreAt ?? T.mergeAt;
  if (g.counter && M.counterAt !== null && s.moment && t >= M.counterAt) {
    const c = g.counter, inP = springAt(t, M.counterAt, .55, 15), outP = exitIn(seg(t, loreAt - 40, loreAt + 240));
    if (outP < 1) {
      const n = Math.round(s.moment.count * expoOut(seg(t, M.counterAt + 60, M.counterAt + 760)));
      const line = s.countLine(n), fin = s.countLine(s.moment.count);
      const bump = pulse(t, M.counterAt + 760, 260);
      out.push(obj({ key: 'counter', kind: 'plate', tone: 'lime', origin: 'tl', x: c.x + (1 - clamp(inP)) * 90, y: c.y - outP * (c.y + c.h + 90), w: c.w, h: c.h, radius: 20, z: 60, rot: mix(-5, -1.2, inP) - outP * 3, sx: (1 + bump * .05) * mix(.6, 1, clamp(inP)), sy: (1 + bump * .05) * mix(.6, 1, clamp(inP)),
        opacity: clamp(seg(t, M.counterAt, M.counterAt + 80)),
        runs: [run('n', n === s.moment.count ? fin.big : line.big, 30, 18, c.big, 800, ink, { tabular: true }), run('s', fin.small, 30, 18 + Math.round(c.big * 1.04), c.small, 700, ink)] }));
    }
  }
  // The feed panel and the lore plate are one object: the dark chat panel turns vermilion and becomes the joke.
  const P = g.panel, Lo = g.lore;
  const firstMsg = M.messagesAt[0];
  const panelIn = P && firstMsg !== undefined && t >= firstMsg - 140;
  const loreIn = Lo && M.loreAt !== null && t >= M.loreAt;
  if (!panelIn && !loreIn) return out;
  const absorb = N ? enter(seg(t, T.mergeAt + 40, T.mergeAt + 440)) : exitIn(seg(t, T.exitAt, T.exitAt + 300));
  if (absorb >= 1) return out;
  const shown = P ? M.messagesAt.filter(at => t >= at - 100).length : 0;
  const morph = Lo && M.loreAt !== null ? glide(seg(t, M.loreAt, M.loreAt + 520)) : 0;
  let box: Box;
  if (P) {
    const growH = 26 + Math.max(1, shown) * P.lh + 16;
    const hP = mix(P.h, growH, 1);
    const pin = springAt(t, firstMsg! - 140, .6, 14);
    const panelBox = { x: P.x, y: P.y, w: P.w, h: mix(hP * .6, hP, clamp(pin)) };
    box = Lo ? lerpBox(panelBox, Lo, morph) : panelBox;
  } else {
    const pop = springAt(t, M.loreAt!, .55, 14);
    box = { ...Lo!, y: Lo!.y + (1 - clamp(pop)) * 60 };
  }
  if (absorb > 0 && N) box = lerpBox(box, { x: N.card.x + N.card.w * .5, y: N.card.y + N.card.h * .3, w: box.w * .4, h: box.h * .4 }, absorb);
  const runs: Run[] = [];
  if (P) P.lines.forEach((text, i) => {
    const at = M.messagesAt[i];
    if (at === undefined) return;
    runs.push(kinetic(run(`m${i}`, text, 32, 26 + i * P.lh + Math.round((P.lh - P.size) / 2) - 4, P.size, 700, paper), seg(t, at - 100, at + 240), clamp(morph * 2.2 - i * .2)));
  });
  if (Lo && M.loreAt !== null && t >= M.loreAt) {
    runs.push(kinetic(run('term', Lo.term, 30, 28, Lo.termSize, 800, ink), seg(t, M.loreAt + 120, M.loreAt + 480)));
    Lo.expl.forEach((line, i) => {
      const at = (M.explAt ?? M.loreAt!) + i * 80;
      runs.push(kinetic(run(`e${i}`, line, 30, Math.round(28 + Lo.termSize * 1.02 + 18 + i * Lo.explSize * 1.24), Lo.explSize, 700, ink), seg(t, at, at + 360)));
    });
  }
  const fill = mixColor(COLORS.high, COLORS.vermilion, clamp(morph * 1.6));
  const side = mixColor(COLORS.lime, COLORS.vermilionSide, clamp(morph * 1.6));
  const drift = Math.sin((t - (firstMsg ?? M.loreAt ?? 0)) / 1300 * Math.PI) * 3;
  out.push(obj({ key: 'feed', kind: 'plate', tone: P ? 'slip' : 'vermilion', origin: 'tl', ...box, y: box.y + drift, radius: 20, z: 56, fill: P ? fill : undefined, side: P ? side : undefined, mask: true,
    rot: mix(-1, -.8, morph), sx: 1, sy: 1, opacity: 1 - seg(absorb, .6, 1), runs }));
  if (Lo && M.stampAt !== null && t >= M.stampAt && absorb < .3) {
    const st = springAt(t, M.stampAt, .42, 20);
    out.push(obj({ key: 'lore-stamp', kind: 'stamp', tone: 'ink', origin: 'tl', x: Math.min(box.x + box.w - Lo.stampW + 12, g.W - Lo.stampW - 6), y: box.y - 24 + drift, w: Lo.stampW, h: 54, radius: 10, z: 57,
      sx: mix(1.7, 1, st), sy: mix(1.7, 1, st), rot: 4, opacity: clamp(seg(t, M.stampAt, M.stampAt + 50)) * (1 - absorb * 3),
      runs: [run('st', s.lore!.stamp, 14, 8, 36, 700, paper, { tabular: true })] }));
  }
  return out;
}

/** Map a point given in a box's local (unscaled) coordinates through the box's scale+rotation about its centre. */
function attach(b: Box, scale: number, rotDeg: number, lx: number, ly: number): { x: number; y: number } {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = (b.x + lx - cx) * scale, dy = (b.y + ly - cy) * scale, r = rotDeg * Math.PI / 180;
  return { x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) };
}

function compute(t: number, g: Geo): SceneObject[] {
  const { script, timeline: T } = g;
  const objects: SceneObject[] = [];
  const ink = COLORS.ink, paper = COLORS.paper;
  const plateRadius = Math.round(g.big * .14);
  const exitAt = T.exitAt;
  const markCentre = { x: g.mark.x + g.mark.size / 2, y: g.mark.y + g.mark.size / 2 };
  // ── Beat 1: greeting plates. Beat 2: the greeting plate becomes "Previously", the brand tile arrives. ──
  const titleOut = T.welcomeOnly ? 0 : exitIn(seg(t, (T.middle ? T.middleAt : T.mergeAt) - 120, (T.middle ? T.middleAt : T.mergeAt) + 200));
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
  // ── The middle: chapter list → focus chapter opens into its clip → chat reacts → the joke it became ──
  objects.push(...middleState(t, g), ...heroState(t, g), ...reactionState(t, g));
  // ── Beat 6: the mark and the real chat command, then everything leaves ──
  objects.push(...markState(t, g));
  void markCentre;
  return objects;
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
  const last = g.timeline.middle?.focus ?? (script.chapters.length ? script.chapters.length - 1 : undefined);
  if (N) out.push(obj({ key: 'now', kind: 'card', tone: 'vermilion', x: N.card.x, y: N.card.y, w: N.card.w, h: N.card.h, radius: 28, z: 25, opacity: o,
    notch: { x: 28, w: N.notchW, h: g.notchH, opacity: 1, runs: [run('l', script.now!.label, 20, Math.round((g.notchH - 36) / 2) - 1, 36, 700, paper)] },
    runs: N.words.map((w, i) => run(`n${i}`, w.text, N.textX + w.x, N.textY + w.line * N.lineH, N.size, 800, ink)) }));
  if (last !== undefined) {
    const chapter = script.chapters[last]!, size = 44;
    const area = N?.window ? { x: N.card.x + N.window.x, y: N.card.y + N.window.y, w: N.window.w, h: N.window.h } : N ? null : { ...g.frame };
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
  const M = T.middle;
  const phase: ScenePhase = !live ? 'clear' : timeMs < (T.morphAt ?? T.raidersOutAt) ? 'welcome' : timeMs < (M ? T.middleAt : T.mergeAt) ? 'title'
    : M && M.counterAt !== null && timeMs >= M.counterAt && timeMs < T.mergeAt ? 'chat' : timeMs < T.mergeAt ? 'chapters' : timeMs < T.exitAt ? 'now' : 'return';
  // Plain-text equivalent of the focal statement, for assistive and summary surfaces.
  let caption: CaptionFrame | null = null;
  const focal = phase === 'now' || phase === 'return' || options.reducedMotion ? S.now?.text
    : phase === 'chapters' || phase === 'chat' ? S.chapters[M && (M.litAt === null || timeMs >= M.litAt) ? M.focus : 0]?.title
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
  const M = T.middle;
  if (M) {
    M.rowsAt.forEach(at => cues.push(['flick', at + 120, .45]));
    if (M.litAt !== null) cues.push(['tap', M.litAt + 100, .35]);
    cues.push(['slide', M.extractAt + 40, .4], ['latch', M.openedAt - 10, .6]);
    if (M.counterAt !== null) cues.push(['chatter', M.counterAt, .55, (M.loreAt ?? T.mergeAt) - M.counterAt]);
    if (M.loreAt !== null) cues.push(['tap', M.loreAt + 260, .55]);
    if (M.stampAt !== null) cues.push(['tap2', M.stampAt + 40, .5]);
  }
  if (g.now) cues.push(['felt', T.mergeAt, .55, 1100], ['resolve', T.settleAt, .5]);
  cues.push(['release', T.exitAt + 60, .45], ['tap', T.exitAt + 400, .4], ['release', T.leaveAt, .5]);
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
