"""Sound design palette for the Previously film: tape and felt, paper and ceramic.
Each generator is deterministic per event id: pitch +-5 %, level +-2 dB and timbre vary by id."""
import numpy as np
from dsp import SR, rng, exp_decay, lp, hp, bp, sweep_filter, saw, osc_phase, pan, soft_clip, midi_hz

D_MINOR = [62, 64, 65, 67, 69, 70, 72, 74, 76, 77, 79, 81]


def _var(eid, spread=0.05):
    r = rng('sfx', eid)
    return 1 + spread * (2 * r.uniform() - 1), 10 ** ((2 * r.uniform() - 1) * 2 / 20), r


def thump(e, big=False):
    pv, gv, r = _var(e['id'])
    n = int((0.42 if big else 0.28) * SR); t = np.arange(n) / SR
    f = (62 if big else 78) * pv + (140 if big else 110) * np.exp(-t / 0.03)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * exp_decay(n, 0.14 if big else 0.09)
    felt = lp(r.standard_normal(n), 900) * exp_decay(n, 0.02) * 0.6
    tap = bp(r.standard_normal(n), 1800, 4200) * exp_decay(n, 0.004) * 0.25
    return (body + felt + tap) * gv * (0.7 if big else 0.5)


def tick(e):
    pv, gv, r = _var(e['id'], 0.08)
    n = int(0.06 * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * 2600 * pv * t) * exp_decay(n, 0.008) + hp(r.standard_normal(n), 3000) * exp_decay(n, 0.003) * 0.6
    return x * gv * 0.22


def plate(e):
    pv, gv, r = _var(e['id'])
    n = int(0.3 * SR); t = np.arange(n) / SR
    slap = bp(r.standard_normal(n), 500, 3200) * exp_decay(n, 0.03)
    body = np.sin(2 * np.pi * (150 * pv + 60 * np.exp(-t / 0.02)) * t) * exp_decay(n, 0.08)
    return (slap * 0.55 + body * 0.6) * gv * 0.55


def pop(e):
    pv, gv, r = _var(e['id'], 0.07)
    n = int(0.16 * SR); t = np.arange(n) / SR
    base = 1.0
    if e.get('note') is not None:
        base = midi_hz(D_MINOR[int(e['note']) % 12]) / 440
    f = (220 + 700 * np.exp(-t / 0.012)) * pv * base
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * exp_decay(n, 0.05)
    click = hp(r.standard_normal(n), 2500) * exp_decay(n, 0.002) * 0.4
    return (x + click) * gv * 0.45


def click(e):
    pv, gv, r = _var(e['id'])
    n = int(0.3 * SR); t = np.arange(n) / SR
    tr = bp(r.standard_normal(n), 1800, 4500) * exp_decay(n, 0.003) * 0.9
    thud = np.sin(2 * np.pi * (95 * pv + 120 * np.exp(-t / 0.015)) * t) * exp_decay(n, 0.07)
    ring = np.sin(2 * np.pi * 587 * t) * exp_decay(n, 0.05) * 0.12
    return soft_clip((tr + thud + ring) * gv, 1.3) * 0.7


def morph(e):
    pv, gv, r = _var(e['id'])
    dur = e.get('dur') or 0.5; n = int((dur + 0.15) * SR); t = np.arange(n) / SR
    p = np.clip(t / dur, 0, 1)
    f = (180 + 520 * (p ** 1.6)) * pv
    ph = osc_phase(f, n)
    x = saw(ph) * 0.6 + saw(ph * 1.5) * 0.25
    x = sweep_filter(x, 400 + 3000 * np.sin(np.pi * p) ** 2, 'band', 2.5)
    env = np.sin(np.pi * np.clip(t / (dur + 0.1), 0, 1)) ** 1.2
    air = bp(r.standard_normal(n), 2000, 7000) * env * 0.15
    return (x * env + air) * gv * 0.5


def whoosh(e):
    pv, gv, r = _var(e['id'])
    dur = e.get('dur') or 0.4; n = int((dur + 0.2) * SR); t = np.arange(n) / SR
    p = np.clip(t / dur, 0, 1)
    vel = np.exp(-((p - 0.55) / 0.22) ** 2)
    x = r.standard_normal(n)
    x = sweep_filter(x, (500 + 4200 * vel) * pv, 'band', 1.2)
    x = x * (vel + 0.05) * np.where(t < dur, 1, np.exp(-(t - dur) / 0.05))
    return x * gv * 0.6


def air(e):
    pv, gv, r = _var(e['id'])
    dur = e.get('dur') or 1.0; n = int((dur + 0.3) * SR); t = np.arange(n) / SR
    env = np.sin(np.pi * np.clip(t / (dur + 0.3), 0, 1)) ** 2
    x = sweep_filter(r.standard_normal(n), 800 + 2500 * env, 'band', 0.7)
    return x * env * gv * 0.25


def riser(e):
    pv, gv, r = _var(e['id'])
    dur = e.get('dur') or 2.0; n = int(dur * SR); t = np.arange(n) / SR
    p = t / dur
    noise = sweep_filter(r.standard_normal(n), 300 + 7000 * p ** 2, 'low', 1.4)
    ph = osc_phase(110 * 2 ** (2 * p), n)
    tone = sweep_filter(saw(ph) + saw(ph * 1.01), 300 + 3500 * p ** 2, 'low', 1.0)
    env = p ** 2.2
    return (noise * 0.6 + tone * 0.25) * env * gv * 0.5


def impact(e):
    pv, gv, r = _var(e['id'])
    n = int(2.2 * SR); t = np.arange(n) / SR
    sub = np.sin(2 * np.pi * np.cumsum(38 + 40 * np.exp(-t / 0.08)) / SR) * exp_decay(n, 0.45)
    punch = lp(r.standard_normal(n), 2500) * exp_decay(n, 0.012) * 0.9
    shimmer = sum(np.sin(2 * np.pi * f * t + r.uniform() * 6) * exp_decay(n, 0.6 + 0.3 * k) for k, f in enumerate([1174.7, 1480, 1760, 2349.3]))
    shimmer = shimmer * 0.06 * np.clip(t / 0.02, 0, 1)
    return soft_clip((sub * 0.95 + punch + shimmer) * gv, 1.3) * 0.85


def letters(e):
    out = np.zeros(int(((e.get('dur') or 0.5) + 0.1) * SR))
    for i in range(10):
        ee = {'id': f"{e['id']}-{i}"}
        x = tick(ee) * (0.7 + 0.03 * i)
        n = len(x); t = np.arange(n) / SR
        x = x * 0.5 + np.sin(2 * np.pi * midi_hz(D_MINOR[i % 7] + 12) * t) * exp_decay(n, 0.02) * 0.05
        i0 = int(i * 0.035 * SR)
        out[i0:i0 + n] += x[:len(out) - i0]
    return out


def draw(e):
    pv, gv, r = _var(e['id'])
    dur = e.get('dur') or 0.5; n = int(dur * SR); t = np.arange(n) / SR
    am = 0.6 + 0.4 * np.abs(np.sin(2 * np.pi * (13 + 5 * r.uniform()) * t))
    x = bp(r.standard_normal(n), 2500, 8000) * am * np.sin(np.pi * t / dur) ** 0.6
    return x * gv * 0.18


def tapestop(e):
    """the mechanical part of the rewind press: a low clunk and a motor whine falling"""
    pv, gv, r = _var(e['id'])
    n = int(0.45 * SR); t = np.arange(n) / SR
    clunk = lp(r.standard_normal(n), 600) * exp_decay(n, 0.025)
    whine = np.sin(2 * np.pi * np.cumsum(900 * np.exp(-t / 0.08) + 60) / SR) * exp_decay(n, 0.12) * 0.25
    return (clunk * 0.8 + whine) * gv * 0.6


def rewind(e):
    """tape spooling backward: chattering high squeal with fast wobble plus hiss"""
    pv, gv, r = _var(e['id'])
    dur = e.get('dur') or 1.2; n = int(dur * SR); t = np.arange(n) / SR
    p = t / dur
    speed = np.sin(np.pi * np.clip(p, 0, 1)) ** 0.7
    wob = np.cumsum(r.standard_normal(n)) ; wob = lp(wob - np.mean(wob), 18); wob /= (np.max(np.abs(wob)) + 1e-9)
    f = (900 + 2600 * speed) * (1 + 0.18 * wob)
    ph = osc_phase(f, n)
    tones = (saw(ph) * 0.4 + np.sin(2 * np.pi * ph * 1.5) * 0.3)
    chatter = 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * (28 + 30 * speed) * t))
    tones = bp(tones * (0.6 + 0.4 * chatter), 700, 6000)
    hiss = lp(hp(r.standard_normal(n), 3000), 9000) * 0.1
    return (tones * 0.5 + hiss) * speed * gv * 0.4


def tapeland(e):
    pv, gv, r = _var(e['id'])
    n = int(0.32 * SR); t = np.arange(n) / SR
    f = 1400 * np.exp(-t / 0.07) + 60
    x = bp(saw(osc_phase(f, n)), 80, 4000) * exp_decay(n, 0.12)
    thud = np.sin(2 * np.pi * 70 * t) * exp_decay(n, 0.05) * 0.5
    return (x * 0.4 + thud) * gv * 0.6


def drop(e):
    pv, gv, r = _var(e['id'])
    n = int(0.9 * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * np.cumsum(32 + 50 * np.exp(-t / 0.15)) / SR) * exp_decay(n, 0.35)
    return x * gv * 0.7


# palette for later passages
def shutter(e):
    pv, gv, r = _var(e['id']); n = int(0.18 * SR)
    a = bp(r.standard_normal(n), 2000, 7000) * exp_decay(n, 0.004)
    b = np.roll(bp(r.standard_normal(n), 1200, 5000) * exp_decay(n, 0.006), int(0.045 * SR))
    return (a + b * 0.8) * gv * 0.5


def flick(e):
    pv, gv, r = _var(e['id']); n = int(0.14 * SR); t = np.arange(n) / SR
    x = sweep_filter(r.standard_normal(n), 3000 * pv * (1 + t * 8), 'band', 1.5) * exp_decay(n, 0.03)
    return x * gv * 0.4


def stamp(e):
    pv, gv, r = _var(e['id']); n = int(0.25 * SR); t = np.arange(n) / SR
    return (lp(r.standard_normal(n), 1200) * exp_decay(n, 0.02) + np.sin(2 * np.pi * 120 * t) * exp_decay(n, 0.05)) * gv * 0.6


def ceramic(e):
    pv, gv, r = _var(e['id']); n = int(0.6 * SR); t = np.arange(n) / SR
    f0 = midi_hz(81) * pv
    x = sum(np.sin(2 * np.pi * f0 * k * t) * exp_decay(n, 0.25 / k) for k in (1, 2.76, 5.4))
    return (x * 0.2 + hp(r.standard_normal(n), 5000) * exp_decay(n, 0.002) * 0.3) * gv * 0.5


def chatter(e):
    pv, gv, r = _var(e['id']); dur = e.get('dur') or 2.0; n = int(dur * SR); out = np.zeros(n)
    k = int(dur * 30)
    for i in range(k):
        t0 = (i / k) * dur + r.uniform(0, 0.03); m = int(0.04 * SR); tt = np.arange(m) / SR
        blip = np.sin(2 * np.pi * r.uniform(700, 2400) * tt) * exp_decay(m, 0.01) * r.uniform(0.3, 1)
        j = int(t0 * SR); out[j:j + m] += blip[:max(0, n - j)]
    return out * np.sin(np.pi * np.arange(n) / n) * gv * 0.25


def key(e):
    pv, gv, r = _var(e['id'], 0.1); n = int(0.05 * SR)
    return bp(r.standard_normal(n), r.uniform(1500, 3500), r.uniform(5000, 8000)) * exp_decay(n, r.uniform(0.004, 0.009)) * gv * 0.3


def chime(e):
    pv, gv, r = _var(e['id']); n = int(1.4 * SR); t = np.arange(n) / SR
    return sum(np.sin(2 * np.pi * midi_hz(m) * t) * exp_decay(n, 0.5) * np.clip((t - d) * 50, 0, 1) for m, d in ((74, 0), (78, 0.08), (81, 0.16))) * gv * 0.12


def sweep(e):
    pv, gv, r = _var(e['id']); dur = e.get('dur') or 0.8; n = int(dur * SR); p = np.arange(n) / n
    return sweep_filter(r.standard_normal(n), 6000 - 5500 * p, 'band', 2) * np.sin(np.pi * p) * gv * 0.4


GEN = {'thump': thump, 'thumpBig': lambda e: thump(e, True), 'tick': tick, 'plate': plate, 'pop': pop, 'click': click, 'morph': morph,
       'whoosh': whoosh, 'air': air, 'riser': riser, 'impact': impact, 'letters': letters, 'draw': draw, 'tapestop': tapestop,
       'rewind': rewind, 'tapeland': tapeland, 'drop': drop, 'shutter': shutter, 'flick': flick, 'stamp': stamp, 'ceramic': ceramic,
       'chatter': chatter, 'key': key, 'chime': chime, 'sweep': sweep, 'hush': lambda e: np.zeros(16)}


def render_event(e):
    x = GEN[e['kind']](e)
    p0 = (e.get('x', 0.5) - 0.5) * 1.6
    if e.get('pan2') is not None:
        p1 = (e['pan2'] - 0.5) * 1.6
        pp = np.linspace(p0, p1, len(x))
        a = (np.clip(pp, -1, 1) + 1) * np.pi / 4
        return np.stack([x * np.cos(a), x * np.sin(a)])
    return pan(x, p0)
