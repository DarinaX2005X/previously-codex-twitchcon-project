import type { SceneSoundEvent } from './scene.js';

/**
 * Synthesized scene palette (Web Audio only, no samples or music). Each sound belongs to one kind of
 * visual event from the scene timeline: swoosh, felt thump, tape-rewind chirp, card flick, shutter latch,
 * paper slide, chatter swell (granular), ceramic taps, felt tone, two-note resolve and release.
 * Pitch varies by ±3 % seeded from the event id; at most two voices plus the chatter layer; master limiter.
 */
type Ctx = BaseAudioContext;
type Voice = { sources: AudioScheduledSourceNode[]; nodes: AudioNode[]; endAt: number; granular: boolean };

const hashOf = (id: string) => [...id].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 7);
export const pitchVariation = (id: string) => .97 + (hashOf(id) % 601) / 10000;

function noiseBuffer(ctx: Ctx, seconds: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate), data = buffer.getChannelData(0);
  let s = seed || 1;
  for (let i = 0; i < length; i++) { s = (Math.imul(1664525, s) + 1013904223) >>> 0; data[i] = (s / 4294967296) * 2 - 1; }
  return buffer;
}
/** Natural length of each sound, used for voice stealing and the offline render. */
export function sfxLength(event: SceneSoundEvent): number {
  switch (event.kind) {
    case 'swoosh': return .42; case 'release': return .5; case 'thump': return .3; case 'tap': case 'tap2': return .22;
    case 'rewind': return .36; case 'slide': return .26; case 'flick': return .09; case 'latch': return .2;
    case 'chatter': return (event.durationMs ?? 1200) / 1000 + .1; case 'felt': return (event.durationMs ?? 1100) / 1000 + .3; case 'resolve': return .8;
    default: return .25;
  }
}

/** Schedules one event into `dest` at context time `when`. Returns the voice so the caller can stop it early. */
export function scheduleSfx(ctx: Ctx, dest: AudioNode, event: SceneSoundEvent, when: number): Voice {
  const seed = hashOf(event.id), v = pitchVariation(event.id), level = Math.max(0, Math.min(1, event.gain)) * .5;
  const sources: AudioScheduledSourceNode[] = [], nodes: AudioNode[] = [];
  const gainNode = (value = 0) => { const g = ctx.createGain(); g.gain.value = value; nodes.push(g); return g; };
  const filter = (type: BiquadFilterType, frequency: number, q = .7) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = frequency; f.Q.value = q; nodes.push(f); return f; };
  const env = (g: GainNode, at: number, peak: number, attack: number, decay: number) => {
    g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(Math.max(.0002, peak), at + attack); g.gain.exponentialRampToValueAtTime(.0001, at + attack + decay);
  };
  const noise = (at: number, seconds: number, chain: AudioNode, salt = 0) => {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, seconds, seed + salt); src.connect(chain); src.start(at); src.stop(at + seconds); sources.push(src); return src;
  };
  const tone = (type: OscillatorType, at: number, seconds: number, from: number, to: number | null, chain: AudioNode, glide = seconds) => {
    const osc = ctx.createOscillator(); osc.type = type; osc.frequency.setValueAtTime(from, at); if (to) osc.frequency.exponentialRampToValueAtTime(to, at + glide);
    osc.connect(chain); osc.start(at); osc.stop(at + seconds); sources.push(osc); return osc;
  };
  const t = when;
  switch (event.kind) {
    case 'swoosh': case 'release': {
      // Air: band-passed noise sweeping up (swoosh) or down (release), shaped like a passing object.
      const down = event.kind === 'release';
      const f = filter('bandpass', down ? 2200 * v : 380 * v, .9), g = gainNode(); noise(t, .45, f); f.connect(g); g.connect(dest);
      f.frequency.setValueAtTime(down ? 2200 * v : 380 * v, t); f.frequency.exponentialRampToValueAtTime(down ? 260 * v : 2600 * v, t + .38);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(level * .9, t + (down ? .07 : .26)); g.gain.exponentialRampToValueAtTime(.0001, t + .42);
      break;
    }
    case 'thump': {
      // Felt thump: a dropping sine body under a short muffled noise contact.
      const body = gainNode(); env(body, t, level * 1.25, .004, .24); tone('sine', t, .3, 150 * v, 52 * v, body, .12); body.connect(dest);
      const lp = filter('lowpass', 900 * v, .5), contact = gainNode(); env(contact, t, level * .55, .002, .05); noise(t, .08, lp, 1); lp.connect(contact); contact.connect(dest);
      break;
    }
    case 'tap': case 'tap2': {
      // Ceramic tap: two inharmonic partials with a bright, fast decay; the second tap sits a little higher.
      const base = (event.kind === 'tap2' ? 2260 : 1900) * v;
      const g = gainNode(); env(g, t, level * .5, .002, .16); tone('sine', t, .2, base, null, g); g.connect(dest);
      const h = gainNode(); env(h, t, level * .22, .001, .07); tone('sine', t, .1, base * 2.76, null, h); h.connect(dest);
      const hp = filter('highpass', 4000, .7), click = gainNode(); env(click, t, level * .25, .001, .015); noise(t, .03, hp, 2); hp.connect(click); click.connect(dest);
      break;
    }
    case 'rewind': {
      // Tape rewind chirp: a warbling saw swept down an octave and a half through a closing low-pass.
      const lp = filter('lowpass', 2600 * v, 3), g = gainNode(); env(g, t, level * .55, .01, .32);
      const osc = tone('sawtooth', t, .36, 900 * v, 210 * v, lp, .3);
      const wob = ctx.createOscillator(), depth = gainNode(28 * v); wob.frequency.value = 27; wob.connect(depth); depth.connect(osc.frequency); wob.start(t); wob.stop(t + .36); sources.push(wob);
      lp.frequency.setValueAtTime(2600 * v, t); lp.frequency.exponentialRampToValueAtTime(500 * v, t + .32); lp.connect(g); g.connect(dest);
      break;
    }
    case 'slide': {
      // Paper slide: soft band-passed friction with a short swell.
      const f = filter('bandpass', 2900 * v, .8), g = gainNode(); noise(t, .26, f, 3); f.connect(g); g.connect(dest);
      f.frequency.setValueAtTime(3200 * v, t); f.frequency.exponentialRampToValueAtTime(1700 * v, t + .22);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(level * .8, t + .05); g.gain.exponentialRampToValueAtTime(.0001, t + .25);
      break;
    }
    case 'flick': {
      // Card flick: a crisp high noise snap with a tiny pitched click.
      const hp = filter('highpass', 2800 * v, .9), g = gainNode(); env(g, t, level * .7, .001, .05); noise(t, .07, hp, 4); hp.connect(g); g.connect(dest);
      const c = gainNode(); env(c, t, level * .3, .001, .025); tone('triangle', t, .04, 1400 * v, 900 * v, c); c.connect(dest);
      break;
    }
    case 'latch': {
      // Shutter latch: two mechanical clicks 28 ms apart over a small low thud.
      for (const [i, at, f0] of [[0, t, 1700], [1, t + .028, 3100]] as const) {
        const bp = filter('bandpass', f0 * v, 2.2), g = gainNode(); env(g, at, level * .8, .001, .035); noise(at, .05, bp, 5 + i); bp.connect(g); g.connect(dest);
      }
      const thud = gainNode(); env(thud, t + .02, level * .7, .003, .12); tone('sine', t + .02, .16, 110 * v, 70 * v, thud, .1); thud.connect(dest);
      break;
    }
    case 'chatter': {
      // Granular chatter swell: many tiny filtered blips whose density rises and falls with the burst.
      const length = (event.durationMs ?? 1200) / 1000, grains = Math.round(length * 70);
      const bus = gainNode(level * 1.25), bp = filter('bandpass', 1500 * v, .6); bp.connect(bus); bus.connect(dest);
      let s = seed;
      const next = () => { s = (Math.imul(1103515245, s) + 12345) >>> 0; return s / 4294967296; };
      for (let i = 0; i < grains; i++) {
        // Density shaped like a swell: more grains near 40 % of the window.
        const u = next(), x = Math.pow(u, .85);
        const at = t + x * length, shape = Math.sin(Math.min(1, x / .95) * Math.PI);
        if (next() > .25 + .75 * shape) continue;
        const f0 = (650 + next() * 1700) * v, d = .018 + next() * .03;
        const g = gainNode(); env(g, at, .18 + .3 * shape, .002, d);
        tone(next() > .5 ? 'triangle' : 'sine', at, d + .01, f0, f0 * (next() > .5 ? 1.18 : .86), g, d); g.connect(bp);
      }
      break;
    }
    case 'felt': {
      // Low felt tone under the merge: a soft fifth that swells and settles.
      const length = (event.durationMs ?? 1100) / 1000;
      const lp = filter('lowpass', 520, .4), g = gainNode(); lp.connect(g); g.connect(dest);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(level * .5, t + .12); g.gain.exponentialRampToValueAtTime(.0001, t + length + .25);
      tone('triangle', t, length + .3, 98 * v, null, lp); tone('sine', t, length + .3, 147 * v, null, lp);
      break;
    }
    case 'resolve': {
      // Two-note resolve on settle: a soft mallet fourth.
      for (const [at, f0] of [[t, 587.3], [t + .13, 783.99]] as const) {
        const g = gainNode(); env(g, at, level * .55, .004, .55); tone('sine', at, .62, f0 * v, null, g); g.connect(dest);
        const o = gainNode(); env(o, at, level * .14, .002, .2); tone('sine', at, .25, f0 * 3 * v, null, o); o.connect(dest);
      }
      break;
    }
    default: {
      const g = gainNode(); env(g, t, level * .5, .004, .2); tone('sine', t, .24, 220 * v, 160 * v, g); g.connect(dest);
    }
  }
  return { sources, nodes, endAt: when + sfxLength(event), granular: event.kind === 'chatter' };
}

function stopVoice(voice: Voice, at?: number) {
  for (const s of voice.sources) { s.onended = null; try { if (at === undefined) s.stop(); else s.stop(at); } catch { /* already stopped */ } if (at === undefined) s.disconnect(); }
  if (at === undefined) for (const n of voice.nodes) n.disconnect();
}
function masterChain(ctx: Ctx, volume: number, makeup = 0): GainNode {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -9; limiter.knee.value = 4; limiter.ratio.value = 20; limiter.attack.value = .002; limiter.release.value = .12;
  const output = ctx.createGain(); output.gain.value = Math.max(0, Math.min(.6, volume));
  if (!makeup) { output.connect(limiter); limiter.connect(ctx.destination); return output; }
  // Mastered for the video edit: a gentle glue compressor, make-up gain, then a brick-wall style limiter.
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -26; glue.knee.value = 10; glue.ratio.value = 4; glue.attack.value = .004; glue.release.value = .2;
  const gain = ctx.createGain(); gain.gain.value = makeup;
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.attack.value = .001; limiter.release.value = .08;
  output.connect(glue); glue.connect(gain); gain.connect(limiter); limiter.connect(ctx.destination);
  return output;
}

/** Real-time player bound to one scene. Silent until enabled; a seek never dumps skipped cues. */
export class SceneSound {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private voices: Voice[] = [];
  private seen = new Set<string>();
  private previous = 0;
  constructor(private readonly volume = .45, private readonly blocked: () => void = () => {}) {}
  async enable(): Promise<boolean> {
    try {
      if (!this.context) { this.context = new AudioContext(); this.output = masterChain(this.context, this.volume); }
      await this.context.resume(); if (this.context.state !== 'running') { this.blocked(); return false; } return true;
    } catch { this.blocked(); return false; }
  }
  tick(timeMs: number, events: SceneSoundEvent[]): void {
    if (timeMs < this.previous) { this.stopVoices(); this.seen.clear(); }
    for (const event of events) {
      if (event.atMs > timeMs || this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      if (timeMs - event.atMs <= 100 && event.atMs >= this.previous) this.play(event);
    }
    this.previous = timeMs;
  }
  private play(event: SceneSoundEvent): void {
    const ctx = this.context; if (!ctx || ctx.state !== 'running' || !this.output) return;
    const now = ctx.currentTime;
    this.voices = this.voices.filter(v => { if (v.endAt > now) return true; stopVoice(v); return false; });
    if (event.kind !== 'chatter') {
      const tonal = this.voices.filter(v => !v.granular);
      while (tonal.length >= 2) { const old = tonal.shift()!; stopVoice(old); this.voices = this.voices.filter(v => v !== old); }
    }
    this.voices.push(scheduleSfx(ctx, this.output, event, now + .005));
  }
  private stopVoices(): void { for (const v of this.voices) stopVoice(v); this.voices = []; }
  stop(): void { this.stopVoices(); this.seen.clear(); this.previous = 0; const ctx = this.context; this.context = null; this.output = null; if (ctx) void ctx.close(); }
}

/**
 * Renders the scene's sound events offline with the same synthesis, voice limit and limiter as the
 * broadcast, and returns a 16-bit stereo WAV. Runs in a browser (OfflineAudioContext).
 */
/** Make-up gain of the offline master, tuned so the 12 s scene measures about -16 LUFS integrated. */
export const SFX_MASTER_MAKEUP = 2.6;
export async function renderSceneSfxWav(events: SceneSoundEvent[], durationMs: number, sampleRate = 48000, volume = .5, makeup = SFX_MASTER_MAKEUP): Promise<ArrayBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * (durationMs / 1000 + .6)), sampleRate);
  const output = masterChain(ctx, volume, makeup);
  const ordered = [...events].sort((a, b) => a.atMs - b.atMs);
  const tonal: Voice[] = [];
  for (const event of ordered) {
    const at = event.atMs / 1000;
    if (event.kind !== 'chatter') {
      const active = tonal.filter(v => v.endAt > at);
      if (active.length >= 2) stopVoice(active[0]!, at);
    }
    const voice = scheduleSfx(ctx, output, event, at);
    if (!voice.granular) tonal.push(voice);
  }
  const buffer = await ctx.startRendering();
  // Never clip: keep sample peaks at or below -1 dBFS.
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) for (const v of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  const ceiling = Math.pow(10, -1 / 20);
  if (peak > ceiling) for (let c = 0; c < buffer.numberOfChannels; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < data.length; i++) data[i]! *= ceiling / peak; }
  return encodeWav(buffer);
}

export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels, length = buffer.length, rate = buffer.sampleRate;
  const out = new ArrayBuffer(44 + length * channels * 2), view = new DataView(out);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + length * channels * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, length * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) { const s = Math.max(-1, Math.min(1, data[c]![i]!)); view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true); offset += 2; }
  return out;
}
