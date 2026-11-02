import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RecapPlan } from '../../../shared/contracts/index.js';
import { ScenePlayer } from '../ScenePlayer.js';
import { resolveSceneLayout } from '../geometry.js';
import { sceneSoundEvents } from '../scene.js';
import { renderSceneSfxWav } from '../sound.js';
import type { PreparedMedia } from '../media.js';
import { LAB_MEDIA, labPlan } from './plans.js';

/**
 * Development-only scene lab: renders the broadcast scene at 1920×1080 over a stand-in background,
 * with scrubbing and a frame-exact capture hook (`?capture=1&t=<ms>` or `window.__seek(ms)`).
 */
const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
const variant = params.get('plan') ?? 'full';
const skipParam = params.get('skip');
const bgMode = params.get('bg') ?? 'video';
const guides = params.get('guides') === '1';
const reduced = params.get('reduced') === '1';
const bgOffsetMs = Number(params.get('bgAt') ?? 4000);

declare global { interface Window { __seek?: (ms: number) => Promise<number>; __ready?: Promise<void>; __plan?: RecapPlan; __events?: unknown; __renderSfx?: () => Promise<string>; __duration?: number } }

async function loadPlan(): Promise<{ plan: RecapPlan; media: Record<string, string> }> {
  if (variant.startsWith('foxlight')) {
    const module = await import('../../../../fixtures/foxlight.js');
    const raid = module.foxlightRaid();
    const plan = raid.plan;
    if (variant === 'foxlight-10') plan.durationMs = 10000;
    if (variant === 'foxlight-15') plan.durationMs = 15000;
    return { plan, media: Object.fromEntries(raid.media.map(m => [m.id, m.file])) };
  }
  return { plan: labPlan(variant), media: LAB_MEDIA };
}

let markReady: () => void = () => {};
window.__ready = new Promise(resolve => { markReady = resolve; });

function waitFrames(n = 2) { return new Promise<void>(resolve => { const step = (k: number) => k <= 0 ? resolve() : requestAnimationFrame(() => step(k - 1)); step(n); }); }
async function settleVideos() {
  const videos = [...document.querySelectorAll('video')];
  await Promise.all(videos.map(v => new Promise<void>(resolve => {
    const done = () => { if (!v.seeking && v.readyState >= 2) resolve(); else setTimeout(done, 8); };
    const timer = setTimeout(resolve, 3000);
    const finish = () => { clearTimeout(timer); resolve(); };
    if (!v.seeking && v.readyState >= 2) finish(); else { v.addEventListener('seeked', () => done(), { once: true }); v.addEventListener('loadeddata', () => done(), { once: true }); setTimeout(() => { if (!v.seeking && v.readyState >= 2) finish(); }, 30); }
  })));
}

function Background({ t }: { t: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current; if (!v) return;
    const want = (bgOffsetMs + t) / 1000;
    if (capture || !playingGlobal) { v.pause(); if (Number.isFinite(v.duration) && Math.abs(v.currentTime - want) > .001) v.currentTime = Math.min(want, v.duration - .05); }
    else { if (Math.abs(v.currentTime - want) > .25) v.currentTime = want; if (v.paused) void v.play().catch(() => {}); }
  }, [t]);
  if (bgMode === 'none') return null;
  if (bgMode === 'poster') return <img src="/demo/foxlight/stream-full-poster.jpg" style={{ position: 'absolute', inset: 0, width: 1920, height: 1080, objectFit: 'cover' }} alt=""/>;
  if (bgMode === 'stand') return <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 35% 60%, #5b6b4a 0, #22303a 45%, #0e1418 100%)' }}/>;
  if (bgMode === 'white') return <div style={{ position: 'absolute', inset: 0, background: '#e8e8e8' }}/>;
  return <video ref={ref} src="/demo/foxlight/stream-full.mp4" muted playsInline preload="auto" style={{ position: 'absolute', inset: 0, width: 1920, height: 1080, objectFit: 'cover' }}/>;
}
let playingGlobal = false;

function Lab() {
  const [data, setData] = useState<{ plan: RecapPlan; media: Record<string, string> } | null>(null);
  const [t, setT] = useState(Number(params.get('t') ?? 0));
  const [playing, setPlaying] = useState(false);
  const [scale, setScale] = useState(1);
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => { void loadPlan().then(setData); }, []);
  useEffect(() => { if (capture) return; const fit = () => setScale(Math.min(1, (innerWidth - 32) / 1920)); fit(); addEventListener('resize', fit); return () => removeEventListener('resize', fit); }, []);
  const resolveMedia = useCallback((id: string) => data?.media[id], [data]);
  const layout = useMemo(() => data ? resolveSceneLayout(data.plan.layout) : null, [data]);
  const onMediaReady = useCallback((_media: PreparedMedia) => { void document.fonts.ready.then(() => waitFrames(3)).then(() => markReady()); }, []);
  useEffect(() => {
    if (!data) return;
    window.__plan = data.plan; window.__duration = data.plan.durationMs;
    window.__events = sceneSoundEvents(data.plan, layout);
    window.__seek = async (ms: number) => { setT(ms); await waitFrames(2); await settleVideos(); await waitFrames(1); return ms; };
    window.__renderSfx = async () => {
      const events = sceneSoundEvents(data.plan, layout);
      const bytes = await renderSceneSfxWav(events, data.plan.durationMs);
      let binary = ''; const view = new Uint8Array(bytes);
      for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
      return btoa(binary);
    };
  }, [data, layout]);
  useEffect(() => { pending.current?.(); }, [t]);
  useEffect(() => {
    playingGlobal = playing;
    if (!playing || !data) return;
    const start = performance.now() - t; let frame = 0;
    const tick = (now: number) => { const next = now - start; if (next >= data.plan.durationMs) { setT(data.plan.durationMs); setPlaying(false); return; } setT(next); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, data]);
  if (!data) return <p style={{ padding: 24 }}>Loading plan…</p>;
  const stage = <div style={{ position: 'relative', width: 1920, height: 1080, overflow: 'hidden', background: '#000' }}>
    <Background t={t}/>
    <div style={{ position: 'absolute', inset: 0 }}>
      <ScenePlayer plan={data.plan} timeMs={t} skipAtMs={skipParam ? Number(skipParam) : undefined} clipAudio={!capture} playing={playing} frameExact={capture || !playing} resolveMedia={resolveMedia} reducedMotion={reduced} soundEnabled={playing && params.get('sound') === '1'} onMediaReady={onMediaReady}/>
    </div>
    {guides && layout && <>
      <div style={{ position: 'absolute', left: layout.bounds.x, top: layout.bounds.y, width: layout.bounds.width, height: layout.bounds.height, outline: '2px dashed #C8F560', pointerEvents: 'none' }}/>
      {data.plan.layout.protectedRects.map((r, i) => <div key={i} style={{ position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height, outline: '2px solid #ff3b3b', background: 'rgb(255 59 59 / .12)', pointerEvents: 'none' }}/>)}
    </>}
  </div>;
  if (capture) return stage;
  return <div style={{ padding: 16 }}>
    <div style={{ width: 1920 * scale, height: 1080 * scale, overflow: 'hidden' }}><div style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>{stage}</div></div>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, font: '600 16px Onest, sans-serif' }}>
      <button type="button" onClick={() => { if (t >= data.plan.durationMs) setT(0); setPlaying(p => !p); }}>{playing ? 'Pause' : 'Play'}</button>
      <input type="range" min={0} max={data.plan.durationMs} step={1000 / 60} value={t} onChange={e => { setPlaying(false); setT(Number(e.target.value)); }} style={{ flex: 1 }}/>
      <span style={{ fontVariantNumeric: 'tabular-nums', width: 80 }}>{(t / 1000).toFixed(2)} s</span>
      <select value={variant} onChange={e => { params.set('plan', e.target.value); location.search = params.toString(); }}>
        {['full', '30', '120', '10', 'welcome', 'queue', 'nochat', 'nomedia', 'manual', 'nowonly', 'compact', 'ru', 'foxlight', 'foxlight-10'].map(v => <option key={v}>{v}</option>)}
      </select>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(capture ? <Lab/> : <StrictMode><Lab/></StrictMode>);
