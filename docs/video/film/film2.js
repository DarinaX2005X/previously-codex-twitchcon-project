// Passages 4-10 of the Previously film (24 s to the end). Pure functions of film time t.
// Rework after studying every reference sheet (review/video/REFERENCE-NOTES.md):
// one focal object per moment, calm centred captions that hold, light fields with soft colour light,
// a camera that keeps moving through real UI, morph chains that are the product's own states, no piles.
import { clamp, seg, lerp, expoOut, expoIn, expoInOut, cubicInOut, springAt, el, svgEl, fmtTime, bezier2 } from './lib.js';
import { makeMark, placeMark } from './mark.js';
import { Slot, card, cursor, button, pressScale, wordIn, hblur } from './kit.js';
import { FACTS, CODEX, CHAT } from './content.js';

export const END = 138.0;
const A = '/docs/video/film/assets/ui/';

/** An image seen through a window with its own camera: (cx, cy) in image CSS px lands on the window centre, scaled by s. */
function view(parent, src, cssW, { radius = 26, shadow = 'soft' } = {}) {
  const box = el('div', 'abs', parent);
  Object.assign(box.style, { overflow: 'hidden', borderRadius: radius + 'px' });
  if (shadow === 'soft') box.style.boxShadow = '0 2px 4px rgb(60 40 20 / .10), 0 50px 100px -40px rgb(60 35 15 / .45)';
  if (shadow === 'dark') box.style.boxShadow = '0 60px 120px -40px rgb(0 0 0 / .8)';
  const img = el('img', '', box); img.src = src; Object.assign(img.style, { position: 'absolute', left: '0px', top: '0px', width: cssW + 'px', transformOrigin: '0 0', maxWidth: 'none' });
  return {
    box, img,
    set(r, cam, extra = '') {
      Object.assign(box.style, { width: r.w + 'px', height: r.h + 'px', transform: `translate(${r.x}px,${r.y}px) ${extra}`, borderRadius: (r.r ?? radius) + 'px' });
      img.style.transform = `translate(${r.w / 2 - cam.cx * cam.s}px,${r.h / 2 - cam.cy * cam.s}px) scale(${cam.s})`;
    },
  };
}
const keyed = (t, keys) => {
  let D = { ...keys[0][1] };
  for (let i = 0; i < keys.length - 1; i++) { const [t0, a] = keys[i], [t1, b] = keys[i + 1]; if (t >= t0) { const e = expoInOut(seg(t, t0, t1)); D = {}; for (const k of Object.keys(a)) D[k] = lerp(a[k], b[k] ?? a[k], e); } }
  return D;
};
const land = (t, t0, z = 0.62, w = 11) => (t <= t0 ? 0 : springAt(t - t0, z, w));   // 0 -> 1, small overshoot, settles
const breathe = (t, k = 1) => ({ rx: 1.2 * k * Math.sin(t * 0.7), ry: 1.6 * k * Math.sin(t * 0.53 + 1), dx: 6 * k * Math.sin(t * 0.41) });
const lerpR = (a, b, p) => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p), r: lerp(a.r ?? 0, b.r ?? 0, p) });

export function createFilm2(stage, { ev, seekVideo, FPS }) {
  const root = el('div', 'layer', stage);
  const L = (name, parent = root) => { const d = el('div', 'layer', parent); d.dataset.name = name; return d; };
  let RECTS = null;
  const slots = [];
  const S = (parent, o, ph) => { const s = new Slot(parent, o, ph); slots.push(s); return s; };
  const CAP = { x: 100, y: 62, size: 84, width: 1720, align: 'center', color: 'var(--ink)', stagger: 0.08 };

  // ================= fields =================
  const airy = L('airy');
  airy.style.background = '#F3EEE6';
  const glow1 = el('div', 'layer', airy), glow2 = el('div', 'layer', airy), glow3 = el('div', 'layer', airy);
  const dark = L('dark');
  dark.style.background = '#111418';
  const dglow = el('div', 'layer', dark);
  const verm = el('div', 'abs', root); verm.style.background = 'var(--verm)';
  function renderFields(t, tint) {
    const a = 0.5 + 0.5 * Math.sin(t * 0.31), b = 0.5 + 0.5 * Math.cos(t * 0.23);
    glow1.style.background = `radial-gradient(900px 650px at ${12 + 8 * a}% ${88 - 6 * b}%, rgb(255 140 100 / ${0.30 * tint.warm}), transparent 70%)`;
    glow2.style.background = `radial-gradient(1000px 700px at ${86 - 6 * b}% ${10 + 8 * a}%, rgb(110 175 180 / ${0.30 * tint.cool}), transparent 72%)`;
    glow3.style.background = `radial-gradient(800px 520px at ${55 + 10 * b}% ${55 + 10 * a}%, rgb(200 245 96 / ${0.28 * tint.lime}), transparent 70%)`;
    dglow.style.background = `radial-gradient(1200px 800px at ${30 + 10 * a}% ${100 - 5 * b}%, rgb(255 90 54 / .26), transparent 70%), radial-gradient(1000px 700px at ${85 - 8 * b}% 0%, rgb(70 122 128 / .25), transparent 72%)`;
  }

  // ================= P4: honest frame on vermilion (24-30.3) =================
  const p4 = L('p4');
  S(p4, { ...CAP, y: 300, size: 100, stagger: 0.11 }, [{ t0: 24.2, t1: 29.15, text: ['What', 'you', 'see', 'next', 'is', 'the', { text: 'real app', emph: 'plate-ink' }] }]);
  S(p4, { ...CAP, y: 430, size: 100, stagger: 0.11 }, [{ t0: 25.5, t1: 29.2, text: ['replaying', 'an', { text: 'example recording', emph: 'under' }] }]);
  const note = el('div', 'abs', p4);
  Object.assign(note.style, { width: '1300px', padding: '30px 44px 34px', borderRadius: '24px', background: 'var(--paper)', boxShadow: '0 6px 0 var(--paper-side), 0 40px 70px -30px rgb(80 20 0 / .5)', color: 'var(--ink)', fontSize: '46px', fontWeight: 650, letterSpacing: '-.015em', lineHeight: 1.2, textAlign: 'center' });
  const noteWords = 'We made the game for this example. The speech, chat and raid in it are written as an example too.'.split(' ').map(w => el('span', '', note, w + ' '));

  // ================= the player (P5, P6) =================
  const pl = L('player');
  const frame = el('div', 'abs', pl);
  Object.assign(frame.style, { borderRadius: '30px', background: 'var(--ink-deep)', overflow: 'hidden', boxShadow: '0 2px 4px rgb(60 40 20 / .12), 0 60px 120px -40px rgb(60 35 15 / .5)', transformOrigin: '0 0' });
  const fview = el('div', 'abs', frame); fview.style.overflow = 'hidden';
  const vids = {};
  for (const k of ['stream', 'run', 'moon', 'fixed', 'lanterns']) {
    const v = el('video', '', fview); Object.assign(v, { src: k === 'stream' ? '/demo/foxlight/stream-full.mp4' : `/demo/foxlight/clip-${k}.mp4`, muted: true, preload: 'auto' });
    Object.assign(v.style, { position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%', objectFit: 'cover', display: 'none', transformOrigin: '50% 50%' });
    vids[k] = v;
  }
  const bar = el('div', 'abs', frame);
  Object.assign(bar.style, { height: '64px', background: 'var(--paper)', display: 'flex', alignItems: 'center', gap: '16px', padding: '0 26px', color: 'var(--ink)', fontSize: '26px', whiteSpace: 'nowrap' });
  const liveDot = el('i', '', bar); Object.assign(liveDot.style, { width: '13px', height: '13px', borderRadius: '7px', background: '#3c9a2e' });
  el('b', '', bar, 'Foxlight Dev').style.fontWeight = 750;
  el('span', '', bar, 'Building a tiny cave platformer').style.color = 'var(--muted-paper)';
  const exTag = el('span', '', bar, 'Example recording');
  Object.assign(exTag.style, { marginLeft: 'auto', background: 'var(--verm)', color: 'var(--ink)', fontWeight: 750, fontSize: '22px', padding: '6px 14px', borderRadius: '9px', transformOrigin: '50% 50%' });
  const clock = el('span', 'tab', bar, '0:05'); Object.assign(clock.style, { fontWeight: 800, fontSize: '28px', minWidth: '74px', textAlign: 'right' });
  const sub = el('div', 'abs', pl);   // the transcript, as a subtitle pill on the footage
  Object.assign(sub.style, { padding: '14px 26px 18px', borderRadius: '18px', background: 'rgb(244 239 230 / .96)', color: 'var(--ink)', fontSize: '40px', fontWeight: 650, letterSpacing: '-.015em', whiteSpace: 'nowrap', boxShadow: '0 20px 40px -18px rgb(0 0 0 / .5)', transformOrigin: '50% 50%' });
  const subTab = el('span', 'tab', sub, '0:05'); Object.assign(subTab.style, { display: 'inline-block', background: 'var(--ink)', color: 'var(--paper)', borderRadius: '8px', padding: '0 10px', fontSize: '28px', marginRight: '16px', fontWeight: 800, verticalAlign: '5px' });
  const subText = el('span', '', sub);
  const SPEECH = [
    { t0: 30.7, t1: 32.0, tab: '0:05', text: 'Today I am building a tiny cave platformer.' },
    { t0: 32.25, t1: 33.7, tab: '0:05', text: 'The goal tonight is to make the lanterns light up the cave.' },
    { t0: 46.0, t1: 46.9, tab: '1:40', text: 'Okay, let me try the spring.' },
  ];

  // ================= chat column (the product's own chat panel, rebuilt with the real messages) =================
  const chat = el('div', 'abs', pl);
  Object.assign(chat.style, { width: '560px', height: '760px', borderRadius: '28px', background: 'var(--ink)', overflow: 'hidden', boxShadow: '0 60px 120px -40px rgb(40 25 10 / .6)', transformOrigin: '0 0' });
  const chatHead = el('div', 'abs', chat); Object.assign(chatHead.style, { width: '560px', height: '74px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px', color: 'var(--paper)', fontSize: '28px', fontWeight: 750, background: 'var(--ink-raised)', zIndex: 2 });
  el('span', '', chatHead, 'Stream chat');
  el('span', '', chatHead, 'Foxlight Dev').style.color = 'var(--muted-ink)';
  const chatList = el('div', 'abs', chat); chatList.style.width = '560px';
  const ROW = 64;
  const chatMsgs = [
    ...CHAT.early.map((m, i) => ({ text: m, t: 34.25 + i * 0.62 })),
    ...FACTS.moment.burst.map((m, i) => ({ text: m, t: 48.9 + 3.0 * Math.pow(i / (FACTS.moment.burst.length - 1), 1.6), burst: true })),
  ];
  for (const m of chatMsgs) {
    m.el = el('div', 'abs', chatList, m.text);
    Object.assign(m.el.style, { left: '20px', height: (ROW - 10) + 'px', lineHeight: (ROW - 10) + 'px', padding: '0 18px', borderRadius: '14px', fontSize: '32px', fontWeight: 650, whiteSpace: 'nowrap', color: 'var(--paper)' });
  }
  const moonIdx = chatMsgs.length - 1;   // the last burst message is "MOON JUMP"
  const counter = el('div', 'abs', pl);
  Object.assign(counter.style, { background: 'var(--lime)', color: 'var(--ink)', borderRadius: '20px', padding: '10px 26px 14px', boxShadow: '0 6px 0 var(--lime-side), 0 30px 50px -20px rgb(40 60 0 / .5)', fontWeight: 800, whiteSpace: 'nowrap', transformOrigin: '50% 50%' });
  const cNum = el('span', 'tab', counter); Object.assign(cNum.style, { fontSize: '72px', letterSpacing: '-.03em', marginRight: '16px' });
  el('span', '', counter, 'messages in 10 seconds').style.fontSize = '34px';

  // ================= P5/P6 objects: the chapter card, the hold bar, the lore plate, the four chapters, the strip =================
  const p56 = L('p56');
  const capP5 = S(p56, CAP, [
    { t0: 30.5, t1: 33.75, text: ['It', { text: 'listens', emph: 'verm' }, 'to', 'the', 'streamer'] },
    { t0: 34.0, t1: 36.95, text: ['and', 'reads', 'the', { text: 'chat', emph: 'plate-lime' }] },
    { t0: 37.2, t1: 40.0, text: ['then', 'writes', 'a', 'short', { text: 'chapter', emph: 'under' }] },
    { t0: 40.25, t1: 44.25, text: ['and', 'waits', { text: '75 seconds', emph: 'plate-ink' }, 'before', 'showing', 'it'] },
    { t0: 45.6, t1: 48.6, text: ['Then', 'the', 'fox', 'tries', 'the', { text: 'spring', emph: 'verm' }] },
    { t0: 48.85, t1: 51.85, text: ['and', 'chat', { text: 'reacts', emph: 'plate-lime' }] },
    { t0: 52.1, t1: 55.5, text: ['Chat', 'named', 'it', 'the', { text: 'moon jump', emph: 'verm' }] },
    { t0: 55.75, t1: 59.6, text: ['Every', 'chapter', 'keeps', 'its', { text: 'sources', emph: 'under' }] },
  ]);
  const ch = card(p56, { tc: '0:05', title: 'Fox learns to jump', img: '/demo/foxlight/clip-run.jpg' });
  const holdBar = el('div', 'abs', p56); Object.assign(holdBar.style, { height: '26px', borderRadius: '13px', background: 'rgb(20 23 27 / .12)', overflow: 'hidden' });
  const holdFill = el('div', 'abs', holdBar); Object.assign(holdFill.style, { height: '26px', borderRadius: '13px', background: 'linear-gradient(90deg, #FF8A5C, var(--verm))' });
  const holdN = el('div', 'abs tab', p56); Object.assign(holdN.style, { color: 'var(--ink)', fontWeight: 800, fontSize: '96px', letterSpacing: '-.04em', lineHeight: 1 });
  const holdNote = el('div', 'abs', p56, 'counted faster here'); Object.assign(holdNote.style, { color: 'var(--muted-paper)', fontSize: '28px', fontWeight: 650 });
  const dot = el('div', 'abs', p56); dot.style.background = 'var(--verm)';
  const check = svgEl('svg', p56, { width: 200, height: 200, viewBox: '0 0 200 200', style: 'position:absolute;left:0;top:0;overflow:visible' });
  const checkPath = svgEl('path', check, { d: 'M58 104 L88 132 L144 72', fill: 'none', stroke: '#14171B', 'stroke-width': 16, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 100 });
  const pubWord = el('div', 'abs', p56, 'Published'); Object.assign(pubWord.style, { color: 'var(--ink)', fontWeight: 800, fontSize: '84px', letterSpacing: '-.035em' });
  const lore = el('div', 'abs', p56); Object.assign(lore.style, { overflow: 'hidden', background: 'var(--lime)', transformOrigin: '0 0' });
  const loreIn = el('div', 'abs', lore); Object.assign(loreIn.style, { width: '1180px', padding: '46px 60px', color: 'var(--ink)' });
  const loreT = el('div', '', loreIn, FACTS.lore.term); Object.assign(loreT.style, { fontSize: '150px', fontWeight: 800, letterSpacing: '-.045em', lineHeight: 0.95 });
  const loreE = el('div', '', loreIn, 'When the spring had no speed limit, it launched the fox through the ceiling.'); Object.assign(loreE.style, { fontSize: '46px', fontWeight: 650, lineHeight: 1.2, marginTop: '22px', letterSpacing: '-.015em', maxWidth: '1000px' });
  const loreTab = el('div', 'abs tab', lore, 'since 2:05'); Object.assign(loreTab.style, { left: 'auto', right: '40px', top: '36px', background: 'var(--ink)', color: 'var(--paper)', fontWeight: 800, fontSize: '40px', padding: '4px 18px', borderRadius: '12px' });
  const loreLabel = el('div', '', loreIn, 'moon jump'); loreLabel.style.display = 'none';
  const FOUR = [
    { tc: '0:05', title: 'Fox learns to jump', img: '/demo/foxlight/clip-run.jpg' },
    { tc: '1:40', title: 'The moon jump', img: '/demo/foxlight/clip-moon.jpg' },
    { tc: '3:30', title: 'Spring gets a speed limit', img: '/demo/foxlight/clip-fixed.jpg' },
    { tc: '5:20', title: 'Lanterns light the cave', img: '/demo/foxlight/clip-lanterns.jpg' },
  ].map(c => ({ ...c, ...card(p56, c) }));
  const strip = el('div', 'abs', p56);
  Object.assign(strip.style, { width: '1680px', height: '84px', borderRadius: '22px', background: 'rgb(255 255 255 / .7)', boxShadow: '0 1px 0 rgb(255 255 255 / .9) inset, 0 30px 60px -30px rgb(60 35 15 / .35)' });
  const TABS = [{ tc: '0:05', title: 'Fox learns to jump', x: 14 }, { tc: '1:40', title: 'The moon jump', x: 420 }, { tc: '2:05', title: 'moon jump', x: 770, lore: true }, { tc: '3:30', title: 'Spring gets a speed limit', x: 1000 }, { tc: '5:20', title: 'Lanterns', x: 1440 }]
    .map(d => { const e = el('div', 'abs', strip); Object.assign(e.style, { top: '12px', height: '60px', lineHeight: '60px', padding: '0 18px', borderRadius: '14px', background: d.lore ? 'var(--lime)' : 'var(--ink)', color: d.lore ? 'var(--ink)' : 'var(--paper)', fontWeight: 750, fontSize: '28px', whiteSpace: 'nowrap', transformOrigin: '0 50%' }); e.innerHTML = `<span class="tab" style="font-weight:800;margin-right:10px">${d.tc}</span>${d.title}`; return { ...d, el: e }; });

  // ================= live product pages (rendered by the real app, full composition) =================
  const APPURL = 'https://localhost:4317';
  function live(parent, name, path, w, h) {
    const box = el('div', 'abs', parent);
    Object.assign(box.style, { overflow: 'hidden', background: '#14171B', boxShadow: '0 2px 4px rgb(60 40 20 / .10), 0 60px 120px -40px rgb(40 25 10 / .55)' });
    const f = el('iframe', ''); f.name = name; f.width = w; f.height = h; f.src = APPURL + path; box.appendChild(f);
    Object.assign(f.style, { position: 'absolute', left: '0px', top: '0px', width: w + 'px', height: h + 'px', border: '0', transformOrigin: '0 0', pointerEvents: 'none' });
    return {
      box, f, w, h,
      // R: on-screen rectangle; cam: page point (cx, cy) placed at the rectangle's centre at scale s
      // scrolling pages (rep) keep a short viewport and scroll inside; render.cjs applies window.__scroll before the shot
      scrolls: false, freeze: null,
      set(R, cam, extra = '') {
        let sy = 0;
        if (this.scrolls) { sy = this.freeze ?? Math.max(0, Math.round(cam.cy - h / 2)); (window.__scroll = window.__scroll || {})[name] = sy; }
        Object.assign(box.style, { width: R.w + 'px', height: R.h + 'px', borderRadius: (R.r ?? 0) + 'px', transform: `translate(${R.x}px,${R.y}px) ${extra}` });
        f.style.transform = `translate(${R.w / 2 - cam.cx * cam.s}px,${R.h / 2 - (cam.cy - sy) * cam.s}px) scale(${cam.s})`;
        this.R = R; this.cam = cam; this.sy = sy;
      },
      // page point -> screen point (without the extra 3D transform)
      map(px, py) { const R = this.R, c = this.cam; return { x: R.x + R.w / 2 + (px - c.cx) * c.s, y: R.y + R.h / 2 + (py - c.cy) * c.s }; },
    };
  }
  const U = k => (window.__ui && window.__ui[k]) || FALLBACK[k];
  const FALLBACK = {
    pubNow: { x: 654, y: 166, w: 666, h: 354 }, pubStoryClip: { x: 1100, y: 690, w: 200, h: 160 }, pubMoon: { x: 260, y: 640, w: 1124, h: 300 }, pubStory: { x: 260, y: 420, w: 1124, h: 300 },
    landScroll: 10400, landSection: { x: 0, y: 10300, w: 1440, h: 1000 }, landChat: { x: 756, y: 10644, w: 612, h: 677 },
    repChange: { x: 56, y: 2462, w: 1328, h: 384 }, repApply: { x: 952, y: 2755, w: 230, h: 60 }, repRecap: { x: 56, y: 1000, w: 1328, h: 1389 }, repPlayer: { x: 56, y: 216, w: 968, h: 712 },
    repCheat: { x: 760, y: 1110, w: 340, h: 340 }, repApplied: { x: 56, y: 2462, w: 1328, h: 384 },
    repDock: { x: 460, y: 2988, w: 520, h: 2662 }, repPause: { x: 476, y: 3409, w: 240, h: 44 }, repForget: { x: 724, y: 3409, w: 240, h: 44 },
    repDialogV: { x: 446, y: 370, w: 549, h: 360 }, repYesV: { x: 687, y: 640, w: 136, h: 64 }, repDock2: { x: 460, y: 2988, w: 520, h: 2662 },
  };
  const FULL = { x: 0, y: 0, w: 1920, h: 1080, r: 0 };
  const PLANE = { x: 160, y: 190, w: 1600, h: 1000, r: 30 };
  const topFade = el('div', 'abs', root); Object.assign(topFade.style, { width: '1920px', height: '260px', background: 'linear-gradient(rgb(243 238 230 / .97) 45%, rgb(243 238 230 / 0))' });

  // ================= P7: three ways in (60-82) =================
  const p7 = L('p7');
  const pub = live(p7, 'pub', '/example', 1440, 3200);
  const chatObj = view(p7, A + 'chat-answer.png', 592, { radius: 30 });
  const capP7 = S(p7, CAP, [
    { t0: 60.25, t1: 63.0, text: ['A', 'viewer', 'arrives', 'at', { text: '7:10', emph: 'plate-ink' }] },
    { t0: 63.25, t1: 68.0, text: ['and', 'types', { text: '!previously', emph: 'verm' }, 'in', 'chat'] },
    { t0: 68.25, t1: 74.0, text: ['or', 'opens', 'the', { text: 'recap page', emph: 'under' }] },
    { t0: 74.25, t1: 78.9, text: ['A', 'raid', 'gets', 'it', 'on', { text: 'stream', emph: 'plate-ink' }] },
    { t0: 79.15, t1: 81.8, text: ['One', 'story', 'feeds', 'all', { text: 'three', emph: 'verm' }] },
  ]);
  const cap = el('div', 'abs', p7); Object.assign(cap.style, { background: 'var(--paper)', color: 'var(--ink)', fontWeight: 800, fontSize: '120px', letterSpacing: '-.04em', padding: '8px 50px 24px', borderRadius: '999px', whiteSpace: 'nowrap', overflow: 'hidden', boxShadow: '0 2px 4px rgb(60 40 20 / .1), 0 40px 80px -30px rgb(60 35 15 / .4)', transformOrigin: '0 50%' });
  const capText = el('span', '', cap); const capCaret = el('span', '', cap, '|'); Object.assign(capCaret.style, { fontWeight: 300, color: 'var(--verm)' });
  const ring = svgEl('svg', p7, { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0;overflow:visible' });
  const ringR = svgEl('rect', ring, { fill: 'none', stroke: '#FF5A36', 'stroke-width': 8, rx: 26, pathLength: 1000, 'stroke-linecap': 'round' });
  const moonV = view(p7, A + 'public-moon.png', 894, { radius: 22 });
  const moonVid = el('video', '', moonV.box); Object.assign(moonVid, { src: '/demo/foxlight/clip-moon.mp4', muted: true, preload: 'auto' }); Object.assign(moonVid.style, { position: 'absolute', objectFit: 'cover', borderRadius: '12px' });
  const sceneWin = el('div', 'abs', p7); Object.assign(sceneWin.style, { overflow: 'hidden', background: '#000', boxShadow: '0 60px 120px -40px rgb(0 0 0 / .7)' });
  const scene2 = el('iframe', '', sceneWin); scene2.width = 1920; scene2.height = 1080; Object.assign(scene2.style, { border: '0', width: '1920px', height: '1080px', position: 'absolute', left: '0px', top: '0px', transformOrigin: '0 0' });
  const thread = svgEl('svg', p7, { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0;overflow:visible' });
  const threadP = svgEl('path', thread, { fill: 'none', stroke: '#FF5A36', 'stroke-width': 8, 'stroke-linecap': 'round', pathLength: 100 });
  const threadDots = [0, 1, 2].map(() => svgEl('circle', thread, { r: 0, fill: '#FF5A36' }));
  const triLabels = ['In chat', 'On the recap page', 'On stream'].map(s => { const e = el('div', 'abs', p7, s); Object.assign(e.style, { color: 'var(--ink)', fontWeight: 750, fontSize: '44px', letterSpacing: '-.02em', whiteSpace: 'nowrap', textAlign: 'center', width: '600px' }); return e; });
  const cur7 = cursor(p7); cur7.style.transformOrigin = '0 0';
  const fade7 = el('div', 'abs', p7); Object.assign(fade7.style, { width: '1920px', height: '300px', background: 'linear-gradient(rgb(243 238 230 / .97) 50%, rgb(243 238 230 / 0))' });
  p7.appendChild(capP7.root);

  // ================= P8: the streamer stays in charge (82-102), the real replay page and dock =================
  const p8 = L('p8');
  const repl = live(p8, 'rep', '/replay', 1440, 1100); repl.scrolls = true;
  const capP8 = S(p8, CAP, [
    { t0: 82.25, t1: 85.0, text: ['The', 'streamer', 'stays', 'in', { text: 'charge', emph: 'verm' }] },
    { t0: 85.25, t1: 89.75, text: ['Correct', 'a', 'chapter', { text: 'once', emph: 'plate-ink' }] },
    { t0: 90.0, t1: 93.3, text: ['and', 'every', 'place', 'uses', 'the', 'new', { text: 'wording', emph: 'under' }] },
    { t0: 93.55, t1: 96.4, text: [{ text: 'Pause', emph: 'verm' }, 'listening', 'at', 'any', 'time'] },
    { t0: 96.65, t1: 99.4, text: ['or', 'forget', 'the', 'last', { text: 'two minutes', emph: 'plate-ink' }] },
    { t0: 99.65, t1: 101.5, text: ['and', 'what', 'was', 'made', 'from', 'them'] },
  ]);
  const cur = cursor(p8); cur.style.transformOrigin = '0 0';
  const chip = el('div', 'abs', p8); Object.assign(chip.style, { background: 'var(--paper)', color: 'var(--ink)', borderRadius: '20px', padding: '16px 30px 20px', fontWeight: 800, fontSize: '50px', letterSpacing: '-.03em', whiteSpace: 'nowrap', boxShadow: '0 2px 4px rgb(60 40 20 / .12), 0 40px 70px -24px rgb(40 25 10 / .55)', transformOrigin: '50% 50%' });
  chip.innerHTML = '<span class="tab" style="display:inline-block;background:#14171B;color:#F4EFE6;border-radius:10px;padding:2px 12px;font-size:34px;margin-right:16px;vertical-align:6px">3:30</span>Moon jump becomes a cheat code';
  const landRing = el('div', 'abs', p8); Object.assign(landRing.style, { border: '6px solid var(--verm)' });
  const ripple = el('div', 'abs', p8); Object.assign(ripple.style, { border: '6px solid var(--verm)', borderRadius: '50%' });
  const zoomDark = el('div', 'abs', root); zoomDark.style.background = '#111418';
  p8.appendChild(topFade); p8.appendChild(capP8.root);

  // ================= P9: Codex (102-126), dark with a soft glow =================
  const p9 = L('p9');
  const c1 = S(p9, { ...CAP, y: 200, size: 104, color: 'var(--paper)' }, [{ t0: 101.8, t1: 107.85, text: ['Built', 'in', 'one', { text: 'Codex session', emph: 'plate-paper' }] }]);
  const c2 = S(p9, { ...CAP, y: 120, size: 104, color: 'var(--paper)' }, [{ t0: 107.95, t1: 110.5, text: [{ text: `${CODEX.workers}`, emph: 'verm' }, 'parallel', 'workers'] }]);
  const space = el('div', 'layer', p9); space.style.perspective = '900px'; space.style.perspectiveOrigin = '50% 52%';
  const space3 = el('div', 'layer', space); space3.style.transformStyle = 'preserve-3d';
  const swarm = Array.from({ length: CODEX.workerNames.length * 2 }, (_, i) => {
    const n = CODEX.workerNames[i % CODEX.workerNames.length];
    const e = el('div', 'abs', space3, n);
    const hot = i % 6 === 0;
    Object.assign(e.style, { background: hot ? 'var(--verm)' : i % 3 === 0 ? 'var(--paper)' : 'var(--ink-high)', color: hot || i % 3 === 0 ? 'var(--ink)' : 'var(--paper)', fontWeight: 750, fontSize: '40px', padding: '10px 24px 14px', borderRadius: '16px', whiteSpace: 'nowrap', boxShadow: '0 6px 0 rgb(0 0 0 / .35), 0 30px 60px -20px rgb(0 0 0 / .6)', transformOrigin: '50% 50%', backfaceVisibility: 'hidden' });
    const r = (k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    return { e, ang: r(1) * Math.PI * 2, rad: 380 + r(2) * 900, z0: r(3), y0: (r(4) - 0.5) * 900, spin: (r(5) - 0.5) * 0.4 };
  });
  const odo = (parent, size, color) => { // rolling digits: one vertical strip per digit
    const box = el('div', 'abs', parent); box.style.width = '1920px';
    const row = el('div', '', box); Object.assign(row.style, { display: 'flex', alignItems: 'flex-start', justifyContent: 'center', width: '1920px', color, fontWeight: 800, letterSpacing: '-.04em', lineHeight: 1 });
    return { box, size, cells: [], set(str, frac = {}) {
      while (this.cells.length < str.length) { const c = el('div', '', row); Object.assign(c.style, { position: 'relative', overflow: 'hidden', height: size * 1.02 + 'px', fontSize: size + 'px' }); const strip = el('div', 'tab', c); strip.style.position = 'relative'; c.strip = strip; this.cells.push(c); }
      this.cells.forEach((c, i) => {
        const ch = str[i] ?? '';
        c.style.display = i < str.length ? '' : 'none';
        if (/\d/.test(ch)) {
          Object.assign(c.style, { overflow: 'hidden', alignSelf: 'flex-start', margin: '0', height: size * 1.02 + 'px', fontSize: size + 'px' });
          if (c.dataset.k !== 'd') { c.strip.innerHTML = ''; for (let d = 0; d <= 10; d++) { const s = el('div', '', c.strip, String(d % 10)); s.style.height = size * 1.02 + 'px'; } c.dataset.k = 'd'; }
          const v = (frac[i] ?? +ch);
          c.strip.style.transform = `translateY(${-v * size * 1.02}px)`;
          const sp = Math.abs((frac[i] ?? +ch) - Math.round(frac[i] ?? +ch));
          c.strip.style.filter = sp > 0.02 ? `blur(${Math.min(5, sp * 14)}px)` : 'none';
          c.style.width = size * 0.62 + 'px';
        } else { const small = /[a-z]/.test(ch); c.dataset.k = 't'; c.strip.textContent = ch === ' ' ? ' ' : ch; c.strip.style.transform = 'none'; c.strip.style.filter = 'none'; c.style.width = 'auto'; c.style.fontSize = (small ? size * 0.4 : size) + 'px'; c.style.height = (small ? size * 0.4 * 1.1 : size * 1.02) + 'px'; c.style.overflow = 'visible'; c.style.alignSelf = small ? 'flex-end' : 'flex-start'; c.style.margin = small ? `0 ${size * 0.08}px ${size * 0.14}px ${size * 0.03}px` : '0'; c.strip.style.lineHeight = small ? '1.1' : (size * 1.02) + 'px'; c.strip.style.paddingTop = '0px'; }
      });
    } };
  };
  // value with rolling: each digit place shows its own fractional position
  const odoVal = (v, place, last) => { const d = Math.floor(v / place) % 10; if (last) return d + (v - Math.floor(v)); const carry = clamp((v % place) - (place - 1)); return d + cubicInOut(carry); };
  const rollDigits = (v, len) => { const out = {}; let s = String(Math.floor(v)).padStart(len, '0'); for (let i = 0; i < len; i++) { const place = Math.pow(10, len - 1 - i); const d = (v / place) % 10; const below = (v % place) / place; out[i] = Math.floor(d) + (below > 0.9 ? (below - 0.9) * 10 : 0); } return { s, out }; };
  const durO = odo(p9, 230, 'var(--paper)');
  const durL = el('div', 'abs', p9, `${CODEX.from} to ${CODEX.to} UTC`); Object.assign(durL.style, { width: '1920px', textAlign: 'center', fontSize: '50px', letterSpacing: '-.02em', color: 'var(--muted-ink)', fontWeight: 700 });
  const toolO = odo(p9, 260, 'var(--paper)');
  const toolL = el('div', 'abs', p9, 'tool calls by Codex and its workers'); Object.assign(toolL.style, { width: '1920px', textAlign: 'center', fontSize: '52px', letterSpacing: '-.02em', color: 'var(--verm)', fontWeight: 750 });
  const bugCards = CODEX.bugs.map(b => {
    const c = el('div', 'abs', p9); Object.assign(c.style, { width: '1720px', background: 'var(--paper)', color: 'var(--ink)', borderRadius: '44px', padding: '64px 80px 76px', boxShadow: '0 10px 0 var(--paper-side), 0 60px 120px -40px rgb(0 0 0 / .8)', transformOrigin: '50% 50%' });
    const lab = el('div', '', c, b.label); Object.assign(lab.style, { fontSize: '54px', fontWeight: 800, color: 'var(--verm-side)', marginBottom: '20px', letterSpacing: '-.025em' });
    const tx = el('div', '', c, b.text); Object.assign(tx.style, { fontSize: '102px', fontWeight: 800, lineHeight: 1.02, letterSpacing: '-.04em' });
    const st = el('div', 'abs', c, 'fixed'); Object.assign(st.style, { left: 'auto', right: '60px', top: '-96px', border: '14px solid var(--verm)', color: 'var(--verm)', background: 'var(--paper)', fontWeight: 800, fontSize: '160px', padding: '0 40px 6px', borderRadius: '30px', transformOrigin: '50% 50%', lineHeight: 1.05 });
    return { c, st };
  });
  const q = el('div', 'abs', p9); Object.assign(q.style, { width: '1760px', color: 'var(--paper)', textAlign: 'center' });
  const qLab = el('div', '', q, CODEX.question.label); Object.assign(qLab.style, { fontSize: '52px', fontWeight: 750, color: 'var(--lime)', marginBottom: '22px' });
  const qTx = el('div', '', q, `“${CODEX.question.text}”`); Object.assign(qTx.style, { fontSize: '160px', fontWeight: 800, letterSpacing: '-.05em', lineHeight: 0.98 });
  const ans = el('div', 'abs', p9, CODEX.question.answer); Object.assign(ans.style, { width: '1640px', textAlign: 'center', background: 'var(--lime)', color: 'var(--ink)', fontWeight: 800, fontSize: '66px', lineHeight: 1.15, letterSpacing: '-.02em', padding: '26px 44px 32px', borderRadius: '28px', boxShadow: '0 9px 0 var(--lime-side)', transformOrigin: '50% 50%' });
  const testO = odo(p9, 280, 'var(--verm)');
  const testL = el('div', 'abs', p9); Object.assign(testL.style, { width: '1920px', textAlign: 'center', fontSize: '56px', letterSpacing: '-.02em', fontWeight: 750, color: 'var(--paper)' });
  const runO = odo(p9, 240, 'var(--lime)');
  const runL = el('div', 'abs', p9, 'chat messages in one long load run, 3.80 virtual hours'); Object.assign(runL.style, { width: '1920px', textAlign: 'center', fontSize: '54px', letterSpacing: '-.02em', fontWeight: 750, color: 'var(--paper)' });
  // "and polished in Claude Code": the work products leave the code in 2.5D, on both sides
  const cc = S(p9, { ...CAP, y: 90, size: 96, color: 'var(--paper)' }, [{ t0: 123.45, t1: 125.85, text: ['and', 'polished', 'in', { text: 'Claude Code', emph: 'plate-paper' }] }]);
  const stage3 = el('div', 'layer', p9); stage3.style.perspective = '1400px'; stage3.style.perspectiveOrigin = '50% 55%';
  const space4 = el('div', 'layer', stage3); space4.style.transformStyle = 'preserve-3d';
  const code = el('div', 'abs', space4);
  Object.assign(code.style, { width: '640px', padding: '30px 36px 34px', borderRadius: '26px', background: '#0C0E11', boxShadow: '0 0 0 2px #2C333C, 0 60px 120px -40px rgb(0 0 0 / .9)', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '25px', lineHeight: 1.6, color: '#A9B1BC', whiteSpace: 'pre', transformOrigin: '50% 50%' });
  code.innerHTML = [
    '<span style="color:#FF5A36">:root</span> {',
    '  --pv-ink: <span style="color:#F4EFE6">#14171B</span>;',
    '  --pv-paper: <span style="color:#F4EFE6">#F4EFE6</span>;',
    '  --pv-vermilion: <span style="color:#FF5A36">#FF5A36</span>;',
    '  --pv-lime: <span style="color:#C8F560">#C8F560</span>;',
    '  --pv-display-tracking: -.035em;',
    '}',
  ].join('\n');
  const SVG = {
    slides: `<svg viewBox="0 0 300 210"><rect x="34" y="26" width="250" height="160" rx="16" fill="#CFC5B3"/><rect x="22" y="16" width="250" height="160" rx="16" fill="#E4DDD0"/><rect x="8" y="6" width="250" height="160" rx="16" fill="#F4EFE6"/><rect x="28" y="30" width="120" height="16" rx="5" fill="#14171B"/><rect x="28" y="56" width="170" height="10" rx="4" fill="#4A4F57"/><rect x="28" y="76" width="140" height="10" rx="4" fill="#4A4F57"/><rect x="150" y="96" width="88" height="54" rx="9" fill="#FF5A36"/><rect x="28" y="104" width="100" height="40" rx="8" fill="#14171B"/></svg>`,
    video: `<svg viewBox="0 0 300 210"><rect x="6" y="18" width="288" height="174" rx="18" fill="#0C0E11"/><rect x="18" y="30" width="264" height="132" rx="10" fill="#273644"/><circle cx="150" cy="96" r="30" fill="#FF5A36"/><path d="M141 81 L165 96 L141 111 Z" fill="#14171B"/><rect x="18" y="172" width="264" height="6" rx="3" fill="#2C333C"/><rect x="18" y="172" width="150" height="6" rx="3" fill="#FF5A36"/><g fill="#F4EFE6">${[0, 1, 2, 3, 4, 5, 6, 7].map(i => `<rect x="${26 + i * 33}" y="21" width="16" height="5" rx="2"/>`).join('')}</g></svg>`,
    readme: `<svg viewBox="0 0 220 280"><rect x="6" y="6" width="208" height="268" rx="16" fill="#F4EFE6"/><rect x="26" y="28" width="30" height="30" rx="9" fill="#FF5A36"/><path fill-rule="evenodd" d="M33 35h11a7 7 0 0 1 0 14h-4v5h-7z" fill="#14171B"/><rect x="64" y="34" width="100" height="16" rx="5" fill="#14171B"/><rect x="26" y="76" width="168" height="74" rx="10" fill="#273644"/><rect x="26" y="164" width="168" height="9" rx="4" fill="#4A4F57"/><rect x="26" y="182" width="150" height="9" rx="4" fill="#4A4F57"/><rect x="26" y="200" width="160" height="9" rx="4" fill="#4A4F57"/><rect x="26" y="226" width="168" height="30" rx="8" fill="#14171B"/></svg>`,
    visuals: `<svg viewBox="0 0 300 220"><rect x="6" y="6" width="288" height="208" rx="18" fill="#1E232A"/><rect x="22" y="22" width="80" height="80" rx="14" fill="#FF5A36"/><rect x="110" y="22" width="80" height="80" rx="14" fill="#F4EFE6"/><rect x="198" y="22" width="80" height="80" rx="14" fill="#C8F560"/><text x="22" y="186" font-family="Onest" font-weight="800" font-size="84" fill="#F4EFE6" letter-spacing="-4">Aa</text><rect x="150" y="122" width="128" height="76" rx="12" fill="#14171B" stroke="#2C333C" stroke-width="3"/><rect x="164" y="138" width="60" height="10" rx="4" fill="#FF5A36"/><rect x="164" y="158" width="96" height="8" rx="4" fill="#A9B1BC"/><rect x="164" y="174" width="80" height="8" rx="4" fill="#A9B1BC"/></svg>`,
    landing: `<svg viewBox="0 0 320 220"><rect x="6" y="6" width="308" height="208" rx="16" fill="#14171B"/><rect x="6" y="6" width="308" height="28" rx="16" fill="#272D35"/><circle cx="24" cy="20" r="5" fill="#FF5A36"/><circle cx="40" cy="20" r="5" fill="#4A5360"/><rect x="24" y="52" width="130" height="18" rx="5" fill="#F4EFE6"/><rect x="24" y="76" width="110" height="18" rx="5" fill="#F4EFE6"/><rect x="24" y="104" width="120" height="8" rx="4" fill="#A9B1BC"/><rect x="24" y="130" width="96" height="26" rx="10" fill="#FF5A36"/><rect x="170" y="52" width="128" height="120" rx="12" fill="#273644"/><rect x="186" y="132" width="96" height="28" rx="8" fill="#F4EFE6"/></svg>`,
  };
  const products = [
    { k: 'slides', label: 'Slides', w: 380, side: -1, x: 420, y: 470, z: 80, ry: 24, d: 0.0 },
    { k: 'readme', label: 'README', w: 250, side: -1, x: 175, y: 830, z: -160, ry: 30, d: 0.12 },
    { k: 'visuals', label: 'Visuals', w: 340, side: -1, x: 560, y: 850, z: 40, ry: 20, d: 0.24 },
    { k: 'landing', label: 'Landing', w: 400, side: 1, x: 1500, y: 480, z: 80, ry: -24, d: 0.06 },
    { k: 'video', label: 'Video', w: 370, side: 1, x: 1600, y: 830, z: -80, ry: -26, d: 0.18 },
  ].map(o => { const e = el('div', 'abs', space4); e.innerHTML = SVG[o.k]; const sv = e.querySelector('svg'); sv.style.width = o.w + 'px'; sv.style.display = 'block'; sv.style.filter = 'drop-shadow(0 30px 40px rgb(0 0 0 / .55))'; const lb = el('div', '', e, o.label); Object.assign(lb.style, { marginTop: '14px', textAlign: 'center', color: '#F4EFE6', fontWeight: 750, fontSize: '34px', letterSpacing: '-.02em' }); Object.assign(e.style, { width: o.w + 'px', transformOrigin: '50% 50%' }); return { ...o, e }; });
  p9.appendChild(cc.root);
  const paperCircle = el('div', 'abs', root); paperCircle.style.background = '#F3EEE6'; paperCircle.style.borderRadius = '50%';

  // ================= P10: try it, then the mark (126-138), light =================
  const p10 = L('p10');
  const setupL = live(p10, 'setup', '/setup', 1440, 900);
  const rep0 = live(p10, 'rep0', '/replay', 1440, 900);
  const cap10 = S(p10, { ...CAP, y: 62, size: 92, stagger: 0.1 }, [
    { t0: 126.3, t1: 128.85, text: ['Run', 'it', 'on', 'your', 'own', { text: 'channel', emph: 'verm' }] },
    { t0: 129.1, t1: 131.6, text: ['with', 'your', 'Twitch', 'app', 'and', { text: 'OpenAI key', emph: 'plate-ink' }] },
    { t0: 131.85, t1: 133.55, text: ['or', 'try', 'the', 'example', { text: 'replay', emph: 'under' }] },
  ]);
  const url = el('div', 'abs', p10, 'previously-seven.vercel.app/replay'); Object.assign(url.style, { background: 'var(--ink)', color: 'var(--paper)', fontWeight: 800, fontSize: '64px', letterSpacing: '-.03em', padding: '14px 44px 22px', borderRadius: '22px', transformOrigin: '50% 50%', whiteSpace: 'nowrap' });
  const endTabs = ['0:05', '1:40', '3:30', '5:20'].map(tc => { const e = el('div', 'abs tab', p10, tc); Object.assign(e.style, { background: 'var(--ink)', color: 'var(--paper)', fontWeight: 800, fontSize: '50px', padding: '6px 20px 10px', borderRadius: '16px', transformOrigin: '50% 50%' }); return e; });
  const endMark = makeMark(p10);
  const endWord = el('img', 'abs', p10); endWord.src = '/brand/wordmark-text.svg';
  const endTag = el('div', 'abs', p10, 'Catch up with the stream while it keeps going'); Object.assign(endTag.style, { color: 'var(--ink)', fontWeight: 750, fontSize: '64px', letterSpacing: '-.03em', whiteSpace: 'nowrap', width: '1920px', textAlign: 'center' });
  const endUrl = el('div', 'abs', p10, 'previously-seven.vercel.app'); Object.assign(endUrl.style, { background: 'var(--ink)', color: 'var(--paper)', fontWeight: 800, fontSize: '50px', letterSpacing: '-.025em', padding: '10px 34px 16px', borderRadius: '999px', whiteSpace: 'nowrap', transformOrigin: '50% 50%' });
  const fade10 = el('div', 'abs', p10); Object.assign(fade10.style, { width: '1920px', height: '260px', background: 'linear-gradient(rgb(243 238 230 / .97) 45%, rgb(243 238 230 / 0))' });
  p10.appendChild(fade10); p10.appendChild(cap10.root); p10.appendChild(url);

  async function setup() {
    for (const s of slots) s.layout();
    RECTS = await (await fetch(A + 'rects.json')).json();
    scene2.src = '/src/features/overlay/lab/index.html?capture=1&plan=foxlight&bg=video&bgAt=4000';
    await new Promise(r => scene2.addEventListener('load', r, { once: true }));
    const w = scene2.contentWindow;
    for (let i = 0; i < 400 && !(w.__seek && w.__ready); i++) await new Promise(r => setTimeout(r, 50));
    await Promise.race([w.__ready, new Promise(r => setTimeout(r, 15000))]);
    // ---- sound events placed from the picture ----
    for (const s of slots) for (const ph of s.phrases) ph.words.forEach((wd, i) => {
      if (i === 0) ev(`ph-${ph.t0}`, wd.t - 0.02, 'tick', { x: 0.5, gain: 0.45 });
      if (wd.emph) ev(`w-${ph.t0}-${i}`, wd.t, wd.emph.startsWith('plate') ? 'pop' : 'thump', { x: clamp((s.x + wd.x + wd.w / 2) / 1920), gain: 0.7, note: (i * 2) % 7 });
      if (wd.under) ev(`u-${ph.t0}-${i}`, wd.t + 0.3, 'draw', { dur: 0.4, x: 0.5, gain: 0.6 });
    });
    ev('note', 26.5, 'flick', { x: 0.5 });
    ev('field-to-tag', 29.25, 'morph', { dur: 0.9, x: 0.5, pan2: 0.9 });
    ev('tag-pop', 30.1, 'pop', { x: 0.85, gain: 0.6 });
    for (const sp of SPEECH) for (let i = 0; i < 10; i++) ev(`key-${sp.t0}-${i}`, sp.t0 + (sp.t1 - sp.t0) * i / 10, 'key', { x: 0.45, gain: 0.55 });
    ev('chat-in', 34.0, 'whoosh', { dur: 0.6, x: 1.0, pan2: 0.75 });
    chatMsgs.filter(m => !m.burst).forEach((m, i) => ev(`cm-${i}`, m.t, 'pop', { x: 0.78, gain: 0.45, note: 3 + i }));
    ev('extract', 37.2, 'air', { dur: 0.8, x: 0.5 });
    ev('card-form', 37.95, 'plate', { x: 0.5 });
    for (let i = 0; i < 16; i++) ev(`hold-${i}`, 40.6 + 2.6 * (i / 16), 'tick', { x: 0.5, gain: 0.35 + i * 0.03 });
    ev('to-dot', 43.3, 'morph', { dur: 0.4, x: 0.5, gain: 0.7 });
    ev('check', 43.75, 'chime', { x: 0.5 });
    ev('published', 43.95, 'stamp', { x: 0.55, gain: 0.8 });
    ev('to-strip', 44.6, 'whoosh', { dur: 0.5, x: 0.5, pan2: 0.2, gain: 0.6 });
    ev('strip-tab', 45.1, 'tick', { x: 0.1, gain: 0.6 });
    ev('fox-launch', 48.2, 'whoosh', { dur: 0.5, x: 0.4, gain: 0.6 });
    ev('chat-in2', 48.7, 'whoosh', { dur: 0.5, x: 1.0, pan2: 0.75 });
    ev('chat-burst', 48.9, 'chatter', { dur: 3.0, x: 0.75 });
    ev('counter', 48.95, 'pop', { x: 0.75, gain: 0.6 });
    ev('extract-row', 52.2, 'air', { dur: 0.7, x: 0.6 });
    ev('lore-plate', 52.85, 'ceramic', { x: 0.5 });
    ev('lore-tab', 53.25, 'ceramic', { x: 0.75, gain: 0.7 });
    ev('edge-on', 56.25, 'flick', { x: 0.5 });
    ev('four', 56.55, 'whoosh', { dur: 0.5, x: 0.5, gain: 0.6 });
    FOUR.forEach((c, i) => ev(`four-${i}`, 56.6 + i * 0.06, 'flick', { x: 0.2 + i * 0.2, gain: 0.5 }));
    ev('four-file', 59.3, 'whoosh', { dur: 0.5, x: 0.5, pan2: 0.5, gain: 0.5 });
    ev('now-in', 60.2, 'air', { dur: 0.8, x: 0.5 });
    for (let i = 0; i < 11; i++) ev(`cap-${i}`, 63.6 + i * 0.075, 'key', { x: 0.5, gain: 0.8 });
    ev('cap-enter', 64.6, 'click', { x: 0.5, gain: 0.7 });
    ev('answer-in', 64.85, 'whoosh', { dur: 0.5, x: 0.5, pan2: 0.6 });
    ev('ring', 66.2, 'draw', { dur: 0.6, x: 0.6 });
    ev('page-in', 68.2, 'air', { dur: 1.2, x: 0.5 });
    ev('moon-extract', 71.6, 'pop', { x: 0.5 });
    ev('moon-shutter', 72.05, 'shutter', { x: 0.5 });
    ev('window', 74.0, 'morph', { dur: 0.8, x: 0.5 });
    ev('planes', 79.0, 'morph', { dur: 0.7, x: 0.5 });

    ev('to-quiet', 81.9, 'tapeland', { x: 0.5, gain: 0.6 });
    ev('dock-in', 81.8, 'air', { dur: 1.0, x: 0.5 });
    ev('change-in', 85.2, 'flick', { x: 0.6 });
    ev('apply', 87.2, 'click', { x: 0.6, gain: 1.0 });
    ev('apply-ok', 87.4, 'chime', { x: 0.6 });
    ev('chip-lift', 89.2, 'pop', { x: 0.5 }); ev('to-recap', 89.9, 'air', { dur: 0.7, x: 0.5 }); ev('chip-land', 90.8, 'plate', { x: 0.5 }); ev('to-dock', 93.2, 'air', { dur: 0.7, x: 0.5 });
    
    ev('pause', 94.9, 'click', { x: 0.5 });
    
    ev('hush', 97.35, 'hush', { dur: 0.45 });
    ev('forget', 97.8, 'click', { x: 0.5, gain: 1.2 });
    ev('dialog', 97.95, 'plate', { x: 0.5 });
    ev('forget-yes', 99.2, 'click', { x: 0.5, gain: 1.0 });
    
    ev('zoom-dark', 101.6, 'riser', { dur: 0.6, gain: 0.6 });
    ev('codex-in', 102.2, 'drop', { gain: 0.6 });
    ev('dur', 104.0, 'impact', { x: 0.5, gain: 0.5 });
    for (let i = 0; i < 14; i++) ev(`clk-${i}`, 104.1 + i * 0.1, 'tick', { x: 0.5, gain: 0.3 });
    ev('swarm-air', 107.9, 'air', { dur: 2.6, x: 0.5 }); for (let i = 0; i < 10; i++) ev(`wh-${i}`, 108.1 + i * 0.22, 'whoosh', { dur: 0.35, x: (i * 0.37) % 1, pan2: 1 - (i * 0.37) % 1, gain: 0.3 });
    ev('tools', 110.4, 'thumpBig', { x: 0.5, gain: 0.7 });
    for (let i = 0; i < 16; i++) ev(`tc-${i}`, 110.5 + i * 0.09, 'tick', { x: 0.5, gain: 0.28 });
    ev('bug-0', 113.3, 'flick', { x: 0.5 }); ev('fixed-0', 115.0, 'stamp', { x: 0.75, gain: 1.1 });
    ev('bug-1', 116.4, 'flick', { x: 0.5 }); ev('fixed-1', 118.1, 'stamp', { x: 0.75, gain: 1.1 });
    ev('run', 119.5, 'thumpBig', { x: 0.5, gain: 0.7 }); for (let i = 0; i < 14; i++) ev(`run-${i}`, 119.6 + i * 0.08, 'tick', { x: 0.5, gain: 0.3 });
    ev('tests', 121.5, 'thumpBig', { x: 0.5, gain: 0.7 });
    for (let i = 0; i < 10; i++) ev(`tr-${i}`, 122.2 + i * 0.065, 'tick', { x: 0.5, gain: 0.35 });
    ev('cc-code', 123.35, 'air', { dur: 0.6, x: 0.5 });
    [0, 0.06, 0.12, 0.18, 0.24].forEach((d, i) => ev(`cc-${i}`, 123.85 + d, 'whoosh', { dur: 0.45, x: 0.5, pan2: i % 2 ? 0.9 : 0.1, gain: 0.55 }));
    [0, 0.06, 0.12, 0.18, 0.24].forEach((d, i) => ev(`ccl-${i}`, 124.3 + d, 'pop', { x: i % 2 ? 0.8 : 0.2, gain: 0.5, note: 2 + i }));
    ev('to-light', 125.3, 'riser', { dur: 0.75, gain: 0.7 });
    ev('url', 132.3, 'pop', { x: 0.5 });
    ev('gather-end', 133.15, 'riser', { dur: 0.85, gain: 0.8 });
    ev('logo-end', 134.0, 'impact', { x: 0.4, gain: 1.0 });
    ev('letters-end', 134.05, 'letters', { dur: 0.5, x: 0.5 });
    ev('url-end', 135.2, 'pop', { x: 0.5, gain: 0.6 });
  }

  // =====================================================================================
  function render(t, pending) {
    const show = (e, on) => { e.style.display = on ? '' : 'none'; return on; };
    root.style.display = t >= 23.9 ? '' : 'none';
    if (t < 23.9) return;
    for (const s of slots) s.render(t);
    window.__liveVisible = (t >= 59.9 && t < 64) || (t >= 68 && t < 82.3) || (t >= 81.7 && t < 102.3) || (t >= 126 && t < 133.5);

    // ---------- fields ----------
    const tint = { warm: 1, cool: 1, lime: (t > 48.6 && t < 52.4) ? 0.9 : 0 };
    renderFields(t, tint);
    const airyOn = (t >= 29.0 && t < 101.96) || t >= 125.95;
    show(airy, airyOn);
    show(dark, t >= 101.94 && t < 126.2);
    // P4 vermilion field shrinks into the "Example recording" tag of the player (mask reveal of the light field)
    const PL = { x: 370, y: 205, w: 1180 }; PL.vh = PL.w * 9 / 16; PL.h = 64 + PL.vh;
    const tagR = { x: PL.x + PL.w - 26 - 74 - 16 - 226, y: PL.y + 11, w: 226, h: 42, r: 9 };
    if (show(verm, t >= 23.9 && t < 29.95)) {
      const p = expoInOut(seg(t, 29.2, 29.95));
      const R = lerpR({ x: -20, y: -20, w: 1960, h: 1120, r: 0 }, tagR, p);
      Object.assign(verm.style, { width: R.w + 'px', height: R.h + 'px', borderRadius: R.r + 'px', transform: `translate(${R.x}px,${R.y}px)` });
    }
    // P8 -> P9: zoom through the dark dock
    // P9 -> P10: a light circle grows out of the last number
    if (show(paperCircle, t >= 125.45 && t < 126.25)) {
      const p = expoIn(seg(t, 125.45, 126.0)), r = lerp(0, 1300, p);
      Object.assign(paperCircle.style, { width: 2 * r + 'px', height: 2 * r + 'px', transform: `translate(${960 - r}px,${520 - r}px)` });
    }

    // ---------- P4 ----------
    if (show(p4, t >= 23.9 && t < 29.6)) {
      const lift = expoIn(seg(t, 28.9, 29.35));
      p4.style.transform = `translateY(${-120 * lift}px)`; p4.style.opacity = 1 - lift;
      const g = clamp(springAt(t - 26.45, 0.7, 12), 0, 1.1);
      noteWords.forEach((w, i) => { w.style.opacity = 0.22 + 0.78 * seg(t, 26.6 + i * 0.07, 26.8 + i * 0.07); });
      Object.assign(note.style, { transformOrigin: '50% 0', transform: `translate(${310}px,${620 + 30 * (1 - g)}px) scale(${0.96 + 0.04 * clamp(g)})`, opacity: t >= 26.4 ? clamp(g * 3) : 0 });
    }

    // ---------- the player (P5, P6) ----------
    const plOn = show(pl, t >= 29.2 && t < 60.4);
    if (plOn) {
      // camera on the player: centred, then aside for the chat, then back; a slow push throughout
      const K = keyed(t, [
        [29.2, { x: PL.x, y: PL.y, s: 1 }], [33.8, { x: PL.x, y: PL.y, s: 1 }], [34.4, { x: 90, y: 230, s: 0.92 }],
        [37.0, { x: 90, y: 230, s: 0.92 }], [37.6, { x: 90, y: 230, s: 0.92 }],
        [44.8, { x: 90, y: 230, s: 0.92 }], [45.5, { x: PL.x, y: PL.y, s: 1 }], [48.5, { x: PL.x, y: PL.y, s: 1 }], [49.1, { x: 90, y: 230, s: 0.92 }],
        [55.4, { x: 90, y: 230, s: 0.92 }], [56.0, { x: 90, y: 1200, s: 0.92 }],
      ]);
      const push = 1 + 0.025 * Math.sin(t * 0.35);
      Object.assign(frame.style, { width: PL.w + 'px', height: PL.h + 'px', transform: `translate(${K.x}px,${K.y}px) scale(${K.s * push})` });
      Object.assign(fview.style, { width: PL.w + 'px', height: PL.vh + 'px', transform: 'translate(0px,64px)' });
      bar.style.width = PL.w + 'px';
      exTag.style.transform = `scale(${t < 29.9 ? 0.7 : 1 + 0.12 * (1 - springAt(t - 29.85, 0.45, 16))})`;
      exTag.style.opacity = t >= 29.9 ? 1 : 0;
      // dim the context while the chapter or the joke is the focus
      const dim = Math.max(seg(t, 37.2, 37.7) * (1 - seg(t, 44.6, 45.2)), seg(t, 52.1, 52.6) * (1 - seg(t, 59.5, 60.0)));
      frame.style.filter = dim > 0.01 ? `blur(${6 * dim}px) brightness(${1 - 0.25 * dim})` : 'none';
      frame.style.opacity = 1 - 0.55 * dim;
      // footage
      let k = 'stream', ct = 4.3 + (t - 29.2);
      if (t >= 30.0) { k = 'run'; ct = 0.5 + (t - 30.0) * 0.7; }
      if (t >= 45.5) { k = 'moon'; ct = 0.4 + (t - 45.5); }
      if (t >= 52.0) { k = 'moon'; ct = 6.9; }
      for (const [n, v] of Object.entries(vids)) v.style.display = n === k ? '' : 'none';
      const pr = seekVideo(vids[k], Math.min(ct, 10.3)); if (pr) pending.push(pr);
      let ck = 5 + Math.floor(Math.max(0, t - 30.0) * 0.7);
      if (t >= 45.0) ck = Math.round(lerp(ck, 100, expoInOut(seg(t, 45.0, 45.6)))) + Math.max(0, Math.floor(t - 45.6));
      clock.textContent = fmtTime(Math.min(ck, 112));
      // transcript subtitle
      const sp = SPEECH.find(s => t >= s.t0 - 0.25 && t < s.t1 + (s.t0 > 40 ? 1.6 : 0.3)) || null;
      if (show(sub, !!sp && !(t > 33.95 && t < 34.0))) {
        subTab.textContent = sp.tab;
        subText.textContent = sp.text.slice(0, Math.floor(sp.text.length * clamp(seg(t, sp.t0, sp.t1))));
        const a = expoOut(seg(t, sp.t0 - 0.25, sp.t0));
        const by = K.y + (64 + PL.vh - 40) * K.s;
        sub.style.transform = `translate(${K.x + 40 * K.s}px,${by - 80 + 24 * (1 - a)}px)`;
        sub.style.opacity = a * (1 - seg(t, sp.t1 + (sp.t0 > 40 ? 1.4 : 0.15), sp.t1 + (sp.t0 > 40 ? 1.6 : 0.3)));
        sub.style.filter = frame.style.filter;
      }
      // the chat column: a list with the newest row lit (no piles)
      const chatOn = (t >= 33.9 && t < 37.9) || (t >= 48.6 && t < 55.9);
      if (show(chat, chatOn)) {
        const enter = t < 40 ? expoOut(seg(t, 33.9, 34.5)) : expoOut(seg(t, 48.6, 49.2));
        const leave = t < 40 ? expoIn(seg(t, 37.3, 37.85)) : expoIn(seg(t, 55.4, 55.85));
        chat.style.transform = `translate(${lerp(1960, 1270, enter) + 700 * leave}px,${230}px)`;
        const visible = chatMsgs.filter(m => t >= m.t && (t < 40 ? !m.burst : true));
        const n = visible.length;
        // scroll position: follows the newest message, smoothed by its own arrival spring
        let off = 0;
        visible.forEach((m, i) => { off += clamp(springAt(t - m.t, 0.8, 18), 0, 1.05); });
        const baseY = 760 - 20 - ROW;   // newest row sits at the bottom
        chatMsgs.forEach((m, i) => {
          const idx = visible.indexOf(m);
          if (!show(m.el, idx >= 0)) return;
          const y = baseY - (off - 1 - idx) * ROW;
          const lit = idx === n - 1 || (t >= 52.0 && i === moonIdx);
          m.el.style.transform = `translateY(${y}px)`;
          m.el.style.background = lit ? 'var(--lime)' : 'transparent';
          m.el.style.color = lit ? 'var(--ink)' : 'var(--paper)';
          m.el.style.opacity = y < 70 ? 0 : clamp(0.35 + 0.65 * (y / baseY));
        });
        chat.style.filter = (t > 37.2 && t < 40) ? `blur(${6 * seg(t, 37.2, 37.6)}px)` : 'none';
      }
      if (show(counter, t >= 48.95 && t < 52.4)) {
        cNum.textContent = String(Math.round(FACTS.moment.count * clamp(seg(t, 48.95, 51.9)) ** 0.9));
        const g = clamp(springAt(t - 48.95, 0.55, 14), 0, 1.15), out = expoIn(seg(t, 52.05, 52.4));
        counter.style.transform = `translate(${1270 + 280 - 260}px,${150}px) scale(${g * (1 - out)})`;
      }
    }

    // ---------- P5/P6: chapter card, hold, lore, four chapters, strip ----------
    if (show(p56, t >= 29.9 && t < 60.4)) {
      // the chapter card forms from the transcript and the lit chat row, centred and large
      const CC = { x: 960 - 520 * 1.38 / 2, y: 250, s: 1.38 };
      if (show(ch.el, t >= 37.55 && t < 45.4)) {
        const g = clamp(springAt(t - 37.55, 0.62, 12), 0, 1.12), drop = expoInOut(seg(t, 44.55, 45.25));
        const ttl = ch.el.querySelector('.ttl'); const full = 'Fox learns to jump';
        ttl.textContent = full.slice(0, Math.floor(full.length * seg(t, 38.0, 38.6)));
        ch.el.style.transformOrigin = '0 0';
        ch.el.style.transform = `translate(${lerp(CC.x, 120 + 14, drop)}px,${lerp(CC.y, 975, drop)}px) scale(${lerp(CC.s * (0.6 + 0.4 * g), 0.13, drop)})`;
        ch.el.style.opacity = clamp(g * 2);
        ch.el.style.filter = t > 40.3 && t < 43.7 ? 'saturate(.6)' : 'none';
      }
      // the hold: the card's lower edge pulls out into a bar that empties over 75 s (shown faster),
      // then contracts into a dot, the dot into a check: Published
      const barR = { x: CC.x, y: CC.y + 392 * 1.38 + 36, w: 520 * 1.38, h: 26 };
      if (show(holdBar, t >= 40.3 && t < 43.75)) {
        const grow = expoOut(seg(t, 40.3, 40.75)), shrink = expoInOut(seg(t, 43.25, 43.7));
        const p = seg(t, 40.6, 43.15);
        const w = barR.w * grow * (1 - shrink) + 26 * shrink;
        Object.assign(holdBar.style, { width: w + 'px', transform: `translate(${960 - w / 2}px,${barR.y}px)` });
        Object.assign(holdFill.style, { width: Math.max(26, w * (1 - p * (1 - shrink))) + 'px' });
        holdBar.style.background = shrink > 0.1 ? 'var(--verm)' : 'rgb(20 23 27 / .12)';
      }
      if (show(holdN, t >= 40.4 && t < 43.3)) {
        holdN.textContent = `${Math.ceil(75 * (1 - seg(t, 40.6, 43.15)))} s`;
        const a = expoOut(seg(t, 40.4, 40.7));
        holdN.style.transform = `translate(${CC.x + 718 + 50}px,${barR.y - 120 + 20 * (1 - a)}px)`; holdN.style.opacity = a * (1 - seg(t, 43.1, 43.3));
      }
      if (show(holdNote, t >= 40.6 && t < 43.2)) holdNote.style.transform = `translate(${CC.x + 718 + 56}px,${barR.y - 12}px)`;
      if (show(dot, t >= 43.6 && t < 44.65)) {
        const g = clamp(springAt(t - 43.6, 0.5, 14), 0, 1.2), d = 26 + 134 * g;
        const out = expoIn(seg(t, 44.45, 44.65));
        Object.assign(dot.style, { width: d + 'px', height: d + 'px', borderRadius: d / 2 + 'px', transform: `translate(${960 - 260 - d / 2}px,${barR.y + 13 - d / 2}px) scale(${1 - out})` });
      }
      if (show(check, t >= 43.75 && t < 44.65)) { check.style.transform = `translate(${960 - 260 - 100}px,${barR.y + 13 - 100}px) scale(${1 - expoIn(seg(t, 44.45, 44.65))})`; checkPath.setAttribute('stroke-dasharray', `${100 * expoOut(seg(t, 43.75, 44.05))} 100`); }
      if (show(pubWord, t >= 43.9 && t < 44.65)) { const a = wordIn(t, 43.95, 0.3); pubWord.style.transform = `translate(${960 - 150 + a.dx}px,${barR.y - 42}px) scale(${a.sc})`; pubWord.style.opacity = a.op * (1 - seg(t, 44.45, 44.65)); }
      // the timeline strip (bottom), tabs arrive as chapters publish
      if (show(strip, t >= 44.5 && t < 60.3)) {
        const g = expoOut(seg(t, 44.5, 44.95)), out = expoIn(seg(t, 58.8, 59.3));
        strip.style.transform = `translate(120px,${lerp(1120, 975, g) + 200 * out}px)`;
        const tTab = [45.1, 51.7, 54.1, 59.6, 59.7];
        TABS.forEach((d, i) => { if (show(d.el, t >= tTab[i])) d.el.style.transform = `translate(${d.x}px,0px) scaleX(${clamp(springAt(t - tTab[i], 0.55, 16), 0, 1.1)})`; });
      }
      // the "MOON JUMP" row is lifted out of the chat, grows, and becomes the running joke
      if (show(lore, t >= 52.2 && t < 55.75)) {
        const rowR = { x: 1270 + 20, y: 230 + 760 - 20 - ROW, w: 260, h: ROW - 10, r: 14 };
        const big = { x: 960 - 590, y: 330, w: 1180, h: 420, r: 40 };
        const p = expoInOut(seg(t, 52.25, 52.95)), out = expoInOut(seg(t, 55.15, 55.7));
        const tabR = { x: 120 + 770, y: 975 + 12, w: 170, h: 60, r: 14 };
        const R = out > 0 ? lerpR(big, tabR, out) : lerpR(rowR, big, p);
        Object.assign(lore.style, { width: R.w + 'px', height: R.h + 'px', borderRadius: R.r + 'px', transform: `translate(${R.x}px,${R.y}px)` });
        lore.style.background = p < 0.5 ? 'var(--lime)' : 'var(--verm)';
        loreIn.style.transform = `scale(${R.w / 1180})`; loreIn.style.transformOrigin = '0 0';
        loreIn.style.opacity = clamp((p - 0.45) * 3) * (1 - clamp(out * 3));
        loreTab.style.transform = `scale(${clamp(springAt(t - 53.2, 0.5, 16), 0, 1.2) * (1 - out)})`;
        lore.style.boxShadow = '0 10px 0 var(--verm-side), 0 60px 120px -40px rgb(60 20 0 / .5)';
      }
      // one chapter card turns edge-on and becomes the four chapters
      const fanOn = t >= 55.9 && t < 59.96;
      const fan = [{ x: 250, y: 170, r: -3 }, { x: 1000, y: 160, r: 2.5 }, { x: 280, y: 545, r: 2 }, { x: 1030, y: 535, r: -2.5 }];
      FOUR.forEach((c, i) => {
        if (!show(c.el, fanOn && (i === 0 || t >= 56.45))) return;
        c.el.style.transformOrigin = '0 0';
        if (t < 56.45) { // the first card rises from the strip and turns edge-on
          const up = expoOut(seg(t, 55.9, 56.25)), turn = expoIn(seg(t, 56.15, 56.45));
          const s = lerp(0.13, 1.25, up);
          c.el.style.transform = `perspective(1400px) translate(${lerp(134, 960 - 325, up)}px,${lerp(975, 300, up)}px) scale(${s}) rotateY(${88 * turn}deg)`;
          return;
        }
        const a = clamp(springAt(t - 56.45 - i * 0.05, 0.6, 11), 0, 1.08);
        const F = fan[i];
        const x = lerp(960 - 325, F.x, a), y = lerp(300, F.y, a);
        const bob = 6 * Math.sin((t - 56.5) * 2.1 + i * 1.7);       // secondary motion while held
        c.el.style.zIndex = 4 - i;
        if (i === 0) {   // match: this card lands on the same chapter in the live page
          // match cut: the card's clip frame lands exactly on the clip thumbnail of the same chapter in the live page
          const m = expoInOut(seg(t, 59.2, 59.85));
          const st = U('pubStory'), cl = U('pubStoryClip'), sA = 1300 / st.w;
          const thumb = { x: 960 + (cl.x - (st.x + st.w / 2)) * sA, y: 540 + (cl.y - (st.y + st.h / 2)) * sA, w: cl.w * sA };
          const sc = thumb.w / 480;                       // the card image is 480 wide at 20,20 inside the card
          const tgt = { x: thumb.x - 20 * sc, y: thumb.y - 20 * sc };
          const s0 = 1.18 * (0.85 + 0.1 * a);
          c.el.style.transform = `perspective(1400px) translate(${lerp(x, tgt.x, m)}px,${lerp(y + bob, tgt.y, m)}px) scale(${lerp(s0, sc, m)}) rotateY(${88 * (1 - clamp(a))}deg) rotate(${F.r * a * (1 - m)}deg)`;
          c.el.style.opacity = 1 - seg(t, 59.8, 60.05);
          return;
        }
        const go = expoIn(seg(t, 59.0 + i * 0.05, 59.45 + i * 0.05));   // the others leave in depth, outward
        const ox = (F.x - 640) * 2.4 * go, oy = (F.y - 350) * 2.4 * go;
        c.el.style.transform = `perspective(1400px) translate(${x + ox}px,${y + bob + oy}px) scale(${1.18 * (0.85 + 0.1 * a) * (1 + 0.8 * go)}) rotateY(${88 * (1 - clamp(a))}deg) rotate(${F.r * a}deg)`;
        c.el.style.filter = go > 0.02 ? `blur(${12 * go}px)` : 'none';
        c.el.style.opacity = 1 - seg(t, 59.3, 59.5 + i * 0.05);
      });
    }

    // ---------- P7: three ways in (live pages) ----------
    show(topFade, false);
    if (show(p7, t >= 59.5 && t < 82.3)) {
      show(fade7, false);
      // A: the real public recap page rises from below, then the camera pushes into its "Right now" card
      const nowR = U('pubNow');
      if (show(pub.box, (t >= 59.55 && t < 64.95) || (t >= 67.75 && t < 74.85) || (t >= 78.95 && t < 82.3))) {
        if (t < 65) {
          // the page opens around the matched chapter, the camera pulls back to the whole page, then pushes into "Right now";
          // when the viewer types, the page recedes in depth behind the command
          const story = U('pubStory');
          const camA = { cx: story.x + story.w / 2, cy: story.y + story.h / 2, s: 1300 / story.w };
          const camB = { cx: 720, cy: 520, s: 1.3 };
          const camC = { cx: nowR.x + nowR.w / 2, cy: nowR.y + nowR.h / 2 + 10, s: 1500 / nowR.w };
          const pull = cubicInOut(seg(t, 60.0, 61.0)), z = expoInOut(seg(t, 61.35, 62.15));
          const cam = { cx: lerp(lerp(camA.cx, camB.cx, pull), camC.cx, z), cy: lerp(lerp(camA.cy, camB.cy, pull), camC.cy, z), s: lerp(lerp(camA.s, camB.s, pull), camC.s, z) };
          const rec = expoInOut(seg(t, 63.0, 63.6)), gone = seg(t, 64.6, 64.95);
          const br = breathe(t, 0.6);
          pub.set(FULL, cam, `perspective(1800px) translateZ(${-260 * rec}px) rotateX(${br.rx * z}deg) rotateY(${br.ry * z}deg)`);
          pub.box.style.transformOrigin = '50% 50%';
          // the page reveals outward from the matched chapter (mask), not by a fade
          const open = expoOut(seg(t, 59.55, 60.15));
          const L0 = 960 - 650, T0 = 540 - 218, R0 = 1920 - (960 + 650), B0 = 1080 - (540 + 218);
          pub.box.style.clipPath = open < 1 ? `inset(${T0 * (1 - open)}px ${R0 * (1 - open)}px ${B0 * (1 - open)}px ${L0 * (1 - open)}px round ${28 * (1 - open)}px)` : 'none';
          pub.box.style.filter = rec > 0.01 ? `blur(${7 * rec}px) brightness(${1 - 0.25 * rec})` : 'none';
          pub.box.style.opacity = 1 - gone;
          show(fade7, true); fade7.style.opacity = clamp(open * 1.5) * (1 - rec);
        } else if (t < 75) {
          pub.box.style.clipPath = 'none';
          // C: the camera travels down the page, the moon jump chapter lifts out with its clip; then the page becomes the raid's stage
          const a = 1, win = expoInOut(seg(t, 74.0, 74.75));
          const H0 = 860, W0 = H0 * 592 / 679, k0 = W0 / 592, cr = { x: 960 - W0 / 2, y: 180 };
          const lk = { x: cr.x + 28 * k0, y: cr.y + 442 * k0, w: 357 * k0, h: 22 * k0 };
          const op = expoInOut(seg(t, 67.8, 68.45));
          pub.box.style.clipPath = op < 1 ? `inset(${lk.y * (1 - op)}px ${(1920 - lk.x - lk.w) * (1 - op)}px ${(1080 - lk.y - lk.h) * (1 - op)}px ${lk.x * (1 - op)}px round ${10 + 20 * (1 - op)}px)` : 'none';
          const story = U('pubStory'), moon = U('pubMoon');
          const K = keyed(t, [[67.8, { cx: 720, cy: 700, s: 1.6 }], [68.6, { cx: 720, cy: 640, s: 1.2 }], [69.6, { cx: 720, cy: 600, s: 1.3 }], [70.9, { cx: 720, cy: story.y + story.h / 2 + 80, s: 1.333 }], [71.5, { cx: 720, cy: moon.y + moon.h / 2, s: 1.45 }], [73.9, { cx: 720, cy: moon.y + moon.h / 2, s: 1.45 }], [74.75, { cx: 720, cy: 450, s: 1400 / 1440 }]]);
          const R = lerpR({ ...FULL, y: lerp(1080, 0, a) }, { x: 260, y: 200, w: 1400, h: 788, r: 40 }, win);
          const br = breathe(t, 0.5);
          pub.set(R, K, `perspective(2000px) rotateX(${br.rx}deg) rotateY(${br.ry}deg)`);
          pub.box.style.transformOrigin = '50% 50%';
          pub.box.style.transformOrigin = '50% 100%';
          const dim = seg(t, 71.5, 71.9) * (1 - seg(t, 73.4, 73.8));
          pub.box.style.filter = dim > 0.01 ? `blur(${6 * dim}px) brightness(${1 - 0.3 * dim})` : 'none';
          pub.box.style.opacity = 1 - seg(t, 74.55, 74.85);
          show(fade7, true); fade7.style.opacity = seg(t, 68.2, 68.6) * (1 - win);
          // element extraction: the chapter clone starts exactly on the page's chapter, lifts and grows
          if (show(moonV.box, t >= 71.5 && t < 73.9)) {
            const p0 = pub.map(moon.x, moon.y), w0 = moon.w * K.s;
            const g = expoInOut(seg(t, 71.5, 72.2)), back = expoInOut(seg(t, 73.3, 73.9));
            const e = g * (1 - back);
            const W = lerp(w0, 1560, e), H = W * 465 / 1341;
            moonV.set({ x: lerp(p0.x, 960 - 780, e), y: lerp(p0.y, 330, e), w: W, h: H, r: 22 }, { cx: 447, cy: 155, s: W / 894 });
            moonV.box.style.boxShadow = `0 ${40 * e}px ${100 * e}px -30px rgb(40 25 10 / ${0.6 * e})`;
            Object.assign(moonVid.style, { left: W * 0.6 + 'px', top: H * 0.13 + 'px', width: W * 0.355 + 'px', height: H * 0.6 + 'px', display: t >= 72.0 && t < 73.4 ? '' : 'none' });
            if (t >= 72.0) { const pr = seekVideo(moonVid, 2.6 + (t - 72.0)); if (pr) pending.push(pr); }
          }
        } else {
          pub.box.style.filter = 'none'; pub.box.style.opacity = 1;
        }
      } else show(moonV.box, false);
      // B: typed command in a capsule anchored at its left edge (no re-centring jitter)
      const typed = '!previously';
      if (show(cap, t >= 63.2 && t < 65.15)) {
        capText.textContent = typed.slice(0, Math.floor(typed.length * seg(t, 63.55, 64.4)));
        capCaret.style.opacity = t < 64.4 || Math.floor(t * 3) % 2 === 0 ? 1 : 0;
        const g = clamp(springAt(t - 63.2, 0.65, 14), 0, 1.08), pr = pressScale(t, 64.55), out = expoIn(seg(t, 64.8, 65.15));
        cap.style.transform = `translate(${960 - 420}px,${440 - 260 * out}px) scale(${g * pr * (1 - 0.5 * out)})`;
        cap.style.opacity = 1 - out;
      }
      // the real chat panel with the bot's answer, as a whole component: it rises, turns flat, the reply gets a drawn ring
      const chOn = (t >= 65.0 && t < 68.5);
      if (show(chatObj.box, chOn || (t >= 78.95 && t < 82.3))) {
        if (chOn) {
          const a = clamp(land(t, 65.0, 0.6, 10), 0, 1.06), out = expoIn(seg(t, 67.95, 68.45));
          const H = 860, W = H * 592 / 679;
          const R = { x: 960 - W / 2, y: lerp(1150, 180, a), w: W, h: H, r: 30 };
          const br = breathe(t, 0.8);
          chatObj.set(R, { cx: 296, cy: 339.5, s: W / 592 }, `perspective(1800px) rotateX(${20 * (1 - clamp(a)) + br.rx}deg) rotateY(${-10 * (1 - clamp(a)) + br.ry}deg) translateZ(${-300 * out}px)`);
          chatObj.box.style.filter = out > 0.01 ? `blur(${8 * out}px)` : 'none';
          chatObj.box.style.transformOrigin = '50% 100%';
          if (show(ring, t >= 66.3 && t < 68.1)) {
            const k = W / 592, p0 = { x: R.x + 3 * k, y: R.y + 274 * k }, p1 = { x: R.x + 589 * k, y: R.y + 486 * k };
            ringR.setAttribute('x', p0.x - 12); ringR.setAttribute('y', p0.y - 12); ringR.setAttribute('width', p1.x - p0.x + 24); ringR.setAttribute('height', p1.y - p0.y + 24);
            ringR.setAttribute('stroke-dasharray', `${1000 * expoOut(seg(t, 66.3, 66.95))} 1000`);
            ring.style.opacity = 1 - seg(t, 67.8, 68.1);
          }
        }
      }
      if (!(t >= 66.3 && t < 68.1)) show(ring, false);
      if (show(cur7, t >= 66.9 && t < 68.0)) {
        const H0 = 860, W0 = H0 * 592 / 679, k0 = W0 / 592, cr = { x: 960 - W0 / 2, y: 180 };
        const tgt = { x: cr.x + 220 * k0, y: cr.y + 456 * k0 };
        const p = expoOut(seg(t, 66.9, 67.5)), A0 = { x: 1500, y: 1120 };
        const c = bezier2(A0, { x: 1400, y: 700 }, tgt, p);
        const down = t >= 67.6 && t < 67.7;
        cur7.style.transform = `translate(${c.x - 8}px,${c.y - 4}px) scale(${(down ? 0.88 : 1) * 1.5})`;
      }
      if (!(t >= 71.5 && t < 73.9)) show(moonV.box, false);
      // D: the page window becomes the stage of the real raid scene
      if (show(sceneWin, t >= 74.5 && t < 82.3)) {
        const a = expoInOut(seg(t, 74.5, 75.2)), p3 = expoInOut(seg(t, 78.95, 79.7));
        const R0 = { x: 260, y: 200, w: 1400, h: 788, r: 40 }, R1 = { x: 160, y: 176, w: 1600, h: 900, r: 30 };
        let R = lerpR(R0, R1, a);
        if (t < 79) {
          Object.assign(sceneWin.style, { width: R.w + 'px', height: R.h + 'px', borderRadius: R.r + 'px', transform: `translate(${R.x}px,${R.y}px)`, transformOrigin: '50% 50%' });
          const s = Math.max(R.w / 1920, R.h / 1080);
          scene2.style.transform = `translate(${(R.w - 1920 * s) / 2}px,${(R.h - 1080 * s) / 2}px) scale(${s})`;
        }
        const w = scene2.contentWindow;
        if (w && w.__seek) { const SEG = [[74.5, 1.6, 1.1], [75.6, 16.3, 1.6], [77.2, 34.4, 1.1], [78.3, 42.7, 0.7], [79.0, 17.4, 0]]; let ms = 0; for (const [f0, s0, d] of SEG) if (t >= f0) ms = (s0 + Math.min(d, t - f0)) * 1000; pending.push(w.__seek(ms)); }
      }
      // E: one story feeds all three: three whole surfaces stand in depth, each at full composition
      if (t >= 78.95) {
        const p3 = expoOut(seg(t, 78.95, 79.8)), o3 = expoIn(seg(t, 81.75, 82.25));
        const W = 620, H = 620 * 10 / 16;
        const drift = 30 * Math.sin((t - 79) * 0.8);
        const slot = i => ({ x: 22 + i * 640 + drift * (i - 1), y: lerp(1150, 360, clamp(p3 * 1.4 - i * 0.15)) + 900 * o3, w: W, h: H, r: 24 });
        const tilt = i => `perspective(2000px) rotateY(${(1 - i) * 10}deg) translateZ(${i === 1 ? 40 : 0}px)`;
        const c0 = slot(0), ch2 = c0.h + 160, cw = ch2 * 592 / 679;
        chatObj.set({ x: c0.x + (W - cw) / 2, y: c0.y - 60, w: cw, h: ch2, r: 22 }, { cx: 296, cy: 339.5, s: cw / 592 }, tilt(0)); chatObj.box.style.transformOrigin = '50% 50%';
        pub.set(slot(1), { cx: 720, cy: 450, s: W / 1440 }, tilt(1)); pub.box.style.transformOrigin = '50% 50%'; pub.box.style.filter = 'none'; pub.box.style.opacity = 1;
        const R = slot(2);
        Object.assign(sceneWin.style, { width: R.w + 'px', height: R.h + 'px', borderRadius: '24px', transform: `translate(${R.x}px,${R.y}px) ${tilt(2)}`, transformOrigin: '50% 50%' });
        const s = Math.max(W / 1920, H / 1080); scene2.style.transform = `translate(${(W - 1920 * s) / 2}px,${(H - 1080 * s) / 2}px) scale(${s})`;
        if (show(thread, true)) {
          const ys = [0, 1, 2].map(i => slot(i).y + H + 14), xs = [0, 1, 2].map(i => slot(i).x + W / 2);
          threadP.setAttribute('d', `M${xs[0] - 260} ${ys[0]} C ${xs[0]} ${ys[0] + 60}, ${xs[1] - 200} ${ys[1] + 60}, ${xs[1]} ${ys[1]} S ${xs[2] - 200} ${ys[2] - 40}, ${xs[2] + 300} ${ys[2]}`);
          threadP.setAttribute('stroke-dasharray', `${100 * expoOut(seg(t, 79.55, 80.5))} 100`);
          threadDots.forEach((d, i) => { d.setAttribute('cx', xs[i]); d.setAttribute('cy', ys[i]); d.setAttribute('r', 12 * clamp(springAt(t - 79.75 - i * 0.22, 0.45, 18), 0, 1.4)); });
        }
        triLabels.forEach((e, i) => { if (show(e, true)) { e.style.transform = `translate(${slot(i).x - 20}px,${slot(i).y + H + (i === 0 ? 110 : 44)}px)`; e.style.opacity = seg(t, 79.5 + i * 0.1, 79.8 + i * 0.1) * (1 - o3); } });
      } else { triLabels.forEach(e => show(e, false)); show(thread, false); }
    }

    // ---------- P8: the streamer stays in charge (the real replay page and its dock) ----------
    if (show(p8, t >= 81.45 && t < 102.3)) {
      const ap = U('repApply'), chg = U('repChange'), cheat = U('repCheat'), dock = U('repDock'), pz = U('repPause'), fg = U('repForget'), dock2 = U('repDock2');
      const fsy = Math.max(0, Math.round(fg.y + 40 - 550)), dv = U('repDialogV'), yv = U('repYesV');
      const dlg = { ...dv, y: dv.y + fsy }, yes = { ...yv, x: yv.x - 34, y: yv.y + fsy };
      const dockTop = dock.y + 330;
      const D = keyed(t, [
        [81.45, { y: 1150, rx: 28, full: 0, cx: 720, cy: 560, s: 1600 / 1440 }],
        [82.35, { y: 190, rx: 0, full: 0, cx: 720, cy: 560, s: 1600 / 1440 }],
        [83.6, { y: 190, rx: 0, full: 1, cx: 720, cy: 560, s: 1.333 }],
        [84.7, { y: 190, rx: 0, full: 1, cx: 720, cy: 560, s: 1.333 }],
        [85.6, { y: 190, rx: 0, full: 1, cx: 720, cy: chg.y + chg.h / 2 - 40, s: 1.333 }],
        [86.3, { y: 190, rx: 0, full: 1, cx: 900, cy: chg.y + chg.h / 2 - 20, s: 1.75 }],
        [87.9, { y: 190, rx: 0, full: 1, cx: 900, cy: chg.y + chg.h / 2 - 20, s: 1.75 }],
        [88.5, { y: 190, rx: 0, full: 1, cx: 1060, cy: chg.y + chg.h - 60, s: 2.1 }],
        [89.8, { y: 190, rx: 0, full: 1, cx: 1060, cy: chg.y + chg.h - 60, s: 2.1 }],
        [90.6, { y: 190, rx: 0, full: 1, cx: cheat.x + cheat.w / 2, cy: cheat.y + 200, s: 1.55 }],
        [93.1, { y: 190, rx: 0, full: 1, cx: cheat.x + cheat.w / 2, cy: cheat.y + 215, s: 1.6 }],
        [93.9, { y: 190, rx: 0, full: 1, cx: 720, cy: dockTop, s: 1.9 }],
        [96.4, { y: 190, rx: 0, full: 1, cx: 720, cy: dockTop, s: 1.9 }],
        [96.9, { y: 190, rx: 0, full: 1, cx: fg.x + fg.w / 2, cy: fg.y + 40, s: 2.3 }],
        [97.85, { y: 190, rx: 0, full: 1, cx: fg.x + fg.w / 2, cy: fg.y + 40, s: 2.3 }],
        [98.35, { y: 190, rx: 0, full: 1, cx: dlg.x + dlg.w / 2, cy: dlg.y + dlg.h / 2 - 70, s: 1.8 }],
        [99.25, { y: 190, rx: 0, full: 1, cx: dlg.x + dlg.w / 2, cy: dlg.y + dlg.h / 2 - 70, s: 1.8 }],
        [99.8, { y: 190, rx: 0, full: 1, cx: 720, cy: dock2.y + 330, s: 1.9 }],
        [101.25, { y: 190, rx: 0, full: 1, cx: 720, cy: dock2.y + 330, s: 1.9 }],
      ]);
      const R = lerpR({ ...PLANE, y: D.y }, FULL, D.full);
      repl.freeze = t >= 97.75 && t < 99.5 ? fsy : null;
      repl.set(R, { cx: D.cx, cy: D.cy, s: D.s }, D.rx > 0.2 ? `perspective(1800px) rotateX(${D.rx}deg)` : '');
      repl.box.style.transformOrigin = '50% 100%';
      show(topFade, D.full > 0.5); topFade.style.opacity = clamp(D.full * 2 - 1);
      // cursor: travels to the real control, presses it; the click itself happens in the page at the same frame
      const at = r => repl.map(r.x + r.w / 2, r.y + r.h * 0.6);
      const path = [[86.3, null], [87.0, ap], [87.8, ap], [88.3, null], [94.1, null], [94.75, pz], [95.4, pz], [95.9, null], [96.9, null], [97.6, fg], [98.1, fg], [98.6, yes], [99.4, yes], [99.9, null]];
      let cp = null;
      for (let i = 0; i < path.length - 1; i++) {
        const [t0, a] = path[i], [t1, b] = path[i + 1];
        if (t >= t0 && t < t1 && (a || b)) { const A2 = a ? at(a) : { x: 1980, y: 1150 }, B2 = b ? at(b) : { x: 1980, y: 1150 }; cp = bezier2(A2, { x: (A2.x + B2.x) / 2 + 60, y: Math.min(A2.y, B2.y) - 80 }, B2, expoOut(seg(t, t0, t1))); }
      }
      if (show(cur, !!cp)) { const down = [87.2, 94.9, 97.8, 99.2].some(tp => t >= tp && t < tp + 0.1); cur.style.transform = `translate(${cp.x - 8}px,${cp.y - 4}px) scale(${(down ? 0.88 : 1) * 1.5})`; }
      const rp = [[87.2, ap], [94.9, pz], [97.8, fg], [99.2, yes]].find(([tp]) => t >= tp && t < tp + 0.45);
      if (show(ripple, !!rp)) { const c = at(rp[1]), q2 = seg(t, rp[0], rp[0] + 0.45), r = 20 + 90 * expoOut(q2); Object.assign(ripple.style, { width: 2 * r + 'px', height: 2 * r + 'px', transform: `translate(${c.x - r}px,${c.y - r}px)`, opacity: 1 - q2 }); }
      // carry the object: the corrected chapter leaves the confirmation, rides with the camera and lands on its card in the recap
      if (show(chip, t >= 89.2 && t < 90.95)) {
        const lift = clamp(land(t, 89.2, 0.6, 12), 0, 1.08), drop = expoIn(seg(t, 90.45, 90.85));
        const w = chip.offsetWidth;
        const tgtY = 540 + (52 - 200) * 1.55;
        const y = lerp(lerp(700, 470, lift), tgtY - 40, drop), sc = lerp(lerp(0.6, 1.05, clamp(lift)), 0.62, drop);
        const sway = 4 * Math.sin((t - 89.2) * 5) * (1 - drop);
        chip.style.transform = `translate(${960 - w / 2}px,${y}px) scale(${sc}) rotate(${sway * 0.4}deg)`;
        chip.style.opacity = 1 - seg(t, 90.8, 90.95);
      }
      if (show(landRing, t >= 90.8 && t < 91.35)) {
        const q2 = seg(t, 90.8, 91.35), c0 = repl.map(cheat.x, cheat.y), c1 = repl.map(cheat.x + cheat.w, cheat.y + cheat.h), g = 12 + 40 * expoOut(q2);
        Object.assign(landRing.style, { width: c1.x - c0.x + 2 * g + 'px', height: c1.y - c0.y + 2 * g + 'px', borderRadius: 24 + g + 'px', transform: `translate(${c0.x - g}px,${c0.y - g}px)`, opacity: 1 - q2 });
      }
      // zoom through the dark dock into the Codex passage
      if (show(zoomDark, t >= 101.3 && t < 102.3)) { const c = { x: 960, y: 640 }, r = 1500 * expoInOut(seg(t, 101.3, 101.95)); Object.assign(zoomDark.style, { width: 2 * r + 'px', height: 2 * r + 'px', borderRadius: '50%', transform: `translate(${c.x - r}px,${c.y - r}px)`, opacity: 1 }); }
    } else show(zoomDark, false);

    // ---------- P9: Codex, one fact at a time ----------
    if (show(p9, t >= 101.7 && t < 126.2)) {
      if (show(durO.box, t >= 104.0 && t < 108.0)) {
        const g = clamp(springAt(t - 104.0, 0.6, 12), 0, 1.08), out = expoIn(seg(t, 107.6, 108.0));
        const m = 574 * cubicInOut(seg(t, 104.1, 105.6)), hh = m / 60, mm = m % 60;
        const str = `${Math.floor(hh)}h${String(Math.floor(mm)).padStart(2, '0')}min`;
        durO.set(str, { 0: odoVal(m, 60, false), 2: odoVal(mm, 10, false), 3: odoVal(mm, 1, true) });
        durO.box.style.transform = `translate(0px,${460 - 160 * out}px) scale(${0.92 + 0.08 * g})`; durO.box.style.opacity = clamp(g * 2) * (1 - out);
        durL.style.transform = `translate(0px,${720 - 160 * out}px)`; durL.style.opacity = seg(t, 104.4, 104.8) * (1 - out); show(durL, true);
      } else show(durL, false);
      // the 27 workers fly through real 3D space around the camera, near ones large and sharp, far ones small and soft
      const swOn = t >= 107.9 && t < 110.4;
      if (show(space, swOn)) {
        const a = expoOut(seg(t, 107.9, 108.9)), out = expoIn(seg(t, 109.7, 110.35));
        const travel = (t - 107.9) * 560 + 2200 * out;
        swarm.forEach((w, i) => {
          let z = ((w.z0 * 3400 + travel) % 3400) - 2800;     // -2800 (far) .. 600 (passing the camera)
          const ang = w.ang + (t - 107.9) * w.spin;
          const x = Math.cos(ang) * w.rad * (0.55 + 0.45 * a), y = w.y0 * 0.7 + Math.sin(ang) * w.rad * 0.35;
          w.e.style.transform = `translate3d(${960 + x - 160}px,${560 + y}px,${z}px) rotateY(${-x / 60}deg)`;
          const dfocus = Math.abs(z + 600) / 900;
          w.e.style.filter = `blur(${Math.min(8, dfocus * 3).toFixed(1)}px)`;
          w.e.style.opacity = clamp((z + 2800) / 700) * clamp((600 - z) / 250) * a * (1 - out);
        });
      }
      if (show(toolO.box, t >= 110.7 && t < 113.15)) {
        const g = clamp(springAt(t - 110.7, 0.6, 12), 0, 1.08), out = expoIn(seg(t, 112.8, 113.15));
        const v = 4798 * cubicInOut(seg(t, 110.7, 112.0));
        const n = Math.floor(v), str = n >= 1000 ? `${Math.floor(n / 1000)},${String(n % 1000).padStart(3, '0')}` : String(n);
        const f = {}; let place = 1;
        for (let i = str.length - 1; i >= 0; i--) { if (str[i] === ',') continue; f[i] = odoVal(v, place, place === 1); place *= 10; }
        toolO.set(str, f);
        toolO.box.style.transform = `translate(0px,${330 - 120 * out}px) scale(${0.92 + 0.08 * g})`; toolO.box.style.opacity = clamp(g * 2) * (1 - out);
        show(toolL, true); toolL.style.transform = `translate(0px,${620 - 120 * out}px)`; toolL.style.opacity = seg(t, 110.8, 111.2) * (1 - out);
      } else show(toolL, false);
      bugCards.forEach((b, i) => {
        const t0 = 113.3 + i * 3.1;
        if (!show(b.c, t >= t0 && t < t0 + 3.15)) return;
        const a = clamp(land(t, t0, 0.6, 9), 0, 1.06), out = expoIn(seg(t, t0 + 2.8, t0 + 3.15));
        const hit = t >= t0 + 1.7 ? Math.exp(-(t - t0 - 1.7) * 9) * Math.cos((t - t0 - 1.7) * 38) : 0;
        b.c.style.transform = `perspective(1800px) translate3d(${100 - 1700 * out}px,${300 + 14 * hit}px,${-900 * (1 - clamp(a))}px) rotateX(${8 * (1 - clamp(a))}deg) rotateY(${-14 * (1 - clamp(a)) + 0.8 * Math.sin((t - t0) * 1.3)}deg) scale(${1 + 0.02 * seg(t, t0 + 0.5, t0 + 2.8) - 0.015 * hit},${1 + 0.02 * seg(t, t0 + 0.5, t0 + 2.8) + 0.01 * hit})`;
        b.c.style.boxShadow = `0 10px 0 var(--paper-side), 0 ${60 - 30 * Math.abs(hit)}px ${120 - 50 * Math.abs(hit)}px -40px rgb(0 0 0 / .85)`;
        const s = 1.9 - 0.9 * expoOut(seg(t, t0 + 1.7, t0 + 1.82));
        b.st.style.transform = `rotate(-7deg) scale(${t >= t0 + 1.7 ? s : 0})`;
      });
      show(q, false); show(ans, false);
      // the long load run, as a fact
      if (show(runO.box, t >= 119.5 && t < 121.55)) {
        const g = clamp(springAt(t - 119.5, 0.6, 12), 0, 1.08), out = expoIn(seg(t, 121.2, 121.55));
        const v = 280780 * cubicInOut(seg(t, 119.55, 120.7)), n = Math.floor(v);
        const str = n >= 1000 ? `${Math.floor(n / 1000)},${String(n % 1000).padStart(3, '0')}` : String(n);
        const f = {}; let place = 1;
        for (let i = str.length - 1; i >= 0; i--) { if (str[i] === ',') continue; f[i] = odoVal(v, place, place === 1); place *= 10; }
        runO.set(str, f);
        runO.box.style.transform = `translate(0px,${330 - 140 * out}px) scale(${0.92 + 0.08 * g})`; runO.box.style.opacity = clamp(g * 2) * (1 - out);
        show(runL, true); runL.style.transform = `translate(0px,${620 - 140 * out}px)`; runL.style.opacity = seg(t, 119.8, 120.2) * (1 - out);
      } else show(runL, false);
      if (show(testO.box, t >= 121.5 && t < 123.45)) {
        const g = clamp(springAt(t - 121.5, 0.6, 12), 0, 1.08), out = expoIn(seg(t, 123.1, 123.45));
        const v = lerp(609, 656, cubicInOut(seg(t, 122.2, 122.85)));
        testO.set(String(Math.floor(v)), { 0: odoVal(v, 100, false), 1: odoVal(v, 10, false), 2: odoVal(v, 1, true) });
        testO.box.style.transform = `translate(0px,${320 - 140 * out}px) scale(${0.92 + 0.08 * g})`; testO.box.style.opacity = clamp(g * 2) * (1 - out);
        show(testL, true); testL.textContent = t < 122.2 ? 'tests passed when the Codex session ended' : 'tests pass today, across 73 files';
        testL.style.transform = `translate(0px,${640 - 140 * out}px)`; testL.style.opacity = clamp(g * 2) * (1 - seg(t, 122.05, 122.2) + seg(t, 122.2, 122.35)) * (1 - out);
      } else show(testL, false);
      // and polished in Claude Code: the code panel rises, the work products leave it in depth to both sides
      const ccOn = t >= 123.3 && t < 126.1;
      if (show(stage3, ccOn)) {
        const up = clamp(springAt(t - 123.35, 0.62, 11), 0, 1.06);
        const cw = 640;
        code.style.transform = `translate3d(${960 - cw / 2}px,${lerp(900, 470, up)}px,${lerp(-300, 0, clamp(up))}px) rotateX(${12 * (1 - clamp(up)) + 2 * Math.sin(t * 0.9)}deg)`;
        products.forEach(o => {
          const t0 = 123.85 + o.d;
          const a = clamp(springAt(t - t0, 0.58, 9), 0, 1.08), vis = t >= t0;
          const sx = 960 - o.w / 2, sy = 580;
          const fx = o.x - o.w / 2, fy = o.y - 150;
          const x = lerp(sx, fx, a), y = lerp(sy, fy, a) - 60 * Math.sin(Math.PI * clamp(a));     // an arc out of the code
          const z = lerp(-500, o.z, clamp(a));
          const bob = 8 * Math.sin((t - t0) * 2.2 + o.d * 9);
          o.e.style.transform = `translate3d(${x}px,${y + bob}px,${z}px) rotateY(${o.ry * clamp(a) + 4 * Math.sin(t * 0.8 + o.d * 5)}deg) rotateX(${6 * Math.sin(t * 0.6 + o.d * 3)}deg) scale(${lerp(0.3, 1, clamp(a))})`;
          o.e.style.opacity = vis ? clamp(a * 2.5) : 0;
          o.e.style.filter = Math.abs(o.z) > 100 ? `blur(${(o.z < 0 ? 1.6 : 0.6) * clamp(a)}px)` : 'none';
        });
      }
    }

    // ---------- P10: the real setup page, the real replay, then the mark ----------
    if (show(p10, t >= 125.6)) {
      show(fade10, t >= 126.0 && t < 133.5);
      if (show(setupL.box, t >= 126.0 && t < 131.95)) {
        const a = expoOut(seg(t, 126.0, 127.0)), out = expoIn(seg(t, 131.5, 131.95));
        const R = { ...PLANE, y: lerp(1100, 200, a) };
        const K = { cx: 720, cy: 450, s: 1600 / 1440 };
        setupL.set({ ...R, y: R.y - 1150 * out }, K, a < 0.999 ? `perspective(1800px) rotateX(${24 * (1 - a)}deg)` : '');
        setupL.box.style.transformOrigin = '50% 100%';
      }
      if (show(rep0.box, t >= 131.75 && t < 133.45)) {
        const a = expoOut(seg(t, 131.75, 132.5)), out = expoInOut(seg(t, 133.0, 133.45));
        rep0.set({ ...PLANE, y: lerp(1100, 200, a) + 1100 * out }, { cx: 720, cy: 450, s: 1600 / 1440 }, a < 0.999 ? `perspective(1800px) rotateX(${22 * (1 - a)}deg)` : '');
        rep0.box.style.transformOrigin = '50% 100%';
      }
      if (show(url, t >= 132.25 && t < 133.4)) { const g = clamp(springAt(t - 132.25, 0.55, 14), 0, 1.15), out = expoIn(seg(t, 133.05, 133.4)); const w = url.offsetWidth; url.style.transform = `translate(${960 - w / 2}px,${900}px) scale(${g * (1 - out)})`; }
      const k = 2.6, x0 = Math.round((1920 - 440 * k) / 2), y0 = 300;
      const tc = { x: x0 + 55 * k, y: y0 + 53 * k };
      endTabs.forEach((e, i) => {
        if (!show(e, t >= 133.0 && t < 134.05)) return;
        const g = expoIn(seg(t, 133.0 + i * 0.04, 134.0)), ang = i * Math.PI / 2 + 0.7 + g * 2.2, r = lerp(760, 0, g);
        e.style.transform = `translate(${tc.x + Math.cos(ang) * r * 1.25 - 70}px,${tc.y + Math.sin(ang) * r * 0.6 - 40}px) scale(${1.3 - 1.0 * g}) rotate(${(1 - g) * 25}deg)`;
        hblur(e, g * 20);
      });
      if (show(endMark.box, t >= 133.92)) {
        const hit = t >= 134 ? 1 + 0.1 * Math.exp(-(t - 134) * 8) : 1;
        placeMark(endMark, x0, y0, 96 * k, { sx: hit, sy: 2 - hit, back: clamp(seg(t, 133.92, 134.2)), sheen: 0.7 * Math.sin(Math.PI * seg(t, 134.15, 135.8)) + 0.6 * Math.sin(Math.PI * seg(t, 136.0, 137.8)) });
      }
      if (show(endWord, t >= 134.0)) { const a = expoOut(seg(t, 134.0, 134.55)); Object.assign(endWord.style, { width: 300 * k + 'px', transform: `translate(${x0 + 109 * k - 80 * (1 - a)}px,${y0}px)`, clipPath: `inset(0 ${100 - 100 * a}% 0 0)` }); }
      if (show(endTag, t >= 134.5)) { const a = wordIn(t, 134.6, 0.4); endTag.style.opacity = a.op; endTag.style.transform = `translate(0px,${630 + 24 * (1 - a.e)}px)`; endTag.style.filter = a.blur > 0.4 ? `blur(${a.blur}px)` : 'none'; }
      if (show(endUrl, t >= 135.1)) { const g = clamp(springAt(t - 135.15, 0.55, 14), 0, 1.12); const w = endUrl.offsetWidth; endUrl.style.transform = `translate(${960 - w / 2}px,${760}px) scale(${g})`; }
    }
  }
  return { setup, render };
}

