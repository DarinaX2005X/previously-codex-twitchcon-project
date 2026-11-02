"""Original score for the Previously film: 120 BPM, D minor, sections follow BEATS.md.
Renders stems (drums, bass, keys, pad, lead) for the whole film. Deterministic.
python music.py <out_dir> [--events film-events.json] [--dur 148]"""
import json, os, sys
import numpy as np
from dsp import (SR, rng, t_axis, midi_hz, n2m, env_adsr, exp_decay, lp, hp, bp, sweep_filter, saw, osc_phase, pan, place,
                 reverb_ir, convolve, delay, soft_clip, write_wav)

BPM = 120
BEAT = 60 / BPM
BAR = 4 * BEAT


def bt(bar, beat=0.0):
    """time of (1-indexed bar, beat offset in beats)"""
    return (bar - 1) * BAR + beat * BEAT


# ---------------- instruments ----------------
def kick(vel=1.0, key=0, tone=1.0):
    n = int(0.45 * SR); t = np.arange(n) / SR
    f = 46 + 110 * np.exp(-t / 0.035) * tone
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * exp_decay(n, 0.16)
    click = lp(rng('kick', key).standard_normal(n) * exp_decay(n, 0.003), 4000) * 0.5
    return soft_clip((body + click) * vel, 1.4) * 0.95


def snare(vel=1.0, key=0):
    n = int(0.3 * SR); r = rng('snare', key)
    noise = bp(r.standard_normal(n), 1400, 7500) * exp_decay(n, 0.07)
    body = np.sin(2 * np.pi * 185 * np.arange(n) / SR) * exp_decay(n, 0.04)
    return (noise * 0.9 + body * 0.6) * vel * 0.6


def clap(vel=1.0, key=0):
    n = int(0.35 * SR); r = rng('clap', key); x = np.zeros(n)
    for k, off in enumerate([0, 0.009, 0.019, 0.03]):
        i = int(off * SR); m = n - i
        x[i:] += r.standard_normal(m) * exp_decay(m, 0.012 if k < 3 else 0.11)
    return bp(x, 900, 5200) * vel * 0.5


def hat(vel=1.0, key=0, open_=False):
    n = int((0.32 if open_ else 0.06) * SR); r = rng('hat', key)
    x = lp(hp(r.standard_normal(n), 6500, 3), 12500, 2) * exp_decay(n, 0.09 if open_ else 0.014)
    return x * vel * 0.2


def rim(vel=1.0, key=0):
    n = int(0.08 * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * 1650 * t) * exp_decay(n, 0.012) + bp(rng('rim', key).standard_normal(n), 2000, 6000) * exp_decay(n, 0.004)
    return x * vel * 0.25


def bass(m, dur, vel=1.0, cutoff=520, key=0):
    n = int((dur + 0.12) * SR); f = midi_hz(m)
    ph = osc_phase(f, n)
    sub = np.sin(2 * np.pi * ph)
    s = saw(ph * 1.003) * 0.6 + saw(ph * 0.997) * 0.6
    s = lp(s, cutoff, 2)
    e = env_adsr(n, 0.005, 0.12, 0.75, 0.1, hold=None)
    return soft_clip((sub * 0.85 + s * 0.45) * e * vel, 1.2) * 0.55


def epiano(m, dur, vel=1.0, key=0):
    n = int((dur + 0.9) * SR); t = np.arange(n) / SR; f = midi_hz(m)
    idx = 2.2 * vel * np.exp(-t / 0.35)
    mod = np.sin(2 * np.pi * f * t) * idx
    car = np.sin(2 * np.pi * f * t + mod)
    tine = np.sin(2 * np.pi * f * 7.02 * t) * np.exp(-t / 0.03) * 0.15 * vel
    e = np.exp(-t / (0.9 + 0.4 * (60 - min(m, 84)) / 24))
    rel = np.ones(n); r0 = int(dur * SR); rel[r0:] = np.exp(-np.arange(n - r0) / (0.12 * SR))
    trem = 1 + 0.08 * np.sin(2 * np.pi * 4.6 * t)
    mono = (car + tine) * e * rel * vel * 0.26
    return np.stack([mono * trem, mono * (2 - trem)])


def pluck(m, dur=0.6, vel=1.0, key=0, bright=0.5):
    f = midi_hz(m); N = max(2, int(SR / f)); n = int((dur + 0.4) * SR)
    r = rng('pluck', m, key)
    buf = lp(r.uniform(-1, 1, N), 2000 + 7000 * bright, 1)
    out = np.zeros(n); d = 0.996 - 0.004 * (1 - bright)
    # vectorised Karplus-Strong by blocks of N
    cur = buf.copy()
    for i in range(0, n, N):
        k = min(N, n - i); out[i:i + k] = cur[:k]
        cur = d * 0.5 * (cur + np.roll(cur, -1))
    body = np.sin(2 * np.pi * f * np.arange(n) / SR) * exp_decay(n, 0.25) * 0.3
    return (out + body) * vel * 0.4 * exp_decay(n, dur * 0.8)


def bell(m, dur=1.2, vel=1.0, key=0):
    n = int((dur + 1.0) * SR); t = np.arange(n) / SR; f = midi_hz(m)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * 2.4 * np.exp(-t / 0.4)
    x = np.sin(2 * np.pi * f * t + mod) * np.exp(-t / 0.9)
    x += np.sin(2 * np.pi * f * 2.0 * t) * np.exp(-t / 0.5) * 0.25
    return x * vel * 0.18


def lead(m, dur, vel=1.0, cutoff=2600, key=0):
    n = int((dur + 0.15) * SR); f = midi_hz(m)
    t = np.arange(n) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.clip((t - 0.15) / 0.2, 0, 1)
    ph = osc_phase(f * vib, n)
    x = saw(ph) * 0.5 + saw(ph * 1.006) * 0.5 + np.sign(np.sin(2 * np.pi * ph * 0.5)) * 0.15
    x = lp(x, cutoff, 2)
    return x * env_adsr(n, 0.01, 0.2, 0.6, 0.12) * vel * 0.16


def arp_note(m, dur, vel, cutoff, key=0):
    n = int((dur + 0.08) * SR); ph = osc_phase(midi_hz(m), n)
    x = saw(ph) * 0.7 + np.sign(np.sin(2 * np.pi * ph)) * 0.3
    x = lp(x, cutoff, 2)
    return x * env_adsr(n, 0.003, 0.08, 0.3, 0.05) * vel * 0.2


def pad_chord(ms, dur, cutoff, vel=1.0, key=0, attack=0.35):
    n = int((dur + 0.6) * SR); out = np.zeros((2, n))
    for j, m in enumerate(ms):
        for k, det in enumerate((-0.11, 0.0, 0.09)):
            f = midi_hz(m + det); ph = osc_phase(f, n) + rng('pad', m, k, key).uniform()
            out[k % 2] += saw(ph) * (0.7 if k == 1 else 0.5)
            out[(k + 1) % 2] += saw(ph * 1.0007) * 0.25
    cut = cutoff if np.ndim(cutoff) else np.full(n, cutoff)
    if len(cut) < n:
        cut = np.pad(cut, (0, n - len(cut)), mode='edge')
    out = np.stack([sweep_filter(out[c], cut, 'low', 0.7) for c in range(2)])
    e = env_adsr(n, attack, 0.4, 0.8, 0.6)
    return out * e * vel * 0.045 / max(1, len(ms) ** 0.5)


# ---------------- harmony ----------------
CH = {  # chord tones (midi) for pads/keys, bass root
    'Dm': (['D3', 'F3', 'A3', 'C4'], 'D2'), 'Bb': (['Bb2', 'D3', 'F3', 'A3'], 'Bb1'), 'F': (['F3', 'A3', 'C4', 'E4'], 'F2'),
    'C': (['C3', 'E3', 'G3', 'Bb3'], 'C2'), 'Gm': (['G2', 'Bb2', 'D3', 'F3'], 'G1'), 'A': (['A2', 'C#3', 'E3', 'G3'], 'A1'),
    'Asus': (['A2', 'D3', 'E3', 'G3'], 'A1'), 'D': (['D3', 'F#3', 'A3', 'E4'], 'D2'), 'Dm9': (['D3', 'F3', 'A3', 'E4'], 'D2'),
}
P1 = ['Dm', 'Bb', 'F', 'C']
P2 = ['Bb', 'C', 'Dm', 'Dm']
PB = ['Dm9', 'Dm9', 'Bb', 'Bb', 'Gm', 'Gm', 'Asus', 'A']
SCALE = [62, 64, 65, 67, 69, 70, 72, 74, 76, 77, 79, 81]  # D minor from D4


def chord_at(bar):
    if 41 <= bar <= 51:
        return PB[(bar - 41) % 8]
    if 64 <= bar <= 67:
        return ['Bb', 'C', 'Dm', 'C'][bar - 64]
    if bar >= 68:
        return 'D'
    if 52 <= bar <= 63:
        return P2[(bar - 52) % 4] if bar >= 60 else P1[(bar - 52) % 4]
    return P1[(bar - 1) % 4]


MOTIF = [(0, 'A4', 1), (1, 'C5', 0.5), (1.5, 'D5', 1.5), (3, 'F5', 0.5), (3.5, 'E5', 0.5), (4, 'D5', 1), (5, 'C5', 0.5), (5.5, 'A4', 2.5)]
MOTIF_UP = [(0, 'A4', 0.5), (0.5, 'D5', 0.5), (1, 'F5', 1), (2, 'E5', 0.5), (2.5, 'F5', 0.5), (3, 'A5', 1), (4, 'G5', 0.5), (4.5, 'F5', 0.5), (5, 'E5', 1), (6, 'F#5', 2)]


SECTIONS = [(1, 3, 'hook'), (4, 9, 'scene'), (10, 10, 'build'), (11, 12, 'brand'), (13, 15, 'example'), (16, 22, 'listen'), (23, 28, 'moon'),
            (29, 40, 'montage'), (41, 51, 'break'), (52, 63, 'codex'), (64, 67, 'rise'), (68, 71, 'end')]


def section(bar):
    for a, b, name in SECTIONS:
        if a <= bar <= b:
            return name
    return 'end'


def render(out_dir, dur=142.0, events=None):
    n = int(dur * SR) + SR * 2
    st = {k: np.zeros((2, n)) for k in ('drums', 'bass', 'keys', 'pad', 'lead')}
    kicks = []
    bars = int(np.ceil(dur / BAR))
    for bar in range(1, bars + 1):
        sec = section(bar); ch = chord_at(bar); tones, root = CH[ch]
        tones = [n2m(x) for x in tones]; rootm = n2m(root)
        t0 = bt(bar)
        # ---------- drums ----------
        def K(b, v=1.0, tone=1.0):
            place(st['drums'], pan(kick(v, (bar, b), tone), 0), t0 + b * BEAT); kicks.append((t0 + b * BEAT, v))
        def CL(b, v=1.0):
            place(st['drums'], pan(clap(v, (bar, b)), 0.05), t0 + b * BEAT)
        def SN(b, v=1.0):
            place(st['drums'], pan(snare(v, (bar, b)), -0.05), t0 + b * BEAT)
        def HH(b, v=1.0, o=False):
            place(st['drums'], pan(hat(v, (bar, b), o), 0.35 if o else -0.3), t0 + b * BEAT)
        def RM(b, v=1.0):
            place(st['drums'], pan(rim(v, (bar, b)), 0.4), t0 + b * BEAT)
        r = rng('groove', bar)
        if sec == 'scene':
            K(0, 0.8); K(2, 0.75)
            for b in (1, 3): CL(b, 0.45)
            for i in range(8): HH(i * 0.5, 0.35 + 0.15 * (i % 2))
            if bar == 9:
                for i in range(8): SN(2 + i * 0.25, 0.25 + 0.06 * i)
        elif sec == 'build':
            K(0, 0.9)
        elif sec in ('brand', 'montage', 'rise') or (sec == 'codex' and bar >= 54):
            for b in range(4): K(b, 1.0 if b % 2 == 0 else 0.9)
            if sec != 'codex' or bar >= 56:
                for b in (1, 3): CL(b, 0.75)
            hats16 = sec in ('montage', 'rise') or (sec == 'codex' and bar >= 58) or sec == 'brand'
            for i in range(16 if hats16 else 8):
                HH(i * (0.25 if hats16 else 0.5), (0.22 + 0.2 * ((i % 4) == 2)) * (1.0 + 0.2 * r.uniform()))
            if sec == 'montage':
                for b in range(4): HH(b + 0.5, 0.45, True)
            if bar in (40, 63, 67):
                for i in range(8): SN(2 + i * 0.25, 0.3 + 0.08 * i)
        elif sec in ('example',):
            K(0, 0.85); K(2, 0.75)
            for b in (1, 3): CL(b, 0.5)
            for i in range(8): HH(i * 0.5, 0.3 + 0.12 * (i % 2))
        elif sec in ('listen', 'moon'):
            K(0, 0.95); K(1.5, 0.7); K(2, 0.85)
            if bar % 2 == 0: K(3.5, 0.55)
            for b in (1, 3): CL(b, 0.6)
            step = 0.25 if sec == 'moon' else 0.5
            for i in range(int(4 / step)): HH(i * step, 0.25 + 0.18 * ((i * step) % 1 == 0.5))
            for b in (0.5, 1.5, 2.5, 3.5):
                if sec == 'listen': RM(b, 0.5)
            if bar in (22, 28):
                for i in range(8): SN(2 + i * 0.25, 0.3 + 0.07 * i)
        elif sec == 'break':
            if 45 <= bar <= 51 and bar != 48:
                K(0, 0.55, 0.7)
            if 50 <= bar <= 51:
                for i in range(4): HH(i + 0.5, 0.18)
        elif sec == 'end':
            if bar == 68:
                K(0, 1.1)
        # ---------- bass ----------
        if sec in ('scene', 'example'):
            for b, d in ((0, 0.9), (1.5, 0.4), (2, 0.9), (3.5, 0.4)):
                place(st['bass'], pan(bass(rootm, d * BEAT * 2 * 0.5 + 0.2, 0.85, 420), 0), t0 + b * BEAT)
        elif sec in ('brand', 'listen', 'moon', 'montage', 'rise') or (sec == 'codex' and bar >= 54):
            pat = [(0, 0, 0.75), (0.75, 0, 0.25), (1.5, 12 if sec in ('moon', 'montage') else 0, 0.4), (2, 0, 0.75), (2.75, 7, 0.25), (3.5, 10 if sec != 'listen' else 0, 0.4)]
            for b, iv, d in pat:
                place(st['bass'], pan(bass(rootm + iv, d * BEAT + 0.08, 0.9, 700 if sec == 'montage' else 520, (bar, b)), 0), t0 + b * BEAT)
        elif sec == 'build':
            place(st['bass'], pan(bass(rootm, BAR - 0.2, 0.7, 300), 0), t0)
        elif sec == 'break' and bar >= 45:
            place(st['bass'], pan(bass(rootm, BAR - 0.1, 0.55, 260), 0), t0)
        elif sec == 'end' and bar == 68:
            place(st['bass'], pan(bass(n2m('D2'), 3.5, 0.9, 380), 0), t0)
        # ---------- pad ----------
        cutoffs = {'hook': 500, 'scene': 1300, 'build': 900, 'brand': 3200, 'example': 1100, 'listen': 1900, 'moon': 2400, 'montage': 3600,
                   'break': 1500, 'codex': 1200, 'rise': 3000, 'end': 2600}
        cut = cutoffs[sec]
        if sec == 'build':
            cut = np.linspace(700, 4200, int((BAR + 0.6) * SR))
        if sec == 'codex':
            cut = np.full(int((BAR + 0.6) * SR), 900 + 250 * (bar - 52))
        if sec == 'example' and bar == 13:
            cut = np.concatenate([np.linspace(3200, 700, SR), np.full(int((BAR - 0.4) * SR), 700)])
        pv = 0.55 if sec == 'hook' else 1.0
        if sec == 'end':
            if bar == 68:
                place(st['pad'], pad_chord(tones + [n2m('A4')], 7.5, 2600, 1.2, bar, 0.02), t0)
        else:
            place(st['pad'], pad_chord(tones, BAR, cut, pv, bar), t0)
        # ---------- keys ----------
        if sec in ('scene', 'example', 'listen', 'break'):
            hits = [(0, 1.8), (2.5, 1.2)] if sec != 'break' else [(0, 3.6)]
            if sec == 'break' and bar % 2 == 0:
                hits = [(1.5, 1.0), (2.5, 1.5)]
            for b, d in hits:
                for j, m in enumerate(tones):
                    place(st['keys'], epiano(m + 12, d * BEAT, 0.55 if sec == 'scene' else 0.7, (bar, b, j)), t0 + b * BEAT + j * 0.006)
        if sec in ('listen', 'moon') and bar >= 17:
            for i in range(8):
                m = tones[[0, 2, 1, 3, 2, 1, 3, 2][i]] + 24
                place(st['keys'], pan(pluck(m, 0.35, 0.5 + 0.2 * (i % 2 == 0), (bar, i), 0.55), 0.3 * np.sin(i)), t0 + i * 0.5 * BEAT)
        if sec == 'montage':
            for b in (0, 0.75, 1.5, 2.5, 3.25):
                for j, m in enumerate(tones[:3]):
                    place(st['keys'], pan(pluck(m + 12, 0.3, 0.6, (bar, b, j), 0.8), -0.3 + 0.3 * j), t0 + b * BEAT)
        if sec == 'codex':
            for i in range(16):
                m = tones[[0, 1, 2, 3, 2, 1][i % 6]] + 12 + (12 if i % 8 >= 6 else 0)
                c = 600 + 260 * (bar - 52) + 400 * (i % 4 == 0)
                place(st['keys'], pan(arp_note(m, 0.11, 0.8 + 0.2 * (i % 4 == 0), c, (bar, i)), 0.25 * np.sin(i * 0.7)), t0 + i * 0.25 * BEAT)
        # ---------- lead motif ----------
        motif_bars = {11: MOTIF, 19: MOTIF, 25: MOTIF, 31: MOTIF, 35: MOTIF_UP, 39: MOTIF, 60: MOTIF, 66: MOTIF_UP, 68: [(0, 'D5', 2), (2, 'F#5', 2), (4, 'A5', 4)]}
        if bar in motif_bars:
            for b, nm, d in motif_bars[bar]:
                m = n2m(nm); tt = t0 + b * BEAT
                if sec in ('brand', 'end'):
                    place(st['lead'], pan(bell(m, d * BEAT + 0.4, 0.9, (bar, b)), 0.15), tt)
                    place(st['lead'], pan(pluck(m - 12, d * BEAT, 0.5, (bar, b), 0.4), -0.15), tt)
                elif sec in ('montage', 'rise', 'codex'):
                    place(st['lead'], pan(lead(m, d * BEAT, 0.9, 3000, (bar, b)), 0), tt)
                    place(st['lead'], pan(bell(m + 12, 0.4, 0.35, (bar, b)), 0.3), tt)
                else:
                    place(st['lead'], epiano(m, d * BEAT, 0.8, (bar, b)), tt)

    # ---------- hook stabs from picture events ----------
    if events:
        for e in events:
            if e['t'] < 6.0 and e['kind'] in ('thump', 'thumpBig') and e.get('note') is not None:
                m = SCALE[int(e['note']) % len(SCALE)] - 12 * (0 if e['kind'] == 'thump' else 1)
                p = (e['x'] - 0.5) * 1.2
                place(st['keys'], pan(pluck(m, 0.5, 0.7, e['id'], 0.6), p), e['t'])
                if e['kind'] == 'thumpBig':
                    place(st['keys'], pan(pluck(m + 7, 0.6, 0.5, e['id'] + 'b', 0.6), -p), e['t'] + 0.004)
    # hook motif seed, quiet and filtered, bar 1
    for b, nm, d in MOTIF[:3]:
        place(st['lead'], pan(bell(n2m(nm), d * BEAT, 0.35, ('hook', b)), 0.2), bt(1, b))

    # ---------- bus processing ----------
    # sidechain pads/bass/keys to the kick
    sc = np.ones(n)
    for kt, v in kicks:
        i = int(kt * SR); m = min(int(0.3 * SR), n - i)
        if m > 0:
            sc[i:i + m] = np.minimum(sc[i:i + m], 1 - 0.55 * v * np.exp(-np.arange(m) / (0.09 * SR)))
    for k in ('bass', 'pad', 'keys'):
        st[k] *= sc
    ir = reverb_ir(2.6, 5500, 'music')
    st['keys'] = st['keys'] + convolve(st['keys'], ir) * 0.22
    st['lead'] = delay(st['lead'], 0.375, 0.32, 0.28) ; st['lead'] = st['lead'] + convolve(st['lead'], ir) * 0.3
    st['pad'] = st['pad'] + convolve(st['pad'], ir) * 0.25
    st['drums'] = st['drums'] + convolve(hp(st['drums'], 300), ir) * 0.06
    os.makedirs(out_dir, exist_ok=True)
    total = int(dur * SR)
    for k, x in st.items():
        np.save(os.path.join(out_dir, f'stem-{k}.npy'), x[:, :total].astype(np.float32))
    json.dump({'kicks': kicks}, open(os.path.join(out_dir, 'music-meta.json'), 'w'))
    return {k: x[:, :total] for k, x in st.items()}


if __name__ == '__main__':
    out = sys.argv[1]
    ev = None
    if '--events' in sys.argv:
        ev = json.load(open(sys.argv[sys.argv.index('--events') + 1], encoding='utf-8'))
    dur = float(sys.argv[sys.argv.index('--dur') + 1]) if '--dur' in sys.argv else 142.0
    st = render(out, dur, ev)
    gains = {'drums': 0.9, 'bass': 0.8, 'keys': 0.8, 'pad': 0.9, 'lead': 0.75}
    mix = sum(st[k] * g for k, g in gains.items())
    from dsp import normalize_peak
    write_wav(os.path.join(out, 'music-draft.wav'), normalize_peak(soft_clip(mix, 1.1), 0.89))
    print('wrote', out)
