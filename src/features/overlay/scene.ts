import type { RecapPlan, Rect } from '../../shared/contracts/index.js';
import { FRAME, conservativeMeasure, intersects, protectedBounds, wrapCaption, type MeasureText, type SceneLayout } from './geometry.js';
import { clamp, enter, exitIn, expoOut, glide, mix, pulse, quadIn, rand, seg, springAt } from './motion.js';
import { sceneScript, type SceneScript } from './script.js';
import { buildTimeline, type Slot, type Timeline } from './timeline.js';

export const COLORS = { ink: '#14171B', raised: '#1E232A', edge: '#2C333C', paper: '#F4EFE6', paperShade: '#E4DDD0', vermilion: '#FF5A36', vermilionDeep: '#C93F22', vermilionBack: '#8F2F1C', lime: '#C8F560', mutedInk: '#A9B1BC', mutedPaper: '#4A4F57' } as const;
export type Tone = 'vermilion' | 'ink' | 'paper' | 'lime' | 'raised' | 'slip' | 'clear';
export type Run = { key: string; text: string; x: number; y: number; size: number; weight: number; color: string; opacity: number; blur: number; dy: number; dx?: number; scale: number; tabular?: boolean };
export type SceneObject = {
  key: string; kind: 'plate' | 'card' | 'slip' | 'tab' | 'mark' | 'line' | 'stamp';
  tone: Tone; x: number; y: number; w: number; h: number; rot: number; sx: number; sy: number; opacity: number; z: number; radius: number;
  runs: Run[]; mask?: boolean; fill?: string; origin?: 'tl'; lift?: number; rotX?: number; rotY?: number; sheen?: number;
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
type Geo = {
  W: number; H: number; compact: boolean; script: SceneScript; timeline: Timeline;
  big: number; plateH: number; padX: number; greetW: number;
  guests: { text: string; size: number; w: number; h: number } | null;
  viewers: { size: number; h: number; w: number } | null;
  lead: { w: number }; rest: { text: string; size: number; w: number; h: number } | null; restBelow: boolean;
  dock: { scale: number; restScale: number; h: number; oneRowH: number };
  frame: Box; card: Box; tabH: number; tabSize: number; stack: { x: number; y: number; scale: number };
  stripY: number; stripX1: number; rightX: number;
  chapterSize: number; chapterWords: Words[]; chapterLineCounts: number[];
  slips: { text: string; w: number; h: number; tx: number; ty: number; rot: number; fromY: number }[];
  counter: Box & { big: number; small: number } | null;
  lore: { x: number; y: number; termW: number; termH: number; termSize: number; expl: string[]; explSize: number; explW: number; explH: number; stampW: number } | null;
  now: { card: Box; size: number; words: Words; groups: number[][]; window: Box | null; tabW: number; textX: number; textY: number; lineH: number } | null;
  mark: { size: number; x: number; y: number };
  command: { w: number; h: number; size: number; parts: { text: string; weight: number; x: number }[] } | null;
};

const PAD = 0.3;
export const REACTION_LEAD_MS = 2900;
const lineH = (size: number) => Math.round(size * 1.04);

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

const geoCache = new WeakMap<RecapPlan, Map<string, Geo>>();
function geometry(plan: RecapPlan, layout: SceneLayout, options: RenderOptions): Geo {
  const measure = options.measure ?? conservativeMeasure;
  const key = `${layout.bounds.x},${layout.bounds.y},${layout.bounds.width},${layout.bounds.height}|${options.channel ?? ''}|${options.title ?? ''}|${options.measure ? 'm' : 'c'}|${options.availableMedia ? plan.media.filter(m => options.availableMedia!(m.id)).map(m => m.id).join(',') : '*'}`;
  let cache = geoCache.get(plan);
  if (!cache) { cache = new Map(); geoCache.set(plan, cache); }
  const hit = cache.get(key);
  if (hit && hit.script) return hit;
  const raw = sceneScript(plan, { channel: options.channel, title: options.title });
  const W = layout.bounds.width, H = layout.bounds.height, compact = layout.mode === 'compact';
  const available = (id: string | null) => !!id && (!options.availableMedia || options.availableMedia(id));
  const script: SceneScript = { ...raw, chapters: raw.chapters.map(c => ({ ...c, mediaId: available(c.mediaId) ? c.mediaId : null })), now: raw.now ? { ...raw.now, mediaId: available(raw.now.mediaId) ? raw.now.mediaId : null } : null };
  const big = Math.round(clamp(Math.floor((H - 140) / 2.36), 88, 128));
  const plateH = Math.round(big * 1.16), padX = Math.round(big * PAD);
  const greetW = measure(script.greeting, big, 800) + padX * 2;
  let guests: Geo['guests'] = null;
  if (script.guests) {
    let size = big;
    while (size > 64 && measure(script.guests, size, 800) + 2 * Math.round(size * PAD) > W - 16) size -= 4;
    guests = { text: script.guests, size, w: measure(script.guests, size, 800) + 2 * Math.round(size * PAD), h: Math.round(size * 1.16) };
  }
  const viewers = script.viewers !== null ? { size: 52, h: 70, w: Math.round(measure(script.viewersLabel(script.viewers), 52, 700) + 44) } : null;
  const leadW = measure(script.titleLead, big, 800) + padX * 2;
  let rest: Geo['rest'] = null;
  if (script.titleRest) {
    let size = Math.round(big * .78);
    while (size > 56 && measure(script.titleRest, size, 800) + 2 * Math.round(size * PAD) > W - 16) size -= 4;
    rest = { text: script.titleRest, size, w: measure(script.titleRest, size, 800) + 2 * Math.round(size * PAD), h: Math.round(size * 1.16) };
  }
  const restBelow = !!rest && leadW + 16 + rest.w > W - 8;
  const dockScale = 46 / big, restScale = rest ? Math.max(36 / rest.size, dockScale) : dockScale;
  const dock = { scale: dockScale, restScale, h: Math.round(plateH * dockScale) + (rest ? 8 + Math.round(rest.h * restScale) : 0), oneRowH: Math.round(plateH * dockScale) };
  // Hero frame column; compact bands put it at the right edge.
  const tabH = 50, tabSize = 36;
  const fh = Math.round(H - 102), fw = Math.round(fh * 16 / 9);
  const fx = compact ? Math.max(0, W - fw - 24) : Math.round(Math.min(W * .36, W - fw - 380));
  const frame = { x: fx, y: 60, w: fw, h: fh };
  const cw = Math.round(clamp(fw * .92, 440, 620)), ch = 236;
  const card = { x: fx, y: 60 + 40, w: cw, h: ch };
  const chapterSize = 64;
  const chapterWords: Words[] = [], chapterLineCounts: number[] = [];
  const kept: SceneScript['chapters'] = [];
  for (const chapter of script.chapters) {
    const words = layoutWords(chapter.title, cw - 72, chapterSize, measure, 800);
    if (!words || lineCount(words) > 2) continue; // An unfitting title stays out instead of shrinking or slicing.
    kept.push(chapter); chapterWords.push(words); chapterLineCounts.push(lineCount(words));
  }
  const momentChapter = raw.moment ? script.chapters[raw.moment.chapterIndex] : undefined;
  script.chapters = kept;
  script.moment = raw.moment && momentChapter && kept.includes(momentChapter) ? { ...raw.moment, chapterIndex: kept.indexOf(momentChapter) } : null;
  const stackScale = .78;
  const stack = { x: 12, y: dock.h + 14 + tabH, scale: stackScale };
  const stripY = H - 46, stripX1 = Math.max(260, fx - 40);
  const rightX = compact ? 0 : fx + fw + 40;
  const rightW = compact ? Math.max(360, fx - 40) : W - rightX;
  // Chat moment: counter at the top of the reaction column, slips pile below it.
  let counter: Geo['counter'] = null; const slips: Geo['slips'] = [];
  if (script.moment) {
    const line = script.countLine(script.moment.count);
    const bigC = 56, smallC = 38;
    const cwid = Math.max(measure(line.big, bigC, 800), measure(line.small, smallC, 700)) + 48;
    counter = { x: compact ? 8 : fx + fw - cwid + 34, y: 4, w: cwid, h: Math.round(bigC * 1.05 + smallC * 1.2 + 28), big: bigC, small: smallC };
    // Slips fall into a pile: rows fill from the bottom of the reaction column, later slips land higher.
    const left = compact ? 8 : fx + fw - 40, right = W - 6, pitch = 58;
    let rowY = H - 66, x = left, row = 0;
    script.moment.messages.forEach((text, i) => {
      const size = 38, w = Math.round(measure(text, size, 700) + 40), h = 62;
      if (x > left && x + w > right) { row++; rowY -= pitch; x = left + (row % 2) * 26; }
      const jitter = (rand(text, i) - .5) * 22;
      slips.push({ text, w, h, tx: clamp(x + jitter, left - 10, right - w), ty: Math.max(4, rowY + (rand(text, i + 9) - .5) * 10), rot: (rand(text, i + 3) - .5) * 9, fromY: frame.y + frame.h * (.2 + .5 * rand(text, i + 5)) });
      x += w + 8;
    });
  }
  let lore: Geo['lore'] = null;
  if (script.lore) {
    const loreX = compact ? 8 : Math.max(card.x + card.w + 20, W - 700);
    const colW = W - loreX - 8;
    let termSize = 72;
    while (termSize > 52 && measure(script.lore.term, termSize, 800) + termSize * .6 > colW) termSize -= 4;
    const termW = measure(script.lore.term, termSize, 800) + Math.round(termSize * .6), termH = Math.round(termSize * 1.16);
    const explSize = 36, maxW = Math.max(320, colW - 12);
    const tryLines = (text: string) => { const lines = wrapCaption(text, maxW - 36, explSize, (t, s) => measure(t, s, 700)); return lines.length <= 3 ? lines : null; };
    const explanation = script.lore.explanation;
    let expl = explanation ? tryLines(explanation) : null;
    if (!expl && explanation) { const first = explanation.match(/^.+?[.!?](?=\s|$)/u)?.[0]; expl = first ? tryLines(first) : null; }
    const explW = expl ? Math.max(...expl.map(l => measure(l, explSize, 700))) + 36 : 0;
    lore = { x: loreX, y: compact ? 52 : 58, termW, termH, termSize, expl: expl ?? [], explSize, explW, explH: expl ? Math.round(expl.length * explSize * 1.2 + 26) : 0, stampW: measure(script.lore.stamp, 36, 700) + 30 };
  }
  // The now card: largest object, a corner window keeps the last clip playing.
  let now: Geo['now'] = null;
  if (script.now) {
    const cardY = dock.oneRowH + 12 + tabH, cardW = Math.min(W, 1640), cardH = H - cardY - 6;
    const hasWindow = !!(script.now.mediaId ?? [...script.chapters].reverse().find(c => c.mediaId)?.mediaId);
    const ww = hasWindow ? Math.round(clamp(cardW * .24, 280, 420)) : 0, wh = Math.round(ww * 9 / 16);
    const textW = cardW - 96 - (hasWindow ? ww + 40 : 0);
    let chosen: { size: number; words: Words } | null = null;
    for (const size of [96, 92, 88, 84, 80]) { const words = layoutWords(script.now.text, textW, size, measure, 800); if (words && lineCount(words) <= 2) { chosen = { size, words }; break; } }
    if (chosen) {
      const lh = lineH(chosen.size), lines = lineCount(chosen.words);
      now = { card: { x: 0, y: cardY, w: cardW, h: cardH }, size: chosen.size, words: chosen.words, groups: wordGroups(chosen.words), window: hasWindow ? { x: cardW - ww - 26, y: 26, w: ww, h: wh } : null,
        tabW: measure(script.now.label, tabSize, 700) + 40, textX: 48, textY: Math.round((cardH - lines * lh) / 2 + (lines === 1 ? 0 : 4)), lineH: lh };
    } else script.now = null;
  }
  const markSize = Math.round(Math.min(150, H * .33));
  let command: Geo['command'] = null;
  if (script.command) {
    const size = 40, parts: { text: string; weight: number; x: number }[] = [];
    let x = 24;
    for (const [text, weight] of [[script.command.before, 600], [script.command.command, 800], [script.command.after, 600]] as const) { parts.push({ text, weight, x }); x += measure(text, size, weight) + measure(' ', size, 600); }
    command = { w: Math.round(x - measure(' ', size, 600) + 24), h: 66, size, parts };
  }
  const groupCount = now ? now.groups.length : 0;
  const timeline = buildTimeline(script, plan.durationMs, groupCount);
  const geo: Geo = { W, H, compact, script, timeline, big, plateH, padX, greetW, guests, viewers, lead: { w: leadW }, rest, restBelow, dock,
    frame, card, tabH, tabSize, stack, stripY, stripX1, rightX, chapterSize, chapterWords, chapterLineCounts, slips, counter, lore, now,
    mark: { size: markSize, x: 20, y: H - markSize - 18 }, command };
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

function compute(t: number, plan: RecapPlan, layout: SceneLayout, g: Geo): SceneObject[] {
  const { W, H, script, timeline: T } = g;
  const objects: SceneObject[] = [];
  const ink = COLORS.ink, paper = COLORS.paper;
  const plateRadius = Math.round(g.big * .16);
  // ── Beat 1 and 2: greeting plates, then the title morph and dock ──
  const leadText = (() => {
    const out: Run[] = [];
    const greet = run('greet', script.greeting, g.padX, Math.round((g.plateH - g.big) / 2), g.big, 800, ink);
    if (T.welcomeOnly) { out.push(greet); return out; }
    const m = T.morphAt!;
    out.push(kinetic(greet, 1, seg(t, m + 20, m + 190)));
    out.push(kinetic(run('lead', script.titleLead, g.padX, greet.y, g.big, 800, ink), seg(t, m + 140, m + 420)));
    return out;
  })();
  const aIn = springAt(t, T.aAt, .58, 13);
  const aLand = pulse(t, T.aAt + 170, 260);
  let aW = g.greetW;
  if (!T.welcomeOnly) aW = mix(g.greetW, g.lead.w, glide(seg(t, T.morphAt! + 20, T.morphAt! + 300)));
  const morphSquash = T.welcomeOnly ? 0 : pulse(t, T.morphAt! + 120, 380);
  // Dock: shrink toward the top-left corner label.
  const dockP = glide(seg(t, T.dockAt, T.dockAt + 420));
  const mergeRow = g.now ? glide(seg(t, T.mergeAt, T.mergeAt + 500)) : 0;
  const dockScale = mix(1, g.dock.scale, dockP);
  const aX = mix(-aW - 140, 0, aIn), aY = mix(30, 0, dockP);
  // Leaves with everything else when the scene contracts into the mark.
  const absorb = enter(seg(t, T.exitAt + 140, T.exitAt + 470));
  const markCentre = { x: g.mark.x + g.mark.size / 2, y: g.mark.y + g.mark.size / 2 };
  const absorbBox = (b: Box, s: number) => ({ x: mix(b.x, markCentre.x - b.w * s * .1, absorb), y: mix(b.y, markCentre.y - b.h * s * .1, absorb) });
  if (t < T.exitAt + 470) {
    const pos = absorbBox({ x: aX, y: aY, w: aW, h: g.plateH }, dockScale);
    objects.push(obj({ key: 'title-lead', kind: 'plate', tone: 'vermilion', origin: 'tl', x: pos.x, y: pos.y, w: aW, h: g.plateH, radius: plateRadius, z: 30, mask: true,
      sx: dockScale * (1 + aLand * .07 - morphSquash * .06) * (1 - absorb * .85), sy: dockScale * (1 - aLand * .06 + morphSquash * .08) * (1 - absorb * .85),
      opacity: 1 - seg(t, T.exitAt + 380, T.exitAt + 470), runs: leadText, rot: mix(-3, 0, enter(seg(t, T.aAt, T.aAt + 400))) }));
  }
  // Second word group: the raiders (ink plate), then exits upward behind the lead plate.
  if (g.guests && T.bAt !== null) {
    const bIn = springAt(t, T.bAt, .6, 14), out = exitIn(seg(t, T.raidersOutAt + 60, T.raidersOutAt + 320));
    const y0 = 30 + g.plateH + 14;
    if (out < 1) objects.push(obj({ key: 'guests', kind: 'plate', tone: 'ink', x: mix(-g.guests.w - 160, 0, bIn), y: y0 + mix(40, 0, bIn) - out * (y0 + g.guests.h + 40), w: g.guests.w, h: g.guests.h,
      radius: plateRadius, z: 28, rot: mix(-5, 0, enter(seg(t, T.bAt, T.bAt + 450))) - out * 2, sx: 1 + pulse(t, T.bAt + 190, 240) * .06, sy: 1 - pulse(t, T.bAt + 190, 240) * .05,
      runs: [run('g', g.guests.text, Math.round(g.guests.size * PAD), Math.round((g.guests.h - g.guests.size) / 2), g.guests.size, 800, paper)] }));
    if (g.viewers && T.viewersAt !== null && script.viewers !== null) {
      const vIn = springAt(t, T.viewersAt, .5, 16), vOut = exitIn(seg(t, T.raidersOutAt, T.raidersOutAt + 240));
      const count = Math.round(script.viewers * expoOut(seg(t, T.viewersAt, T.viewersAt + 520)));
      const label = script.viewersLabel(count), finalLabel = script.viewersLabel(script.viewers);
      const vy = y0 + g.guests.h + 14;
      const vw = g.viewers.w; void finalLabel;
      if (vOut < 1) objects.push(obj({ key: 'viewers', kind: 'plate', tone: 'paper', origin: 'tl', x: 0, y: vy - vOut * (vy + 120), w: vw, h: g.viewers.h, radius: 14, z: 27,
        sx: mix(.4, 1, vIn), sy: mix(.4, 1, vIn), opacity: clamp(seg(t, T.viewersAt, T.viewersAt + 80)), rot: mix(4, 0, vIn),
        runs: [run('v', label, 20, Math.round((g.viewers.h - g.viewers.size) / 2) - 1, g.viewers.size, 700, ink, { tabular: true })] }));
    }
  }
  // "on Foxlight Dev" slides out from under the lead plate, then docks under it.
  if (g.rest && !T.welcomeOnly) {
    const m = T.morphAt!;
    const outP = springAt(t, m + 330, .7, 13);
    const finalX = g.restBelow ? 0 : g.lead.w + 16, finalY = g.restBelow ? 30 + g.plateH + 14 : 30 + (g.plateH - g.rest.h);
    const hiddenX = g.restBelow ? 0 : Math.max(0, g.lead.w - g.rest.w), hiddenY = g.restBelow ? 30 : finalY;
    const dockedX = 0, dockedY = Math.round(g.plateH * g.dock.scale) + 8;
    const rowX = g.lead.w * g.dock.scale + 10, rowY = Math.round((g.plateH * g.dock.scale - g.rest.h * g.dock.restScale) / 2);
    let x = mix(hiddenX, finalX, outP), y = mix(hiddenY, finalY, outP);
    x = mix(x, dockedX, dockP); y = mix(y, dockedY, dockP);
    x = mix(x, rowX, mergeRow); y = mix(y, rowY, mergeRow);
    const s = mix(1, g.dock.restScale, dockP);
    const pos = absorbBox({ x, y, w: g.rest.w, h: g.rest.h }, s);
    if (t >= m + 300 && t < T.exitAt + 470) objects.push(obj({ key: 'title-rest', kind: 'plate', tone: 'paper', origin: 'tl', x: pos.x, y: pos.y, w: g.rest.w, h: g.rest.h, radius: Math.round(g.rest.size * .16), z: 29,
      sx: s * (1 - absorb * .85) * (g.restBelow ? 1 : mix(Math.min(1, g.lead.w * .9 / g.rest.w), 1, clamp(outP))), sy: s * (1 - absorb * .85), opacity: 1 - seg(t, T.exitAt + 380, T.exitAt + 470),
      runs: [run('r', g.rest.text, Math.round(g.rest.size * PAD), Math.round((g.rest.h - g.rest.size) / 2), g.rest.size, 800, ink)] }));
  }
  // ── Beat 3: chapter cards, the hero card that opens into clips, and the timeline strip ──
  const slots = T.slots;
  const cardRadius = 22;
  const cardBox = g.card, frameBox = g.frame;
  const chapterRuns = (index: number, color: string, prefix: string) => (g.chapterWords[index] ?? []).map((w, i) => run(`${prefix}${index}:${i}`, w.text, 36 + w.x, 70 + w.line * lineH(g.chapterSize), g.chapterSize, 800, color));
  if (T.stackAt !== null && slots.length) {
    // Waiting cards: every shown chapter except those already taken by the hero.
    slots.forEach((slot, order) => {
      if (order === 0) return; // the first card becomes the hero
      const arrive = enter(seg(t, T.stackAt! + order * 90, T.stackAt! + order * 90 + 460));
      const taken = seg(t, slot.focusAt + 100, slot.focusAt + 360);
      if (taken >= 1) return;
      const waiting = slots.filter((s, k) => k > 0 && s.focusAt + 100 > t).indexOf(slot);
      const k = Math.max(0, waiting);
      const restX = g.stack.x + k * 26, restY = g.stack.y + k * 16, rot0 = [-3.5, 2.2, -1.2][k] ?? 0;
      const tp = glide(taken);
      const s = mix(g.stack.scale, 1, tp);
      const vx = mix(-cardBox.w - 160, restX, arrive), vy = restY + (1 - arrive) * 60;
      const box = { x: mix(vx - cardBox.w * (1 - g.stack.scale) / 2, cardBox.x, tp), y: mix(vy - cardBox.h * (1 - g.stack.scale) / 2, cardBox.y, tp), w: cardBox.w, h: cardBox.h };
      const rot = mix(mix(-16, rot0, arrive), 0, tp);
      objects.push(obj({ key: `stack:${slot.chapter}`, kind: 'card', tone: 'ink', ...box, radius: cardRadius, z: 10 - k, sx: s, sy: s, rot, opacity: 1 - seg(taken, .8, 1),
        runs: chapterRuns(slot.chapter, paper, 's'), lift: .4 }));
      const tc = script.chapters[slot.chapter]!.timecode, tp0 = attach(box, s, rot, 28 + k * 120, -g.tabH + 6);
      objects.push(obj({ key: `stack-tab:${slot.chapter}`, kind: 'tab', tone: 'paper', origin: 'tl', x: tp0.x, y: tp0.y, w: tabWidth(g, tc), h: g.tabH, radius: 10, z: 9 - k, sx: s, sy: s, rot,
        opacity: 1 - seg(taken, .7, 1), runs: [run('tc', tc, 20, Math.round((g.tabH - g.tabSize) / 2) - 1, g.tabSize, 700, ink, { tabular: true })] }));
    });
    // Timeline strip: a thin rule along the bottom edge with a tab per finished chapter.
    const stripIn = enter(seg(t, T.stackAt, T.stackAt + 520));
    const stripOut = g.now ? glide(seg(t, T.mergeAt + 80, T.mergeAt + 480)) : glide(seg(t, T.exitAt, T.exitAt + 300));
    if (stripOut < 1) objects.push(obj({ key: 'strip', kind: 'line', tone: 'paper', x: 0, y: g.stripY + 24, w: (g.stripX1) * stripIn * (1 - stripOut), h: 4, radius: 2, z: 3, opacity: .9 }));
    slots.forEach((slot, order) => {
      const next = slots[order + 1];
      if (!next) return;
      const drop = glide(seg(t, next.focusAt, next.focusAt + 400));
      if (drop <= 0) return;
      const tc = script.chapters[slot.chapter]!.timecode, tw = tabWidth(g, tc);
      const sx = 8 + order * (tw + 14), sy = g.stripY;
      const fromX = frameBox.x + 28, fromY = (slot.openAt !== null ? frameBox.y : cardBox.y) - g.tabH + 6;
      const into = g.now ? enter(seg(t, T.mergeAt + order * 50, T.mergeAt + 420 + order * 50)) : 0;
      const tabTarget = g.now ? { x: g.now.card.x + 32, y: g.now.card.y - g.tabH + 6 } : { x: sx, y: sy };
      if (into >= 1) return;
      const arc = Math.sin(drop * Math.PI) * -60;
      objects.push(obj({ key: `strip-tab:${slot.chapter}`, kind: 'tab', tone: 'paper', x: mix(mix(fromX, sx, drop), tabTarget.x, into), y: mix(mix(fromY, sy, drop) + arc, tabTarget.y, into), w: tw, h: g.tabH, radius: 10, z: 4,
        rot: mix(-6, 0, drop) * (1 - into), sx: 1 - into * .4, sy: 1 - into * .4, opacity: 1 - seg(into, .75, 1),
        runs: [run('tc', tc, 20, Math.round((g.tabH - g.tabSize) / 2) - 1, g.tabSize, 700, ink, { tabular: true })] }));
    });
  }
  // The hero: first stack card → card → clip frame → (swap) … → now card → mark.
  const hero = heroState(t, g);
  if (hero) objects.push(...hero);
  // ── Beat 4: chat slips burst from the frame edge, a counter counts, the slips collapse into the lore plate ──
  const chatSlot = slots.find(slot => slot.chat);
  if (chatSlot?.chat && script.moment) {
    const { burstAt, collapseAt, loreAt } = chatSlot.chat;
    const m = g.slips.length, gap = Math.min(85, 900 / Math.max(1, m));
    const gather = { x: (g.lore?.x ?? g.rightX) + (g.lore?.termW ?? 200) / 2, y: (g.lore?.y ?? 40) + (g.lore?.termH ?? 80) / 2 };
    g.slips.forEach((slip, i) => {
      const at = burstAt + i * gap;
      if (t < at) return;
      const fly = expoOut(seg(t, at, at + 520));
      const settle = springAt(t, at + 300, .45, 18);
      const back = (m - 1 - i) * 18;
      const col = glide(seg(t, collapseAt + back, collapseAt + back + 380));
      if (col >= 1) return;
      const fromX = frameBox.x + frameBox.w - slip.w * .4;
      const x = mix(mix(fromX, slip.tx, fly), gather.x - slip.w / 2, col);
      const y = mix(mix(slip.fromY, slip.ty, fly) - Math.sin(fly * Math.PI) * 50, gather.y - slip.h / 2, col);
      const s = mix(mix(.55, 1, fly) * (1 + (1 - settle) * .05), .35, col);
      objects.push(obj({ key: `slip:${i}`, kind: 'slip', tone: 'slip', x, y, w: slip.w, h: slip.h, radius: 12, z: 40 + i, rot: mix(mix(-22, slip.rot, fly), 0, col), sx: s, sy: s,
        opacity: clamp(seg(t, at, at + 60)) * (1 - seg(col, .7, 1)), runs: [run('m', slip.text, 20, Math.round((slip.h - 38) / 2) - 2, 38, 700, paper)] }));
    });
    if (g.counter) {
      const c = g.counter, inP = springAt(t, burstAt + 60, .55, 15), outP = exitIn(seg(t, collapseAt + 80, collapseAt + 330));
      if (t >= burstAt + 60 && outP < 1) {
        const n = Math.round(script.moment.count * Math.pow(seg(t, burstAt + 80, burstAt + 1150), .7));
        const line = script.countLine(n), fin = script.countLine(script.moment.count);
        objects.push(obj({ key: 'counter', kind: 'plate', tone: 'lime', x: c.x, y: mix(-c.h - 20, c.y, inP) - outP * (c.h + 80), w: c.w, h: c.h, radius: 16, z: 60, rot: mix(-5, -1.5, inP),
          runs: [run('n', n === script.moment.count ? fin.big : line.big, 24, 14, c.big, 800, ink, { tabular: true }), run('s', fin.small, 24, 14 + Math.round(c.big * 1.05), c.small, 700, ink)] }));
      }
    }
    if (g.lore && script.lore) {
      const L = g.lore;
      const pop = springAt(t, loreAt, .52, 15);
      const into = g.now ? glide(seg(t, T.mergeAt + 60, T.mergeAt + 460)) : glide(seg(t, T.exitAt, T.exitAt + 300));
      const target = g.now ? { x: g.now.card.x + g.now.card.w * .55, y: g.now.card.y + g.now.card.h * .5 } : { x: L.x, y: -200 };
      if (t >= loreAt && into < 1) {
        const lx = mix(L.x, target.x - L.termW * .2, into), ly = mix(L.y, target.y, into), s = mix(mix(.3, 1, pop), .25, into);
        objects.push(obj({ key: 'lore-term', kind: 'plate', tone: 'vermilion', x: lx, y: ly, w: L.termW, h: L.termH, radius: 16, z: 56, sx: s, sy: s, rot: mix(6, -1.5, pop),
          opacity: 1 - seg(into, .6, 1), runs: [run('t', script.lore.term, Math.round(L.termSize * .3), Math.round((L.termH - L.termSize) / 2), L.termSize, 800, ink)] }));
        if (L.expl.length) {
          const slide = enter(seg(t, loreAt + 140, loreAt + 520));
          objects.push(obj({ key: 'lore-expl', kind: 'plate', tone: 'paper', x: lx + 18, y: ly + mix(L.termH - L.explH, L.termH - 6, slide), w: L.explW, h: L.explH, radius: 12, z: 55, sx: s, sy: s, rot: mix(0, .6, slide),
            opacity: clamp(slide * 4) * (1 - seg(into, .5, .9)), runs: L.expl.map((line, i) => run(`e${i}`, line, 18, 14 + i * Math.round(L.explSize * 1.2), L.explSize, 700, ink)) }));
        }
        const stamp = springAt(t, loreAt + 320, .4, 20);
        if (t >= loreAt + 320) objects.push(obj({ key: 'lore-stamp', kind: 'stamp', tone: 'ink', x: Math.min(lx + L.termW - L.stampW * .5, g.W - L.stampW - 6), y: ly - 48, w: L.stampW, h: 54, radius: 10, z: 57,
          sx: mix(1.6, 1, stamp) * s, sy: mix(1.6, 1, stamp) * s, rot: -7, opacity: clamp(seg(t, loreAt + 320, loreAt + 380)) * (1 - seg(into, .5, .9)),
          runs: [run('st', script.lore.stamp, 15, 8, 36, 700, paper, { tabular: true })] }));
      }
    }
  }
  // ── Beat 6: the mark and the real chat command, then everything leaves ──
  objects.push(...markState(t, g));
  return objects;
}

function tabWidth(g: Geo, text: string): number { return Math.round(text.length * g.tabSize * .58 + 40); }

/** Map a point given in a box's local (unscaled) coordinates through the box's scale+rotation about its centre. */
function attach(b: Box, scale: number, rotDeg: number, lx: number, ly: number): { x: number; y: number } {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = (b.x + lx - cx) * scale, dy = (b.y + ly - cy) * scale, r = rotDeg * Math.PI / 180;
  return { x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) };
}

function heroState(t: number, g: Geo): SceneObject[] {
  const { script, timeline: T } = g;
  const out: SceneObject[] = [];
  const ink = COLORS.ink, paper = COLORS.paper;
  const C = g.card, F = g.frame, N = g.now;
  const slots = T.slots, exitAt = T.exitAt;
  if (t >= exitAt + 560) return out;
  let slotIndex = -1;
  if (slots.length && T.stackAt !== null && t >= T.stackAt) slotIndex = 0;
  for (let i = 1; i < slots.length; i++) if (t >= slots[i]!.focusAt) slotIndex = i;
  const slot = slotIndex >= 0 ? slots[slotIndex]! : undefined;
  const mergeP = N && slots.length ? glide(seg(t, T.mergeAt, T.mergeAt + 650)) : 0;
  let box: Box, rot = 0, scale = 1, lift = 0, open = 0;
  if (!slot) {
    if (!N || t < T.mergeAt - 120) return out;
    // No chapters: the now card enters from the left edge on its own.
    const inP = springAt(t, T.mergeAt - 120, .7, 12);
    box = { ...N.card, x: mix(-N.card.w - 160, N.card.x, inP) };
    rot = mix(-4, 0, enter(seg(t, T.mergeAt - 120, T.mergeAt + 420)));
  } else {
    if (slotIndex === 0) {
      const arrive = enter(seg(t, T.stackAt!, T.stackAt! + 460));
      const lp = glide(seg(t, slot.focusAt, slot.focusAt + 340));
      const stackPos = { x: mix(-C.w - 160, g.stack.x, arrive), y: g.stack.y + (1 - arrive) * 60 };
      // In the stack the card is drawn at stack scale around its centre; compensate so its top-left sits at stackPos.
      const s0 = g.stack.scale, offX = C.w * (1 - s0) / 2, offY = C.h * (1 - s0) / 2;
      box = { x: mix(stackPos.x - offX, C.x, lp), y: mix(stackPos.y - offY, C.y, lp), w: C.w, h: C.h };
      scale = mix(s0, 1, lp);
      rot = mix(mix(-16, -3.5, arrive), 0, lp);
      lift = Math.sin(lp * Math.PI);
    } else box = { ...C };
    const openP = slot.openAt !== null ? glide(seg(t, slot.openAt, slot.openedAt!)) : 0;
    open = openP;
    if (slotIndex > 0 && openP === 0) {
      const prev = slots[slotIndex - 1]!;
      const fold = glide(seg(t, slot.focusAt, slot.focusAt + 220));
      box = lerpBox(prev.openAt !== null ? F : C, C, fold);
      open = prev.openAt !== null ? 1 - fold : 0;
    } else box = lerpBox(box, F, openP);
    if (slot.openedAt !== null) scale *= 1 + pulse(t, slot.openedAt, 240) * .022;
  }
  scale *= 1 + lift * .035;
  // A slow push-in keeps the readable hold alive.
  if (N) scale *= 1 + .018 * glide(seg(t, T.settleAt - 300, exitAt + 100));
  if (mergeP > 0) box = lerpBox(box, N!.card, mergeP);
  const contract = glide(seg(t, exitAt + 80, exitAt + 520));
  if (contract > 0) box = lerpBox(box, { x: g.mark.x, y: g.mark.y, w: g.mark.size, h: g.mark.size }, contract);
  rot *= 1 - mergeP;
  const breathe = N && t > T.mergeAt + 300 ? Math.sin((t - T.mergeAt - 300) / 1500 * Math.PI) : 0;
  const settled = N ? seg(t, T.mergeAt + 300, T.mergeAt + 900) * (1 - contract) : 0;
  const rotY = breathe * 1.3 * settled, rotX = (Math.cos((t - T.mergeAt) / 1900 * Math.PI) - 1) * .7 * settled;
  const fill = contract > 0 ? mixColor(ink, COLORS.vermilion, seg(contract, .35, .9)) : undefined;
  const radius = mix(mix(22, 26, open), g.mark.size * .26, contract);
  // Media: the slot's clip fills the opening frame; after the merge the last clip keeps playing in a corner window.
  let media: SceneObject['media'] | undefined;
  const lastMedia = [...slots].reverse().find(s => s.mediaId)?.mediaId ?? null;
  const nowMedia = script.now?.mediaId ?? lastMedia;
  const frameMedia = slot?.mediaId && (open > 0) ? slot.mediaId : null;
  const mediaId = mergeP > .55 ? nowMedia : frameMedia ?? (mergeP > 0 ? lastMedia : null);
  if (mediaId) {
    const full = { x: 10, y: 10, w: box.w - 20, h: box.h - 20 };
    const win = N?.window ?? { x: box.w / 2, y: box.h / 2, w: 0, h: 0 };
    const inner = mergeP > 0 ? lerpBox(full, win, mergeP) : full;
    const collapse = exitIn(seg(t, exitAt, exitAt + 220));
    // Chat reacts a few seconds after the event, so the moment clip is timed for its burst to follow the action on screen.
    const momentStart = slot?.chat ? slot.chat.burstAt - REACTION_LEAD_MS : null;
    const mediaStart = mergeP > .55 && script.now?.mediaId ? T.mergeAt : (momentStart ?? slot?.openAt ?? T.mergeAt);
    // The frame opens as a shutter: the picture is revealed from the centre line outward.
    const folding = !!slot && slotIndex > 0 && slot.openAt !== null && t < slot.openAt || !!slot && slot.openAt === null && open > 0;
    const reveal = mergeP > 0 || folding ? 1 : clamp(open * 1.25);
    media = { id: mediaId, x: mix(inner.x + inner.w / 2, inner.x, reveal), y: mix(inner.y + inner.h / 2, inner.y, Math.min(1, reveal * 1.1)), w: inner.w * reveal * (1 - collapse), h: inner.h * Math.min(1, reveal * 1.1) * (1 - collapse),
      radius: mix(14, 12, mergeP), opacity: (1 - collapse) * (folding ? clamp(open * 1.8 - .5) : 1), timeMs: Math.max(0, t - mediaStart), playing: collapse < 1 };
    if (collapse > 0) { media.x = mix(inner.x, inner.x + inner.w / 2, collapse); media.y = mix(inner.y, inner.y + inner.h / 2, collapse); }
  }
  // Chapter title: paper words on the card. When the card opens, a paper label wipes in under the words
  // (they turn ink) and the label rides down to the frame's bottom-left edge as one object.
  const attached: SceneObject[] = [];
  const titleBlock = (index: number, s0: Slot, prefix: string, enterP: number, exitQ: number, dropP: number) => {
    const words = g.chapterWords[index] ?? [], lines = g.chapterLineCounts[index] ?? 1, lh = lineH(g.chapterSize);
    const blockW = Math.max(0, ...words.map(w => w.x + w.w));
    const wipe = s0.openAt !== null ? enter(seg(t, s0.openAt - 20, s0.openAt + 130)) : 0;
    const ride = s0.openAt !== null ? glide(seg(t, s0.openAt + 40, s0.openedAt! + 60)) : 0;
    const exitPlate = Math.max(dropP, N ? exitIn(seg(t, T.mergeAt, T.mergeAt + 220)) : 0);
    const closedPlate = { x: 36 - 22, y: 66 - 13 }, openPlate = { x: 22, y: F.h - lines * lh - 4 };
    const pl = { x: mix(closedPlate.x, openPlate.x, ride), y: mix(closedPlate.y, (s0 === slot ? box.h : F.h) - lines * lh - 4, ride) };
    if (s0 !== slot) { pl.x = openPlate.x; pl.y = box.h - lines * lh - 4; }
    const color = mixColor(paper, ink, seg(wipe, .2, .7));
    if (wipe > 0 && exitPlate < 1) {
      const p0 = attach(box, scale, rot, pl.x, pl.y);
      attached.push(obj({ key: `${prefix}-plate`, kind: 'plate', tone: 'paper', origin: 'tl', x: p0.x, y: p0.y + exitPlate * 160, w: blockW + 44, h: lines * lh + 26, radius: 14, z: 51,
        sx: scale * wipe, sy: scale, rot: rot + exitPlate * 4, opacity: 1 - seg(exitPlate, .6, 1) }));
    }
    const runs: Run[] = words.map((w, i) => kinetic(run(`w${index}:${i}`, w.text, w.x, 8 + w.line * lh, g.chapterSize, 800, color), clamp(enterP * (words.length + 4) / 4 - i * .25), clamp(exitQ * (words.length + 3) / 3 - i * .33)));
    const p1 = attach(box, scale, rot, pl.x + 22, pl.y + 13 - 8);
    if (exitPlate < 1) attached.push(obj({ key: `${prefix}-title`, kind: 'plate', tone: 'clear', origin: 'tl', x: p1.x, y: p1.y + exitPlate * 160, w: C.w - 40, h: lines * lh + 20, radius: 0, z: 52, mask: true,
      sx: scale, sy: scale, rot: rot + exitPlate * 4, opacity: 1 - seg(exitPlate, .6, 1), runs }));
  };
  if (slot && mergeP < 1 && contract <= 0) {
    const words = g.chapterWords[slot.chapter] ?? [];
    const swapIn = slotIndex > 0 ? seg(t, slot.focusAt + 200, slot.focusAt + 200 + 220 + words.length * 55) : 1;
    titleBlock(slot.chapter, slot, 'hero', swapIn, 0, 0);
    const prev = slots[slotIndex - 1];
    if (prev && t < slot.focusAt + 400) {
      // The previous chapter's label drops off the folding frame; a card-only chapter rolls its words up instead.
      if (prev.openAt !== null) titleBlock(prev.chapter, prev, 'prev', 1, 0, exitIn(seg(t, slot.focusAt, slot.focusAt + 260)));
      else titleBlock(prev.chapter, prev, 'prev', 1, seg(t, slot.focusAt, slot.focusAt + 260), 0);
    }
  }
  // Tab on the top edge. On a swap the old tab detaches into the timeline strip and a new one rises from behind the card.
  const tabRuns: Run[] = [];
  let tabW = N?.tabW ?? 120, tabRise = 0;
  const toNow = N ? (slots.length ? seg(t, T.mergeAt + 120, T.mergeAt + 420) : 1) : 0;
  const ty = Math.round((g.tabH - g.tabSize) / 2) - 1;
  if (slot) {
    const tc = script.chapters[slot.chapter]!.timecode;
    if (slotIndex > 0) tabRise = 1 - enter(seg(t, slot.focusAt + 160, slot.focusAt + 420));
    tabW = mix(tabWidth(g, tc), N?.tabW ?? tabWidth(g, tc), enter(toNow));
    tabRuns.push(kinetic(run('tc' + slot.chapter, tc, 20, ty, g.tabSize, 700, ink, { tabular: true }), 1, toNow, 1.6));
  }
  const tabOut = enter(seg(t, exitAt, exitAt + 240));
  if (N) tabRuns.push(kinetic(run('now-label', script.now!.label, 20, ty, g.tabSize, 700, ink), toNow, tabOut, 1.6));
  if (tabRuns.length && tabOut < 1) {
    const p = attach(box, scale, rot, 28, -g.tabH + 6 + tabRise * (g.tabH - 4));
    out.push(obj({ key: 'hero-tab', kind: 'tab', tone: 'paper', origin: 'tl', x: p.x, y: p.y + tabOut * 50, w: tabW, h: g.tabH, radius: 10, z: 49, rot, sx: scale, sy: scale, mask: true, opacity: 1 - tabOut, runs: tabRuns }));
  }
  // Now statement: 2–3 word groups, each landing on its own beat.
  const runs: Run[] = [];
  if (N && (mergeP > 0 || !slots.length)) {
    const textOut = seg(t, exitAt, exitAt + 280);
    N.groups.forEach((group, gi) => {
      const at = T.groupsAt[gi] ?? T.mergeAt;
      group.forEach((wi, k) => {
        const w = N.words[wi]!;
        runs.push(kinetic(run(`now${wi}`, w.text, N.textX + w.x, N.textY + w.line * N.lineH, N.size, 800, paper), seg(t, at - 380 + k * 45, at + k * 45), clamp(textOut * 1.7 - (N.groups.length - 1 - gi) * .15)));
      });
    });
  }
  const sheen = N && t > T.settleAt - 200 && contract <= 0 ? seg(t, T.settleAt - 200, T.settleAt + 1800) : undefined;
  out.push(obj({ key: 'hero', kind: 'card', tone: 'ink', x: box.x, y: box.y, w: box.w, h: box.h, radius, z: 50, rot, sx: scale, sy: scale,
    lift: .45 + lift * .55, rotX, rotY, fill, runs, media, sheen, mask: true, opacity: 1 - seg(t, exitAt + 500, exitAt + 560) }));
  out.push(...attached);
  return out;
}

function markState(t: number, g: Geo): SceneObject[] {
  const T = g.timeline, X = T.exitAt, out: SceneObject[] = [];
  if (t < X + 440 || t >= T.goneAt) return out;
  const s = g.mark.size;
  const glyph = springAt(t, X + 460, .5, 16), back = glide(seg(t, X + 520, X + 760));
  const leave = exitIn(seg(t, T.leaveAt, T.leaveAt + 330));
  const settleBounce = pulse(t, X + 520, 260);
  const x = g.mark.x - leave * (g.mark.x + s + 900);
  out.push(obj({ key: 'mark', kind: 'mark', tone: 'vermilion', x, y: g.mark.y, w: s, h: s, radius: s * .26, z: 70, sx: 1 - settleBounce * .05, sy: 1 + settleBounce * .05, rot: -leave * 6,
    mark: { glyph, back } }));
  if (g.command) {
    const c = g.command, inP = springAt(t, X + 760, .7, 14);
    if (t >= X + 760) out.push(obj({ key: 'command', kind: 'plate', tone: 'paper', x: mix(g.mark.x + s * .3, g.mark.x + s + 22, inP) - leave * (g.mark.x + s + c.w + 900), y: g.mark.y + (s - c.h) / 2, w: c.w, h: c.h, radius: 14, z: 69, mask: true,
      sx: mix(.6, 1, inP), sy: 1, opacity: clamp(inP * 2),
      runs: c.parts.map((p, i) => run(`c${i}`, p.text, p.x, Math.round((c.h - c.size) / 2) - 1, c.size, p.weight, p.weight > 700 ? COLORS.ink : COLORS.mutedPaper)) }));
  }
  return out;
}

function reducedObjects(t: number, plan: RecapPlan, g: Geo): SceneObject[] {
  const { script, W } = g, out: SceneObject[] = [];
  const end = Math.min(plan.durationMs, g.timeline.goneAt);
  const o = Math.min(seg(t, 0, 200), 1 - seg(t, end - 200, end));
  const ink = COLORS.ink, paper = COLORS.paper;
  out.push(obj({ key: 'title-lead', kind: 'plate', tone: 'vermilion', origin: 'tl', x: 0, y: 0, w: g.lead.w, h: g.plateH, sx: g.dock.scale, sy: g.dock.scale, radius: Math.round(g.big * .16), z: 30, opacity: o,
    runs: [run('lead', script.welcomeOnly ? script.greeting : script.titleLead, g.padX, Math.round((g.plateH - g.big) / 2), g.big, 800, ink)] }));
  if (g.rest && !script.welcomeOnly) out.push(obj({ key: 'title-rest', kind: 'plate', tone: 'paper', origin: 'tl', x: g.lead.w * g.dock.scale + 10, y: Math.round((g.plateH * g.dock.scale - g.rest.h * g.dock.restScale) / 2), w: g.rest.w, h: g.rest.h, sx: g.dock.restScale, sy: g.dock.restScale, radius: 14, z: 29, opacity: o,
    runs: [run('r', g.rest.text, Math.round(g.rest.size * PAD), Math.round((g.rest.h - g.rest.size) / 2), g.rest.size, 800, ink)] }));
  const last = g.timeline.shownChapters.at(-1);
  const N = g.now;
  let nowX = 0;
  if (last !== undefined && N) {
    const words = g.chapterWords[last] ?? [], lh = lineH(g.chapterSize);
    const box = { x: 0, y: N.card.y, w: g.card.w, h: Math.min(g.card.h, N.card.h) };
    out.push(obj({ key: 'chapter', kind: 'card', tone: 'ink', x: box.x, y: box.y, w: box.w, h: box.h, radius: 22, z: 20, opacity: o, runs: words.map((w, i) => run(`w${i}`, w.text, 36 + w.x, 58 + w.line * lh, g.chapterSize, 800, paper)) }));
    out.push(obj({ key: 'chapter-tab', kind: 'tab', tone: 'paper', x: 28, y: box.y - g.tabH + 6, w: tabWidth(g, script.chapters[last]!.timecode), h: g.tabH, radius: 10, z: 19, opacity: o, runs: [run('tc', script.chapters[last]!.timecode, 20, 6, g.tabSize, 700, ink, { tabular: true })] }));
    nowX = g.card.w + 30;
  }
  if (N) {
    const width = Math.min(W - nowX, N.card.w);
    const fits = N.words.every(w => w.x + w.w <= width - 96);
    const x = fits ? nowX : 0;
    out.push(obj({ key: 'now', kind: 'card', tone: 'ink', x, y: N.card.y, w: fits ? width : N.card.w, h: N.card.h, radius: 26, z: 25, opacity: o,
      runs: N.words.map((w, i) => run(`n${i}`, w.text, N.textX + w.x, N.textY + w.line * N.lineH, N.size, 800, paper)) }));
    out.push(obj({ key: 'now-tab', kind: 'tab', tone: 'paper', x: x + 28, y: N.card.y - g.tabH + 6, w: N.tabW, h: g.tabH, radius: 10, z: 24, opacity: o, runs: [run('l', script.now!.label, 20, 6, g.tabSize, 700, ink)] }));
  }
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
      objects = compute(timeMs, plan, layout, g);
      // Motion blur proportional to screen velocity, measured against the previous 60 fps frame.
      const before = new Map(compute(timeMs - 1000 / 60, plan, layout, g).map(o => [o.key, o]));
      for (const o of objects) {
        const p = before.get(o.key);
        if (!p) continue;
        const vx = (o.x + o.w * o.sx / 2) - (p.x + p.w * p.sx / 2), vy = (o.y + o.h * o.sy / 2) - (p.y + p.h * p.sy / 2);
        const bx = Math.min(24, Math.abs(vx) * .32), by = Math.min(24, Math.abs(vy) * .32);
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
  const fallback: SceneLayout = layout ?? { bounds: { x: 64, y: 558, width: 1792, height: 458 }, mode: 'full', captionSize: 96, openingSize: 152, protected: [] };
  const g = geometry(plan, fallback, options), T = g.timeline;
  const cues: [string, number, number, number?][] = [];
  cues.push(['swoosh', 0, .5], ['thump', T.aAt + 170, .8]);
  if (T.bAt !== null) cues.push(['thump', T.bAt + 190, .65]);
  if (T.viewersAt !== null) cues.push(['tap', T.viewersAt + 120, .35]);
  if (T.morphAt !== null) cues.push(['rewind', T.morphAt + 40, .55], ['slide', T.morphAt + 340, .3]);
  else cues.push(['swoosh', T.raidersOutAt, .3]);
  if (T.stackAt !== null) T.slots.forEach((_, i) => cues.push(['flick', T.stackAt! + i * 90 + 230, .45]));
  T.slots.forEach((slot, i) => {
    if (i > 0) cues.push(['slide', slot.focusAt + 40, .4]);
    if (slot.openedAt !== null) cues.push(['latch', slot.openedAt - 10, .6]);
    if (slot.chat) cues.push(['chatter', slot.chat.burstAt, .5, slot.chat.collapseAt - slot.chat.burstAt + 150], ['tap', slot.chat.loreAt + 20, .55], ['tap2', slot.chat.loreAt + 330, .5]);
  });
  if (g.now) cues.push(['felt', T.mergeAt, .55, 1100], ['resolve', T.settleAt, .5]);
  cues.push(['release', T.exitAt + 120, .45], ['tap', T.exitAt + 470, .4], ['release', T.leaveAt, .5]);
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
