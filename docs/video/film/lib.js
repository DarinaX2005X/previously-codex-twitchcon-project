export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const lerp = (a, b, p) => a + (b - a) * p;
export const expoOut = p => p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
export const expoIn = p => p <= 0 ? 0 : Math.pow(2, 10 * (p - 1));
export const expoInOut = p => p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2;
export const cubicInOut = p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
export const backOut = (p, s = 1.70158) => { p = clamp(p); const c3 = s + 1; return 1 + c3 * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2); };
// closed-form damped spring from 0 to 1, time in seconds since start; 0 before start
export function springAt(dt, z = 0.6, w = 14) {
  if (dt <= 0) return 0;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * dt) * (Math.cos(wd * dt) + (z * w / wd) * Math.sin(wd * dt));
}
export const bezier2 = (a, c, b, p) => ({ x: (1 - p) * (1 - p) * a.x + 2 * (1 - p) * p * c.x + p * p * b.x, y: (1 - p) * (1 - p) * a.y + 2 * (1 - p) * p * c.y + p * p * b.y });
export function el(tag, cls, parent, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; }
const NS = 'http://www.w3.org/2000/svg';
export function svgEl(tag, parent, attrs = {}) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; }
// directional blur: one SVG filter per element, stdDeviation updated per frame
let defs = null, n = 0; const map = new WeakMap();
export function dirBlur(elm, x, y) {
  if (!defs) { const s = svgEl('svg', document.body, { width: 0, height: 0, style: 'position:absolute' }); defs = svgEl('defs', s); }
  let f = map.get(elm);
  if (!f) { const id = 'db' + (n++); const fl = svgEl('filter', defs, { id, x: '-60%', y: '-100%', width: '220%', height: '300%', 'color-interpolation-filters': 'sRGB' }); const g = svgEl('feGaussianBlur', fl, { stdDeviation: '0 0' }); f = { id, g }; map.set(elm, f); }
  f.g.setAttribute('stdDeviation', `${(x / 2).toFixed(2)} ${(y / 2).toFixed(2)}`);
  return f.id;
}
export const fmtTime = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const mixColor = (a, b, p) => a.map((v, i) => Math.round(lerp(v, b[i], p)));
