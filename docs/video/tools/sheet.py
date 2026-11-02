"""Contact sheet: python sheet.py <dir-or-glob> <out.jpg> [cols] [thumb_w]
Labels each thumbnail with its file name (time)."""
import sys, glob, os
from PIL import Image, ImageDraw, ImageFont
src, out = sys.argv[1], sys.argv[2]
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 6
tw = int(sys.argv[4]) if len(sys.argv) > 4 else 400
files = sorted(glob.glob(os.path.join(src, '*.jpg')) + glob.glob(os.path.join(src, '*.png'))) if os.path.isdir(src) else sorted(glob.glob(src))
files = [f for f in files if os.path.getsize(f) > 0]
im0 = Image.open(files[0]); th = int(tw * im0.height / im0.width)
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * th), (8, 8, 8))
try: font = ImageFont.truetype('arial.ttf', 16)
except Exception: font = ImageFont.load_default()
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((tw, th), Image.LANCZOS)
    x, y = (i % cols) * tw, (i // cols) * th
    sheet.paste(im, (x, y))
    label = os.path.splitext(os.path.basename(f))[0]
    d.rectangle([x, y, x + 8 * len(label) + 8, y + 20], fill=(0, 0, 0)); d.text((x + 4, y + 2), label, fill=(255, 230, 0), font=font)
sheet.save(out, quality=88); print(out, len(files))
