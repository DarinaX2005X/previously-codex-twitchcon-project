"""Neighbour frames around transitions: python strips.py film.mp4 out_dir name:t0:t1 [name:t0:t1 ...]
Extracts every frame (60 fps) in [t0, t1) and tiles them 6 per row with frame time labels."""
import sys, os, subprocess, glob, shutil
here = os.path.dirname(os.path.abspath(__file__))
mp4, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for spec in sys.argv[3:]:
    name, t0, t1 = spec.split(':'); t0, t1 = float(t0), float(t1)
    tmp = os.path.join(out, '_tmp_' + name); shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
    f0 = round(t0 * 60)
    subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t0 - 0.5:.3f}', '-i', mp4, '-ss', '0.5', '-t', f'{t1 - t0:.3f}', '-vf', 'scale=480:-1', '-q:v', '3', os.path.join(tmp, 'f%04d.jpg')], check=True)
    for i, f in enumerate(sorted(glob.glob(os.path.join(tmp, 'f*.jpg')))):
        os.rename(f, os.path.join(tmp, f't{(f0 + i) / 60:08.3f}.jpg'))
    subprocess.run([sys.executable, os.path.join(here, 'sheet.py'), tmp, os.path.join(out, f'strip-{name}.jpg'), '6', '480'], check=True)
    shutil.rmtree(tmp)
