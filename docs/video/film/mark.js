import { clamp, el } from './lib.js';
export const MARK_SVG = `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg"><defs><mask id="gapM" maskUnits="userSpaceOnUse" x="0" y="0" width="96" height="96"><rect width="96" height="96" fill="#fff"/><path d="M39 12.5H71A24.5 24.5 0 0 1 95.5 37V73A24.5 24.5 0 0 1 71 97.5H39A24.5 24.5 0 0 1 14.5 73V37A24.5 24.5 0 0 1 39 12.5Z" fill="#000"/></mask><linearGradient id="sheenM" x1="0" y1="0" x2="1" y2="1"><stop offset=".2" stop-color="#FFE3BD" stop-opacity="0"/><stop offset=".42" stop-color="#FFE3BD" stop-opacity=".2"/><stop offset=".52" stop-color="#FFF7EC" stop-opacity=".26"/><stop offset=".64" stop-color="#A8E6FF" stop-opacity=".14"/><stop offset=".8" stop-color="#A8E6FF" stop-opacity="0"/></linearGradient></defs>
<g class="mk-back"><path d="M24 4H56A20 20 0 0 1 76 24V56A20 20 0 0 1 56 76H24A20 20 0 0 1 4 56V24A20 20 0 0 1 24 4Z" fill="#8F2F1C" mask="url(#gapM)"/></g>
<g class="mk-side"><path d="M39 20H71A21 21 0 0 1 92 41V73A21 21 0 0 1 71 94H39A21 21 0 0 1 18 73V41A21 21 0 0 1 39 20Z" fill="#C93F22"/></g>
<g class="mk-front"><path d="M39 16H71A21 21 0 0 1 92 37V69A21 21 0 0 1 71 90H39A21 21 0 0 1 18 69V37A21 21 0 0 1 39 16Z" fill="#FF5A36"/><path class="mk-sheen" d="M39 16H71A21 21 0 0 1 92 37V69A21 21 0 0 1 71 90H39A21 21 0 0 1 18 69V37A21 21 0 0 1 39 16Z" fill="url(#sheenM)" opacity="0"/></g>
<g class="mk-glyph" style="transform-origin:55px 53px"><path fill-rule="evenodd" d="M36 33A4 4 0 0 1 40 29H60A17 17 0 0 1 60 63H51V75A4 4 0 0 1 47 79H40A4 4 0 0 1 36 75Z M51.5 46L66 38.5L66 53.5Z" fill="#14171B"/></g></svg>`;

export function makeMark(parent) {
  const box = el('div', 'tile', parent);
  box.innerHTML = MARK_SVG;
  const q = s => box.querySelector(s);
  return { box, back: q('.mk-back'), side: q('.mk-side'), front: q('.mk-front'), glyph: q('.mk-glyph'), sheen: q('.mk-sheen') };
}
// Mark unit geometry: the front tile spans x 18..92, y 16..90 of the 96 box.
export function placeMark(m, x, y, size, o = {}) {
  const { rot = 0, sx = 1, sy = 1, back = 1, glyph = 1, sheen = 0, blur = 0, opacity = 1 } = o;
  Object.assign(m.box.style, { width: size + 'px', height: size + 'px', transform: `translate(${x}px,${y}px) rotate(${rot}deg) scale(${sx},${sy})`, opacity });
  m.back.style.opacity = clamp(back); m.back.style.transform = `translate(${(1 - back) * 12}px,${(1 - back) * 10}px)`;
  m.side.style.opacity = clamp(back * 1.5);
  m.glyph.style.transform = `scale(${glyph})`; m.glyph.style.opacity = clamp(glyph * 2);
  m.sheen.setAttribute('opacity', sheen);
  m.box.style.filter = blur > 0.3 ? `blur(${blur}px)` : 'none';
}

