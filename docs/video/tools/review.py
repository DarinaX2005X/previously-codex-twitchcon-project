"""Review a render: contact sheets at N fps per 30 s block, big brightness jumps (flash check), loudness and true peak.
python review.py film.mp4 out_dir [fps=2]"""
import sys, os, subprocess, glob, shutil, json
import numpy as np
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
mp4, out = sys.argv[1], sys.argv[2]
fps = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
os.makedirs(out, exist_ok=True)
tmp = os.path.join(out, '_frames'); shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
subprocess.run(['ffmpeg', '-v', 'error', '-i', mp4, '-vf', f'fps={fps},scale=400:-1', '-q:v', '3', os.path.join(tmp, 'f%05d.jpg')], check=True)
files = sorted(glob.glob(os.path.join(tmp, 'f*.jpg')))
for i, f in enumerate(files):
    os.rename(f, os.path.join(tmp, f't{i / fps:07.2f}.jpg'))
files = sorted(glob.glob(os.path.join(tmp, 't*.jpg')))
block = int(30 * fps)
for k in range(0, len(files), block):
    d = os.path.join(out, '_b'); shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    for f in files[k:k + block]: shutil.copy(f, d)
    a = k / fps
    subprocess.run([sys.executable, os.path.join(here, 'sheet.py'), d, os.path.join(out, f'sheet-{fps:g}fps-{int(a):03d}-{int(a + 30):03d}.jpg'), '10', '400'], check=True, capture_output=True)
    shutil.rmtree(d)
# flash check on every frame (downscaled luma)
r = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp4, '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-'], capture_output=True)
y = np.frombuffer(r.stdout, np.uint8).reshape(-1, 36 * 64).mean(1)
jumps = [(i / 60, float(y[i] - y[i - 1])) for i in range(1, len(y)) if abs(y[i] - y[i - 1]) > 40]
loud = subprocess.run(['ffmpeg', '-hide_banner', '-i', mp4, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
summ = loud[loud.rfind('Summary'):]
report = {'frames': int(len(y)), 'brightness_jumps_over_40': jumps[:40], 'loudness_summary': summ}
json.dump(report, open(os.path.join(out, 'review.json'), 'w'), indent=1)
print(json.dumps({'frames': report['frames'], 'jumps': len(jumps)}), summ.replace('\n', ' ')[:400])
shutil.rmtree(tmp)
