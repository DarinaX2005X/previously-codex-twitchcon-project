"""Mix music stems, picture-driven SFX and the raid scene's own SFX into the film soundtrack.
python mix.py --stems <dir> --events ev.json [--scene-sfx s.wav --scene-at 6.0] --from 0 --to 24 --out mix.wav"""
import argparse, json, subprocess, os
import numpy as np
from dsp import SR, place, read_wav, write_wav, lp, hp, soft_clip, convolve, reverb_ir
from sfx import render_event


def tape_treatment(music, events):
    """The rewind press stops the tape, the score plays backward at speed, then lands."""
    by = {e['id']: e for e in events}
    if 'tile-press' not in by or 'rewind-land' not in by:
        return music
    t_press, t_land = by['tile-press']['t'], by['rewind-land']['t']
    t_drop = by['drop']['t'] if 'drop' in by else t_land + 0.25
    out = music.copy()
    # 1) tape stop over 0.14 s before the press: decelerating read head
    a = int((t_press - 0.14) * SR); b = int(t_press * SR); n = b - a
    u = np.linspace(0, 1, n); pos = a + (n * (u - u ** 2 / 2) * 1.0)  # speed 1 -> 0
    for c in range(2):
        out[c, a:b] = np.interp(pos, np.arange(music.shape[1]), music[c]) * (1 - u ** 3)
    # 2) rewind: the preceding 3 s of score read backward, accelerating then slowing, pitched up
    a2, b2 = int(t_press * SR), int(t_land * SR); m = b2 - a2
    src_end = t_press - 0.14; src_len = 3.0
    u = np.linspace(0, 1, m)
    prog = (1 - np.cos(np.pi * u)) / 2
    pos = (src_end - src_len * prog) * SR
    env = np.sin(np.pi * u) ** 0.5
    for c in range(2):
        seg = np.interp(pos, np.arange(music.shape[1]), music[c])
        out[c, a2:b2] = hp(seg, 250) * env * 0.8
    # 3) a breath of silence until the downbeat
    out[:, b2:int(t_drop * SR)] *= 0.0
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stems'); ap.add_argument('--events'); ap.add_argument('--scene-sfx'); ap.add_argument('--scene-at', type=float, default=6.0)
    ap.add_argument('--from', dest='t0', type=float, default=0); ap.add_argument('--to', dest='t1', type=float, default=24); ap.add_argument('--out')
    ap.add_argument('--lufs', type=float, default=-14.0)
    ap.add_argument('--scene-at2', type=float, default=None); ap.add_argument('--scene-from2', type=float, default=1.3); ap.add_argument('--scene-dur2', type=float, default=5.3)
    a = ap.parse_args()
    events = json.load(open(a.events, encoding='utf-8'))
    gains = {'drums': 0.85, 'bass': 0.8, 'keys': 0.75, 'pad': 0.85, 'lead': 0.7}
    stems = {k: np.load(os.path.join(a.stems, f'stem-{k}.npy')) for k in gains}
    n_all = max(s.shape[1] for s in stems.values())
    music = sum(stems[k] * g for k, g in gains.items())
    music = tape_treatment(music, events)
    sfx = np.zeros((2, n_all))
    for e in events:
        place(sfx, render_event(e), e['t'] - 0.002, e.get('gain', 1.0))
    ir = reverb_ir(1.6, 7000, 'sfx-room')
    sfx = sfx + convolve(hp(sfx, 400), ir) * 0.12
    scene = np.zeros((2, n_all))
    if a.scene_sfx and os.path.exists(a.scene_sfx):
        sc = read_wav(a.scene_sfx)
        place(scene, sc, a.scene_at, 1.0)
        if a.scene_at2 is not None:  # the scene again inside the montage, from its own clock offset
            i0 = int(a.scene_from2 * SR); seg2 = sc[:, i0:i0 + int(a.scene_dur2 * SR)].copy()
            k = int(0.08 * SR); seg2[:, -k:] *= np.linspace(1, 0, k)
            place(scene, seg2, a.scene_at2, 0.75)
    # duck the score under SFX and the scene (smoothed envelope, up to ~4 dB)
    trig = np.abs(sfx).max(0) + np.abs(scene).max(0) * 0.8
    k = int(0.06 * SR); env = np.convolve(trig, np.ones(k) / k, mode='same')
    env = np.clip(env / 0.12, 0, 1)
    rel = np.zeros_like(env); g = 0.0; att, relc = 1 - np.exp(-1 / (0.01 * SR)), 1 - np.exp(-1 / (0.25 * SR))
    for i in range(0, len(env), 64):
        v = env[i:i + 64].max(); g += (v - g) * (att * 64 if v > g else relc * 64); g = min(max(g, 0), 1); rel[i:i + 64] = g
    duck = 10 ** (-4.0 * rel / 20)
    # the raid scene's passage keeps the score a little lower overall
    sec = np.ones(n_all); s0, s1 = int(a.scene_at * SR), int((a.scene_at + 11.6) * SR); sec[s0:s1] = 10 ** (-5.0 / 20)
    if a.scene_at2 is not None: sec[int(a.scene_at2 * SR):int((a.scene_at2 + a.scene_dur2) * SR)] = 10 ** (-4.0 / 20)
    # hush events: a beat of silence in the score before a big press
    for e in events:
        if e['kind'] == 'hush':
            h0, h1 = int(e['t'] * SR), int((e['t'] + e['dur']) * SR); k = int(0.04 * SR)
            g = np.ones(n_all); g[h0:h1] = 0; g[max(0, h0 - k):h0] = np.linspace(1, 0, min(k, h0)); g[h1:h1 + k] = np.linspace(0, 1, k)
            sec *= g
    music = lp(music, 13000, 2)
    mix = music * duck * sec + sfx * 0.9 + scene * 1.15
    mix = soft_clip(mix * 0.9, 1.05)
    i0, i1 = int(a.t0 * SR), int(a.t1 * SR)
    seg = mix[:, i0:i1]
    tmp = a.out.replace('.wav', '.pre.wav')
    write_wav(tmp, seg / (np.abs(seg).max() + 1e-9) * 0.7)
    # two-pass loudnorm to the web target, true peak -1 dBTP
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', tmp, '-af', f'loudnorm=I={a.lufs}:TP=-2.0:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True)
    js = r.stderr[r.stderr.rfind('{'):r.stderr.rfind('}') + 1]; m = json.loads(js)
    af = (f"loudnorm=I={a.lufs}:TP=-2.0:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
          f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,afade=t=in:d=0.012,afade=t=out:st={max(0.0, a.t1 - a.t0 - 0.9):.3f}:d=0.9,lowpass=f=17500,aresample=192000,alimiter=limit=0.7:attack=1:release=60:level=false,aresample=48000")
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', tmp, '-af', af, '-ar', '48000', '-c:a', 'pcm_s16le', a.out], check=True)
    os.remove(tmp)
    print('mix', a.out, 'measured input', m['input_i'], 'LUFS')


if __name__ == '__main__':
    main()
