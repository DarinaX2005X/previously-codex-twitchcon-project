/** Pure easing and physics helpers. Every scene property is a function of absolute scene time. */
export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const seg = (t: number, a: number, b: number) => b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a));
export const mix = (a: number, b: number, p: number) => a + (b - a) * p;

function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break; t -= e / d; }
    return sy(clamp(t));
  };
}
/** Entrances: cubic-bezier(.16,1,.3,1). */
export const enter = bezier(.16, 1, .3, 1);
/** Exits accelerate away. */
export const exitIn = bezier(.55, 0, .9, .4);
/** Moves between positions: quick start, long landing. */
export const glide = bezier(.6, 0, .2, 1);
export const expoOut = (p: number) => p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
export const quadIn = (p: number) => p * p;

/** Closed-form damped spring step response, t in seconds. 1 at rest, overshoots for zeta < 1. */
export function spring(tSec: number, zeta = .62, omega = 15): number {
  if (tSec <= 0) return 0;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * tSec) * (Math.cos(wd * tSec) + zeta * omega / wd * Math.sin(wd * tSec));
}
/** Spring that starts at time `at` (ms). */
export const springAt = (t: number, at: number, zeta = .62, omega = 15) => spring((t - at) / 1000, zeta, omega);
/** A one-shot impact pulse 0→1→0 (for squash on contact), peak at `at`. */
export function pulse(t: number, at: number, width = 220): number {
  if (t < at - width * .25 || t > at + width) return 0;
  if (t < at) return seg(t, at - width * .25, at);
  const p = (t - at) / width;
  return Math.exp(-5 * p) * Math.cos(p * Math.PI * 1.5) * (1 - p);
}
/** Deterministic hash → [0,1). */
export function rand(seed: string | number, salt = 0): number {
  let h = 2166136261 ^ salt;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
export const timecode = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
