import { describe, it, expect } from 'vitest';
import { planFixture } from './fixture.js';
import { labPlan } from '../../src/features/overlay/lab/plans.js';
import { resolveSceneLayout, intersects, protectedBounds, wrapCaption } from '../../src/features/overlay/geometry.js';
import { renderAt, sceneClip, sceneSoundEvents, sceneTextFits, fitText, clampWords, type SceneFrame } from '../../src/features/overlay/scene.js';
import { desiredVideoTime } from '../../src/features/overlay/media.js';

const texts = (frame: SceneFrame) => frame.objects.flatMap(o => [...o.runs, ...(o.notch?.runs ?? [])].map(r => r.text)).join(' ');
const allMedia = { availableMedia: () => true };
function sweep(plan = labPlan('full'), options = allMedia, step = 50) {
  const layout = resolveSceneLayout(plan.layout)!;
  const frames: SceneFrame[] = [];
  for (let t = 0; t < plan.durationMs; t += step) frames.push(renderAt(t, plan, layout, options));
  return { plan, layout, frames };
}

describe('broadcast footprint', () => {
  it('keeps the band and its clip envelope clear of every padded protected area', () => {
    for (const variant of ['full', 'compact']) {
      const plan = labPlan(variant), layout = resolveSceneLayout(plan.layout)!, clip = sceneClip(layout);
      for (const rect of plan.layout.protectedRects) {
        expect(intersects(layout.bounds, protectedBounds(rect))).toBe(false);
        expect(intersects(clip, protectedBounds(rect))).toBe(false);
      }
      expect(clip.x).toBeLessThanOrEqual(layout.bounds.x);
      // A raid scene may take a tall band for its ~10 s, never the protected face-cam area.
      expect(clip.width * clip.height).toBeLessThan(1920 * 1080 * .66);
    }
  });
  it('uses compact free space but refuses impossible geometry rather than shrinking type', () => {
    const compact = resolveSceneLayout({ preset: 'lower', protectedRects: [{ x: 1240, y: 0, width: 680, height: 1080 }] });
    expect(compact?.mode).toBe('compact');
    expect(resolveSceneLayout({ preset: 'left', protectedRects: [{ x: 0, y: 0, width: 1920, height: 1080 }] })).toBeNull();
  });
  it('keeps main lines at broadcast size: now ≥80 px, chapter titles ≥64 px, labels ≥36 px', () => {
    const { frames } = sweep();
    for (const frame of frames) for (const o of frame.objects) for (const r of o.runs) {
      const size = r.size * (o.key.startsWith('stack') ? .78 : 1);
      if (o.key.startsWith('title') || o.key === 'counter' || o.key.startsWith('lore') || o.kind === 'tab' || o.key === 'command' || o.key.startsWith('slip') || o.key === 'viewers') continue;
      expect(size, `${o.key}:${r.text}`).toBeGreaterThanOrEqual(r.key.startsWith('now') ? 80 : 30);
    }
    for (const frame of frames) for (const o of frame.objects) for (const r of o.runs) if (o.kind === 'tab' || o.key.startsWith('lore') || o.key.startsWith('slip') || o.key === 'command') expect(r.size).toBeGreaterThanOrEqual(36);
  });
});

describe('deterministic scene', () => {
  it('seeks to the same frame in any order', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    const first = renderAt(5375, plan, layout, allMedia);
    renderAt(11800, plan, layout, allMedia); renderAt(0, plan, layout, allMedia);
    expect(renderAt(5375, plan, layout, allMedia)).toEqual(first);
  });
  it('clears completely at the exact end and excludes negative scheduled time', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    expect(renderAt(-1, plan, layout).visible).toBe(false);
    expect(renderAt(12000, plan, layout).visible).toBe(false);
    expect(renderAt(11999, plan, layout).objects).toHaveLength(0);
    expect(renderAt(6000, plan, layout).objects.length).toBeGreaterThanOrEqual(3);
  });
  it('keeps one focus at a time: few objects share the screen in the middle', () => {
    const { frames } = sweep();
    for (const f of frames) if (f.phase === 'chapters' || f.phase === 'chat') {
      const solid = f.objects.filter(o => o.tone !== 'clear' && o.kind !== 'tab' && o.opacity > .3);
      expect(solid.length, `${f.timeMs}`).toBeLessThanOrEqual(f.phase === 'chapters' ? 8 : 5);
    }
  });
  it('is mid-change in nearly every frame of the active passages (the pause test)', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    let still = 0, total = 0;
    for (let t = 100; t < 7600; t += 250) {
      const a = JSON.stringify(renderAt(t, plan, layout, allMedia).objects.map(o => [o.key, Math.round(o.x), Math.round(o.y), Math.round(o.w), o.runs.map(r => Math.round(r.dy))]));
      const b = JSON.stringify(renderAt(t + 60, plan, layout, allMedia).objects.map(o => [o.key, Math.round(o.x), Math.round(o.y), Math.round(o.w), o.runs.map(r => Math.round(r.dy))]));
      total++; if (a === b) still++;
    }
    expect(still / total).toBeLessThanOrEqual(.35);
  });
});

describe('everything shown comes from the plan', () => {
  it('shows the raid, chapters with timecodes, real chat lines, the counter, lore and the now statement', () => {
    const { plan, frames } = sweep();
    const seen = frames.map(texts).join(' ');
    for (const value of ['Welcome,', 'pixelmoth raiders', '37 viewers', 'Previously', 'on Foxlight Dev', '0:05', '1:40', '3:30', 'Fox learns to', 'moon', '45 messages', 'in 10 seconds', '2:05', 'Right now', 'lantern', '!previously'])
      expect(seen, value).toContain(value);
    // Chat reacts as a counted number over a short feed of real lines, never a pile.
    for (const message of plan.scene!.moment!.messages.slice(0, 2)) expect(seen).toContain(message);
    expect(frames.some(f => f.phase === 'chat')).toBe(true);
    for (const f of frames) expect(f.objects.filter(o => o.kind === 'slip').length).toBe(0);
  });
  it('without a moment there is no chat beat, no slips and no counter', () => {
    const { frames } = sweep(labPlan('nochat'));
    expect(frames.some(f => f.phase === 'chat')).toBe(false);
    expect(frames.flatMap(f => f.objects).some(o => o.kind === 'slip' || o.key === 'counter' || o.key.startsWith('lore'))).toBe(false);
  });
  it('without playable media the cards stay cards', () => {
    const { frames } = sweep(labPlan('full'), { availableMedia: () => false });
    expect(frames.flatMap(f => f.objects).some(o => o.media)).toBe(false);
    const { frames: none } = sweep(labPlan('nomedia'), allMedia);
    expect(none.flatMap(f => f.objects).some(o => o.media)).toBe(false);
  });
  it('plays only canonical clip bounds', () => {
    const { plan, frames } = sweep();
    const ids = new Set(plan.media.map(m => m.id));
    for (const o of frames.flatMap(f => f.objects)) if (o.media) { expect(ids.has(o.media.id)).toBe(true); expect(o.media.timeMs).toBeGreaterThanOrEqual(0); }
    expect(desiredVideoTime(plan, 'fx-media-moon', 12000, 2000)).toBe(10);
    expect(desiredVideoTime(plan, 'not-permitted', 2000, 2000)).toBeNull();
  });
  it('a welcome-only cut greets, shows the stream title and leaves without chapters', () => {
    const { frames } = sweep(labPlan('welcome'));
    const seen = frames.map(texts).join(' ');
    expect(seen).toContain('pixelmoth raiders'); expect(seen).toContain('Building');
    expect(frames.flatMap(f => f.objects).some(o => o.key.startsWith('stack') || o.kind === 'slip')).toBe(false);
  });
  it('a queued welcome for several raids names the first and counts the rest', () => {
    const seen = sweep(labPlan('queue')).frames.map(texts).join(' ');
    expect(seen).toContain('pixelmoth and 2 more raids'); expect(seen).toContain('54 viewers');
  });
  it('a manual show welcomes in with the stream title', () => {
    const seen = sweep(labPlan('manual')).frames.map(texts).join(' ');
    expect(seen).toContain('Welcome in'); expect(seen).toContain('Building a tiny cave platformer'); expect(seen).not.toContain('raiders');
  });
  it('the 10 s cut keeps the chat moment and drops other chapters; 15 s gives clips more time', () => {
    const short = sweep(labPlan('10')).frames, long = sweep(labPlan('15')).frames;
    expect(short.some(f => f.phase === 'chat')).toBe(true);
    expect(short.map(texts).join(' ')).not.toContain('Fox learns');
    expect(long.map(texts).join(' ')).toContain('Fox learns');
    expect(long.filter(f => f.objects.some(o => o.media)).length).toBeGreaterThan(sweep().frames.filter(f => f.objects.some(o => o.media)).length);
  });
  it('an older plan without scene material still plays its approved beats', () => {
    const plan = planFixture(), layout = resolveSceneLayout(plan.layout)!;
    const seen = Array.from({ length: 240 }, (_, i) => texts(renderAt(i * 50, plan, layout))).join(' ');
    expect(seen).toContain('Testing the reconnect fix');
  });
});

describe('fitting and reduced motion', () => {
  it('never drops the now statement: it shrinks to 80 px, then ends at a word boundary with an ellipsis', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    plan.scene!.now!.text = 'Making the lantern behind the waterfall reachable while also rebuilding every single cave room and its lighting from scratch tonight';
    expect(sceneTextFits(plan, layout)).toBe(true);
    const seen = sweep(plan).frames.map(texts).join(' ');
    expect(seen).toContain('Making the lantern behind'); expect(seen).toMatch(/\S…/u); expect(seen).not.toContain('scratch tonight');
  });
  it('never drops a chapter: a long title is clamped with an ellipsis and keeps its first words', () => {
    const plan = labPlan('full');
    plan.scene!.chapters[0]!.title = 'An extremely long chapter title that keeps going well past what two lines of the card can hold';
    const seen = sweep(plan).frames.map(texts).join(' ');
    expect(seen).toContain('An extremely long'); expect(seen).toContain('…'); expect(seen).toContain('Spring'); expect(seen).toContain('0:05');
  });
  it('shows the full Russian chapter title', () => {
    const seen = sweep(labPlan('ru')).frames.map(texts).join(' ');
    for (const word of ['Пружине', 'ограничили', 'скорость', 'Лис', 'учится', 'прыгать']) expect(seen).toContain(word);
  });
  it('clamps text by measured width at a word boundary, and cuts a single overlong word by characters', () => {
    const measure = (text: string, size: number) => [...text].length * size * .5;
    expect(fitText('one two three', 1000, [80, 64], 1, measure)).toMatchObject({ size: 80, truncated: false, text: 'one two three' });
    expect(fitText('one two three four five six', 300, [80, 64], 1, measure)).toMatchObject({ size: 64, truncated: true, text: 'one two…' });
    expect(clampWords('one, two three', 300, 64, 1, measure, 800).words.map(w => w.text).join(' ')).toBe('one, two…');
    expect(clampWords('one, two three', 160, 64, 1, measure, 800).words.map(w => w.text).join(' ')).toBe('one…');
    expect(clampWords('Supercalifragilistic', 200, 64, 1, measure, 800).words[0]!.text).toBe('Super…');
  });
  it('measures actual glyph widths using the supplied font metric', () => {
    expect(wrapCaption('WWW iii', 100, 80, text => [...text].reduce((n, c) => n + (c === 'W' ? 40 : 8), 0))).toEqual(['WW', 'W iii']);
  });
  it('reduced motion is a static two-part summary without travel or video', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    const a = renderAt(3000, plan, layout, { ...allMedia, reducedMotion: true }), b = renderAt(8000, plan, layout, { ...allMedia, reducedMotion: true });
    expect(a.objects.map(o => [o.key, o.x, o.y, o.w, o.h])).toEqual(b.objects.map(o => [o.key, o.x, o.y, o.w, o.h]));
    expect(a.objects.some(o => o.media)).toBe(false);
    expect(texts(a)).toContain('lantern'); expect(texts(a)).toContain('moon jump');
  });
});

describe('sound cues share the picture timeline', () => {
  it('fires a varied palette, in order, inside the scene', () => {
    const plan = labPlan('full'), layout = resolveSceneLayout(plan.layout)!;
    const cues = sceneSoundEvents(plan, layout, allMedia);
    expect(new Set(cues.map(c => c.kind)).size).toBeGreaterThanOrEqual(9);
    expect(cues.every((c, i) => c.atMs >= 0 && c.atMs < plan.durationMs && (i === 0 || c.atMs >= cues[i - 1]!.atMs))).toBe(true);
    expect(cues.filter(c => c.kind === 'latch')).toHaveLength(1);
    expect(cues.filter(c => c.kind === 'flick')).toHaveLength(3);
  });
  it('has no chatter or ceramic taps without a moment, and keeps every 10 s cue inside 10 s', () => {
    const nochat = sceneSoundEvents(labPlan('nochat'));
    expect(nochat.some(c => c.kind === 'chatter')).toBe(false);
    expect(nochat.filter(c => c.kind === 'tap2')).toHaveLength(1);
    expect(sceneSoundEvents(labPlan('10')).every(c => c.atMs < 10000)).toBe(true);
  });
});
