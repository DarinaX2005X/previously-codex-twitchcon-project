"""Rebuild every Previously brand asset (SVG and PNG) from the geometry in this file.

    python public/brand/export_brand.py

Requires fontTools and Pillow. The wordmark is Onest at weight 800, converted to outlines
from public/fonts/Onest-Variable.ttf, so no installed font is consulted and GitHub renders
the README logo exactly. SVG and PNG are drawn from the same shapes: SVG keeps arcs and
masks, PNG flattens the same shapes and rasterizes them at 4x before downsampling.

The mark: a vermilion title card carrying an ink P whose counter is a back triangle, with
an earlier card stacked behind it, up and to the left. Earlier frames stack into the present.
"""
from math import cos, sin, pi
from pathlib import Path
from html import escape
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.basePen import BasePen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from PIL import Image, ImageDraw, ImageChops

ROOT = Path(__file__).parent
FONT = ROOT.parent / 'fonts' / 'Onest-Variable.ttf'
SS = 4  # PNG supersampling

INK, PAPER = '#14171B', '#F4EFE6'
VERMILION, VERMILION_SIDE, VERMILION_BACK = '#FF5A36', '#C93F22', '#8F2F1C'

# ---------------------------------------------------------------- geometry (96 unit box)
BACK = (4, 4, 72, 72, 20)        # earlier card
FRONT = (18, 16, 74, 74, 21)     # present card
SIDE = 4                          # darker underside plane of the present card
GAP = 3.5                         # cut between the cards
P_ORIGIN = FRONT                  # P is authored in FRONT coordinates


def rrect_points(x, y, w, h, r, steps=10):
    pts = []
    for cx, cy, a0 in ((x+w-r, y+r, -90), (x+w-r, y+h-r, 0), (x+r, y+h-r, 90), (x+r, y+r, 180)):
        for i in range(steps+1):
            a = (a0 + 90*i/steps) * pi/180
            pts.append((cx + r*cos(a), cy + r*sin(a)))
    return pts


def rrect_d(x, y, w, h, r):
    return f'M{x+r:g} {y:g}H{x+w-r:g}A{r:g} {r:g} 0 0 1 {x+w:g} {y+r:g}V{y+h-r:g}A{r:g} {r:g} 0 0 1 {x+w-r:g} {y+h:g}H{x+r:g}A{r:g} {r:g} 0 0 1 {x:g} {y+h-r:g}V{y+r:g}A{r:g} {r:g} 0 0 1 {x+r:g} {y:g}Z'


def arc(cx, cy, r, a0, a1, steps=24):
    return [(cx + r*cos((a0 + (a1-a0)*i/steps)*pi/180), cy + r*sin((a0 + (a1-a0)*i/steps)*pi/180)) for i in range(steps+1)]


# P letter, absolute 96-box coordinates for the full mark.
STEM_L, STEM_R, TOP, FOOT, BOWL_B, BOWL_R, CR = 36, 51, 29, 79, 63, 77, 4
BOWL_C = ((TOP+BOWL_B)/2, (BOWL_B-TOP)/2)  # centre y, radius
P_D = (f'M{STEM_L} {TOP+CR}A{CR} {CR} 0 0 1 {STEM_L+CR} {TOP}H{BOWL_R-BOWL_C[1]:g}'
       f'A{BOWL_C[1]:g} {BOWL_C[1]:g} 0 0 1 {BOWL_R-BOWL_C[1]:g} {BOWL_B}H{STEM_R}V{FOOT-CR}'
       f'A{CR} {CR} 0 0 1 {STEM_R-CR} {FOOT}H{STEM_L+CR}A{CR} {CR} 0 0 1 {STEM_L} {FOOT-CR}Z')
P_PTS = (arc(STEM_L+CR, TOP+CR, CR, 180, 270) + arc(BOWL_R-BOWL_C[1], BOWL_C[0], BOWL_C[1], -90, 90)
         + [(STEM_R, BOWL_B)] + arc(STEM_R-CR, FOOT-CR, CR, 0, 90) + arc(STEM_L+CR, FOOT-CR, CR, 90, 180))
TRI = [(51.5, 46), (66, 38.5), (66, 53.5)]  # the back triangle counter
TRI_D = 'M' + 'L'.join(f'{x:g} {y:g}' for x, y in TRI) + 'Z'


def affine(pts, m):
    a, b, c, d, e, f = m
    return [(a*x + c*y + e, b*x + d*y + f) for x, y in pts]


# Small mark: the present card alone, filling the box, for 16 to 48 px.
SMALL_TILE = (2, 2, 92, 92, 24)
_s = 92/FRONT[2]
SMALL_M = (_s, 0, 0, _s, 2 - FRONT[0]*_s, 2 - FRONT[1]*_s)
SMALL_T = f'matrix({" ".join(f"{v:.5f}" for v in SMALL_M)})'


# ---------------------------------------------------------------- wordmark outlines
font = instantiateVariableFont(TTFont(FONT), {'wght': 800}, inplace=True)
glyphs, cmap, UPM = font.getGlyphSet(), font.getBestCmap(), font['head'].unitsPerEm
TRACK = -0.03  # em


class Polys(BasePen):
    def __init__(self, gs):
        super().__init__(gs); self.paths = []; self.cur = []
    def _moveTo(self, p): self.cur = [p]
    def _lineTo(self, p): self.cur.append(p)
    def _qCurveToOne(self, b, c):
        a = self.cur[-1]
        self.cur.extend(((1-t)**2*a[0]+2*(1-t)*t*b[0]+t*t*c[0], (1-t)**2*a[1]+2*(1-t)*t*b[1]+t*t*c[1]) for t in [i/16 for i in range(1, 17)])
    def _curveToOne(self, b, c, d):
        a = self.cur[-1]
        self.cur.extend(((1-t)**3*a[0]+3*(1-t)**2*t*b[0]+3*(1-t)*t*t*c[0]+t**3*d[0], (1-t)**3*a[1]+3*(1-t)**2*t*b[1]+3*(1-t)*t*t*c[1]+t**3*d[1]) for t in [i/20 for i in range(1, 21)])
    def _closePath(self): self.paths.append(self.cur)
    def _endPath(self): self.paths.append(self.cur)


def word(text, x, baseline, size):
    """Returns (svg path d, polygons, advance) for text set at size px."""
    s = size/UPM; d = []; polys = []; pen_x = x
    for ch in text:
        g = glyphs[cmap[ord(ch)]]
        m = (s, 0, 0, -s, pen_x, baseline)
        sp = SVGPathPen(glyphs); g.draw(TransformPen(sp, m)); d.append(sp.getCommands())
        pp = Polys(glyphs); g.draw(TransformPen(pp, m)); polys += pp.paths
        pen_x += g.width*s + TRACK*size
    return ' '.join(d), polys, pen_x - x - TRACK*size


# ---------------------------------------------------------------- drawing
class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.svg = []; self.defs = []
        self.im = Image.new('RGBA', (w*SS, h*SS), (0, 0, 0, 0))
    def mask(self, polys, m=(1, 0, 0, 1, 0, 0), evenodd=True):
        out = Image.new('L', self.im.size, 0)
        for poly in polys:
            part = Image.new('L', self.im.size, 0)
            ImageDraw.Draw(part).polygon([(x*SS, y*SS) for x, y in affine(poly, m)], fill=255)
            out = ImageChops.logical_xor(out.convert('1'), part.convert('1')).convert('L') if evenodd else ImageChops.lighter(out, part)
        return out
    def fill(self, mask, color):
        self.im.paste(color, (0, 0), mask)
    def save(self, name, title='Previously'):
        body = ''.join(self.svg)
        defs = f'<defs>{"".join(self.defs)}</defs>' if self.defs else ''
        (ROOT/f'{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}"><title>{title}</title>{defs}{body}</svg>', encoding='utf-8')
        self.im.resize((self.w, self.h), Image.Resampling.LANCZOS).save(ROOT/f'{name}.png')


def sheen_overlay(c, shape_mask, box, uid):
    """Subtle iridescent band across the present card, for large sizes only."""
    x, y, w, h = box
    c.defs.append(f'<linearGradient id="{uid}" x1="0" y1="0" x2="1" y2="1">'
                  '<stop offset=".2" stop-color="#FFE3BD" stop-opacity="0"/>'
                  '<stop offset=".42" stop-color="#FFE3BD" stop-opacity=".2"/>'
                  '<stop offset=".52" stop-color="#FFF7EC" stop-opacity=".26"/>'
                  '<stop offset=".64" stop-color="#A8E6FF" stop-opacity=".14"/>'
                  '<stop offset=".8" stop-color="#A8E6FF" stop-opacity="0"/></linearGradient>')
    small = (c.im.size[0]//SS, c.im.size[1]//SS)
    grad = Image.new('RGBA', small, (0, 0, 0, 0)); px = grad.load()
    stops = [(.2, (255, 227, 189, 0)), (.42, (255, 227, 189, .2)), (.52, (255, 247, 236, .26)), (.64, (168, 230, 255, .14)), (.8, (168, 230, 255, 0))]
    x0, y0, x1, y1 = int(x*c.w/96), int(y*c.h/96), int((x+w)*c.w/96), int((y+h)*c.h/96)
    for j in range(y0, y1):
        for i in range(x0, x1):
            t = ((i-x0)/(x1-x0) + (j-y0)/(y1-y0))/2
            col = stops[0][1] if t <= stops[0][0] else stops[-1][1]
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t0 <= t <= t1:
                    k = (t-t0)/(t1-t0); col = tuple(c0[n]+(c1[n]-c0[n])*k for n in range(4)); break
            px[i, j] = (int(col[0]), int(col[1]), int(col[2]), int(col[3]*255))
    grad = grad.resize(c.im.size, Image.Resampling.BILINEAR)
    alpha = ImageChops.multiply(grad.getchannel('A'), shape_mask)
    grad.putalpha(alpha)
    c.im.alpha_composite(grad)


def draw_mark(c, scale=1.0, ox=0, oy=0, mono=None, sheen=False, uid='m'):
    """Full mark at (ox, oy), size 96*scale."""
    m = (scale, 0, 0, scale, ox, oy)
    g = f'<g transform="translate({ox:g} {oy:g}) scale({scale:g})">'
    back_col = mono or VERMILION_BACK; side_col = mono or VERMILION_SIDE; front_col = mono or VERMILION
    fx, fy, fw, fh, fr = FRONT
    hole = (fx-GAP, fy-GAP, fw+2*GAP, fh+2*GAP+SIDE, fr+GAP)
    c.defs.append(f'<mask id="{uid}gap" maskUnits="userSpaceOnUse" x="0" y="0" width="96" height="96"><rect width="96" height="96" fill="#fff"/><path d="{rrect_d(*hole)}" fill="#000"/></mask>')
    parts = [f'<path d="{rrect_d(*BACK)}" fill="{back_col}" mask="url(#{uid}gap)"/>']
    back = ImageChops.subtract(c.mask([rrect_points(*BACK)], m), c.mask([rrect_points(*hole)], m))
    c.fill(back, back_col)
    if not mono:
        parts.append(f'<path d="{rrect_d(fx, fy+SIDE, fw, fh, fr)}" fill="{side_col}"/>')
        c.fill(c.mask([rrect_points(fx, fy+SIDE, fw, fh, fr)], m), side_col)
    if mono:
        parts.append(f'<path fill-rule="evenodd" d="{rrect_d(*FRONT)} {P_D} {TRI_D}" fill="{mono}"/>')
        c.fill(c.mask([rrect_points(*FRONT), P_PTS, TRI], m), mono)
    else:
        parts.append(f'<path d="{rrect_d(*FRONT)}" fill="{front_col}"/>')
        front = c.mask([rrect_points(*FRONT)], m); c.fill(front, front_col)
        if sheen:
            parts.append(f'<path d="{rrect_d(*FRONT)}" fill="url(#{uid}sheen)"/>')
            sheen_overlay(c, front, (fx, fy, fw, fh), f'{uid}sheen')
        parts.append(f'<path fill-rule="evenodd" d="{P_D} {TRI_D}" fill="{INK}"/>')
        c.fill(c.mask([P_PTS, TRI], m), INK)
    c.svg.append(g + ''.join(parts) + '</g>')


def draw_small(c, mono=None, size=96):
    s = size/96
    m = tuple(v*s if i < 4 else v*s for i, v in enumerate(SMALL_M))
    tile_col = mono or VERMILION
    if mono:
        c.svg.append(f'<g transform="scale({s:g})"><path fill-rule="evenodd" d="{rrect_d(*SMALL_TILE)}" fill="{mono}"/><path fill-rule="evenodd" transform="{SMALL_T}" d="{P_D} {TRI_D}" fill="{mono}"/></g>')
        tile = c.mask([rrect_points(*SMALL_TILE)], (s, 0, 0, s, 0, 0))
        letter = c.mask([P_PTS, TRI], m)
        c.fill(ImageChops.subtract(tile, letter), mono)
    else:
        c.svg.append(f'<g transform="scale({s:g})"><path d="{rrect_d(*SMALL_TILE)}" fill="{tile_col}"/><path fill-rule="evenodd" transform="{SMALL_T}" d="{P_D} {TRI_D}" fill="{INK}"/></g>')
        c.fill(c.mask([rrect_points(*SMALL_TILE)], (s, 0, 0, s, 0, 0)), tile_col)
        c.fill(c.mask([P_PTS, TRI], m), INK)


def export_mark(name, mono=None, sheen=False, size=96):
    c = Canvas(size, size)
    draw_mark(c, size/96, 0, 0, mono=mono, sheen=sheen, uid=name.replace('-', ''))
    c.save(name)


def export_wordmark(name, color, width=440, height=96):
    c = Canvas(width, height)
    draw_mark(c, 1, 0, 0, uid=name.replace('-', ''))
    d, polys, adv = word('Previously', 110, 67, 62)
    c.svg.append(f'<path d="{escape(d, quote=True)}" fill="{color}"/>')
    c.fill(c.mask(polys, evenodd=True), color)
    c.save(name)
    return adv


def export_word_only(name, color=INK):
    _, _, adv = word('Previously', 0, 0, 62)
    c = Canvas(int(adv + 4), 96)
    d, polys, _ = word('Previously', 1, 67, 62)
    c.svg.append(f'<path d="{escape(d, quote=True)}" fill="{color}"/>')
    c.fill(c.mask(polys), color)
    c.save(name)


def export_readme():
    H, B, scale = 240, 10, 1.42
    _, _, adv = word('Previously', 0, 0, 96)
    W = int(52 + 96*scale + 26 + adv + 56)
    c = Canvas(W, H)
    c.svg.append(f'<rect x="{B/2}" y="{B/2}" width="{W-B}" height="{H-B}" rx="44" fill="#FFFFFF" stroke="{INK}" stroke-width="{B}"/>')
    d = ImageDraw.Draw(c.im)
    d.rounded_rectangle((B/2*SS, B/2*SS, (W-B/2)*SS, (H-B/2)*SS), radius=44*SS, fill='#FFFFFF', outline=INK, width=B*SS)
    draw_mark(c, scale, 52, (H-96*scale)/2 - 2, uid='readme')
    wd, polys, adv = word('Previously', 52+96*scale+26, 152, 96)
    c.svg.append(f'<path d="{escape(wd, quote=True)}" fill="{INK}"/>')
    c.fill(c.mask(polys), INK)
    c.save('logo-readme', 'Previously')


def export_small(name, mono=None, size=96):
    c = Canvas(size, size); draw_small(c, mono=mono, size=size); c.save(name)


if __name__ == '__main__':
    export_mark('mark')
    export_mark('mark-large', sheen=True, size=512)
    export_mark('mark-monochrome', mono=INK)
    export_small('mark-small')
    export_small('mark-small-dark')  # same tile; kept for the dark-tone Brand variant
    export_small('favicon')
    export_wordmark('wordmark', INK)
    export_wordmark('wordmark-dark', PAPER)
    export_readme()
    export_word_only('wordmark-text')  # used as a CSS mask by the in-app Brand so it takes the text colour
    # favicon.ico (16, 32, 48) and the touch icon (tile on ink) from the small mark
    sizes = []
    for s in (16, 32, 48, 180):
        c = Canvas(s, s); draw_small(c, size=s); sizes.append(c.im.resize((s, s), Image.Resampling.LANCZOS))
    sizes[2].save(ROOT/'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)], append_images=sizes[:2])
    touch = Image.new('RGBA', (180, 180), INK); touch.alpha_composite(sizes[3].resize((150, 150), Image.Resampling.LANCZOS), (15, 15)); touch.convert('RGB').save(ROOT/'apple-touch-icon.png')
    missing = [ch for ch in 'Previously' if ord(ch) not in cmap]
    assert not missing
    print('Brand assets rebuilt in', ROOT)
