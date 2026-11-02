/**
 * The "Previously on" montage: a short TV-style intro, the stream's chapters cut together in story order
 * (each from its own clip, or a title card when there is no clip), the present, then the outro mark.
 * One pure planner shared by the plan builder (to set the plan's length) and the broadcast scene.
 */
export const MONTAGE_INTRO_MS = 3600;
export const MONTAGE_OUTRO_MS = 2400;
export const MONTAGE_CARD_MS = 3400;
export const MONTAGE_CLIP_MIN_MS = 4500;
export const MONTAGE_CLIP_MAX_MS = 14000;
export const MONTAGE_MAX_MS = 120_000;

export type MontageInput = {
  durationMs: number;
  /** Earlier chapters in story order; `clipMs` is the usable length of its clip window, or null without a clip. */
  chapters: { clipMs: number | null; keep?: boolean }[];
  /** The present: its clip window length, null for a card, or undefined when there is no current statement. */
  now?: { clipMs: number | null };
};
export type MontageSegment = { kind: 'clip' | 'card'; chapter: number | 'now'; at: number; ms: number };
export type MontagePlan = { introMs: number; segments: MontageSegment[]; outroAt: number; totalMs: number };

const natural = (clipMs: number | null) => clipMs === null ? MONTAGE_CARD_MS : Math.max(MONTAGE_CLIP_MIN_MS, Math.min(MONTAGE_CLIP_MAX_MS, clipMs));

export function planMontage(input: MontageInput): MontagePlan {
  const budget = Math.max(0, Math.min(MONTAGE_MAX_MS, input.durationMs) - MONTAGE_INTRO_MS - MONTAGE_OUTRO_MS);
  let items: { chapter: number | 'now'; clipMs: number | null; keep: boolean }[] = input.chapters.map((c, i) => ({ chapter: i, clipMs: c.clipMs, keep: !!c.keep }));
  if (input.now) items.push({ chapter: 'now', clipMs: input.now.clipMs, keep: true });
  const lengths = (list: typeof items, scale: number) => list.map(item => item.clipMs === null ? MONTAGE_CARD_MS : Math.max(MONTAGE_CLIP_MIN_MS, Math.round(natural(item.clipMs) * scale)));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  // Shorten clips toward their minimum first; then leave out the oldest chapters that are not essential.
  let ms = lengths(items, 1);
  while (items.length && sum(ms) > budget) {
    const clipTotal = sum(items.map((item, i) => item.clipMs === null ? 0 : ms[i]!));
    const fixed = sum(ms) - clipTotal;
    const scale = clipTotal ? (budget - fixed) / clipTotal : 0;
    const scaled = lengths(items, Math.min(1, scale));
    if (sum(scaled) <= budget) { ms = scaled; break; }
    const drop = items.findIndex(item => !item.keep);
    if (drop < 0) { const last = items.findIndex(item => item.chapter !== 'now'); items = last >= 0 ? items.filter((_, i) => i !== last) : items.slice(0, -1); }
    else items = items.filter((_, i) => i !== drop);
    ms = lengths(items, 1);
  }
  let at = MONTAGE_INTRO_MS;
  const segments = items.map((item, i) => { const seg: MontageSegment = { kind: item.clipMs === null ? 'card' : 'clip', chapter: item.chapter, at, ms: ms[i]! }; at += ms[i]!; return seg; });
  return { introMs: MONTAGE_INTRO_MS, segments, outroAt: at, totalMs: at + MONTAGE_OUTRO_MS };
}
