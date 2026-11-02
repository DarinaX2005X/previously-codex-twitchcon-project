import { describe, expect, it } from 'vitest';
import { planMontage, MONTAGE_INTRO_MS, MONTAGE_OUTRO_MS, MONTAGE_CARD_MS, MONTAGE_CLIP_MIN_MS } from '../../src/shared/montage.js';

describe('previously montage planner', () => {
  it('cuts every chapter in story order, then the present, inside the plan length', () => {
    const plan = planMontage({ durationMs: 60000, chapters: [{ clipMs: 9000 }, { clipMs: 10500, keep: true }, { clipMs: null }], now: { clipMs: 11000 } });
    expect(plan.segments.map(s => [s.kind, s.chapter])).toEqual([['clip', 0], ['clip', 1], ['card', 2], ['clip', 'now']]);
    expect(plan.segments[0]!.at).toBe(MONTAGE_INTRO_MS);
    expect(plan.segments[2]!.ms).toBe(MONTAGE_CARD_MS);
    expect(plan.totalMs).toBe(MONTAGE_INTRO_MS + 9000 + 10500 + MONTAGE_CARD_MS + 11000 + MONTAGE_OUTRO_MS);
    for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i]!.at).toBe(plan.segments[i - 1]!.at + plan.segments[i - 1]!.ms);
  });
  it('never runs longer than two minutes or the chosen length, shortening clips before leaving chapters out', () => {
    const many = Array.from({ length: 12 }, () => ({ clipMs: 14000 }));
    const full = planMontage({ durationMs: 500000, chapters: many, now: { clipMs: 14000 } });
    expect(full.totalMs).toBeLessThanOrEqual(120000);
    const short = planMontage({ durationMs: 30000, chapters: [{ clipMs: 12000 }, { clipMs: 12000, keep: true }, { clipMs: 12000 }], now: { clipMs: 12000 } });
    expect(short.totalMs).toBeLessThanOrEqual(30000);
    expect(short.segments.some(s => s.chapter === 1)).toBe(true);
    expect(short.segments.some(s => s.chapter === 'now')).toBe(true);
    expect(short.segments.every(s => s.kind === 'card' || s.ms >= MONTAGE_CLIP_MIN_MS)).toBe(true);
  });
  it('has nothing to cut without chapters or a present', () => {
    expect(planMontage({ durationMs: 60000, chapters: [] }).segments).toEqual([]);
  });
});
