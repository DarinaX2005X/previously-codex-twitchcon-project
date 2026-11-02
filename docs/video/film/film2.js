// Passages 4-10 of the Previously film (24 s to the end). Pure functions of film time t.
// Draft 2 staging: the product object owns the frame, type performs at display scale, every passage has its own colour world.
import { clamp, seg, lerp, expoOut, expoIn, expoInOut, cubicInOut, springAt, el, svgEl, fmtTime, bezier2 } from './lib.js';
import { makeMark, placeMark } from './mark.js';
import { Slot, card, slip, cursor, button, pressScale, wordIn, hblur } from './kit.js';
import { FACTS, CODEX } from './content.js';

export const END = 138.0;
const A = '/docs/video/film/assets/ui/';

/** An image seen through a window with its own camera: (cx, cy) in image CSS px is put at the window centre, scaled by s. */
function view(parent, src, cssW, { radius = 26, shadow = true } = {}) {
  const box = el('div', 'abs', parent);
  Object.assign(box.style, { overflow: 'hidden', borderRadius: radius + 'px' });
  if (shadow) box.style.boxShadow = '0 50px 110px -40px rgb(0 0 0 / .75)';
  const img = el('img', '', box); img.src = src; Object.assign(img.style, { position: 'absolute', left: '0px', top: '0px', width: cssW + 'px', transformOrigin: '0 0' });
  return {
    box, img,
    set(r, cam, extra = '') {
      Object.assign(box.style, { width: r.w + 'px', height: r.h + 'px', transform: `translate(${r.x}px,${r.y}px) ${extra}`, borderRadius: (r.r ?? radius) + 'px' });
      img.style.transform = `translate(${r.w / 2 - cam.cx * cam.s}px,${r.h / 2 - cam.cy * cam.s}px) scale(${cam.s})`;
    },
  };
}
const keyed = (t, keys) => { // keyframes [[t, {..}], ...] with expo in-out between them
  let D = { ...keys[0][1] };
  for (let i = 0; i < keys.length - 1; i++) { const [t0, a] = keys[i], [t1, b] = keys[i + 1]; if (t >= t0) { const e = expoInOut(seg(t, t0, t1)); D = {}; for (const k of Object.keys(a)) D[k] = lerp(a[k], b[k] ?? a[k], e); } }
  return D;
};

export function createFilm2(stage, { ev, seekVideo, FPS }) {
  const root = el('div', 'layer', stage);
  const L = name => { const d = el('div', 'layer', root); d.dataset.name = name; return d; };
  let RECTS = null;
  const slots = [];
  const S = (parent, o, ph) => { const s = new Slot(parent, o, ph); slots.push(s); return s; };

  // ================= world fields (colour per passage) =================
  const fields = L('fields');
  const fieldA = el('div', 'layer', fields), fieldB = el('div', 'abs', fields);

  // ================= full-frame footage world (P5, P6) =================
  const foot = L('footage');
  const vids = {};
  for (const k of ['stream', 'run', 'moon', 'fixed', 'lanterns']) {
    const v = el('video', '', foot); Object.assign(v, { src: k === 'stream' ? '/demo/foxlight/stream-full.mp4' : `/demo/foxlight/clip-${k}.mp4`, muted: true, preload: 'auto' });
    Object.assign(v.style, { position: 'absolute', left: '0px', top: '0px', width: '1920px', height: '1080px', objectFit: 'cover', display: 'none', transformOrigin: '50% 50%' });
    vids[k] = v;
  }
  const shade = el('div', 'layer', foot); shade.style.background = 'linear-gradient(180deg, rgb(12 14 17 / .55) 0%, rgb(12 14 17 / .05) 30%, rgb(12 14 17 / .1) 62%, rgb(12 14 17 / .75) 100%)';
  const bar = el('div', 'abs', foot);
  Object.assign(bar.style, { height: '60px', width: '1920px', background: 'var(--paper)', display: 'flex', alignItems: 'center', gap: '18px', padding: '0 40px', color: 'var(--ink)', fontSize: '26px', whiteSpace: 'nowrap' });
  const live = el('i', '', bar); Object.assign(live.style, { width: '14px', height: '14px', borderRadius: '7px', background: '#3c9a2e' });
  el('b', '', bar, 'Foxlight Dev').style.fontWeight = 750;
  el('span', '', bar, 'Building a tiny cave platformer').style.color = 'var(--muted-paper)';
  const exTag = el('span', '', bar, 'Example recording');
  Object.assign(exTag.style, { marginLeft: 'auto', background: 'var(--verm)', color: 'var(--ink)', fontWeight: 750, fontSize: '22px', padding: '6px 14px', borderRadius: '9px', transformOrigin: '50% 50%' });
  const clock = el('span', 'tab', bar, '0:05'); Object.assign(clock.style, { fontWeight: 800, fontSize: '30px', minWidth: '78px', textAlign: 'right' });

  // ================= P4: honest frame on the vermilion field (24-30) =================
  const p4 = L('p4');
  const p4a = S(p4, { x: 100, y: 200, size: 128, color: 'var(--ink)', width: 1720, align: 'center', stagger: 0.12 }, [
    { t0: 24.15, t1: 28.85, text: ['What', 'you', 'see', 'next', 'is', 'the', { text: 'real app', emph: 'plate-ink' }], times: [24.15, 24.27, 24.37, 24.47, 24.62, 24.72, 24.86] },
  ]);
  const p4b = S(p4, { x: 100, y: 380, size: 128, color: 'var(--ink)', width: 1720, align: 'center', stagger: 0.12 }, [
    { t0: 25.35, t1: 28.9, text: ['replaying', 'an', { text: 'example recording', emph: 'under' }], times: [25.35, 25.6, 25.75] },
  ]);
  const p4note = el('div', 'abs', p4);
  Object.assign(p4note.style, { width: '1500px', padding: '34px 48px', borderRadius: '26px', background: 'var(--paper)', boxShadow: '0 7px 0 var(--paper-side), 0 40px 70px -30px rgb(60 10 0 / .6)', color: 'var(--ink)', fontSize: '60px', fontWeight: 700, letterSpacing: '-.02em', lineHeight: 1.16, overflow: 'hidden' });
  const NOTE = 'We made the game for this example. The speech, chat and raid in it are written as an example too.';
  const noteWords = NOTE.split(' ').map(w => el('span', '', p4note, w + ' '));

  // ================= P5 / P6: the story engine over full-frame footage =================
  const p5 = L('p5');
  const big5 = S(p5, { x: 100, y: 150, size: 190, width: 1720, stagger: 0.1 }, [
    { t0: 30.35, t1: 32.45, text: ['It', { text: 'listens', emph: 'verm' }] },
    { t0: 32.7, t1: 34.95, text: ['and', 'reads', 'the', { text: 'chat', emph: 'plate-lime' }] },
  ]);
  const flank = S(p5, { x: 90, y: 330, size: 150, width: 880, stagger: 0.1 }, [
    { t0: 35.25, t1: 37.45, text: ['It', 'writes', 'a'] },
  ]);
  const flank2 = S(p5, { x: 90, y: 520, size: 150, width: 880, stagger: 0.1 }, [
    { t0: 35.5, t1: 37.45, text: [{ text: 'chapter', emph: 'outline' }] },
  ]);
  const holdLine = S(p5, { x: 90, y: 690, size: 76, width: 900, stagger: 0.08 }, [
    { t0: 37.95, t1: 40.6, text: ['seconds', 'before', 'anyone', 'sees', 'it'] },
  ]);
  const quoteLine = S(p5, { x: 100, y: 770, size: 96, width: 1720, align: 'center', stagger: 0.09 }, [
    { t0: 42.85, t1: 45.2, text: ['“Okay,', 'let', 'me', 'try', 'the', { text: 'spring.”', emph: 'verm' }] },
  ]);
  const transcript = el('div', 'abs', p5);
  Object.assign(transcript.style, { width: '1720px', padding: '22px 34px 26px', borderRadius: '22px', background: 'rgb(20 23 27 / .88)', color: 'var(--paper)', fontSize: '54px', fontWeight: 650, lineHeight: 1.2, letterSpacing: '-.015em', boxShadow: '0 30px 60px -20px rgb(0 0 0 / .7)', transformOrigin: '0 0' });
  const trTab = el('span', 'tab', transcript, '0:05'); Object.assign(trTab.style, { display: 'inline-block', background: 'var(--paper)', color: 'var(--ink)', borderRadius: '9px', padding: '0 12px', fontSize: '36px', marginRight: '18px', fontWeight: 800, verticalAlign: '6px' });
  const trText = el('span', '', transcript);
  const trCaret = el('span', '', transcript, '|'); Object.assign(trCaret.style, { color: 'var(--verm)', fontWeight: 400 });
  const SPEECH1 = { t0: 30.5, t1: 33.3, text: 'Today I am building a tiny cave platformer. The fox can run and jump, and the goal tonight is to make the lanterns light up the cave.' };
  const early = ['hello, the fox is cute', 'what engine is this', 'love the lantern idea', 'a spring pad, nice'].map((m, i) => { const s = slip(p5, m); s.style.fontSize = '50px'; s.style.padding = '14px 26px'; return { el: s, t: 32.95 + i * 0.3, y: 330 + i * 120, x: 1060 + (i % 2) * 90 }; });
  const card5 = card(p5, { tc: '0:05', title: 'Fox learns to jump', img: '/demo/foxlight/clip-run.jpg' });
  const C5 = { x: 1010, y: 260, s: 1.62 };   // 520x392 card at 1.62 = 842x635
  const holdN = el('div', 'abs tab', p5); Object.assign(holdN.style, { color: 'var(--verm)', fontWeight: 800, fontSize: '330px', letterSpacing: '-.05em', lineHeight: 1 });
  const holdNote = el('div', 'abs', p5, 'counted faster here'); Object.assign(holdNote.style, { color: 'var(--muted-ink)', fontSize: '30px', fontWeight: 650 });
  const ring = svgEl('svg', p5, { width: 1000, height: 800, style: 'position:absolute;left:0;top:0;overflow:visible' });
  const ringR = svgEl('rect', ring, { x: 0, y: 0, width: 880, height: 672, rx: 44, fill: 'none', stroke: '#FF5A36', 'stroke-width': 12, 'stroke-linecap': 'round', pathLength: 1000 });
  const stamp = el('div', 'abs', p5, 'Published'); Object.assign(stamp.style, { border: '10px solid var(--verm)', color: 'var(--verm)', fontWeight: 800, fontSize: '130px', padding: '0 40px', borderRadius: '26px', background: 'rgb(244 239 230 / .94)', transformOrigin: '50% 50%' });
  // the timeline strip along the bottom: the anchor of the middle of the film
  const strip = el('div', 'abs', p5);
  Object.assign(strip.style, { width: '1760px', height: '92px', borderRadius: '24px', background: 'rgb(20 23 27 / .92)', boxShadow: '0 0 0 2px var(--ink-edge), 0 30px 60px -20px rgb(0 0 0 / .8)' });
  const TABS = [
    { tc: '0:05', title: 'Fox learns to jump', x: 16, t: 41.0 }, { tc: '1:40', title: 'The moon jump', x: 470, t: 51.7 },
    { tc: '2:05', title: 'moon jump', x: 830, t: 52.0, lore: true }, { tc: '3:30', title: 'Spring gets a speed limit', x: 1080, t: 53.25 },
    { tc: '5:20', title: 'Lanterns', x: 1520, t: 54.5 },
  ].map(d => { const e = el('div', 'abs', strip); Object.assign(e.style, { top: '14px', height: '64px', lineHeight: '64px', padding: '0 20px', borderRadius: '14px', background: d.lore ? 'var(--verm)' : 'var(--paper)', color: 'var(--ink)', fontWeight: 750, fontSize: '30px', whiteSpace: 'nowrap', transformOrigin: '0 50%' }); e.innerHTML = `<span class="tab" style="font-weight:800;margin-right:12px">${d.tc}</span>${d.title}`; return { ...d, el: e }; });
  const tileS = makeMark(p5);
  const tileRip = el('div', 'ripple', p5);
  const bigClock = el('div', 'abs tab', p5); Object.assign(bigClock.style, { color: 'var(--paper)', fontWeight: 800, fontSize: '300px', letterSpacing: '-.05em', lineHeight: 1, textShadow: '0 20px 60px rgb(0 0 0 / .5)' });

  // P6: the chat burst on the lime field, the lore plate, later chapters
  const p6 = L('p6');
  const big6 = S(p6, { x: 100, y: 110, size: 170, width: 1720, color: 'var(--ink)', stagger: 0.1 }, [
    { t0: 45.75, t1: 49.3, text: ['Chat', 'calls', 'it'] },
  ]);
  const burst = FACTS.moment.messages.map((m, i) => { const s = slip(p6, m); s.style.fontSize = (i % 3 === 0 ? 62 : 48) + 'px'; s.style.padding = '14px 26px'; s.style.background = 'var(--ink)'; s.style.boxShadow = '0 6px 0 #07080a, 0 30px 50px -20px rgb(40 60 0 / .5)'; return { el: s, i }; });
  const counter = el('div', 'abs', p6); Object.assign(counter.style, { color: 'var(--ink)', fontWeight: 800, lineHeight: 0.9, textAlign: 'left' });
  const cNum = el('div', 'tab', counter); Object.assign(cNum.style, { fontSize: '420px', letterSpacing: '-.06em' });
  const cLab = el('div', '', counter, 'messages in 10 seconds'); Object.assign(cLab.style, { fontSize: '64px', letterSpacing: '-.02em', marginTop: '6px' });
  const lore = el('div', 'abs', p6); Object.assign(lore.style, { background: 'var(--verm)', color: 'var(--ink)', borderRadius: '40px', padding: '40px 64px 54px', boxShadow: '0 12px 0 var(--verm-side), 0 60px 120px -40px rgb(0 0 0 / .9)', width: '1400px', transformOrigin: '50% 50%' });
  const loreT = el('div', '', lore, FACTS.lore.term); Object.assign(loreT.style, { whiteSpace: 'nowrap', fontSize: '230px', fontWeight: 800, letterSpacing: '-.05em', lineHeight: 0.95 });
  const loreE = el('div', '', lore, 'When the spring had no speed limit, it launched the fox through the ceiling.'); Object.assign(loreE.style, { fontSize: '54px', fontWeight: 700, lineHeight: 1.18, marginTop: '22px', letterSpacing: '-.015em' });
  const loreTab = el('div', 'abs tab', lore, 'since 2:05'); Object.assign(loreTab.style, { left: 'auto', right: '48px', top: '-40px', background: 'var(--ink)', color: 'var(--paper)', fontWeight: 800, fontSize: '50px', padding: '6px 22px', borderRadius: '16px', transformOrigin: '50% 50%' });
  const big6b = S(p6, { x: 100, y: 800, size: 150, width: 1720, align: 'center', stagger: 0.09 }, [
    { from: 'side', t0: 52.1, t1: 55.35, text: ['Every', 'chapter', 'keeps', 'its', { text: 'sources', emph: 'under' }] },
  ]);
  const lateCards = [
    { tc: '3:30', title: 'Spring gets a speed limit', img: '/demo/foxlight/clip-fixed.jpg', vid: 'fixed', t0: 52.2 },
    { tc: '5:20', title: 'Lanterns light the cave', img: '/demo/foxlight/clip-lanterns.jpg', vid: 'lanterns', t0: 53.45 },
  ].map(c => ({ ...c, ...card(p6, c) }));

  // ================= P7: three ways in (56-80) =================
  const p7 = L('p7');
  const nowV = view(p7, A + 'public-now.png', 663, { radius: 30 });
  const line7a = S(p7, { x: 100, y: 96, size: 170, width: 1720, color: 'var(--ink)', align: 'center', stagger: 0.1 }, [
    { t0: 56.3, t1: 58.55, text: ['A', 'viewer', 'arrives', 'at', { text: '7:10', emph: 'plate-verm' }] },
  ]);
  const cmd = el('div', 'abs', p7); Object.assign(cmd.style, { background: 'var(--verm)', color: 'var(--ink)', fontWeight: 800, fontSize: '150px', letterSpacing: '-.04em', padding: '10px 44px 22px', borderRadius: '32px', boxShadow: '0 10px 0 var(--verm-side)', whiteSpace: 'nowrap' });
  const cmdText = el('span', '', cmd); const cmdCaret = el('span', '', cmd, '|'); cmdCaret.style.fontWeight = 300;
  const line7b = S(p7, { x: 90, y: 560, size: 120, width: 900, color: 'var(--ink)', stagger: 0.09 }, [
    { t0: 59.95, t1: 64.2, text: ['answers', 'in', 'chat'] },
  ]);
  const chatV = view(p7, A + 'chat-answer.png', 592, { radius: 30 });
  const ring7 = svgEl('svg', p7, { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0;overflow:visible' });
  const ring7p = svgEl('rect', ring7, { fill: 'none', stroke: '#FF5A36', 'stroke-width': 9, rx: 30, pathLength: 1000, 'stroke-linecap': 'round' });
  const pageV = view(p7, A + 'public-page.png', 1920, { radius: 0, shadow: false });
  const line7c = S(p7, { x: 100, y: 820, size: 128, width: 1720, color: 'var(--ink)', stagger: 0.09 }, [
    { t0: 64.75, t1: 68.3, text: [{ text: 'a', emph: 'plate-paper' }, { text: 'page', emph: 'plate-paper' }, { text: 'anyone', emph: 'plate-paper' }, { text: 'can', emph: 'plate-paper' }, { text: 'open', emph: 'plate-paper' }] },
  ]);
  const moonV = view(p7, A + 'public-moon.png', 894, { radius: 30 });
  const moonVid = el('video', '', moonV.box); Object.assign(moonVid, { src: '/demo/foxlight/clip-moon.mp4', muted: true, preload: 'auto' }); Object.assign(moonVid.style, { position: 'absolute', objectFit: 'cover', borderRadius: '16px' });
  const sceneWrap = el('div', 'abs', p7); Object.assign(sceneWrap.style, { width: '1920px', height: '1080px', overflow: 'hidden', transformOrigin: '0 0' });
  const scene2 = el('iframe', '', sceneWrap); scene2.width = 1920; scene2.height = 1080; Object.assign(scene2.style, { border: '0', width: '1920px', height: '1080px' });
  const cap7 = el('div', 'abs', p7); Object.assign(cap7.style, { background: 'var(--paper)', color: 'var(--ink)', fontWeight: 800, fontSize: '76px', letterSpacing: '-.03em', padding: '10px 34px 18px', borderRadius: '22px', boxShadow: '0 7px 0 var(--paper-side)', whiteSpace: 'nowrap', transformOrigin: '100% 50%' });
  cap7.innerHTML = 'and on stream when a <span style="color:var(--verm)">raid</span> arrives';
  const line7d = S(p7, { x: 100, y: 70, size: 132, width: 1720, color: 'var(--ink)', align: 'center', stagger: 0.09 }, [
    { t0: 77.45, t1: 79.55, text: ['One', 'story', 'feeds', 'all', { text: 'three', emph: 'plate-paper' }] },
  ]);
  // ================= P8: the streamer stays in charge (80-102), on paper =================
  const p8 = L('p8');
  const line8 = S(p8, { x: 90, y: 70, size: 140, width: 1740, color: 'var(--ink)', stagger: 0.09 }, [
    { t0: 80.35, t1: 83.15, text: ['The', 'streamer', 'stays', 'in', { text: 'charge', emph: 'plate-verm' }] },
    { t0: 83.4, t1: 86.65, text: ['Correct', 'a', 'chapter', { text: 'once', emph: 'under' }] },
    { t0: 86.9, t1: 90.3, text: ['and', 'every', 'place', 'uses', { text: 'it', emph: 'verm' }] },
    { t0: 90.55, t1: 93.95, text: [{ text: 'Pause', emph: 'outline-ink' }, 'any', 'time'] },
    { t0: 94.25, t1: 98.4, text: ['Or', 'forget', 'the', 'last', { text: 'two minutes', emph: 'plate-verm' }] },
    { t0: 98.65, t1: 101.6, text: ['and', 'what', 'came', 'from', 'them', { text: 'goes', emph: 'under' }] },
  ]);
  const dockB = view(p8, A + 'dock-before.png', 520, { radius: 30 });
  const dockC = view(p8, A + 'dock-after-correction.png', 520, { radius: 30 });
  const dockF = view(p8, A + 'dock-after-forget.png', 520, { radius: 30 });
  const chB = view(p8, A + 'change-before.png', 1448, { radius: 30 });
  const chA = view(p8, A + 'change-after.png', 1448, { radius: 30 });
  const sweep = el('div', 'abs', p8); sweep.style.background = 'linear-gradient(90deg, transparent, rgb(255 90 54 / .9) 40%, rgb(255 90 54 / .9) 60%, transparent)';
  const cur = cursor(p8); cur.style.transformOrigin = '0 0';
  const pauseBtn = button(p8, 'Pause listening', { tone: 'ink', size: 96 });
  const forgetBtn = button(p8, 'Forget last 2 min', { tone: 'ink', size: 96 }); forgetBtn.style.color = 'var(--verm)';
  const gap = el('div', 'abs', p8); Object.assign(gap.style, { height: '12px', borderRadius: '6px', backgroundImage: 'repeating-linear-gradient(90deg, var(--ink) 0 34px, transparent 34px 60px)' });
  const dlgV = view(p8, A + 'forget-dialog.png', 560, { radius: 34 });

  // ================= P9: built in one Codex session (102-126), ink + vermilion =================
  const p9 = L('p9');
  // the passage's field: a cave-dark gradient with the real worker names drifting as a faint typographic texture
  const p9bg = el('div', 'layer', p9); p9bg.style.background = 'radial-gradient(1200px 800px at 15% 95%, rgb(255 90 54 / .22), transparent 70%), radial-gradient(1100px 700px at 90% 5%, rgb(70 122 128 / .3), transparent 72%), linear-gradient(160deg, #10161b, #14171B 55%, #1a1416)';
  const rows9 = [0, 1, 2, 3, 4].map(r => { const e = el('div', 'abs', p9bg, (CODEX.workerNames.slice(r * 5).concat(CODEX.workerNames.slice(0, r * 5))).join('   ')); Object.assign(e.style, { top: 40 + r * 210 + 'px', whiteSpace: 'nowrap', fontSize: '150px', fontWeight: 800, letterSpacing: '-.04em', color: 'rgb(244 239 230 / .045)' }); return e; });
  const nine1 = S(p9, { x: 100, y: 190, size: 200, width: 1720, align: 'center', stagger: 0.1 }, [
    { t0: 102.2, t1: 103.9, text: ['Built', 'in', 'one'] },
  ]);
  const nine2 = S(p9, { x: 100, y: 400, size: 210, width: 1720, color: 'var(--ink)', align: 'center', stagger: 0.1 }, [
    { t0: 102.55, t1: 105.75, text: [{ text: 'Codex session', emph: 'plate-paper' }] },
  ]);
  const nine3 = S(p9, { x: 100, y: 430, size: 200, width: 1720, align: 'center', stagger: 0.1 }, [
    { t0: 106.0, t1: 107.7, text: [{ text: `${CODEX.workers}`, emph: 'verm' }, 'parallel', 'workers'] },
  ]);
  const clk = el('div', 'abs', p9); Object.assign(clk.style, { display: 'flex', alignItems: 'baseline', gap: '40px', color: 'var(--paper)', fontWeight: 800, letterSpacing: '-.05em', lineHeight: 1 });
  const cFrom = el('div', 'tab', clk, '18:57'); const cTo = el('div', 'tab', clk, '18:57'); const cUtc = el('div', '', clk, 'UTC');
  cFrom.style.fontSize = '200px'; cFrom.style.color = '#6E7783'; cTo.style.fontSize = '250px'; cUtc.style.fontSize = '64px'; cUtc.style.color = 'var(--muted-ink)';
  const durPlate = el('div', 'abs tab', p9, CODEX.duration); Object.assign(durPlate.style, { background: 'var(--verm)', color: 'var(--ink)', fontWeight: 800, fontSize: '150px', padding: '10px 48px 22px', borderRadius: '32px', boxShadow: '0 12px 0 var(--verm-side)', transformOrigin: '50% 50%', whiteSpace: 'nowrap' });
  const workerTags = CODEX.workerNames.map((n, i) => { const e = el('div', 'abs', p9, n); Object.assign(e.style, { background: i % 4 === 0 ? 'var(--paper)' : 'var(--ink-high)', color: i % 4 === 0 ? 'var(--ink)' : 'var(--paper)', fontWeight: 700, fontSize: '42px', padding: '10px 24px', borderRadius: '16px', boxShadow: '0 6px 0 #07080a', whiteSpace: 'nowrap', transformOrigin: '50% 50%' }); return e; });
  const tools = el('div', 'abs', p9); Object.assign(tools.style, { color: 'var(--paper)', fontWeight: 800, letterSpacing: '-.05em', textAlign: 'center', lineHeight: 0.92, width: '1920px' });
  const toolsN = el('div', 'tab', tools); toolsN.style.fontSize = '380px';
  const toolsL = el('div', '', tools, 'tool calls'); toolsL.style.fontSize = '90px'; toolsL.style.color = 'var(--verm)';
  const bugs = CODEX.bugs.map((b, i) => {
    const c = el('div', 'abs', p9); Object.assign(c.style, { width: '1800px', background: 'var(--paper)', color: 'var(--ink)', borderRadius: '40px', padding: '56px 72px 70px', boxShadow: '0 10px 0 var(--paper-side), 0 60px 120px -40px rgb(0 0 0 / .9)', transformOrigin: '50% 50%' });
    const lab = el('div', '', c, b.label); Object.assign(lab.style, { fontSize: '58px', fontWeight: 800, color: 'var(--verm-side)', marginBottom: '18px', letterSpacing: '-.02em' });
    const tx = el('div', '', c, b.text); Object.assign(tx.style, { fontSize: '108px', fontWeight: 800, lineHeight: 1.02, letterSpacing: '-.04em' });
    const st = el('div', 'abs', c, b.stamp); Object.assign(st.style, { left: 'auto', right: '60px', top: '-90px', border: '14px solid var(--verm)', color: 'var(--verm)', background: 'var(--paper)', fontWeight: 800, fontSize: '180px', padding: '0 46px 10px', borderRadius: '34px', transformOrigin: '50% 50%', lineHeight: 1.05 });
    return { c, st, t0: b.t0 };
  });
  const quote = el('div', 'abs', p9); Object.assign(quote.style, { width: '1800px', color: 'var(--paper)', transformOrigin: '0 50%' });
  const qLab = el('div', '', quote, CODEX.question.label); Object.assign(qLab.style, { fontSize: '54px', fontWeight: 750, color: 'var(--lime)', marginBottom: '20px' });
  const qTx = el('div', '', quote, `“${CODEX.question.text}”`); Object.assign(qTx.style, { fontSize: '170px', fontWeight: 800, letterSpacing: '-.05em', lineHeight: 0.98 });
  const answer = el('div', 'abs', p9, CODEX.question.answer); Object.assign(answer.style, { width: '1800px', background: 'var(--lime)', color: 'var(--ink)', fontWeight: 800, fontSize: '72px', lineHeight: 1.12, letterSpacing: '-.02em', padding: '26px 44px 32px', borderRadius: '28px', boxShadow: '0 9px 0 var(--lime-side)', transformOrigin: '0 50%' });
  const stats = CODEX.stats.map((s, i) => { const e = el('div', 'abs', p9); Object.assign(e.style, { width: '1720px', color: 'var(--paper)', fontWeight: 800, letterSpacing: '-.05em', lineHeight: 0.9, transformOrigin: '0 50%' }); const n = el('div', 'tab', e, s.n); n.style.fontSize = '400px'; if (i === 1) n.style.color = 'var(--verm)'; if (i === 2) n.style.color = 'var(--lime)'; const d = el('div', '', e, s.label); Object.assign(d.style, { fontSize: '80px', letterSpacing: '-.03em', marginTop: '22px', lineHeight: 1.05, color: 'var(--paper)', maxWidth: '1700px' }); return e; });

  // ================= P10: try it (vermilion), then the mark =================
  const p10 = L('p10');
  const line10 = S(p10, { x: 60, y: 300, size: 190, width: 1800, color: 'var(--ink)', align: 'center', stagger: 0.1 }, [
    { t0: 125.75, t1: 128.65, text: ['Run', 'it', 'on', 'your', { text: 'channel', emph: 'plate-ink' }] },
    { t0: 128.9, t1: 131.55, text: ['with', 'your', 'Twitch', 'app'] },
    { t0: 131.8, t1: 133.25, text: ['or', 'try', 'the', { text: 'example', emph: 'under' }] },
  ]);
  const line10b = S(p10, { x: 60, y: 560, size: 190, width: 1800, color: 'var(--ink)', align: 'center', stagger: 0.1 }, [
    { t0: 129.35, t1: 131.55, text: ['and', 'OpenAI', { text: 'key', emph: 'plate-paper' }] },
  ]);
  const url = el('div', 'abs', p10, 'previously-seven.vercel.app/replay'); Object.assign(url.style, { background: 'var(--paper)', color: 'var(--ink)', fontWeight: 800, fontSize: '84px', letterSpacing: '-.03em', padding: '18px 48px 26px', borderRadius: '26px', boxShadow: '0 9px 0 var(--paper-side)', transformOrigin: '50% 50%', whiteSpace: 'nowrap' });
  const endMark = makeMark(p10);
  const endWord = el('img', 'abs', p10); endWord.src = '/brand/wordmark-text.svg'; endWord.style.filter = 'brightness(0) invert(94%) sepia(6%) saturate(320%) hue-rotate(340deg)';
  const endTag = el('div', 'abs', p10, 'Catch up with the stream while it keeps going'); Object.assign(endTag.style, { color: 'var(--paper)', fontWeight: 800, fontSize: '80px', letterSpacing: '-.035em', whiteSpace: 'nowrap', width: '1920px', textAlign: 'center' });
  const endUrl = el('div', 'abs', p10, 'previously-seven.vercel.app'); Object.assign(endUrl.style, { background: 'var(--paper)', color: 'var(--ink)', fontWeight: 800, fontSize: '64px', letterSpacing: '-.03em', padding: '12px 40px 20px', borderRadius: '22px', boxShadow: '0 8px 0 var(--paper-side)', whiteSpace: 'nowrap', transformOrigin: '50% 50%' });
  const endBg = el('video', '', p10); Object.assign(endBg, { src: '/demo/foxlight/stream-full.mp4', muted: true, preload: 'auto' });
  Object.assign(endBg.style, { position: 'absolute', left: '-60px', top: '-34px', width: '2040px', height: '1148px', objectFit: 'cover', filter: 'blur(28px) saturate(.8)', opacity: 0 });
  p10.insertBefore(endBg, p10.firstChild);
  const endTabs = ['0:05', '1:40', '3:30', '5:20'].map(tc => { const e = el('div', 'abs tab', p10, tc); Object.assign(e.style, { background: 'var(--paper)', color: 'var(--ink)', fontWeight: 800, fontSize: '54px', padding: '6px 20px 10px', borderRadius: '16px', boxShadow: '0 6px 0 var(--paper-side)', transformOrigin: '50% 50%' }); return e; });

  // headline layers sit above their passage's objects
  for (const [p, ss] of [[p7, [line7a, line7b, line7c, line7d]], [p8, [line8]], [p5, [big5, flank, flank2, holdLine, quoteLine]], [p6, [big6, big6b]], [p9, [nine1, nine2, nine3]]]) for (const s of ss) p.appendChild(s.root);
  p6.appendChild(counter);

  async function setup() {
    // ink-coloured outline variant for the paper world
    for (const s of slots) for (const ph of s.phrases) for (const w of ph.words) if (w.emph === 'outline-ink') { w.emph = 'outline'; w.inkOutline = true; }
    for (const s of slots) s.layout();
    RECTS = await (await fetch(A + 'rects.json')).json();
    scene2.src = '/src/features/overlay/lab/index.html?capture=1&plan=foxlight&bg=video&bgAt=4000';
    await new Promise(r => scene2.addEventListener('load', r, { once: true }));
    const w = scene2.contentWindow;
    for (let i = 0; i < 400 && !(w.__seek && w.__ready); i++) await new Promise(r => setTimeout(r, 50));
    await Promise.race([w.__ready, new Promise(r => setTimeout(r, 15000))]);
    // ---- sound events placed from the picture ----
    ev('p4-field', 24.0, 'drop', { gain: 0.5 });
    for (const s of slots) for (const ph of s.phrases) ph.words.forEach((wd, i) => {
      if (i === 0 || wd.emph || s.size >= 150) ev(`w-${ph.t0}-${i}`, wd.t, wd.emph && wd.emph.startsWith('plate') ? 'pop' : 'thump', { x: clamp((s.x + wd.x + wd.w / 2) / 1920), gain: wd.emph ? 0.75 : 0.5, note: (i * 2) % 7 });
      if (wd.under) ev(`u-${ph.t0}-${i}`, wd.t + 0.3, 'draw', { dur: 0.4, x: 0.5, gain: 0.7 });
    });
    ev('p4-note', 26.45, 'flick', { x: 0.5 });
    ev('p4-shrink', 28.95, 'morph', { dur: 0.75, x: 0.6, pan2: 0.9 });
    for (let i = 0; i < 28; i += 2) ev(`key-${i}`, SPEECH1.t0 + i * 0.1, 'key', { x: 0.4, gain: 0.7 });
    early.forEach((s, i) => ev(`early-${i}`, s.t, 'pop', { x: 0.8, gain: 0.55, note: 4 + i }));
    ev('gather5', 35.05, 'whoosh', { dur: 0.55, x: 0.3, pan2: 0.7 });
    ev('card5', 35.5, 'plate', { x: 0.7 });
    for (let i = 0; i < 14; i++) ev(`hold-${i}`, 38.0 + 2.3 * Math.pow(i / 14, 0.8), 'tick', { x: 0.25, gain: 0.45 + i * 0.03 });
    ev('published', 40.5, 'stamp', { x: 0.65, gain: 1.1 });
    ev('to-strip', 40.75, 'whoosh', { dur: 0.4, x: 0.65, pan2: 0.3, gain: 0.6 });
    ev('tile-in', 41.3, 'pop', { x: 0.5 });
    ev('press-fwd', 42.0, 'click', { x: 0.5, gain: 1.1 });
    ev('tape-fwd', 42.02, 'rewind', { dur: 0.6, x: 0.5, gain: 0.7 });
    ev('flip-lime', 45.55, 'impact', { x: 0.5, gain: 0.55 });
    ev('chat-burst', 45.7, 'chatter', { dur: 3.4, x: 0.6 });
    ev('collapse', 49.35, 'whoosh', { dur: 0.5, x: 0.7, pan2: 0.5 });
    ev('lore-plate', 49.9, 'ceramic', { x: 0.5 });
    ev('lore-tab', 50.3, 'ceramic', { x: 0.75, gain: 0.7 });
    ev('lore-to-strip', 51.55, 'whoosh', { dur: 0.45, x: 0.5, pan2: 0.45, gain: 0.6 });
    lateCards.forEach((c, i) => { ev(`late-${i}`, c.t0, 'flick', { x: 0.9 }); ev(`late-sh-${i}`, c.t0 + 0.4, 'shutter', { x: 0.6 }); });
    TABS.forEach((d, i) => ev(`tab-${i}`, d.t, 'tick', { x: 0.1 + d.x / 1900, gain: 0.6 }));
    ev('gather7', 55.4, 'riser', { dur: 0.6, gain: 0.6 });
    ev('flip-paper', 56.0, 'plate', { x: 0.5 });
    for (let i = 0; i < 11; i++) ev(`cmd-${i}`, 58.75 + i * 0.075, 'key', { x: 0.3, gain: 0.8 });
    ev('cmd-enter', 59.7, 'click', { x: 0.3, gain: 0.7 });
    ev('chat-in', 59.75, 'whoosh', { dur: 0.6, x: 1.0, pan2: 0.6 });
    ev('ring-chat', 61.7, 'draw', { dur: 0.6, x: 0.65 });
    ev('page-in', 64.35, 'air', { dur: 1.2, x: 0.5 });
    ev('moon-extract', 68.55, 'pop', { x: 0.6 });
    ev('moon-play', 69.0, 'shutter', { x: 0.6 });
    ev('scene-in', 71.8, 'whoosh', { dur: 0.5, x: 0.5, gain: 0.8 });
    ev('cap7', 72.6, 'plate', { x: 0.85, gain: 0.5 });
    ev('flip-verm', 77.2, 'drop', { gain: 0.5 });
    ev('planes', 77.25, 'morph', { dur: 0.7, x: 0.5 });
    ev('to-quiet', 79.75, 'tapeland', { x: 0.5, gain: 0.7 });
    ev('dock-in', 80.1, 'air', { dur: 0.9, x: 0.5 });
    ev('change-in', 83.35, 'flick', { x: 0.7 });
    ev('apply', 85.0, 'click', { x: 0.6, gain: 1.0 });
    ev('apply-ok', 85.25, 'chime', { x: 0.6 });
    ev('dock-swap', 87.6, 'sweep', { dur: 0.6, x: 0.5 });
    ev('pause-lift', 90.6, 'pop', { x: 0.5 });
    ev('pause', 91.6, 'click', { x: 0.5 });
    ev('forget-lift', 94.4, 'pop', { x: 0.5 });
    ev('hush', 95.5, 'hush', { dur: 0.5 });
    ev('forget', 96.0, 'click', { x: 0.5, gain: 1.2 });
    ev('dialog', 96.2, 'plate', { x: 0.5 });
    ev('forget-yes', 98.0, 'click', { x: 0.5, gain: 1.0 });
    ev('forget-sweep', 98.75, 'sweep', { dur: 0.7, x: 0.5 });
    ev('codex-in', 102.0, 'drop', { gain: 0.6 });
    for (let i = 0; i < 18; i++) ev(`clk-${i}`, 102.9 + i * 0.07, 'tick', { x: 0.5, gain: 0.35 });
    ev('dur', 104.35, 'stamp', { x: 0.7 });
    ev('swarm', 106.0, 'chatter', { dur: 2.0, x: 0.5, gain: 0.6 });
    for (let i = 0; i < 20; i++) ev(`tc-${i}`, 108.0 + i * 0.08, 'tick', { x: 0.5, gain: 0.3 });
    bugs.forEach((b, i) => { ev(`bug-${i}`, b.t0, 'flick', { x: 0.5 }); ev(`bugst-${i}`, b.t0 + 1.55, 'stamp', { x: 0.8, gain: 1.1 }); });
    ev('quote', 117.8, 'flick', { x: 0.5 });
    ev('answer', 119.25, 'stamp', { x: 0.4 });
    CODEX.stats.forEach((s, i) => ev(`stat-${i}`, 121.5 + i * 1.3, 'thumpBig', { x: 0.3, gain: 0.8 }));
    ev('to-end', 125.3, 'tapestop', { x: 0.5 });
    ev('flip-end', 125.7, 'drop', { gain: 0.5 });
    ev('url', 132.25, 'pop', { x: 0.5 });
    ev('field-to-tile', 133.1, 'riser', { dur: 0.9, gain: 0.8 });
    ev('logo-end', 134.0, 'impact', { x: 0.4, gain: 1.0 });
    ev('letters-end', 134.05, 'letters', { dur: 0.5, x: 0.5 });
  }

  // =====================================================================================
  function render(t, pending) {
    const show = (e, on) => { e.style.display = on ? '' : 'none'; return on; };
    root.style.display = t >= 23.9 ? '' : 'none';
    if (t < 23.9) return;
    for (const s of slots) s.render(t);
    for (const s of slots) for (const ph of s.phrases) for (const w of ph.words) if (w.inkOutline) { const f = seg(t, w.t + 0.25, w.t + 0.45); w.el.style.webkitTextStrokeColor = 'var(--ink)'; w.el.style.color = `rgb(20 23 27 / ${f})`; }

    // ---------- colour fields: vermilion (P4), footage (P5), lime (P6 burst), paper (P7a/b, P8), vermilion (P7 end, P10), ink (P9, end) ----------
    const C = { verm: 'var(--verm)', paper: '#EDE6DA', lime: 'var(--lime)', ink: 'var(--ink)', none: 'transparent' };
    let fA = 'none';
    if (t < 29.2) fA = 'verm'; else if (t >= 45.55 && t < 49.45) fA = 'lime'; else if (t >= 56.0 && t < 64.3) fA = 'paper'; else if (t >= 77.2 && t < 80.0) fA = 'verm';
    else if (t >= 80.0 && t < 102.0) fA = 'paper'; else if (t >= 102.0 && t < 125.7) fA = 'ink'; else if (t >= 125.7 && t < 133.1) fA = 'verm'; else if (t >= 133.1) fA = 'ink';
    fieldA.style.background = C[fA];
    show(fields, true);
    // P4 -> P5: the vermilion field shrinks into the "Example recording" tag of the full-frame player
    const sh = expoInOut(seg(t, 28.95, 29.6));
    const tagR = { x: 1920 - 40 - 78 - 18 - 220, y: 10, w: 220, h: 40 };
    const p10shrink = expoIn(seg(t, 133.1, 133.95));
    if (show(fieldB, (t >= 28.9 && t < 29.62) || (t >= 133.1 && t < 134.0))) {
      if (t < 30) Object.assign(fieldB.style, { background: 'var(--verm)', width: lerp(1920, tagR.w, sh) + 'px', height: lerp(1080, tagR.h, sh) + 'px', borderRadius: lerp(0, 9, sh) + 'px', transform: `translate(${lerp(0, tagR.x, sh)}px,${lerp(0, tagR.y, sh)}px)` });
      else { const T = 3.8 * 74, x0 = Math.round((1920 - 440 * 3.8) / 2) + 18 * 3.8, y0 = 250 + 16 * 3.8; Object.assign(fieldB.style, { background: 'var(--verm)', width: lerp(1920, T, p10shrink) + 'px', height: lerp(1080, T, p10shrink) + 'px', borderRadius: lerp(0, T * 21 / 74, p10shrink) + 'px', transform: `translate(${lerp(0, x0, p10shrink)}px,${lerp(0, y0, p10shrink)}px)` }); }
    }
    if (t >= 133.1 && t < 134.0) fieldA.style.background = C.ink;

    // ---------- P4 ----------
    if (show(p4, t >= 23.9 && t < 29.4)) {
      const lift = expoIn(seg(t, 28.85, 29.2));
      for (const s of [p4a, p4b]) s.root.style.opacity = 1 - lift;
      const g = clamp(springAt(t - 26.45, 0.7, 13), 0, 1.1);
      noteWords.forEach((w, i) => { w.style.opacity = 0.2 + 0.8 * seg(t, 26.55 + i * 0.075, 26.75 + i * 0.075); });
      Object.assign(p4note.style, { transformOrigin: '50% 0', transform: `translate(${210}px,${600 + 40 * (1 - g) - 300 * lift}px) scaleY(${g})`, opacity: (t >= 26.4 ? 1 : 0) * (1 - lift) });
    }

    // ---------- footage world (P5 + P6 outside the lime burst) ----------
    const footOn = t >= 28.9 && t < 56.3 && !(t >= 45.6 && t < 49.5);
    if (show(foot, footOn)) {
      let k = 'run', ct = 0.6 + (t - 29.0) * 0.8;
      if (t >= 42.0 && t < 42.6) { k = 'run'; ct = 10.3 - (t - 42.0) * 0; }
      if (t >= 42.6) { k = 'moon'; ct = 0.7 + (t - 42.6); }
      if (t >= 49.4) { k = 'moon'; ct = Math.min(10.3, 6.5 + (t - 49.4) * 0.3); }
      for (const c of lateCards) if (t >= c.t0 + 0.4 && t < c.t0 + 1.25) { k = c.vid; ct = 1.5 + (t - c.t0 - 0.4); }
      for (const [n, v] of Object.entries(vids)) v.style.display = n === k ? '' : 'none';
      const pr = seekVideo(vids[k], ct); if (pr) pending.push(pr);
      // camera: slow push, a whip on the forward press, push towards the spring before the jump
      const push = 1.04 + 0.05 * seg(t, 29.0, 41.9) + 0.12 * cubicInOut(seg(t, 42.6, 45.5));
      const fw = t >= 42.0 && t < 42.7 ? Math.sin(Math.PI * seg(t, 42.0, 42.7)) : 0;
      vids[k].style.transform = `scale(${push}) translate(${-60 * cubicInOut(seg(t, 42.6, 45.5))}px,${40 * cubicInOut(seg(t, 42.6, 45.5))}px)`;
      hblur(vids[k], fw * 40);
      // dim the footage while cards/plates sit on it
      const dim = Math.max(0.0, 0.55 * seg(t, 34.9, 35.4) * (1 - seg(t, 40.7, 41.2)), 0.6 * seg(t, 49.4, 49.8) * (1 - seg(t, 51.6, 52.0)));
      shade.style.background = `linear-gradient(180deg, rgb(12 14 17 / ${0.55 + dim}) 0%, rgb(12 14 17 / ${0.08 + dim}) 30%, rgb(12 14 17 / ${0.12 + dim}) 62%, rgb(12 14 17 / ${0.75 + dim * 0.3}) 100%)`;
      // title bar of the player stays at the top
      bar.style.transform = `translateY(${-60 * (1 - expoOut(seg(t, 29.3, 29.7)))}px)`;
      exTag.style.transform = `scale(${1 + 0.15 * (1 - springAt(t - 29.55, 0.45, 16))})`;
      let ck = 5 + Math.floor(Math.max(0, t - 30.0) * 0.8);
      if (t >= 42.0) ck = Math.round(lerp(14, 100, expoInOut(seg(t, 42.0, 42.6)))) + Math.max(0, Math.floor((t - 42.6) * 1));
      if (t >= 49.4) ck = 106 + Math.floor((t - 49.4) * 0.3);
      for (const c of lateCards) if (t >= c.t0 + 0.3) ck = c.tc === '3:30' ? 211 : 321;
      clock.textContent = fmtTime(ck);
    }

    // ---------- P5 ----------
    if (show(p5, t >= 29.9 && t < 56.3)) {
      // the transcript types the real speech
      const n = Math.floor(SPEECH1.text.length * clamp(seg(t, SPEECH1.t0, SPEECH1.t1)));
      trText.textContent = SPEECH1.text.slice(0, n);
      trCaret.style.opacity = t < SPEECH1.t1 || Math.floor(t * 3) % 2 === 0 ? 1 : 0;
      if (show(transcript, t >= 30.35 && t < 35.6)) {
        const a = expoOut(seg(t, 30.35, 30.7)), g = expoIn(seg(t, 35.0, 35.5));
        transcript.style.transform = `translate(${lerp(100, C5.x + 200, g)}px,${lerp(820 + 60 * (1 - a), C5.y + 300, g)}px) scale(${lerp(1, 0.15, g)})`;
        transcript.style.opacity = a * (1 - seg(t, 35.35, 35.5));
      }
      for (const [i, s] of early.entries()) {
        if (!show(s.el, t >= s.t - 0.05 && t < 35.6)) continue;
        const a = springAt(t - s.t, 0.6, 14), g = expoIn(seg(t, 35.02 + 0.04 * i, 35.45 + 0.04 * i));
        s.el.style.transform = `translate(${lerp(lerp(1950, s.x, a), C5.x + 300, g)}px,${lerp(s.y, C5.y + 300, g)}px) scale(${lerp(1, 0.25, g)}) rotate(${(1 - a) * 8}deg)`;
        s.el.style.opacity = 1 - seg(t, 35.35, 35.5);
      }
      // a big title card forms from them, waits, gets published, drops into the strip
      if (show(card5.el, t >= 35.4 && t < 41.25)) {
        const g = clamp(springAt(t - 35.4, 0.6, 12), 0, 1.15), drop = expoInOut(seg(t, 40.72, 41.2));
        card5.el.style.transformOrigin = '0 0';
        card5.el.style.transform = `translate(${lerp(C5.x, 160 + 16, drop)}px,${lerp(C5.y, 960, drop)}px) scale(${lerp(C5.s * g, 0.12, drop)}) rotate(${lerp(-2, 0, g)}deg)`;
        const full = 'Fox learns to jump'; card5.el.querySelector('.ttl').textContent = full.slice(0, Math.floor(full.length * seg(t, 35.85, 36.4)));
        card5.el.style.filter = t > 37.9 && t < 40.5 ? 'saturate(.55) brightness(.88)' : 'none';
      }
      if (show(ring, t >= 37.8 && t < 40.7)) {
        const p = seg(t, 38.0, 40.4);
        ring.style.transform = `translate(${C5.x - 20}px,${C5.y - 20}px)`;
        ringR.setAttribute('stroke-dasharray', `${1000 * (1 - p)} 1000`);
      }
      if (show(holdN, t >= 37.75 && t < 40.7)) {
        const p = seg(t, 38.0, 40.4);
        holdN.textContent = String(Math.ceil(75 * (1 - Math.pow(p, 1.2))));
        const g = clamp(springAt(t - 37.75, 0.55, 14), 0, 1.15);
        holdN.style.transform = `translate(90px,${360}px) scale(${g})`; holdN.style.transformOrigin = '0 100%';
      }
      if (show(holdNote, t >= 38.2 && t < 40.6)) holdNote.style.transform = 'translate(96px,820px)';
      if (show(stamp, t >= 40.42 && t < 40.85)) { const s = 1.7 - 0.7 * expoOut(seg(t, 40.42, 40.52)); stamp.style.transform = `translate(${C5.x + 120}px,${C5.y + 230}px) rotate(-8deg) scale(${s})`; }
      // strip
      if (show(strip, t >= 40.6 && t < 56.2)) {
        const g = expoOut(seg(t, 40.6, 41.0)), out = expoIn(seg(t, 55.4, 56.0));
        strip.style.transform = `translate(${80}px,${lerp(1120, 960, g) - 420 * out}px) scale(${1 - 0.5 * out})`; strip.style.transformOrigin = '50% 50%';
        strip.style.opacity = 1 - seg(t, 55.8, 56.0);
        for (const d of TABS) if (show(d.el, t >= d.t)) d.el.style.transform = `translate(${d.x}px,0px) scaleX(${clamp(springAt(t - d.t, 0.55, 16), 0, 1.15)})`;
      }
      // the rewind tile, big, pressed as fast forward (mirrored)
      if (show(tileS.box, t >= 41.25 && t < 42.75)) {
        const g = clamp(springAt(t - 41.25, 0.55, 13), 0, 1.2), pr = pressScale(t, 42.0), out = expoIn(seg(t, 42.4, 42.75));
        placeMark(tileS, 960 - 170, 330, 340, { sx: -pr * g * (1 + 3 * out), sy: pr * g * (1 + 3 * out), back: 1, glyph: 1, opacity: 1 - out, blur: out * 20 });
      }
      show(tileRip, false);
      const rp = seg(t, 42.0, 42.45);
      if (rp > 0 && rp < 1) { show(tileRip, true); const fs = 340 * 74 / 96; Object.assign(tileRip.style, { width: fs + 'px', height: fs + 'px', borderRadius: fs * 21 / 74 + 'px', borderWidth: '8px', transform: `translate(${960 - 170 + 18 * 340 / 96}px,${330 + 16 * 340 / 96}px) scale(${1 + 0.9 * expoOut(rp)})`, opacity: 1 - rp }); }
      if (show(bigClock, t >= 42.0 && t < 43.2)) {
        const ck = Math.round(lerp(14, 100, expoInOut(seg(t, 42.0, 42.6))));
        bigClock.textContent = fmtTime(ck);
        const out = expoIn(seg(t, 42.85, 43.2));
        bigClock.style.transform = `translate(${560}px,${300 - 200 * out}px) scale(${1 - 0.3 * out})`; bigClock.style.opacity = clamp(seg(t, 42.0, 42.12)) * (1 - out);
        hblur(bigClock, 0);
      }
    }

    // ---------- P6 ----------
    if (show(p6, t >= 45.5 && t < 56.3)) {
      // lime field: the 14 real messages burst across the frame, the counter rolls to 45
      const bOn = t >= 45.6 && t < 49.6;
      burst.forEach(b => {
        if (!show(b.el, bOn)) return;
        const t0 = 45.65 + b.i * 0.14, a = springAt(t - t0, 0.55, 11);
        const ang = b.i * 2.39, rad = 640 + (b.i % 4) * 70;
        const left = b.i % 2 === 0, row = Math.floor(b.i / 2); const hx = left ? 30 + (row * 67) % 190 : 1290 + (row * 83) % 230, hy = 300 + row * 108 + (left ? 0 : 40);
        const g = expoIn(seg(t, 49.3 + b.i * 0.01, 49.65 + b.i * 0.01));
        b.el.style.opacity = t >= t0 ? 1 : 0;
        b.el.style.transform = `translate(${lerp(lerp(960, hx, a), 760, g)}px,${lerp(lerp(560, hy, a), 520, g)}px) rotate(${((b.i * 53) % 11 - 5) * (1 - g)}deg) scale(${lerp(1, 0.3, g)})`;
      });
      if (show(counter, t >= 45.7 && t < 49.6)) {
        cNum.textContent = String(Math.round(FACTS.moment.count * cubicInOut(seg(t, 45.8, 48.4))));
        const g = clamp(springAt(t - 45.7, 0.55, 13), 0, 1.15), out = expoIn(seg(t, 49.25, 49.6));
        counter.style.transform = `translate(${560}px,${290}px) scale(${g * (1 - out)})`; counter.style.transformOrigin = '30% 50%';
      }
      // the swarm collapses into the running joke, on the dimmed footage
      if (show(lore, t >= 49.55 && t < 52.1)) {
        const g = clamp(springAt(t - 49.55, 0.5, 12), 0, 1.25), d = expoInOut(seg(t, 51.5, 52.05));
        lore.style.transformOrigin = '0 0';
        lore.style.transform = `translate(${lerp(260, 80 + 830, d)}px,${lerp(260, 975, d)}px) scale(${lerp(g, 0.05, d)}) rotate(${-2.5 * (1 - d)}deg)`;
        loreTab.style.transform = `scale(${clamp(springAt(t - 50.3, 0.5, 16), 0, 1.25)}) rotate(4deg)`;
      }
      // later chapters: big cards whip in, open into their clip full frame, then file into the strip
      for (const c of lateCards) {
        if (!show(c.el, t >= c.t0 && t < c.t0 + 1.25)) continue;
        const a = expoOut(seg(t, c.t0, c.t0 + 0.35)), open = expoIn(seg(t, c.t0 + 0.32, c.t0 + 0.42)), d = expoIn(seg(t, c.t0 + 0.95, c.t0 + 1.25));
        c.el.style.transformOrigin = '50% 50%';
        c.el.style.transform = `translate(${lerp(2100, 700, a)}px,${lerp(340, 340, a) + 500 * d}px) scale(${1.6 * (1 + 2.6 * open) * (1 - 0.9 * d)}) rotate(${4 * (1 - a)}deg)`;
        c.el.style.opacity = 1 - seg(t, c.t0 + 0.4, c.t0 + 0.44);
        hblur(c.el, (1 - a) * 50);
      }
    }

    // ---------- P7 ----------
    if (show(p7, t >= 55.4 && t < 80.3)) {
      // paper world: the real "Right now" card at reading size
      const nIn = expoOut(seg(t, 55.9, 56.6)), nOut = expoIn(seg(t, 58.4, 58.9));
      if (show(nowV.box, t >= 55.9 && t < 58.95)) nowV.set({ x: 230, y: lerp(1100, 340, nIn) - 900 * nOut, w: 1460, h: 680, r: 34 }, { cx: 331, cy: 178, s: 2.12 + 0.06 * seg(t, 56.6, 58.4) });
      // typed command, then the real answer from the product's chat reply
      const typed = '!previously';
      if (show(cmd, t >= 58.6 && t < 64.3)) {
        cmdText.textContent = typed.slice(0, Math.floor(typed.length * seg(t, 58.75, 59.6)));
        cmdCaret.style.opacity = t < 59.6 || Math.floor(t * 3) % 2 === 0 ? 1 : 0;
        const mv = expoInOut(seg(t, 59.7, 60.2)), out = expoIn(seg(t, 63.9, 64.3));
        cmd.style.transformOrigin = '0 0';
        cmd.style.transform = `translate(${lerp(250, 90, mv) - 900 * out}px,${lerp(330, 300, mv)}px) scale(${lerp(1.7, 0.85, mv) * pressScale(t, 59.7)})`;
      }
      if (show(chatV.box, t >= 59.75 && t < 64.4)) {
        const a = expoOut(seg(t, 59.75, 60.45)), out = expoIn(seg(t, 63.9, 64.35));
        // the camera travels from the typed command row down to the answer and its link
        const cy = lerp(250, 400, cubicInOut(seg(t, 60.3, 62.4))), s = lerp(1.55, 1.72, cubicInOut(seg(t, 60.3, 63.8)));
        chatV.set({ x: lerp(1950, 960, a) + 1000 * out, y: 60, w: 900, h: 960, r: 32 }, { cx: 296, cy, s }, `perspective(1600px) rotateY(${-22 * (1 - a)}deg)`);
        chatV.cam = { x: lerp(1950, 960, a) + 1000 * out, y: 60, w: 900, h: 960, cx: 296, cy, s };
      }
      if (show(ring7, t >= 61.6 && t < 64.2) && chatV.cam) {
        const c = chatV.cam, m = (lx, ly) => ({ x: c.x + c.w / 2 + (lx - c.cx) * c.s, y: c.y + c.h / 2 + (ly - c.cy) * c.s });
        const p0 = m(3, 274), p1 = m(589, 486);
        ring7p.setAttribute('x', p0.x - 8); ring7p.setAttribute('y', p0.y - 8); ring7p.setAttribute('width', p1.x - p0.x + 16); ring7p.setAttribute('height', p1.y - p0.y + 16);
        ring7p.setAttribute('stroke-dasharray', `${1000 * expoOut(seg(t, 61.65, 62.3))} 1000`);
        ring7.style.opacity = 1 - seg(t, 63.8, 64.2);
      }
      // the public page full width: arrives tilted from below, the camera travels down through it
      if (show(pageV.box, t >= 64.25 && t < 72.0)) {
        const a = expoOut(seg(t, 64.25, 65.2)), sc = cubicInOut(seg(t, 65.4, 71.4)), out = expoIn(seg(t, 71.6, 72.0));
        const cy = lerp(560, 1700, sc);
        pageV.set({ x: 0, y: lerp(1080, 0, a) - 1080 * out, w: 1920, h: 1080, r: lerp(40, 0, a) }, { cx: 960, cy, s: lerp(1.0, 1.18, sc) }, `perspective(1800px) rotateX(${28 * (1 - a)}deg)`);
        pageV.box.style.transformOrigin = '50% 100%';
      }
      // the moon jump chapter is lifted out of the page; its clip plays inside it
      if (show(moonV.box, t >= 68.5 && t < 71.95)) {
        const a = clamp(springAt(t - 68.5, 0.6, 11), 0, 1.1), out = expoIn(seg(t, 71.55, 71.95));
        const W = 1500, H = W * 465 / 1341;
        moonV.set({ x: 210, y: lerp(560, 300, a) - 900 * out, w: W, h: H, r: 34 }, { cx: 447, cy: 155, s: W / 894 });
        moonV.box.style.transform += ` scale(${lerp(0.8, 1, clamp(a))})`;
        Object.assign(moonVid.style, { left: W * 0.6 + 'px', top: H * 0.13 + 'px', width: W * 0.355 + 'px', height: H * 0.6 + 'px', display: t >= 69.0 ? '' : 'none' });
        if (t >= 69.0) { const pr = seekVideo(moonVid, 2.6 + (t - 69.0)); if (pr) pending.push(pr); }
      }
      // the raid scene itself, full frame, with its own sound
      if (show(sceneWrap, t >= 71.75 && t < 77.6)) {
        const a = expoOut(seg(t, 71.75, 72.35)), out = expoIn(seg(t, 77.2, 77.6));
        const s = lerp(0.6, 1, a) * (1 - 0.6 * out);
        sceneWrap.style.borderRadius = lerp(40, 0, a) + 'px';
        sceneWrap.style.transform = `translate(${960 - 960 * s}px,${540 - 540 * s + 1100 * out}px) scale(${s})`;
        const w = scene2.contentWindow;
        if (w && w.__seek) pending.push(w.__seek(Math.min(11500, 1200 + (t - 71.75) * 1000)));
      }
      if (show(cap7, t >= 72.55 && t < 77.4)) {
        const g = clamp(springAt(t - 72.55, 0.65, 13), 0, 1.1), out = expoIn(seg(t, 77.05, 77.4));
        cap7.style.transform = `translate(${1856 - 1180 + 600 * out}px,${86}px) scaleX(${g})`;
      }
      // one story feeds all three: the three surfaces stand side by side on vermilion
      const tOn = t >= 77.25 && t < 80.1;
      const p3 = expoOut(seg(t, 77.25, 77.9)), o3 = expoIn(seg(t, 79.55, 80.05));
      const views = [[chatV, { cx: 296, cy: 380, s: 0.98 }], [pageV, { cx: 960, cy: 520, s: 0.3 }]];
      if (tOn) {
        show(chatV.box, true); show(pageV.box, true); show(sceneWrap, true);
        const W = 560, H = 640, y0 = 330;
        chatV.set({ x: lerp(-700, 90, p3), y: y0 + 900 * o3, w: W, h: H, r: 30 }, views[0][1], `perspective(1600px) rotateY(${12 * p3}deg)`);
        pageV.set({ x: 680, y: lerp(1200, y0, p3) + 900 * o3, w: W, h: H, r: 30 }, views[1][1]);
        pageV.box.style.transformOrigin = '50% 50%';
        sceneWrap.style.opacity = 1;
        const s = W / 1920 * 1.95;
        sceneWrap.style.borderRadius = 30 / s + 'px';
        sceneWrap.style.transform = `perspective(1600px) translate(${lerp(2100, 1270, p3)}px,${y0 + 60 + 900 * o3}px) rotateY(${-12 * p3}deg) scale(${s})`;
        sceneWrap.style.width = 1920 * 0.55 + 'px';
        sceneWrap.style.height = 1080 * 0.97 + 'px';
      } else { sceneWrap.style.width = '1920px'; sceneWrap.style.height = '1080px'; }
    }

    // ---------- P8 (paper world) ----------
    if (show(p8, t >= 79.8 && t < 102.4)) {
      const R = RECTS;
      const LY = keyed(t, [[90.2, { y: 70 }], [90.55, { y: 690 }], [95.9, { y: 690 }], [96.25, { y: 70 }]]).y;
      line8.root.style.transform = `translate(${90 - 40}px,${LY - 140 * 0.22}px)`;
      // the dock rises in big, the camera travels down it; it steps aside while the change panel is read
      const keys = [
        [79.8, { x: 1110, y: 1100, w: 700, h: 760, cx: 260, cy: 150, s: 1.45, o: 1 }],
        [80.6, { x: 1110, y: 300, w: 700, h: 760, cx: 260, cy: 150, s: 1.45, o: 1 }],
        [83.0, { x: 1110, y: 300, w: 700, h: 760, cx: 260, cy: 420, s: 1.45, o: 1 }],
        [83.4, { x: 2000, y: 300, w: 700, h: 760, cx: 260, cy: 420, s: 1.45, o: 1 }],
        [86.7, { x: 2000, y: 300, w: 700, h: 760, cx: 252, cy: 1022, s: 2.4, o: 1 }],
        [87.2, { x: 160, y: 300, w: 1600, h: 640, cx: 252, cy: 1022, s: 2.9, o: 1 }],
        [90.2, { x: 160, y: 300, w: 1600, h: 640, cx: 252, cy: 1000, s: 2.75, o: 1 }],
        [90.7, { x: 1110, y: 300, w: 700, h: 760, cx: 260, cy: 440, s: 1.45, o: 1 }],
        [97.8, { x: 1110, y: 300, w: 700, h: 760, cx: 260, cy: 440, s: 1.45, o: 1 }],
        [98.4, { x: 160, y: 300, w: 1600, h: 680, cx: 260, cy: 560, s: 2.6, o: 1 }],
        [101.5, { x: 160, y: 300, w: 1600, h: 680, cx: 260, cy: 600, s: 2.6, o: 1 }],
        [102.1, { x: 160, y: 1200, w: 1600, h: 680, cx: 260, cy: 600, s: 2.6, o: 1 }],
      ];
      const D = keyed(t, keys);
      const swapC = seg(t, 87.6, 88.1), swapF = seg(t, 98.75, 99.3);
      dockB.set(D, D); show(dockB.box, true);
      if (show(dockC.box, swapC > 0 && t < 90.7)) { dockC.set(D, D); dockC.box.style.clipPath = `inset(0 ${100 - 100 * swapC}% 0 0 round 30px)`; }
      if (show(dockF.box, swapF > 0)) { dockF.set(D, D); dockF.box.style.clipPath = `inset(0 ${100 - 100 * swapF}% 0 0 round 30px)`; }
      const sw = swapF > 0 && swapF < 1 ? swapF : swapC > 0 && swapC < 1 ? swapC : -1;
      if (show(sweep, sw >= 0)) Object.assign(sweep.style, { width: '220px', height: D.h + 'px', transform: `translate(${D.x + D.w * sw - 110}px,${D.y}px)` });
      // the change panel at reading size: the two cards, then Apply my wording
      const chOn = t >= 83.25 && t < 87.1;
      const CK = keyed(t, [[83.25, { x: 100, y: 1200, cx: 724, cy: 178, s: 1.2 }], [83.9, { x: 100, y: 330, cx: 724, cy: 178, s: 1.2 }], [84.6, { x: 100, y: 330, cx: 1085, cy: 175, s: 2.2 }], [86.5, { x: 100, y: 330, cx: 1085, cy: 175, s: 2.2 }], [87.1, { x: 100, y: -900, cx: 1085, cy: 175, s: 2.2 }]]);
      const pr = pressScale(t, 85.0);
      for (const [v, on] of [[chB, chOn && t < 85.15], [chA, chOn && t >= 85.15]]) if (show(v.box, on)) v.set({ x: CK.x, y: CK.y, w: 1720, h: 640, r: 34 }, { cx: CK.cx, cy: CK.cy, s: CK.s * pr });
      const applyAt = { x: CK.x + 860 + (R.applyBtn.x + R.applyBtn.w * 0.5 - CK.cx) * CK.s, y: CK.y + 320 + (R.applyBtn.y + R.applyBtn.h * 0.55 - CK.cy) * CK.s };
      const path = [[84.2, { x: 1950, y: 1150 }], [84.85, applyAt], [85.6, applyAt], [86.2, { x: 1950, y: 1150 }], [96.6, { x: 1950, y: 1150 }], [97.4, { x: 930, y: 940 }], [98.4, { x: 930, y: 940 }], [99.0, { x: 1950, y: 1150 }]];
      let cp = null;
      for (let i = 0; i < path.length - 1; i++) { const [t0, a] = path[i], [t1, b] = path[i + 1]; if (t >= t0 && t < t1) { const e = expoOut(seg(t, t0, t1)); cp = bezier2(a, { x: (a.x + b.x) / 2 + 80, y: Math.min(a.y, b.y) - 90 }, b, e); } }
      if (show(cur, !!cp)) { const down = [85.0, 98.0].some(tp => t >= tp && t < tp + 0.1); cur.style.transform = `translate(${cp.x - 8}px,${cp.y - 4}px) scale(${(down ? 0.9 : 1) * 1.6})`; }
      // pause: lifted out of the dock to full scale, pressed, label swaps, the transcript gap draws
      if (show(pauseBtn, t >= 90.5 && t < 94.0)) {
        const a = expoInOut(seg(t, 90.5, 91.1)), back = expoIn(seg(t, 93.55, 94.0)), p2 = pressScale(t, 91.6);
        pauseBtn.textContent = t >= 91.65 ? 'Resume listening' : 'Pause listening';
        pauseBtn.style.transformOrigin = '50% 50%';
        pauseBtn.style.transform = `translate(${lerp(1300, 120, a)}px,${lerp(420, 470, a) + 800 * back}px) scale(${lerp(0.4, 1, a) * p2})`;
        pauseBtn.style.background = t >= 91.65 ? 'var(--verm)' : 'var(--ink)'; pauseBtn.style.color = t >= 91.65 ? 'var(--ink)' : 'var(--paper)';
      }
      if (show(gap, t >= 91.9 && t < 93.95)) Object.assign(gap.style, { width: 880 * expoOut(seg(t, 91.9, 93.0)) + 'px', transform: 'translate(120px,760px)', opacity: 1 - seg(t, 93.55, 93.95) });
      if (show(forgetBtn, t >= 94.3 && t < 96.4)) {
        const a = expoInOut(seg(t, 94.3, 94.9)), p2 = pressScale(t, 96.0), out = expoIn(seg(t, 96.1, 96.4));
        forgetBtn.style.transformOrigin = '50% 50%';
        forgetBtn.style.transform = `translate(${lerp(1500, 120, a)}px,${lerp(420, 470, a)}px) scale(${lerp(0.4, 1, a) * p2 * (1 - out)})`;
      }
      if (show(dlgV.box, t >= 96.15 && t < 98.6)) {
        const a = clamp(springAt(t - 96.15, 0.6, 12), 0, 1.1), p2 = pressScale(t, 98.0), out = expoIn(seg(t, 98.25, 98.6));
        const W = 1180, H = W * 552 / 840;
        dlgV.set({ x: 370, y: lerp(1100, 290, a) + 900 * out, w: W, h: H, r: 40 }, { cx: 280, cy: 184, s: W / 560 * p2 });
      }
    }

    // ---------- P9 (ink) ----------
    if (show(p9, t >= 101.9 && t < 126.0)) {
      rows9.forEach((r, i) => { r.style.transform = `translateX(${(i % 2 ? -1 : 1) * (t - 102) * 40 - 600}px)`; });
      nine2.root.style.transform = `translate(60px,${400 - 210 * 0.22 - 160 * expoInOut(seg(t, 103.9, 104.4))}px)`;
      clk.style.display = t >= 103.95 && t < 106.0 ? 'flex' : 'none';
      if (t >= 103.95 && t < 106.0) {
        const a = expoOut(seg(t, 103.95, 104.4)), out = expoIn(seg(t, 105.6, 106.0));
        clk.style.transform = `translate(${260 - 1900 * out}px,${lerp(720, 600, a)}px)`; clk.style.opacity = a;
        const mins = Math.round(lerp(0, 574, cubicInOut(seg(t, 104.1, 105.1)))), tt = (18 * 60 + 57 + mins) % 1440;
        cTo.textContent = `${String(Math.floor(tt / 60)).padStart(2, '0')}:${String(tt % 60).padStart(2, '0')}`;
        hblur(cTo, 0);
      }
      if (show(durPlate, t >= 105.15 && t < 106.0)) { const g = clamp(springAt(t - 105.15, 0.5, 14), 0, 1.25), out = expoIn(seg(t, 105.6, 106.0)); durPlate.style.transform = `translate(${1250 - 1900 * out}px,${300}px) scale(${g}) rotate(-6deg)`; }
      // the 27 worker names swarm in from every edge, orbit, then pour into the tool-call counter
      const wOn = t >= 105.95 && t < 110.6;
      workerTags.forEach((e, i) => {
        if (!show(e, wOn)) return;
        const ang = i * 2.399, edge = 1500;
        const a = expoOut(seg(t, 106.0 + i * 0.035, 106.85 + i * 0.035));
        const orbit = (t - 106) * 0.35 * (i % 2 ? 1 : -1);
        const rad = 470 + (i % 5) * 70;
        const hx = 960 + Math.cos(ang + orbit) * rad * 1.45, hy = 600 + Math.sin(ang + orbit) * rad * 0.68;
        const pour = expoIn(seg(t, 107.7 + (i % 9) * 0.05, 108.4 + (i % 9) * 0.05));
        const x = lerp(lerp(960, hx, a), 960, pour) - 150, y = lerp(lerp(540, hy, a), 600, pour);
        const z = 0.75 + (i % 4) * 0.15;
        e.style.transform = `translate(${x}px,${y}px) scale(${z * (1 - 0.8 * pour)})`;
        e.style.opacity = 1 - pour;
        e.style.filter = z < 0.8 ? 'blur(2px)' : 'none';
      });
      if (show(tools, t >= 107.9 && t < 110.6)) {
        toolsN.textContent = Math.round(CODEX.toolCalls * cubicInOut(seg(t, 108.0, 109.4))).toLocaleString('en-US');
        const g = clamp(springAt(t - 107.9, 0.55, 12), 0, 1.15), out = expoIn(seg(t, 110.15, 110.6));
        tools.style.transform = `translate(0px,${330 - 700 * out}px) scale(${g})`; tools.style.transformOrigin = '50% 50%';
      }
      bugs.forEach((b, i) => {
        if (!show(b.c, t >= b.t0 && t < b.t0 + 3.4)) return;
        const a = expoOut(seg(t, b.t0, b.t0 + 0.5)), out = expoIn(seg(t, b.t0 + 3.0, b.t0 + 3.4));
        b.c.style.transform = `perspective(1800px) translate(${60 + (1 - a) * 1700 - out * 2100}px,${250}px) rotateY(${-22 * (1 - a)}deg)`;
        const s = 2.0 - 1.0 * expoOut(seg(t, b.t0 + 1.55, b.t0 + 1.66));
        b.st.style.transform = `rotate(-7deg) scale(${t >= b.t0 + 1.55 ? s : 0})`;
      });
      if (show(quote, t >= 117.75 && t < 121.3)) { const a = expoOut(seg(t, 117.75, 118.25)), out = expoIn(seg(t, 120.9, 121.3)); quote.style.transform = `translate(${60}px,${lerp(420, 170, a) - 1000 * out}px)`; quote.style.opacity = a; }
      if (show(answer, t >= 119.2 && t < 121.3)) { const g = clamp(springAt(t - 119.2, 0.6, 14), 0, 1.1), out = expoIn(seg(t, 120.9, 121.3)); answer.style.transform = `translate(${60}px,${720 - 1000 * out}px) scaleX(${g})`; }
      // three giant numbers, each pushing the previous out (a type wall)
      stats.forEach((e, i) => {
        const t0 = 121.5 + i * 1.3, t1 = t0 + 1.3;
        if (!show(e, t >= t0 - 0.05 && t < (i === 2 ? 125.7 : t1))) return;
        const a = expoOut(seg(t, t0, t0 + 0.4)), out = i === 2 ? expoIn(seg(t, 125.3, 125.7)) : expoIn(seg(t, t1 - 0.28, t1));
        e.style.transform = `translate(${100 + 1500 * (1 - a) - 1900 * out}px,${170}px)`;
        hblur(e, ((1 - a) + out) * 50);
      });
    }

    // ---------- P10 ----------
    if (show(p10, t >= 125.6)) {
      if (show(url, t >= 132.2 && t < 133.4)) { const g = clamp(springAt(t - 132.2, 0.55, 14), 0, 1.2), out = expoIn(seg(t, 133.05, 133.4)); url.style.transform = `translate(${960 - 780}px,${600}px) scale(${g * (1 - out)})`; }
      for (const s of [line10, line10b]) s.root.style.opacity = 1 - seg(t, 133.0, 133.3);
      const k = 3.8, x0 = Math.round((1920 - 440 * k) / 2), y0 = 250;
      // the stream keeps playing behind the mark (bookend of the brand beat)
      if (show(endBg, t >= 133.1)) { endBg.style.opacity = 0.3 * seg(t, 133.1, 134.2); const pr = seekVideo(endBg, 20 + (t - 133.1)); if (pr) pending.push(pr); }
      // the four chapter timecodes spiral in and settle into the tile on the hit
      const tc = { x: x0 + 55 * k, y: y0 + 53 * k };
      endTabs.forEach((e, i) => {
        if (!show(e, t >= 132.9 && t < 134.08)) return;
        const g = expoIn(seg(t, 132.95 + i * 0.04, 134.02)), ang = i * Math.PI / 2 + 0.7 + g * 2.2, r = lerp(820, 0, g);
        e.style.transform = `translate(${tc.x + Math.cos(ang) * r * 1.2 - 70}px,${tc.y + Math.sin(ang) * r * 0.6 - 40}px) scale(${1.4 - 1.1 * g}) rotate(${(1 - g) * 30}deg)`;
        hblur(e, g * 24);
      });
      if (show(endMark.box, t >= 133.92)) {
        const hit = t >= 134 ? 1 + 0.1 * Math.exp(-(t - 134) * 8) : 1;
        placeMark(endMark, x0, y0, 96 * k, { sx: hit, sy: 2 - hit, back: clamp(seg(t, 133.92, 134.2)), sheen: 0.7 * Math.sin(Math.PI * seg(t, 134.15, 135.8)) + 0.6 * Math.sin(Math.PI * seg(t, 136.2, 137.9)) });
      }
      if (show(endWord, t >= 134.0)) { const a = expoOut(seg(t, 134.0, 134.55)); Object.assign(endWord.style, { width: 300 * k + 'px', transform: `translate(${x0 + 109 * k - 90 * (1 - a)}px,${y0}px)`, clipPath: `inset(0 ${100 - 100 * a}% 0 0)` }); }
      if (show(endTag, t >= 134.5)) { const a = wordIn(t, 134.6, 0.4); endTag.style.opacity = a.op; endTag.style.transform = `translate(0px,${690 + 30 * (1 - a.e)}px)`; endTag.style.filter = a.blur > 0.4 ? `blur(${a.blur}px)` : 'none'; }
      if (show(endUrl, t >= 135.05)) { const g = clamp(springAt(t - 135.1, 0.55, 14), 0, 1.15); endUrl.style.transform = `translate(${960 - 520}px,${840}px) scale(${g})`; }
      p10.style.transformOrigin = '50% 50%';
      p10.style.transform = `scale(${1 + 0.03 * seg(t, 134.0, END)})`;
    }
  }
  return { setup, render };
}
