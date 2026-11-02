import sys, glob, os
from PIL import Image, ImageDraw
src, dst = sys.argv[1], sys.argv[2]
files = sorted(f for f in glob.glob(os.path.join(src, '*.*')) if f.lower().endswith(('.png', '.jpg')))
W, H, pad = 600, 400, 24
cols = 3
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * (W + pad) + pad, rows * (H + pad + 30) + pad), (40, 40, 44))
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((W, H), Image.LANCZOS)
    x, y = pad + (i % cols) * (W + pad), pad + (i // cols) * (H + pad + 30)
    sheet.paste(im, (x, y)); d.text((x, y + H + 6), os.path.basename(f), fill=(230, 230, 230))
sheet.save(os.path.join(dst, 'contact-sheet.jpg'), quality=88)
t = os.path.join(src, 'thumbnail.png')
if os.path.exists(t):
    Image.open(t).convert('RGB').resize((300, 200), Image.LANCZOS).save(os.path.join(dst, 'thumbnail-300x200.png'))
print('sheet', len(files), 'images')
# every image at the size Devpost shows it, for a readability check
small = os.path.join(dst, '900')
os.makedirs(small, exist_ok=True)
for f in files:
    Image.open(f).convert('RGB').resize((900, 600), Image.LANCZOS).save(os.path.join(small, os.path.splitext(os.path.basename(f))[0] + '.png'))
