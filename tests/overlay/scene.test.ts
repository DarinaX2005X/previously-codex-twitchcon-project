import { describe,it,expect } from 'vitest';
import { planFixture } from './fixture.js';
import { resolveSceneLayout,intersects,protectedBounds,wrapCaption } from '../../src/features/overlay/geometry.js';
import { renderAt,sceneTextFits,sceneSoundEvents,authoredTime } from '../../src/features/overlay/scene.js';
import { desiredVideoTime } from '../../src/features/overlay/media.js';

describe('broadcast footprint and deterministic scene',()=>{
  it('reserves padded editor and all bounded travelling pixels at every frame',()=>{
    const plan=planFixture(),layout=resolveSceneLayout(plan.layout)!;
    expect(layout.mode).toBe('full');expect(layout.bounds.y).toBeGreaterThanOrEqual(542);
    for(let time=0;time<=12000;time+=16){const frame=renderAt(time,plan,layout);expect(Number.isFinite(frame.aperture.x)).toBe(true);for(const rect of plan.layout.protectedRects)expect(intersects(layout.bounds,protectedBounds(rect))).toBe(false);}
    expect(layout.bounds.x).toBeGreaterThanOrEqual(64);expect(layout.bounds.x+layout.bounds.width).toBeLessThanOrEqual(1856);expect(layout.bounds.y+layout.bounds.height).toBeLessThanOrEqual(1016);
  });
  it('uses compact free space but refuses impossible geometry rather than shrinking type',()=>{
    const compact=resolveSceneLayout({preset:'lower',protectedRects:[{x:1240,y:0,width:680,height:1080}]});expect(compact?.mode).toBe('compact');expect(compact?.captionSize).toBe(80);
    expect(resolveSceneLayout({preset:'left',protectedRects:[{x:0,y:0,width:1920,height:1080}]})).toBeNull();
  });
  it('seeks to the same independently moving planes in any order',()=>{
    const plan=planFixture(),layout=resolveSceneLayout(plan.layout)!;const first=renderAt(6375,plan,layout);
    renderAt(11800,plan,layout);renderAt(0,plan,layout);expect(renderAt(6375,plan,layout)).toEqual(first);
    expect(first.aperture.scale).not.toBe(1);expect(first.source.y).not.toBe(renderAt(2600,plan,layout).source.y);
  });
  it('retains a semantic join with outgoing attempt and incoming change',()=>{
    const plan=planFixture(),layout=resolveSceneLayout(plan.layout)!;const join=renderAt(3500,plan,layout);
    expect(join.retainedCaption?.kind).toBe('attempt');expect(join.retainedPlane?.scale).toBeLessThan(1);expect(join.caption?.kind).toBe('change');expect(join.caption?.reveal).toBeGreaterThan(0);expect(join.aperture.x).toBeGreaterThan(join.retainedPlane!.x+100);
  });
  it('clears completely at exact end and excludes negative scheduled time',()=>{
    const plan=planFixture(),layout=resolveSceneLayout(plan.layout)!;expect(renderAt(-1,plan,layout).visible).toBe(false);expect(renderAt(12000,plan,layout).visible).toBe(false);expect(renderAt(11999,plan,layout).visible).toBe(true);
  });
  it('does not silently chop, paginate or shrink long Russian wording',()=>{
    const plan=planFixture(),layout=resolveSceneLayout(plan.layout)!;plan.language='ru';plan.beats[0].text='Проверяем восстановление предпросмотра после повторного подключения к трансляции. '.repeat(3);
    expect(sceneTextFits(plan,layout)).toBe(false);const frame=renderAt(2500,plan,layout);expect(frame.caption?.text).toBe(plan.beats[0].text);expect(frame.caption?.pages).toBe(1);expect(frame.caption!.lines.length).toBeGreaterThan(2);
  });
  it('measures actual glyph widths using the supplied font metric',()=>{
    expect(wrapCaption('WWW iii',100,80,text=>[...text].reduce((n,c)=>n+(c==='W'?40:8),0))).toEqual(['WW','W iii']);
  });
  it('static reduced motion has no travel, parallax or media autoplay',()=>{
    const plan=planFixture(),layout=resolveSceneLayout(plan.layout)!;const a=renderAt(2200,plan,layout,{reducedMotion:true}),b=renderAt(8200,plan,layout,{reducedMotion:true});expect(a.aperture).toEqual(b.aperture);expect(a.source.opacity).toBe(0);expect(a.mediaVisible).toBe(false);expect(a.caption?.text).toBe(plan.beats[2].text);
  });
  it('compact cut removes origin dwell and all cues stay within the shared duration',()=>{
    const plan=planFixture();plan.durationMs=10000;expect(authoredTime(5000,plan)).toBe(7000);const cues=sceneSoundEvents(plan);expect(cues.every(c=>c.atMs>=0&&c.atMs<10000)).toBe(true);expect(cues.length).toBeLessThan(sceneSoundEvents({...plan,durationMs:12000}).length);
  });
  it('uses only canonical clip bounds and source metadata',()=>{
    const plan=planFixture();plan.media=[{id:'clip:1',kind:'video',inMs:2700,outMs:4300,captureStartMs:10000,captureEndMs:15000,previousSession:false}];expect(desiredVideoTime(plan,'clip:1',2200,2000)).toBe(2.9);expect(desiredVideoTime(plan,'clip:1',12000,2000)).toBe(4.3);expect(desiredVideoTime(plan,'not-permitted',2000,2000)).toBeNull();
  });
  it('keeps one approved context useful without inventing goal, change or lore phases',()=>{
    const plan=planFixture();plan.beats=[{...plan.beats[0],kind:'context',text:'The studio is taking listener requests'}];const layout=resolveSceneLayout(plan.layout)!;
    for(const t of [2500,4500,5500,8500]){const frame=renderAt(t,plan,layout);expect(frame.phase).toBe('context');expect(frame.caption?.kind).toBe('context');expect(frame.caption?.text).toBe(plan.beats[0].text);expect(frame.retainedPlane).toBeNull();expect(frame.edgeOffsets).toHaveLength(1);}
    expect(sceneSoundEvents(plan).some(event=>event.atMs===5150||event.atMs===5340)).toBe(false);
  });
  it('uses only the two supported states and has no compulsory origin stage',()=>{
    const plan=planFixture();plan.beats=[{...plan.beats[0],kind:'context'},plan.beats[2]];const layout=resolveSceneLayout(plan.layout)!;
    expect(renderAt(4500,plan,layout).caption?.kind).toBe('context');expect(renderAt(8500,plan,layout).caption?.kind).toBe('now');
    for(let t=1800;t<9750;t+=100)expect(['attempt','change','origin']).not.toContain(renderAt(t,plan,layout).phase);
  });
});
