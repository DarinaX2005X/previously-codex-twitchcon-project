"""Deterministic synthesis toolkit for the Previously film (48 kHz, float32 stereo)."""
import hashlib
import numpy as np
from scipy import signal

SR = 48000


def rng(*key):
    h = hashlib.sha256('|'.join(map(str, key)).encode()).digest()
    return np.random.default_rng(int.from_bytes(h[:8], 'little'))


def t_axis(dur):
    return np.arange(int(round(dur * SR))) / SR


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


NOTE = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}


def n2m(name):
    """'D4' -> 62"""
    p, o = (name[:2], name[2:]) if len(name) > 2 and name[1] in '#b' else (name[:1], name[1:])
    return 12 * (int(o) + 1) + NOTE[p]


def env_adsr(n, a, d, s, r, sr=SR, hold=None):
    a, d, r = int(a * sr), int(d * sr), int(r * sr)
    hold = n - a - d - r if hold is None else int(hold * sr)
    hold = max(0, hold)
    e = np.concatenate([np.linspace(0, 1, max(a, 1), endpoint=False), np.linspace(1, s, max(d, 1), endpoint=False), np.full(hold, s), np.linspace(s, 0, max(r, 1))])
    if len(e) < n:
        e = np.pad(e, (0, n - len(e)))
    return e[:n]


def exp_decay(n, tau):
    return np.exp(-np.arange(n) / (tau * SR))


def lp(x, fc, order=2):
    fc = min(max(fc, 20), SR * 0.45)
    sos = signal.butter(order, fc, 'low', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=-1)


def hp(x, fc, order=2):
    fc = min(max(fc, 20), SR * 0.45)
    sos = signal.butter(order, fc, 'high', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=-1)


def bp(x, lo, hi, order=2):
    lo = max(lo, 20); hi = min(hi, SR * 0.45)
    sos = signal.butter(order, [lo, hi], 'band', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=-1)


def sweep_filter(x, cutoff, kind='low', q=0.8, block=256):
    """Time-varying resonant biquad (RBJ). cutoff: array same length as x (Hz)."""
    y = np.zeros_like(x)
    z1 = z2 = 0.0
    for i in range(0, len(x), block):
        fc = float(np.clip(cutoff[min(i, len(cutoff) - 1)], 30, SR * 0.45))
        w0 = 2 * np.pi * fc / SR; al = np.sin(w0) / (2 * q); c = np.cos(w0)
        if kind == 'low':
            b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2])
        elif kind == 'high':
            b = np.array([(1 + c) / 2, -(1 + c), (1 + c) / 2])
        else:
            b = np.array([al, 0, -al])
        a = np.array([1 + al, -2 * c, 1 - al])
        b, a = b / a[0], a / a[0]
        seg = x[i:i + block]
        out, zf = signal.lfilter(b, a, seg, zi=np.array([z1, z2]))
        y[i:i + block] = out; z1, z2 = zf
    return y


def saw(phase):
    return 2.0 * (phase % 1.0) - 1.0


def osc_phase(freq, n):
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    return np.cumsum(f) / SR


def pan(mono, p):
    """p in -1..1, equal power"""
    a = (np.clip(p, -1, 1) + 1) * np.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)])


def place(bus, stereo, t, gain=1.0):
    i = int(round(t * SR))
    if i >= bus.shape[1]:
        return
    if i < 0:
        stereo = stereo[:, -i:]; i = 0
    n = min(stereo.shape[1], bus.shape[1] - i)
    if n > 0:
        bus[:, i:i + n] += stereo[:, :n] * gain


def reverb_ir(dur=2.4, tone=6000, seed='hall'):
    r = rng(seed)
    n = int(dur * SR)
    ir = r.standard_normal((2, n)) * exp_decay(n, dur / 6.5)
    ir = lp(ir, tone)
    ir[:, :int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
    return ir / np.sqrt((ir ** 2).sum() / 2)


def convolve(x, ir):
    return np.stack([signal.fftconvolve(x[c], ir[c])[:x.shape[1]] for c in range(2)])


def delay(x, time, fb=0.35, mix=0.3, pingpong=True):
    d = int(time * SR); y = x.copy(); buf = np.zeros_like(x)
    tap = x.copy()
    for k in range(1, 6):
        tap = np.roll(tap, d, axis=1); tap[:, :d] = 0; tap *= fb if k > 1 else 1.0
        if pingpong:
            tap = tap[::-1]
        buf += tap * (fb ** (k - 1))
    return y + buf * mix


def soft_clip(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)


def normalize_peak(x, peak=0.89):
    m = np.max(np.abs(x)) + 1e-9
    return x * (peak / m)


def write_wav(path, x):
    from scipy.io import wavfile
    x = np.clip(x, -1, 1)
    wavfile.write(path, SR, (x.T * 32767).astype(np.int16))


def read_wav(path):
    from scipy.io import wavfile
    sr, d = wavfile.read(path)
    d = d.astype(np.float32) / (32768.0 if d.dtype == np.int16 else 1.0)
    if d.ndim == 1:
        d = np.stack([d, d], 1)
    x = d.T
    if sr != SR:
        x = signal.resample_poly(x, SR, sr, axis=1)
    return x
