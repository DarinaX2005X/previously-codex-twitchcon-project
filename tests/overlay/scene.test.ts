import { describe, it, expect } from 'vitest';
import { planFixture } from './fixture.js';
import { labPlan } from '../../src/features/overlay/lab/plans.js';
import { resolveSceneLayout, intersects, protectedBounds, wrapCaption } from '../../src/features/overlay/geometry.js';
import { renderAt, sceneClip, sceneSoundEvents, fitText, clampWords, type SceneFrame } from '../../src/features/overlay/scene.js';
import { desiredVideoTime } from '../../src/features/overlay/media.js';
import { MONTAGE_INTRO_MS } from '../../src/shared/montage.js';

const texts = (frame: SceneFrame) => frame.objects.flatMap(o => [...o.runs, ...(o.notch?.runs ?? [])].map(r => r.text)).join(' ');
const allMedia = { availableMedia: () => true };
function sweep(plan = labPlan('full'), options: Parameters<typeof renderAt>[3] = allMedia, step = 100) {
  const layout = resolveSceneLayout(plan.layout)!;
  const frames: SceneFrame[] = [];
  for (let t = 0; t < plan.durationMs; t += step) frames.push(renderAt(t, plan, layout, options));
  return { plan, layout, frames };
}
const screen = (f: SceneFrame) => f.objects.find(o => o.key === 'screen');

describe('broadcast footprint', () => {
  it('keeps the welcome band clear of every padded protected area', () => {
    for (const variant of ['full', 'compact']) {
      const plan = labPlan(variant), layout = resolveSceneLayout(plan.layout)!, clip = sceneClip(layout);
      for (const rect of plan.layout.protectedRects) { expect(intersects(layout.bounds, protectedBounds(rect))).toBe(false); expect(intersects(clip, protectedBounds(rect))).toBe(false); }
    }
  });
  it('uses the free band while welcoming, the full frame for the cut, and the band again for the mark', () => {
    const { frames } = sweep();
    expect(frames.find(f => f.timeMs === 500)!.clip.width).toBeLessThan(1920);
    expect(frames.find(f => f.timeMs === 10000)!.clip).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    const s = screen(frames.find(f => f.timeMs === 10000)!)!;
    expect([s.w, s.h]).toEqual([1920, 1080]);
    expect(frames.at(-1)!.clip.width).toBeLessThan(1920);
  });
  it('refuses impossible geometry rather than shrinking type', () => {
    expect(resolveSceneLayout({ preset: 'left', protectedRects: [{ x: 0, y: 0, width: 1920, height: 1080 }] })).toBeNull();
  });
});

describe('deterministic scene', () => {
  it('seeks to the same frame in any order', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    const first = renderAt(15375, plan, layout, allMedia);
    renderAt(40000, plan, layout, allMedia); renderAt(0, plan, layout, allMedia);
    expect(renderAt(15375, plan, layout, allMedia)).toEqual(first);
  });
  it('clears completely at the end and excludes negative scheduled time', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    expect(renderAt(-1, plan, layout).visible).toBe(false);
    expect(renderAt(plan.durationMs, plan, layout).visible).toBe(false);
    expect(renderAt(plan.durationMs - 1, plan, layout).objects).toHaveLength(0);
  });
});

describe('a TV-style cut of the stream', () => {
  it('welcomes the raiders, then plays each chapter in story order with its own clip and caption', () => {
    const { plan, frames } = sweep();
    const seen = frames.map(texts).join(' ');
    for (const value of ['Welcome,', 'pixelmoth raiders', '37 viewers', 'Previously', 'on Foxlight Dev', '0:05', '1:40', '3:30', 'Fox learns to jump', 'The moon jump', 'Spring gets a speed limit', 'Right now', 'lantern', '45 messages', '2:05', '!previously'])
      expect(seen, value).toContain(value);
    const order = frames.map(f => screen(f)?.media?.id).filter((id, i, all) => id && id !== all[i - 1]);
    expect(order).toEqual(['fx-media-run', 'fx-media-moon', 'fx-media-fixed', 'fx-media-lanterns']);
    const ids = new Set(plan.media.map(m => m.id));
    for (const f of frames) { const m = screen(f)?.media; if (m) { expect(ids.has(m.id)).toBe(true); expect(m.timeMs).toBeGreaterThanOrEqual(0); } }
  });
  it('shows a caption on each cut, then clears it so the picture can be seen; the brand bug stays', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    const early = renderAt(MONTAGE_INTRO_MS + 2000, plan, layout, allMedia), late = renderAt(MONTAGE_INTRO_MS + 8500, plan, layout, allMedia);
    expect(early.objects.some(o => o.key === 'caption')).toBe(true);
    expect(late.objects.some(o => o.key === 'caption')).toBe(false);
    expect(late.objects.some(o => o.key === 'title-lead')).toBe(true);
  });
  it('keeps caption type readable on a phone: titles at least 52 px, summaries and tags at least 32 px', () => {
    const { frames } = sweep();
    for (const f of frames) for (const o of f.objects) for (const r of o.runs) {
      if (o.key === 'caption' && /t\d+$/.test(r.key)) expect(r.size).toBeGreaterThanOrEqual(52);
      if (o.key === 'caption' || o.key.endsWith('-tag') || o.key === 'command') expect(r.size).toBeGreaterThanOrEqual(32);
    }
  });
  it('a chapter without a clip becomes a title card instead of disappearing', () => {
    const { frames } = sweep(labPlan('full'), { availableMedia: id => id !== 'fx-media-fixed' });
    expect(frames.some(f => f.objects.some(o => o.key === 'card-text') && texts(f).includes('Spring'))).toBe(true);
    const { frames: none } = sweep(labPlan('nomedia'));
    expect(none.flatMap(f => f.objects).some(o => o.media)).toBe(false);
    expect(none.map(texts).join(' ')).toContain('The moon jump');
  });
  it('a skip goes straight to the mark and ends a moment later', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    const skipped = renderAt(9000, plan, layout, { ...allMedia, skipAtMs: 8000 });
    expect(skipped.phase).toBe('return');
    expect(skipped.endMs).toBeLessThan(11000);
    expect(renderAt(skipped.endMs, plan, layout, { ...allMedia, skipAtMs: 8000 }).objects).toHaveLength(0);
    expect(texts(renderAt(9400, plan, layout, { ...allMedia, skipAtMs: 8000 }))).toContain('!previously');
  });
  it('a welcome-only cut greets, names the stream and leaves without a montage', () => {
    const { frames } = sweep(labPlan('welcome'));
    const seen = frames.map(texts).join(' ');
    expect(seen).toContain('pixelmoth raiders');
    expect(frames.flatMap(f => f.objects).some(o => o.key === 'screen')).toBe(false);
  });
  it('a queued welcome for several raids names the first and counts the rest', () => {
    const seen = sweep(labPlan('queue')).frames.map(texts).join(' ');
    expect(seen).toContain('pixelmoth and 2 more raids'); expect(seen).toContain('54 viewers');
  });
  it('the 30 s cut keeps the chat moment and the present', () => {
    const { frames } = sweep(labPlan('30'));
    const order = frames.map(f => screen(f)?.media?.id).filter((id, i, all) => id && id !== all[i - 1]);
    expect(order).toContain('fx-media-moon'); expect(order).toContain('fx-media-lanterns');
  });
  it('plays only canonical clip bounds', () => {
    const plan = labPlan('full');
    expect(desiredVideoTime(plan, 'fx-media-moon', 12000, 2000)).toBe(10);
    expect(desiredVideoTime(plan, 'not-permitted', 2000, 2000)).toBeNull();
  });
  it('an older plan without scene material still welcomes and leaves', () => {
    const plan = planFixture(), layout = resolveSceneLayout(plan.layout)!;
    const seen = Array.from({ length: 120 }, (_, i) => texts(renderAt(i * 100, plan, layout))).join(' ');
    expect(seen).toContain('Previously');
  });
});

describe('text fitting and reduced motion', () => {
  it('clamps text by measured width at a word boundary, and cuts a single overlong word by characters', () => {
    const measure = (text: string, size: number) => [...text].length * size * .5;
    expect(fitText('one two three', 1000, [80, 64], 1, measure)).toMatchObject({ size: 80, truncated: false, text: 'one two three' });
    expect(fitText('one two three four five six', 300, [80, 64], 1, measure)).toMatchObject({ size: 64, truncated: true, text: 'one two…' });
    expect(clampWords('one, two three', 160, 64, 1, measure, 800).words.map(w => w.text).join(' ')).toBe('one…');
    expect(clampWords('Supercalifragilistic', 200, 64, 1, measure, 800).words[0]!.text).toBe('Super…');
  });
  it('never drops a long chapter title or the present: they are clamped with an ellipsis', () => {
    const plan = labPlan('full');
    plan.scene!.chapters[0]!.title = 'An extremely long chapter title that keeps going well past what two lines of the lower third can hold for anyone';
    const seen = sweep(plan).frames.map(texts).join(' ');
    expect(seen).toContain('An extremely long'); expect(seen).toContain('…');
  });
  it('shows the full Russian chapter titles', () => {
    const seen = sweep(labPlan('ru')).frames.map(texts).join(' ');
    for (const word of ['Пружине', 'ограничили', 'скорость', 'Лис', 'учится', 'прыгать']) expect(seen).toContain(word);
  });
  it('measures actual glyph widths using the supplied font metric', () => {
    expect(wrapCaption('WWW iii', 100, 80, text => [...text].reduce((n, c) => n + (c === 'W' ? 40 : 8), 0))).toEqual(['WW', 'W iii']);
  });
  it('reduced motion keeps the cut but moves nothing: words never travel or blur', () => {
    const { frames } = sweep(labPlan('full'), { ...allMedia, reducedMotion: true }, 250);
    for (const f of frames) for (const o of f.objects) { expect(o.blurX ?? 0).toBe(0); for (const r of o.runs) { expect(r.dy).toBe(0); expect(r.blur).toBe(0); } }
    expect(frames.some(f => screen(f)?.media)).toBe(true);
  });
});

describe('sound cues share the picture timeline', () => {
  it('fires a varied palette, in order, inside the scene', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    const cues = sceneSoundEvents(plan, layout, allMedia);
    expect(new Set(cues.map(c => c.kind)).size).toBeGreaterThanOrEqual(9);
    expect(cues.every((c, i) => c.atMs >= 0 && c.atMs < plan.durationMs && (i === 0 || c.atMs >= cues[i - 1]!.atMs))).toBe(true);
    expect(cues.filter(c => c.kind === 'flick')).toHaveLength(3);
  });
  it('has no chatter without a moment', () => {
    expect(sceneSoundEvents(labPlan('nochat')).some(c => c.kind === 'chatter')).toBe(false);
  });
});
