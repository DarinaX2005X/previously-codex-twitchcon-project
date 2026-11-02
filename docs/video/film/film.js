// Previously submission film. Every visible property is a pure function of film time t (seconds).
// window.renderAt(t) -> Promise (waits for video and scene seeks), window.EVENTS for the sound layer.
import { clamp, seg, lerp, expoOut, expoIn, expoInOut, cubicInOut, backOut, springAt, el, svgEl, dirBlur, fmtTime, mixColor, bezier2 } from './lib.js';
import { FACTS } from './content.js';
import { makeMark, placeMark } from './mark.js';
import { createFilm2, END } from './film2.js';

const FPS = 60;
const stage = document.getElementById('stage');
const params = new URLSearchParams(location.search);
const CAPTURE = params.get('capture') === '1';
const SCENE_URL = '/src/features/overlay/lab/index.html?capture=1&plan=foxlight&bg=video&bgAt=4000';
const SCENE_START = 6.0;          // film time when the raid scene's clock is 0
const STREAM_LAND = 4.0;          // stream-full.mp4 time the rewind lands on (= lab bgAt)
const CATCH = 17.3;               // film time we catch the scene's P mark
// The raid scene runs 44 s (take 8). The film shows an excerpt, cut on the scene's own hard cuts:
// welcome and the "Previously" lockup, three chapter clips with their captions, "Right now", then the P mark.
export const SCENE_SEGS = [[6.0, 0.0, 3.6], [9.6, 4.3, 2.0], [11.6, 14.2, 2.6], [14.2, 24.3, 1.9], [16.1, 34.2, 1.2], [17.3, 42.75, 1.3]];
const sceneAt = t => { let ms = 0; for (const [f0, s0, d] of SCENE_SEGS) if (t >= f0) ms = (s0 + Math.min(d, t - f0)) * 1000; return ms; };

export const EVENTS = [];
// The hook was authored on an old clock; HOOK maps film time to it so the first line reads slower (owner review 4).
const HOOK = [[0, 0], [2.1, 1.55], [2.75, 2.0], [3.4, 2.72], [4.5, 3.98], [5.75, 5.75], [6, 6]];
const pw = (pts, x, a, b) => { if (x <= pts[0][a]) return x - pts[0][a] + pts[0][b]; for (let i = 0; i < pts.length - 1; i++) if (x <= pts[i + 1][a]) { const p = (x - pts[i][a]) / (pts[i + 1][a] - pts[i][a]); return pts[i][b] + p * (pts[i + 1][b] - pts[i][b]); } return x; };
const hookOld = t => t < 6 ? pw(HOOK, t, 0, 1) : t;
const hookNew = t => t < 6 ? pw(HOOK, t, 1, 0) : t;
const ev = (id, t, kind, o = {}) => EVENTS.push({ id, t: +hookNew(t).toFixed(4), kind, x: o.x ?? 0.5, gain: o.gain ?? 1, dur: o.dur ? +(hookNew(t + o.dur) - hookNew(t)).toFixed(4) : 0, note: o.note ?? null, pan2: o.pan2 ?? null });
const waits = [];

// ---------- shared assets ----------
// ---------- background light field ----------
const bg = el('div', 'layer', stage);
bg.style.background = 'var(--ink)';
const glowA = el('div', 'layer', bg), glowB = el('div', 'layer', bg);
function renderBg(t) {
  const ax = 18 + 6 * Math.sin(t * 0.35), ay = 92 + 4 * Math.cos(t * 0.3);
  glowA.style.background = `radial-gradient(1100px 700px at ${ax}% ${ay}%, rgb(255 90 54 / .17), transparent 70%)`;
  const bx = 84 - 5 * Math.sin(t * 0.27), by = 8 + 5 * Math.sin(t * 0.21);
  glowB.style.background = `radial-gradient(1000px 640px at ${bx}% ${by}%, rgb(70 122 128 / .16), transparent 72%)`;
}

// =====================================================================================
// PASSAGE 1: hook (0-6), raid scene (6-18), brand (17.3-24)
// =====================================================================================
const world = el('div', 'abs', stage);   // camera layer for the first kinetic line

// --- line 1: "A raid drops you into someone else's stream"
const L1 = { size: 200, top: 430, left: 170 };
const line1 = [
  { text: 'A', t: 0.0, style: 'paper' },
  { text: 'raid', t: 0.22, style: 'outline' },
  { text: 'drops', t: 0.5, style: 'drop' },
  { text: 'you', t: 0.72, style: 'accent' },
  { text: 'into', t: 0.95, style: 'paper' },
  { text: 'someone', t: 1.12, style: 'muted' },
  { text: "else's", t: 1.32, style: 'muted' },
  { text: 'stream', t: 1.55, style: 'plate' },
];
const streamPlate = el('div', 'plate', world);
streamPlate.style.background = 'var(--paper)';
streamPlate.style.boxShadow = '0 8px 0 var(--paper-side), 0 30px 60px -20px rgb(5 6 8 / .85)';
streamPlate.style.overflow = 'hidden';
const streamInk = el('div', 'word', streamPlate, 'stream'); streamInk.style.color = 'var(--ink)';
for (const w of line1) {
  w.el = el('div', 'word', world, w.text);
  w.el.style.fontSize = L1.size + 'px';
  w.el.style.color = w.style === 'muted' ? '#7E8794' : w.style === 'accent' ? 'var(--verm)' : 'var(--paper)';
}

// --- the stream player (our own neutral player)
const player = el('div', '', stage); player.id = 'player';
const PR = { x: 300, y: 150, w: 1380, bar: 64 }; PR.vh = PR.w * 9 / 16; PR.h = PR.bar + PR.vh;
const pframe = el('div', '', player); pframe.id = 'pframe';
const pview = el('div', '', pframe); pview.id = 'pview';
const vStream = el('video', '', pview); Object.assign(vStream, { src: '/demo/foxlight/stream-full.mp4', muted: true, preload: 'auto', playsInline: true });
vStream.style.width = '1920px'; vStream.style.height = '1080px';
const streaks = el('div', '', pview); streaks.id = 'streaks';
const streakLines = Array.from({ length: 5 }, () => el('div', '', streaks));
const sceneFrame = el('iframe', '', pview); sceneFrame.width = 1920; sceneFrame.height = 1080; sceneFrame.style.width = '1920px'; sceneFrame.style.height = '1080px';
const pcover = el('div', '', pframe); pcover.id = 'pcover';
const ptitle = el('div', '', pframe); ptitle.id = 'ptitle';
el('i', 'live', ptitle);
const ptName = el('b', '', ptitle, 'Foxlight Dev');
el('span', 't', ptitle, 'Building a tiny cave platformer');
const ptime = el('div', '', pframe); ptime.id = 'ptime';
const ptimeText = el('span', 'tab', ptime, '7:10');
const flyWord = el('div', 'word', stage, 'stream'); // "stream" travelling into the title bar
flyWord.style.color = 'var(--ink)';

// --- line 2: "What did I miss?"
const L2 = { size: 172, top: 300, left: 120 };
const line2 = [
  { text: 'What', t: 2.72, style: 'outline' },
  { text: 'did', t: 3.0, style: 'paper' },
  { text: 'I', t: 3.16, style: 'paper' },
  { text: 'miss?', t: 3.38, style: 'plate' },
];
const missPlate = el('div', 'plate', stage);
missPlate.style.background = 'var(--verm)';
missPlate.style.boxShadow = '0 8px 0 var(--verm-side), 0 34px 70px -24px rgb(5 6 8 / .9)';
for (const w of line2) { w.el = el('div', 'word', stage, w.text); w.el.style.fontSize = L2.size + 'px'; w.el.style.color = 'var(--paper)'; }
line2[3].el.style.color = 'var(--ink)';
const missClip = el('div', 'abs', stage); missClip.style.overflow = 'hidden'; // keeps "miss?" inside its plate as it squashes
missClip.appendChild(line2[3].el);
const missGlyph = svgEl('svg', missClip, { viewBox: '18 16 74 74', preserveAspectRatio: 'xMidYMid meet', style: 'position:absolute;inset:0;width:100%;height:100%;overflow:visible' });
svgEl('path', missGlyph, { 'fill-rule': 'evenodd', d: 'M36 33A4 4 0 0 1 40 29H60A17 17 0 0 1 60 63H51V75A4 4 0 0 1 47 79H40A4 4 0 0 1 36 75Z M51.5 46L66 38.5L66 53.5Z', fill: '#14171B' });

// --- rewind tile + ripples
const ripples = [0, 1].map(() => el('div', 'ripple', stage));
const tile = makeMark(stage);

// --- rewind cards (real chapters and their clip posters)
const cardData = [
  { tc: '5:20', title: 'Lanterns light the cave', img: '/demo/foxlight/clip-lanterns.jpg', t0: 4.62, y: 520, s: 0.92, rot: -3 },
  { tc: '3:30', title: 'Spring gets a speed limit', img: '/demo/foxlight/clip-fixed.jpg', t0: 4.88, y: 330, s: 0.78, rot: 2.5 },
  { tc: '1:40', title: 'The moon jump', img: '/demo/foxlight/clip-moon.jpg', t0: 5.12, y: 600, s: 1.12, rot: -1.5 },
  { tc: '0:05', title: 'Fox learns to jump', img: '/demo/foxlight/clip-run.jpg', t0: 5.36, y: 410, s: 0.96, rot: 1.5 },
];
for (const c of cardData) {
  c.el = el('div', 'card', stage);
  const img = el('img', '', c.el); img.src = c.img;
  el('div', 'ttl', c.el, c.title);
  el('div', 'ctab', c.el, c.tc);
}

// --- caption over the scene (upper right, inside the protected region the scene keeps clear)
const caption = el('div', '', stage); caption.id = 'caption';
const capLines = [
  { html: `This is what <em>${FACTS.raid.viewers} raiders</em> see`, t0: 7.55, t1: 10.25 },
  { html: 'built from the stream so far', t0: 10.25, t1: 13.4 },
  { html: 'then it hands the stream back', t0: 13.4, t1: 16.15 },
].map(l => ({ ...l, el: Object.assign(el('div', 'line', caption), { innerHTML: l.html }) }));

// --- brand: scrim, mark clone with trail, wordmark letters, tagline
const scrim = el('div', '', stage); scrim.id = 'scrim';
const trail = [0, 1, 2, 3].map(() => makeMark(stage));
const hero = makeMark(stage);
const wordmarkBox = svgEl('svg', stage, { class: 'letter', viewBox: '0 0 300 96', width: 300, height: 96 });
const letters = [];
const BR = { k: 3.3, x0: 0, y0: 318 }; BR.x0 = Math.round((1920 - 440 * BR.k) / 2);
const tagHolder = [];
const tag = [
  { text: 'Catch up', t: 20.85, line: 0 }, { text: 'with the stream', t: 21.15, line: 0 },
  { text: 'while it', t: 21.55, line: 1 }, { text: 'keeps going', t: 21.8, line: 1, key: true },
].map(w => ({ ...w, el: el('div', 'tagw', stage, w.text) }));
const TAG = { size: 128, tops: [452, 626] };
const brandBg = el('video', '', stage); Object.assign(brandBg, { src: '/demo/foxlight/stream-full.mp4', muted: true, preload: 'auto' });
Object.assign(brandBg.style, { position: 'absolute', left: '-60px', top: '-34px', width: '2040px', height: '1148px', objectFit: 'cover', filter: 'blur(26px) saturate(.8)', opacity: 0 });
const keepPlate = el('div', 'plate', stage); keepPlate.style.background = 'var(--verm)'; keepPlate.style.boxShadow = '0 8px 0 var(--verm-side), 0 40px 80px -30px rgb(5 6 8 / .9)';
const markGroup = el('div', 'layer', stage);
const stroke = svgEl('svg', stage, { id: 'stroke', width: 1920, height: 1080, viewBox: '0 0 1920 1080' });
const brandCam = el('div', 'layer', stage); brandCam.style.transformOrigin = '50% 50%';
for (const e of [...trail.map(m => m.box), stroke]) brandCam.appendChild(e);
markGroup.appendChild(hero.box); markGroup.appendChild(wordmarkBox); brandCam.appendChild(markGroup);
stage.insertBefore(brandBg, brandCam); brandCam.insertBefore(keepPlate, markGroup);
const strokePath = svgEl('path', stroke, { fill: 'none', stroke: '#FF5A36', 'stroke-width': 12, 'stroke-linecap': 'round' });

// ---------- layout that needs fonts ----------
async function layout() {
  await document.fonts.load('800 200px Onest'); await document.fonts.load('700 70px Onest'); await document.fonts.ready;
  let x = L1.left;
  for (const w of line1) { w.w = w.el.offsetWidth; w.h = w.el.offsetHeight; w.x = x; x += w.w + L1.size * 0.24; }
  let x2 = L2.left;
  for (const w of line2) { w.w = w.el.offsetWidth; w.h = w.el.offsetHeight; w.x = x2; x2 += w.w + L2.size * 0.22; }
  // tagline centred under the wordmark
  const gap = TAG.size * 0.24;
  for (const w of tag) { w.el.style.fontSize = TAG.size + 'px'; w.el.style.fontWeight = 800; w.el.style.letterSpacing = '-.035em'; w.w = w.el.offsetWidth; w.h = w.el.offsetHeight; }
  for (const ln of [0, 1]) { const ws = tag.filter(w => w.line === ln); let tw = ws.reduce((a, w) => a + w.w, 0) + gap * (ws.length - 1); let tx = (1920 - tw) / 2; for (const w of ws) { w.x = tx; tx += w.w + gap; } }
  tag[3].el.style.color = 'var(--ink)';
  // wordmark letters from the outlined master (no retyping)
  const svgText = await (await fetch('/brand/wordmark-text.svg')).text();
  const d = /<path d="([^"]+)"/.exec(svgText)[1];
  const subs = d.split(/(?=M)/).filter(s => s.trim());
  const probe = svgEl('svg', document.body, { width: 300, height: 96, style: 'position:absolute;left:-9999px' });
  const boxes = subs.map(sd => { const p = svgEl('path', probe, { d: sd }); const b = p.getBBox(); return { sd, b }; });
  probe.remove();
  boxes.sort((a, b) => a.b.x - b.b.x);
  const groups = [];
  for (const it of boxes) {
    const g = groups.find(g => it.b.x >= g.x0 - 0.5 && it.b.x + it.b.width <= g.x1 + 0.5) || groups.find(g => Math.min(g.x1, it.b.x + it.b.width) - Math.max(g.x0, it.b.x) > 0.5 * Math.min(it.b.width, g.x1 - g.x0));
    if (g) { g.d += it.sd; g.x0 = Math.min(g.x0, it.b.x); g.x1 = Math.max(g.x1, it.b.x + it.b.width); }
    else groups.push({ d: it.sd, x0: it.b.x, x1: it.b.x + it.b.width });
  }
  for (const g of groups) { const p = svgEl('path', wordmarkBox, { d: g.d, fill: '#F4EFE6' }); letters.push({ p, cx: (g.x0 + g.x1) / 2 }); }
  Object.assign(wordmarkBox.style, { width: 300 * BR.k + 'px', height: 96 * BR.k + 'px', left: '0px', top: '0px' });
}

// ---------- events (sound placement) ----------
function buildEvents() {
  const scr = w => clamp((w.x + w.w / 2 - camX1(w.t + 0.3)) / 1920);
  line1.forEach((w, i) => ev(`l1-${i}`, w.t, i === 7 ? 'thumpBig' : 'thump', { x: scr(w), note: [0, 3, 5, 7, 5, 3, 2, 0][i] }));
  ev('l1-raid-fill', line1[1].t + 0.3, 'tick', { x: 0.25 });
  ev('l1-plate', 1.62, 'plate', { x: 0.75 });
  ev('morph-player', 2.0, 'morph', { dur: 0.6, x: 0.7, pan2: 0.5 });
  ev('whip-out', 2.04, 'whoosh', { dur: 0.42, x: 0.6, pan2: 0.0, gain: 0.8 });
  ev('title-swap', 2.46, 'tick', { x: 0.2, gain: 0.7 });
  line2.forEach((w, i) => ev(`l2-${i}`, w.t, 'thump', { x: (w.x + w.w / 2) / 1920, note: [7, 5, 3, 10][i] }));
  ev('l2-what-fill', line2[0].t + 0.28, 'tick', { x: 0.15 });
  ev('l2-plate', 3.44, 'pop', { x: 0.7 });
  ev('tile-morph', 3.98, 'morph', { dur: 0.42, x: 0.6, pan2: 0.5, gain: 0.8 });
  ev('tile-glyph', 4.24, 'pop', { x: 0.5, gain: 0.7 });
  ev('tile-press', 4.5, 'click', { x: 0.5, gain: 1.2 });
  ev('tape-stop', 4.5, 'tapestop', { x: 0.5 });
  ev('rewind', 4.52, 'rewind', { dur: 1.23, x: 0.5 });
  cardData.forEach((c, i) => ev(`card-${i}`, c.t0, 'whoosh', { dur: 0.46, x: 0.0, pan2: 1.0, gain: 0.85 + 0.1 * (i % 2) }));
  ev('rewind-land', 5.75, 'tapeland', { x: 0.5 });
  ev('drop', SCENE_START, 'drop', { x: 0.5 });
  ev('zoom', SCENE_START + 0.05, 'air', { dur: 1.1, x: 0.5 });
  ev('cap-in', 7.55, 'plate', { x: 0.85, gain: 0.55 });
  ev('cap-roll-1', 10.25, 'tick', { x: 0.85, gain: 0.6 });
  ev('cap-roll-2', 13.4, 'tick', { x: 0.85, gain: 0.6 });
  ev('cap-out', 16.15, 'whoosh', { dur: 0.3, x: 0.8, pan2: 1.0, gain: 0.5 });
  ev('catch', CATCH, 'pop', { x: 0.08, gain: 0.8 });
  ev('fly', CATCH + 0.05, 'whoosh', { dur: 2.2, x: 0.1, pan2: 0.25, gain: 1.0 });
  ev('riser-brand', 18.0, 'riser', { dur: 2.0 });
  ev('logo-hit', 20.0, 'impact', { x: 0.3, gain: 1.0 });
  ev('letters', 20.02, 'letters', { dur: 0.55, x: 0.45 });
  ev('mark-rise', 20.55, 'air', { dur: 0.5, x: 0.5, gain: 0.6 });
  tag.forEach((w, i) => ev(`tag-${i}`, w.t, i === 3 ? 'thumpBig' : 'thump', { x: (w.x + w.w / 2) / 1920, gain: 0.8 }));
  ev('keep-plate', 21.86, 'pop', { x: 0.6, gain: 0.7 });
  ev('fill-through', 22.95, 'riser', { dur: 0.95, gain: 0.8 });
  ev('fill-land', 23.9, 'plate', { x: 0.5, gain: 0.8 });
}

// ---------- camera for line 1 ----------
function camTarget(i) { const w = line1[i]; if (i === line1.length - 1) return w.x + w.w / 2 - 1040; return Math.max(0, w.x + w.w - 1700); }
function camX1(t) {
  // overlapping smooth steps: the camera rides the line continuously instead of stopping on each word
  let c = 0;
  for (let i = 0; i < line1.length; i++) {
    const prev = i ? camTarget(i - 1) : 0;
    c += (camTarget(i) - prev) * cubicInOut(seg(t, line1[i].t - 0.3, line1[i].t + 0.32));
  }
  // whip out to the left as the plate becomes the player
  c += 2600 * expoIn(seg(t, 2.02, 2.45));
  return c;
}

function wordIn(w, t, dur = 0.34) {
  const p = seg(t, w.t - 0.06, w.t + dur);
  const e = expoOut(p);
  return { p, e, op: clamp(seg(t, w.t - 0.08, w.t + 0.12)), blur: 9 * (1 - e) * (1 - e), sc: 1.06 - 0.06 * e, dx: 36 * (1 - e) };
}

// stream time shown in the player before the scene takes over
function streamTime(t) {
  const S0 = 31.0; // footage playing "live"
  if (t < 4.5) return S0 + (t - 1.8);
  const end = S0 + (4.5 - 1.8);
  if (t < 5.75) { const p = seg(t, 4.5, 5.75); return lerp(end, STREAM_LAND + 0.25, cubicInOut(p)); }
  return STREAM_LAND + 0.25 * (1 - expoOut(seg(t, 5.75, 6.0)));
}
function shownClock(t) { // seconds of stream time displayed in the title bar
  if (t < 4.5) return 430 + Math.floor(t - 2.6);
  if (t < 5.75) return Math.round(lerp(431, 5, cubicInOut(seg(t, 4.5, 5.75))));
  return 5;
}

let lastScene = -1, lastStream = -1, sceneMarkRect = null, sceneHideMark = false;
async function seekScene(ms) {
  const w = sceneFrame.contentWindow;
  if (!w || !w.__seek) return;
  if (Math.abs(ms - lastScene) < 0.01) return;
  lastScene = ms;
  await w.__seek(ms);
}
function hideSceneMark(on) {
  const doc = sceneFrame.contentDocument; if (!doc || sceneHideMark === on) return;
  let st = doc.getElementById('film-hide');
  if (!st) { st = doc.createElement('style'); st.id = 'film-hide'; doc.head.appendChild(st); }
  st.textContent = on ? '.pv-o:has(.pv-mark-front){visibility:hidden!important}' : '';
  sceneHideMark = on;
}
function readSceneMark() {
  const doc = sceneFrame.contentDocument; const f = doc && doc.querySelector('.pv-mark-front');
  if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
}
function seekVideo(v, time) {
  if (Math.abs(v.currentTime - time) < 0.0005 && v.readyState >= 2) return null;
  return new Promise(res => { const done = () => { clearTimeout(to); res(); }; const to = setTimeout(res, 4000); v.addEventListener('seeked', done, { once: true }); v.currentTime = Math.max(0, Math.min(time, (v.duration || 999) - 0.05)); });
}

// ---------- render ----------
async function renderPassage1(t) {
  renderBg(t);
  const pending = [];

  // ===== line 1 =====
  const cam = camX1(t);
  const camVel = (camX1(t) - camX1(t - 1 / FPS)) * FPS;
  world.style.transform = `translate(${-cam}px,0)`;
  const l1on = t < 2.6;
  world.style.display = l1on ? '' : 'none';
  if (l1on) {
    for (const [i, w] of line1.entries()) {
      const a = wordIn(w, t);
      const s = w.el.style;
      s.opacity = a.op;
      let dy = 0;
      if (w.style === 'drop') dy = -150 * (1 - springAt(t - w.t + 0.06, 0.45, 15)); // "drops" falls into the line
      s.transform = `translate(${w.x + a.dx * (w.style === 'drop' ? 0 : 1)}px,${L1.top + dy}px) scale(${a.sc})`;
      const mb = Math.min(10, Math.abs(camVel) / 400);
      s.filter = (a.blur + mb) > 0.4 ? `blur(${a.blur.toFixed(2)}px)` + (mb > 0.4 ? ` url(#${dirBlur(w.el, mb, 0)})` : '') : 'none';
      if (w.style === 'outline') {
        const f = seg(t, w.t + 0.22, w.t + 0.42);
        s.webkitTextStroke = `4px var(--paper)`;
        s.color = `rgb(244 239 230 / ${f})`;
        s.background = 'none';
      }
      if (w.style === 'plate') w.el.style.visibility = t < 1.6 ? 'visible' : 'hidden';
    }
    // the plate behind "stream"
    const w = line1[7];
    const g = springAt(t - 1.6, 0.62, 16);
    const pw = (w.w + 64) * clamp(g, 0, 1.2), ph = (w.h + 26);
    const showPlate = t >= 1.6 && t < 2.0;
    streamPlate.style.display = showPlate ? '' : 'none';
    if (showPlate) {
      // the plate wipes in from the left behind the word; the ink copy inside it inverts the word
      const px = w.x - 32;
      Object.assign(streamPlate.style, { width: pw + 'px', height: ph + 'px', borderRadius: '22px', transform: `translate(${px}px,${L1.top - 4}px)` });
      const a = wordIn(w, t);
      streamInk.style.fontSize = L1.size + 'px';
      streamInk.style.transform = `translate(${32 + a.dx}px,4px) scale(${a.sc})`;
      streamInk.style.filter = w.el.style.filter;
      // the paper word stays visible where the plate has not reached yet
      w.el.style.visibility = 'visible';
      w.el.style.clipPath = `inset(0 0 0 ${Math.max(0, pw - 32)}px)`;
    } else line1[7].el.style.clipPath = 'none';
  }

  // ===== the player =====
  const pOn = t >= 2.0 && t < 18.6;
  player.style.display = pOn ? '' : 'none';
  if (pOn) {
    // plate rect (screen) at the moment of the morph
    const w = line1[7];
    const camAt = camX1(1.999);
    const from = { x: w.x - 32 - camAt, y: L1.top - 4, w: w.w + 64, h: w.h + 26, r: 22 };
    const to = { x: PR.x, y: PR.y, w: PR.w, h: PR.h, r: 30 };
    const pm = seg(t, 2.0, 2.62);
    const e = springAt(t - 2.0, 0.78, 11);
    const R = { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e), w: lerp(from.w, to.w, e), h: lerp(from.h, to.h, e), r: lerp(from.r, to.r, clamp(e)) };
    // camera on the player: slow push, then zoom-through into the scene
    let S = 1, TX = 0, TY = 0;
    if (t >= 2.6 && t < SCENE_START) { S = 1 + 0.022 * cubicInOut(seg(t, 2.6, 5.9)); const cx = PR.x + PR.w / 2, cy = PR.y + PR.h / 2; TX = cx - S * cx; TY = cy - S * cy; }
    if (t >= SCENE_START) {
      const z = expoInOut(seg(t, SCENE_START, SCENE_START + 1.2));
      const S1 = 1920 / PR.w, S0 = 1.022; const cx = PR.x + PR.w / 2, cy = PR.y + PR.h / 2;
      const T0x = cx - S0 * cx, T0y = cy - S0 * cy, T1x = -PR.x * S1, T1y = -(PR.y + PR.bar) * S1;
      S = lerp(S0, S1, z); TX = lerp(T0x, T1x, z); TY = lerp(T0y, T1y, z);
    }
    player.style.transform = `translate(${TX}px,${TY}px) scale(${S})`;
    Object.assign(pframe.style, { left: R.x + 'px', top: R.y + 'px', width: R.w + 'px', height: R.h + 'px', borderRadius: R.r + 'px' });
    pframe.style.background = pm < 0.35 ? 'var(--paper)' : 'var(--ink-deep)';
    // paper cover collapses into the title bar
    const coverH = lerp(R.h, PR.bar, expoInOut(seg(t, 2.0, 2.36)));
    Object.assign(pcover.style, { width: R.w + 'px', height: coverH + 'px' });
    // viewport
    const vw = R.w, vh = Math.max(0, R.h - PR.bar);
    Object.assign(pview.style, { left: '0px', top: PR.bar * clamp(R.h / PR.h) + 'px', width: vw + 'px', height: vh + 'px' });
    const vs = vw / 1920;
    vStream.style.transform = `translate(0px,${(vh - 1080 * vs) / 2}px) scale(${vs})`;
    sceneFrame.style.transform = `scale(${vs})`;
    // title bar contents
    ptitle.style.opacity = clamp(seg(t, 2.42, 2.62));
    ptitle.style.transform = `translateY(${8 * (1 - expoOut(seg(t, 2.42, 2.7)))}px)`;
    ptime.style.left = (R.w - 190) + 'px';
    ptime.style.opacity = clamp(seg(t, 2.5, 2.7));
    const clock = shownClock(t);
    ptimeText.textContent = fmtTime(clock);
    ptimeText.style.filter = t > 4.5 && t < 5.75 ? `blur(${(0.3 + 2.4 * Math.sin(Math.PI * seg(t, 4.5, 5.75))).toFixed(2)}px)` : 'none';

    // footage vs scene
    const useScene = t >= SCENE_START;
    vStream.style.display = useScene ? 'none' : '';
    sceneFrame.style.display = useScene ? '' : 'none';
    if (!useScene) {
      const st = streamTime(t);
      const p = seekVideo(vStream, st); if (p) pending.push(p);
      // tape streaks during the rewind
      const rw = t >= 4.5 && t < 5.9 ? Math.sin(Math.PI * clamp(seg(t, 4.5, 5.9))) : 0;
      vStream.style.filter = rw > 0.02 ? `url(#${dirBlur(vStream, 26 * rw, 0)}) brightness(${1 + 0.12 * rw}) saturate(${1 - 0.25 * rw})` : 'none';
      streaks.style.display = rw > 0.02 ? '' : 'none';
      streakLines.forEach((s, i) => { const yy = ((i * 0.23 + t * (1.7 + i * 0.4)) % 1) * vh; s.style.top = yy + 'px'; s.style.opacity = rw * (0.35 + 0.15 * i % 0.5); s.style.height = (2 + (i % 3)) + 'px'; });
    } else {
      const sceneMs = sceneAt(t);
      const p = seekScene(sceneMs); if (p) pending.push(p);
      hideSceneMark(t >= CATCH);
      // depth of field as the brand takes over
      const dof = seg(t, CATCH + 0.1, 19.4);
      pview.style.filter = dof > 0.01 ? `blur(${(22 * cubicInOut(dof)).toFixed(2)}px)` : 'none';
    }
  }
  // "stream" word travels into the title bar, then rolls to the channel name
  const fwOn = t >= 2.0 && t < 2.5;
  flyWord.style.display = fwOn ? '' : 'none';
  if (fwOn) {
    const w = line1[7]; const camAt = camX1(1.999);
    const p = expoInOut(seg(t, 2.04, 2.4));
    const x = lerp(w.x - camAt, PR.x + 28 + 32, p), y = lerp(L1.top, PR.y + 16, p);
    const sz = lerp(L1.size, 30, p);
    Object.assign(flyWord.style, { fontSize: sz + 'px', transform: `translate(${x}px,${y}px)`, opacity: 1 - seg(t, 2.36, 2.48) });
  }

  // ===== line 2 + plate + tile =====
  const l2on = t >= 2.6 && t < 4.4;
  for (const [i, w] of line2.entries()) {
    const s = w.el.style;
    if (!l2on && i < 3) { s.display = 'none'; continue; }
    s.display = '';
    if (i === 3) continue;
    const a = wordIn(w, t, 0.32);
    // exit: pushed out to the left by the tile growing (staggered)
    const ex = expoIn(seg(t, 3.96 + i * 0.04, 4.22 + i * 0.04));
    s.opacity = a.op * (1 - ex);
    s.transform = `translate(${w.x + a.dx - 900 * ex}px,${L2.top + 30 * ex}px) scale(${a.sc})`;
    s.filter = (a.blur + ex * 30) > 0.4 ? `blur(${a.blur.toFixed(2)}px) url(#${dirBlur(w.el, ex * 40, 0)})` : 'none';
    if (w.style === 'outline') { const f = seg(t, w.t + 0.24, w.t + 0.44); s.webkitTextStroke = '3.5px var(--paper)'; s.color = `rgb(244 239 230 / ${f})`; }
  }
  // "miss?" plate: grows with a spring, then squashes into the rewind tile
  const mw = line2[3];
  const mOn = t >= 3.38 && t < 4.6;
  missPlate.style.display = mOn ? '' : 'none';
  missClip.style.display = mOn ? '' : 'none';
  const TILE = { cx: PR.x + PR.w / 2, cy: PR.y + PR.bar + PR.vh / 2 + 10, size: 270 };
  if (mOn) {
    const a = wordIn(mw, t, 0.3);
    const g = springAt(t - 3.42, 0.55, 15);
    let R = { x: mw.x - 30, y: L2.top - 10, w: mw.w + 60, h: mw.h + 22, r: 22 };
    const pw = R.w * clamp(g, 0, 1.25);
    let rect = { x: R.x + (R.w - pw) / 2, y: R.y, w: pw, h: R.h, r: R.r };
    // squash into the tile 3.98..4.42
    const m = seg(t, 3.98, 4.42);
    if (m > 0) {
      const e = expoInOut(m);
      const tsz = TILE.size * 74 / 96;
      const T = { x: TILE.cx - tsz / 2 + 6, y: TILE.cy - tsz / 2 + 4, w: tsz, h: tsz, r: tsz * 21 / 74 };
      // squash-stretch: wider then taller
      const sq = Math.sin(Math.PI * m) * 0.12;
      rect = { x: lerp(R.x, T.x, e), y: lerp(R.y, T.y, e), w: lerp(R.w, T.w, e) * (1 + sq), h: lerp(R.h, T.h, e) * (1 - sq), r: lerp(R.r, T.r, e) };
    }
    Object.assign(missPlate.style, { width: rect.w + 'px', height: rect.h + 'px', borderRadius: rect.r + 'px', transform: `translate(${rect.x}px,${rect.y}px)` });
    missPlate.style.visibility = t >= 4.34 ? 'hidden' : 'visible';
    // the word sits inside the plate's clip and slides out when it squashes
    Object.assign(missClip.style, { width: rect.w + 'px', height: rect.h + 'px', borderRadius: rect.r + 'px', transform: `translate(${rect.x}px,${rect.y}px)` });
    const out = expoIn(m);
    const gl = clamp(springAt(t - 4.12, 0.5, 18), 0, 1.3);
    missGlyph.style.transform = `scale(${gl})`; missGlyph.style.transformOrigin = '50% 50%'; missGlyph.style.opacity = clamp(gl * 2);
    const s = mw.el.style;
    s.opacity = a.op; s.transform = `translate(${mw.x - rect.x + a.dx + 260 * out}px,${L2.top - rect.y - 160 * out}px) scale(${a.sc})`;
    s.filter = a.blur > 0.4 ? `blur(${a.blur.toFixed(2)}px)` : 'none';
  } else { mw.el.style.display = 'none'; }

  // the tile itself (after the squash) and its press, then it docks next to the timecode
  const tOn = t >= 4.34 && t < 6.0;
  tile.box.style.display = tOn ? '' : 'none';
  ripples.forEach(r => r.style.display = 'none');
  if (tOn) {
    const glyph = clamp(springAt(t - 4.12, 0.5, 18), 0, 1.3);
    const press = t >= 4.5 ? (t < 4.56 ? 1 - 0.08 * seg(t, 4.5, 4.56) : 0.92 + 0.08 * springAt(t - 4.56, 0.35, 22)) : 1;
    let size = TILE.size, x = TILE.cx - size / 2, y = TILE.cy - size / 2;
    const dock = expoInOut(seg(t, 4.7, 5.15));
    const dsz = 52, dx = PR.x + PR.w - 190 - 70, dy = PR.y + 6;
    size = lerp(size, dsz, dock); x = lerp(x, dx, dock); y = lerp(y, dy, dock);
    const vanish = expoIn(seg(t, 5.78, 5.98));
    placeMark(tile, x, y, size, { sx: press * (1 - vanish), sy: press * (1 - vanish), back: clamp(seg(t, 4.3, 4.5)), glyph, rot: -6 * Math.sin(Math.PI * dock) });
    // rewinding: the glyph spins backward while docked
    if (dock > 0.5) tile.glyph.style.transform = `scale(${glyph}) rotate(${-360 * cubicInOut(seg(t, 5.0, 5.75))}deg)`;
    // ripples in the tile's own outline
    ripples.forEach((r, i) => {
      const p = seg(t, 4.5 + i * 0.08, 4.95 + i * 0.08);
      if (p <= 0 || p >= 1) return;
      const fs = TILE.size * 74 / 96, sc = 1 + 0.7 * expoOut(p);
      Object.assign(r.style, { display: '', width: fs + 'px', height: fs + 'px', borderRadius: fs * 21 / 74 + 'px', transform: `translate(${TILE.cx - fs / 2 + 6}px,${TILE.cy - fs / 2 + 4}px) scale(${sc})`, opacity: 1 - p });
    });
  }

  // ===== rewind cards whip left to right =====
  for (const c of cardData) {
    const p = seg(t, c.t0, c.t0 + 0.46);
    const on = p > 0 && p < 1;
    c.el.style.display = on ? '' : 'none';
    if (!on) continue;
    // fast through the middle, slight brake near centre (readable for a beat)
    const uf = q => { const z = 2 * q - 1; return 0.5 + 0.5 * Math.sign(z) * Math.pow(Math.abs(z), 2.2); };
    const u = uf(p);
    const x = lerp(-500, 2420, u);
    const xPrev = lerp(-500, 2420, uf(seg(t - 1 / FPS, c.t0, c.t0 + 0.46)));
    const v = Math.abs(x - xPrev);
    c.el.style.transform = `translate(${x - 260}px,${c.y - 196}px) scale(${c.s}) rotate(${c.rot}deg)`;
    c.el.style.filter = `url(#${dirBlur(c.el, Math.min(70, v * 0.55), 0)})`;
  }

  // ===== caption over the scene =====
  const capOn = t >= 7.5 && t < 16.6;
  caption.style.display = capOn ? '' : 'none';
  if (capOn) {
    const grow = springAt(t - 7.55, 0.7, 13);
    const out = expoIn(seg(t, 16.15, 16.5));
    // width follows the current line
    const cur = capLines.findIndex(l => t >= l.t0 && t < l.t1);
    const widths = capLines.map(l => l.el.offsetWidth + 60);
    let W = widths[Math.max(0, cur)];
    if (cur > 0) { const p = expoOut(seg(t, capLines[cur].t0, capLines[cur].t0 + 0.4)); W = lerp(widths[cur - 1], widths[cur], p); }
    W *= clamp(grow, 0, 1.15);
    Object.assign(caption.style, { width: W + 'px', transform: `translate(${1856 - W + 400 * out}px,92px)`, filter: out > 0.02 ? `url(#${dirBlur(caption, 40 * out, 0)})` : 'none' });
    capLines.forEach((l, i) => {
      const pin = expoOut(seg(t, l.t0 + 0.05, l.t0 + 0.42)), pout = expoIn(seg(t, l.t1 - 0.02, l.t1 + 0.24));
      const y = 84 * (1 - pin) - 84 * pout;
      l.el.style.transform = `translateY(${y}px)`;
      l.el.style.opacity = (t >= l.t0 && t < l.t1 + 0.3) ? 1 : 0;
      l.el.style.filter = (1 - pin + pout) > 0.05 ? `blur(${(4 * (1 - pin + pout)).toFixed(2)}px)` : 'none';
    });
  }

  // ===== brand =====
  const bOn = t >= CATCH - 0.001 && t < 24.05;
  brandCam.style.display = bOn ? '' : 'none';
  brandCam.style.transform = `scale(${1 + 0.03 * cubicInOut(seg(t, 20.0, 23.0))})`;
  scrim.style.display = bOn ? '' : 'none';
  trail.forEach(m => m.box.style.display = 'none');
  wordmarkBox.style.display = t >= 19.95 ? '' : 'none';
  stroke.style.display = 'none';
  brandBg.style.display = bOn && t >= 19.2 ? '' : 'none';
  for (const w of tag) { if (w.el.parentNode !== brandCam) brandCam.appendChild(w.el); w.el.style.display = bOn && t >= w.t - 0.1 ? '' : 'none'; }
  keepPlate.style.display = bOn && t >= 21.84 ? '' : 'none';
  if (bOn) {
    scrim.style.opacity = 0.9 * cubicInOut(seg(t, CATCH + 0.2, 19.8)) + 0.1 * seg(t, 19.8, 20.0);
    // the stream keeps playing behind the brand, blurred
    if (t >= 19.2) { brandBg.style.opacity = 0.34 * cubicInOut(seg(t, 19.2, 20.4)); const p = seekVideo(brandBg, 12 + (t - 19.2)); if (p) pending.push(p); }
    if (!sceneMarkRect) sceneMarkRect = { x: 70, y: 950, w: 70, h: 70 };
    const r = sceneMarkRect;
    // the clone starts exactly on the scene's mark (front tile = 74 of the 96 unit box)
    const k0 = r.w / 74;
    const start = { x: r.x - 18 * k0, y: r.y - 16 * k0, size: 96 * k0 };
    const end = { x: BR.x0, y: BR.y0, size: 96 * BR.k };
    const flyAt = tt => {
      const p = seg(tt, CATCH + 0.12, 20.0);
      const e = Math.pow(p, 1.5); // accelerates into the hit instead of parking before it
      const ctrl = { x: 1250, y: 260 };
      const c0 = { x: start.x + start.size / 2, y: start.y + start.size / 2 }, c1 = { x: end.x + end.size / 2, y: end.y + end.size / 2 };
      const pt = bezier2(c0, ctrl, c1, e);
      const size = lerp(start.size, end.size, Math.pow(e, 1.1)) * (1 + 1.5 * Math.sin(Math.PI * Math.pow(e, 0.85)));
      return { x: pt.x - size / 2, y: pt.y - size / 2, size, e, p };
    };
    const f = flyAt(t);
    const hit = t >= 20.0 ? springAt(t - 20.0, 0.42, 16) : 0;
    const sq = t < 20 ? 1 : 1 + 0.08 * (1 - hit);
    const rot = -18 * (1 - f.e) + 22 * Math.sin(Math.PI * f.e) * (1 - f.e);
    placeMark(hero, f.x, f.y, f.size, { rot, sx: 2 - sq, sy: sq, sheen: 0.7 * Math.sin(Math.PI * seg(t, 20.0, 21.4)) + 0.4 * Math.sin(Math.PI * seg(t, 21.6, 23.2)) });
    const vel = (() => { const a = flyAt(t - 1 / FPS); return Math.hypot(f.x - a.x, f.y - a.y) * FPS; })();
    hero.box.style.filter = vel > 300 ? `blur(${Math.min(10, vel / 900).toFixed(2)}px)` : 'none';
    if (f.p > 0 && f.p < 1) trail.forEach((m, i) => {
      const g = flyAt(t - 0.035 * (i + 1));
      m.box.style.display = '';
      placeMark(m, g.x, g.y, g.size, { rot: -18 * (1 - g.e), opacity: 0.32 - i * 0.07, back: 0.2, glyph: 0 });
    });
    const punch = t >= 20 ? 1 + 0.02 * Math.exp(-(t - 20) * 7) * Math.cos((t - 20) * 30) : 1;
    if (t >= 19.95) {
      Object.assign(wordmarkBox.style, { transform: `translate(${BR.x0 + 109 * BR.k}px,${BR.y0}px)`, transformOrigin: '0 0' });
      letters.forEach((L, i) => {
        const p = seg(t, 20.0 + i * 0.035, 20.42 + i * 0.035);
        const e = backOut(p, 1.4);
        L.p.setAttribute('transform', `translate(${-40 * (1 - e)} ${14 * (1 - clamp(e))})`);
        L.p.setAttribute('opacity', clamp(p * 3));
      });
    }
    // the mark lifts up and gives the stage to the tagline
    const up = expoInOut(seg(t, 20.55, 21.1));
    const gcx = 960, gcy = BR.y0 + 48 * BR.k;
    const gs = lerp(punch, 0.5, up), gty = lerp(0, 205 - gcy, up);
    markGroup.style.transformOrigin = `${gcx}px ${gcy}px`;
    markGroup.style.transform = `translateY(${gty}px) scale(${gs})`;
    // tagline at display scale, word groups, each with its own entrance
    const fill = expoIn(seg(t, 22.95, 23.85));
    for (const w of tag) {
      const a = wordIn(w, t, 0.36);
      const top = TAG.tops[w.line];
      let dx = a.dx, dy = 0, sc = a.sc;
      if (w.line === 1 && !w.key) dy = 60 * (1 - expoOut(seg(t, w.t - 0.06, w.t + 0.4)));
      if (w.key) { dx = 0; sc = 1 + 0.25 * (1 - springAt(t - w.t + 0.06, 0.5, 14)); }
      w.el.style.opacity = a.op;
      w.el.style.transform = `translate(${w.x + dx}px,${top + dy}px) scale(${sc})`;
      w.el.style.filter = a.blur > 0.4 ? `blur(${a.blur.toFixed(2)}px)` : 'none';
    }
    // "keeps going" sits on a vermilion plate that grows and fills the frame: the next passage lives on it
    const k = tag[3];
    const g = clamp(springAt(t - 21.86, 0.55, 15), 0, 1.25);
    let R = { x: k.x - 34, y: TAG.tops[1] - 14, w: (k.w + 68) * g, h: k.h + 30, r: 24 };
    if (fill > 0) R = { x: lerp(R.x, -20, fill), y: lerp(R.y, -20, fill), w: lerp(R.w, 1960, fill), h: lerp(R.h, 1120, fill), r: lerp(24, 0, fill) };
    Object.assign(keepPlate.style, { width: R.w + 'px', height: R.h + 'px', borderRadius: R.r + 'px', transform: `translate(${R.x}px,${R.y}px)` });
    brandCam.appendChild(keepPlate);
    brandCam.appendChild(k.el);
    k.el.style.opacity = (1 - clamp(fill * 2.2)) * wordIn(k, t).op;
  }
  return Promise.all(pending);
}

// ---------- boot ----------
window.EVENTS = EVENTS; window.SCENE_SEGS = SCENE_SEGS;
window.FILM = { fps: FPS, duration: END };
const film2 = createFilm2(stage, { ev, seekVideo, FPS });
let ready;
window.__ready = ready = (async () => {
  sceneFrame.src = SCENE_URL;
  await new Promise(r => sceneFrame.addEventListener('load', r, { once: true }));
  await layout();
  buildEvents();
  await film2.setup();
  EVENTS.sort((a, b) => a.t - b.t);
  // wait for the scene lab to be ready for frame-exact seeks
  const w = sceneFrame.contentWindow;
  for (let i = 0; i < 400 && !(w.__seek && w.__ready); i++) await new Promise(r => setTimeout(r, 50));
  await Promise.race([w.__ready, new Promise(r => setTimeout(r, 15000))]);
  if (!w.__seek) console.error('scene lab did not expose __seek');
  await new Promise(r => { if (vStream.readyState >= 2) r(); else vStream.addEventListener('loadeddata', r, { once: true }); });
  // read where the scene's mark sits at the catch moment once, so any frame renders the same after a cold seek
  if (w.__seek) { await w.__seek(sceneAt(CATCH + 0.05)); sceneMarkRect = readSceneMark(); lastScene = -1; }
  // preload scene SFX for the sound layer
  window.SCENE_SFX = async () => w.__renderSfx ? await w.__renderSfx() : null;
  window.SCENE_EVENTS = () => w.__events;
})();
window.renderAt = async t => { await ready; const pend = []; film2.render(t, pend); await Promise.all([renderPassage1(hookOld(t)), ...pend]); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return t; };

if (!CAPTURE) {
  document.body.classList.add('preview');
  const hud = el('div', '', document.body); hud.id = 'hud';
  const range = el('input', '', hud); Object.assign(range, { type: 'range', min: 0, max: window.FILM.duration, step: 1 / FPS, value: Number(params.get('t') || 0) });
  range.style.width = '1500px';
  const lab = el('span', '', hud);
  const go = async () => { const t = Number(range.value); await window.renderAt(t); lab.textContent = ' ' + t.toFixed(3) + ' s'; };
  range.addEventListener('input', go); ready.then(go);
}
