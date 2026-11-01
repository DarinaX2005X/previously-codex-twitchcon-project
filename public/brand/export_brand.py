"""Rebuild production SVG and PNG exports from the same outlined vector master.

Requires fontTools and Pillow. No installed font is consulted. Glyph contours from
Onest 700 are the master for both serializers; PNG uses 4x contour rasterization.
"""
from pathlib import Path
from html import escape
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.basePen import BasePen
from fontTools.pens.svgPathPen import SVGPathPen
from PIL import Image, ImageDraw, ImageChops

ROOT = Path(__file__).parent
FONT = ROOT.parent / 'fonts' / 'Onest-Variable.ttf'
SCALE = 4
font = TTFont(FONT)
axis = next(axis for axis in font['fvar'].axes if axis.axisTag == 'wght')
assert all(axis.minValue <= weight <= axis.maxValue for weight in (400,550,650,700))
font = instantiateVariableFont(font, {'wght': 700}, inplace=True)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
units = font['head'].unitsPerEm


class Contours(BasePen):
    def __init__(self):
        super().__init__(glyphs)
        self.paths = []
        self.current = []
    def _moveTo(self, p):
        self.current = [p]
    def _lineTo(self, p):
        self.current.append(p)
    def _qCurveToOne(self, b, c):
        a = self.current[-1]
        self.current.extend(((1-t)**2*a[0]+2*(1-t)*t*b[0]+t*t*c[0], (1-t)**2*a[1]+2*(1-t)*t*b[1]+t*t*c[1]) for t in [i/24 for i in range(1,25)])
    def _curveToOne(self, b, c, d):
        a = self.current[-1]
        self.current.extend(((1-t)**3*a[0]+3*(1-t)**2*t*b[0]+3*(1-t)*t*t*c[0]+t**3*d[0], (1-t)**3*a[1]+3*(1-t)**2*t*b[1]+3*(1-t)*t*t*c[1]+t**3*d[1]) for t in [i/32 for i in range(1,33)])
    def _closePath(self):
        self.paths.append(self.current)
    def _endPath(self):
        self.paths.append(self.current)


def quad(a,b,c):
    return [((1-t)**2*a[0]+2*(1-t)*t*b[0]+t*t*c[0], (1-t)**2*a[1]+2*(1-t)*t*b[1]+t*t*c[1]) for t in [i/32 for i in range(1,33)]]


MARK = [
    ('M17 65V31Q17 19 29 19H50', [(17,65),(17,31)]+quad((17,31),(17,19),(29,19))+[(50,19)], '#66716E', 9),
    ('M32 75V41Q32 29 44 29H63', [(32,75),(32,41)]+quad((32,41),(32,29),(44,29))+[(63,29)], '#A4ADA5', 9),
    ('M47 79V51Q47 39 59 39H70Q82 39 82 51V56Q82 68 70 68H47', [(47,79),(47,51)]+quad((47,51),(47,39),(59,39))+[(70,39)]+quad((70,39),(82,39),(82,51))+[(82,56)]+quad((82,56),(82,68),(70,68))+[(47,68)], '#F26844', 10),
]
SMALL = [
    ('M20 69V29Q20 18 31 18H53', [(20,69),(20,29)]+quad((20,29),(20,18),(31,18))+[(53,18)], 'currentColor', 11),
    ('M44 80V45Q44 35 54 35H67Q79 35 79 47V54Q79 66 67 66H44', [(44,80),(44,45)]+quad((44,45),(44,35),(54,35))+[(67,35)]+quad((67,35),(79,35),(79,47))+[(79,54)]+quad((79,54),(79,66),(67,66))+[(44,66)], 'currentColor', 11),
]


def export(name, width, height, word=False, color='#252B2C', readme=False, monochrome=False, small=False):
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" color="{color}"><title>Previously</title>']
    im = Image.new('RGBA', (width*SCALE, height*SCALE))
    draw = ImageDraw.Draw(im)
    if readme:
        svg.append('<rect x="5" y="5" width="750" height="222" rx="38" fill="white" stroke="#252B2C" stroke-width="10"/>')
        draw.rounded_rectangle((5*SCALE,5*SCALE,755*SCALE,227*SCALE),radius=38*SCALE, fill='white',outline='#252B2C',width=10*SCALE)
    xoff, yoff = (42,65) if readme else (0,0)
    svg.append(f'<g transform="translate({xoff} {yoff})">')
    for path, points, fill, stroke in (SMALL if small else MARK):
        fill = color if monochrome or fill == 'currentColor' else fill
        svg.append(f'<path d="{path}" fill="none" stroke="{fill}" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round"/>')
        transformed = [((x+xoff)*SCALE,(y+yoff)*SCALE) for x,y in points]
        draw.line(transformed,fill=fill,width=stroke*SCALE,joint='curve')
        r=stroke*SCALE/2
        for x,y in transformed:
            draw.ellipse((x-r,y-r,x+r,y+r),fill=fill)
    svg.append('</g>')
    if word:
        size = 77 if readme else 70
        x, baseline = (160,143) if readme else (112,75)
        scale = size/units
        for ch in 'Previously':
            name_glyph = cmap[ord(ch)]
            glyph = glyphs[name_glyph]
            pen = SVGPathPen(glyphs); glyph.draw(pen)
            svg.append(f'<path d="{escape(pen.getCommands(), quote=True)}" transform="translate({x:.5f} {baseline}) scale({scale:.8f} {-scale:.8f})" fill="{color}"/>')
            contours=Contours(); glyph.draw(contours)
            mask=Image.new('1',im.size)
            for contour in contours.paths:
                part=Image.new('1',im.size)
                ImageDraw.Draw(part).polygon([((x+a*scale)*SCALE,(baseline-b*scale)*SCALE) for a,b in contour],fill=1)
                mask=ImageChops.logical_xor(mask,part)
            im.paste(color,(0,0),mask)
            x += glyph.width*scale - (3 if readme else 2.2)
    svg.append('</svg>')
    (ROOT/f'{name}.svg').write_text(''.join(svg),encoding='utf-8')
    im.resize((width,height),Image.Resampling.LANCZOS).save(ROOT/f'{name}.png')


export('logo-readme',760,232,word=True,readme=True)
export('wordmark',480,96,word=True)
export('wordmark-dark',480,96,word=True,color='#F5F4EC')
export('mark',96,96)
export('mark-monochrome',96,96,monochrome=True)
export('mark-small',96,96,monochrome=True,small=True)
export('mark-small-dark',96,96,color='#F5F4EC',monochrome=True,small=True)

if __name__ == '__main__':
    required = 'PreviouslyЁёАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя'
    missing = [ch for ch in required if ord(ch) not in cmap]
    assert not missing, f'Missing required glyphs: {missing}'
    print('Outlined SVG and PNG exports rebuilt. EN/RU glyph coverage checked at weights 400, 550, 650 and 700 within Onest variable range.')
