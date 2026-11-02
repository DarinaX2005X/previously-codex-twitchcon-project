// Reusable film objects: kinetic headline slots, title cards, chat slips, image planes, cursor, strip.
import { clamp, seg, lerp, expoOut, expoIn, springAt, el, dirBlur } from './lib.js';

export const wordIn = (t, t0, dur = 0.34) => {
  const p = seg(t, t0 - 0.06, t0 + dur), e = expoOut(p);
  return { p, e, op: clamp(seg(t, t0 - 0.06, t0 + 0.1)), blur: 16 * (1 - e), sc: 1.12 - 0.12 * e, dx: 60 * (1 - e) };
};

/** A headline slot: phrases replace each other in place (masked roll), words land one by one,
 *  and each phrase emphasises its key words differently: verm, lime plate, paper plate, ink plate, outline, under. */
export class Slot {
  constructor(parent, { x, y, size = 84, weight = 800, color = 'var(--paper)', align = 'left', width = 1680, stagger = 0.1 }, phrases) {
    Object.assign(this, { x, y, size, weight, color, align, width, stagger, phrases });
    this.root = el('div', 'abs', parent);
    Object.assign(this.root.style, { overflow: 'hidden', left: '0px', top: '0px', padding: `${size * 0.22}px 40px ${size * 0.35}px`, transform: `translate(${x - 40}px,${y - size * 0.22}px)`, width: width + 80 + 'px', height: size * 1.6 + 'px' });
    for (const ph of phrases) {
      ph.words = [];
      ph.words = ph.text.map((w, i) => {
        const o = typeof w === 'string' ? { text: w } : w;
        const plate = o.emph && o.emph.startsWith('plate') ? el('div', 'plate', this.root) : null;
        const e = el('div', 'word', this.root, o.text);
        Object.assign(e.style, { fontSize: size + 'px', fontWeight: weight, color: color });
        if (o.emph === 'verm') e.style.color = 'var(--verm)';
        if (o.emph === 'muted') e.style.color = '#8A929E';
        if (plate) {
          const c = { 'plate-lime': ['var(--lime)', 'var(--lime-side)', 'var(--ink)'], 'plate-paper': ['var(--paper)', 'var(--paper-side)', 'var(--ink)'], 'plate-ink': ['var(--ink)', '#07080a', 'var(--paper)'], 'plate-verm': ['var(--verm)', 'var(--verm-side)', 'var(--ink)'] }[o.emph];
          plate.style.background = c[0]; plate.style.boxShadow = `0 5px 0 ${c[1]}`; e.style.color = c[2];
        }
        let under = null;
        if (o.emph === 'under') { under = el('div', '', this.root); Object.assign(under.style, { position: 'absolute', left: '0px', top: '0px', height: Math.max(6, size * 0.08) + 'px', borderRadius: '6px', background: 'var(--verm)', transformOrigin: '0 50%' }); }
        return { ...o, el: e, plate, under, i };
      });
    }
  }
  layout() {
    for (const ph of this.phrases) {
      ph.S = this.size;
      let gap = this.size * 0.24; let x = 0;
      for (const w of ph.words) { w.w = w.el.offsetWidth; w.h = w.el.offsetHeight; }
      let total = ph.words.reduce((a, w) => a + w.w, 0) + gap * (ph.words.length - 1);
      if (total > this.width) { // shrink this phrase to fit the slot
        ph.S = Math.floor(this.size * this.width / total * 0.98);
        for (const w of ph.words) { w.el.style.fontSize = ph.S + 'px'; w.w = w.el.offsetWidth; w.h = w.el.offsetHeight; }
        gap = ph.S * 0.24; total = ph.words.reduce((a, w) => a + w.w, 0) + gap * (ph.words.length - 1);
      }
      x = this.align === 'center' ? (this.width - total) / 2 : this.align === 'right' ? this.width - total : 0;
      for (const w of ph.words) { w.x = x + 40; x += w.w + gap; w.t = (ph.times && ph.times[w.i] != null) ? ph.times[w.i] : ph.t0 + w.i * this.stagger; }
    }
  }
  render(t) {
    for (const ph of this.phrases) {
      const S = ph.S;
      const on = t >= ph.t0 - 0.1 && t < ph.t1 + 0.4;
      for (const w of ph.words) {
        for (const e of [w.el, w.plate, w.under]) if (e) e.style.display = on ? '' : 'none';
        if (!on) continue;
        const a = wordIn(t, w.t, 0.34);
        const out = expoIn(seg(t, ph.t1 + w.i * 0.025, ph.t1 + 0.26 + w.i * 0.025));
        const y = S * 0.22 + S * 1.25 * (1 - a.e) * (ph.from === 'side' ? 0 : 0.55) - S * 1.3 * out;
        const dx = ph.from === 'side' ? a.dx * 2 : 0;
        w.el.style.opacity = a.op;
        w.el.style.transform = `translate(${w.x + dx}px,${y}px) scale(${a.sc})`;
        const bl = a.blur * 0.8 + out * 10;
        w.el.style.filter = bl > 0.4 ? `blur(${bl.toFixed(2)}px)` : 'none';
        if (w.emph === 'outline') { const f = seg(t, w.t + 0.25, w.t + 0.45); w.el.style.webkitTextStroke = `${Math.max(2, S * 0.025)}px currentColor`; w.el.style.color = `rgb(244 239 230 / ${f})`; w.el.style.webkitTextStrokeColor = 'var(--paper)'; }
        if (w.plate) {
          const g = clamp(springAt(t - w.t - 0.08, 0.55, 15), 0, 1.2);
          const pw = (w.w + S * 0.36) * g;
          Object.assign(w.plate.style, { width: pw + 'px', height: S * 1.12 + 'px', borderRadius: S * 0.16 + 'px', transform: `translate(${w.x - S * 0.18}px,${y - S * 0.06}px)` });
          w.plate.style.opacity = a.op;
        }
        if (w.under) {
          const d = expoOut(seg(t, w.t + 0.3, w.t + 0.7));
          Object.assign(w.under.style, { width: w.w + 'px', transform: `translate(${w.x}px,${y + S * 1.02}px) scaleX(${d})` });
        }
      }
    }
  }
}

export function card(parent, { tc, title, img }) {
  const c = el('div', 'card', parent);
  if (img) { const i = el('img', '', c); i.src = img; }
  el('div', 'ttl', c, title);
  const tab = el('div', 'ctab', c, tc);
  return { el: c, tab };
}

export function slip(parent, text, kind = 'chat') {
  const s = el('div', 'slip', parent, text);
  Object.assign(s.style, {
    position: 'absolute', left: '0px', top: '0px', padding: '10px 18px', borderRadius: '12px', whiteSpace: 'nowrap', fontWeight: 650, fontSize: '30px', letterSpacing: '-.01em',
    background: kind === 'chat' ? 'var(--ink-high)' : 'var(--paper)', color: kind === 'chat' ? 'var(--paper)' : 'var(--ink)',
    boxShadow: kind === 'chat' ? '0 4px 0 var(--lime-side), 0 20px 40px -16px rgb(0 0 0 / .8)' : '0 5px 0 var(--paper-side), 0 24px 50px -18px rgb(0 0 0 / .8)', transformOrigin: '50% 50%',
  });
  return s;
}

export function plane(parent, src, { w, radius = 18, shadow = true } = {}) {
  const box = el('div', 'abs', parent);
  const img = el('img', '', box); img.src = src;
  Object.assign(img.style, { width: w + 'px', display: 'block', borderRadius: radius + 'px' });
  if (shadow) box.style.filter = 'drop-shadow(0 40px 60px rgb(0 0 0 / .55))';
  box.style.transformOrigin = '50% 50%';
  return { box, img };
}

export const CURSOR_SVG = '<svg viewBox="0 0 32 32" width="56" height="56"><path d="M5 3 L5 25 L11 19.5 L15 28.5 L19 26.8 L15.2 18 L23 18 Z" fill="#F4EFE6" stroke="#14171B" stroke-width="2" stroke-linejoin="round"/></svg>';
export function cursor(parent) { const c = el('div', 'abs', parent); c.innerHTML = CURSOR_SVG; c.style.filter = 'drop-shadow(0 6px 10px rgb(0 0 0 / .5))'; return c; }

/** a rebuilt button with the product's real label: pops on press */
export function button(parent, label, { tone = 'verm', size = 34 } = {}) {
  const b = el('div', 'abs', parent, label);
  const c = tone === 'verm' ? ['var(--verm)', 'var(--verm-side)', 'var(--ink)'] : tone === 'paper' ? ['var(--paper)', 'var(--paper-side)', 'var(--ink)'] : ['var(--ink-high)', '#07080a', 'var(--paper)'];
  Object.assign(b.style, { padding: `${size * 0.5}px ${size * 0.9}px`, borderRadius: size * 0.42 + 'px', background: c[0], boxShadow: `0 ${size * 0.16}px 0 ${c[1]}, 0 30px 50px -20px rgb(0 0 0 / .8)`, color: c[2], fontWeight: 750, fontSize: size + 'px', whiteSpace: 'nowrap', transformOrigin: '50% 50%' });
  return b;
}
/** press curve: 1 -> 0.93 -> overshoot 1.05 -> 1 */
export const pressScale = (t, tp) => t < tp ? 1 : t < tp + 0.07 ? 1 - 0.07 * seg(t, tp, tp + 0.07) : 0.93 + 0.07 * springAt(t - tp - 0.07, 0.32, 20);

export function hblur(elm, v) { elm.style.filter = v > 0.4 ? `url(#${dirBlur(elm, v, 0)})` : 'none'; }
export { lerp, clamp, seg, expoOut, expoIn, springAt };
