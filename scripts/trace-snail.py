"""Traces the rainbow snail from the old link-preview image into a recolorable SVG.

The art only exists as a JPG (logo/old-social-preview.jpg). This maps each pixel to a
small fixed palette (outlines, grays and eight vivid hues), so the SVG has about 15
colors that the recolor modes can work with, then traces it with vtracer.

Run: pip install vtracer pillow && python scripts/trace-snail.py
"""
import colorsys
import re
import tempfile
from pathlib import Path

import vtracer
from PIL import Image, ImageFilter

SCALE, SPECK = 1.5, 8
# Fixed palette: outlines, grays for the eyes and stalks, the ground, and eight vivid hues.
PALETTE = {
    "ink": (18, 14, 28), "white": (240, 240, 245), "gray": (150, 150, 160), "darkgray": (80, 80, 92),
    "ground": (120, 104, 40),
    "red": (235, 40, 50), "orange": (250, 140, 20), "yellow": (250, 220, 30), "green": (40, 190, 60),
    "cyan": (20, 200, 230), "blue": (40, 90, 230), "purple": (130, 50, 200), "magenta": (220, 40, 180),
    "deeppurple": (68, 24, 104),
}
HUES = [("red", 0), ("orange", 30), ("yellow", 55), ("green", 120), ("cyan", 190), ("blue", 225), ("purple", 275), ("magenta", 315), ("red", 360)]
def classify(r, g, b, x, y, h_img):
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    if l < 0.10: return "ink"
    if l < 0.26 and s > 0.25 and 240 <= h * 360 <= 330: return "deeppurple"
    if l < 0.15: return "ink"
    if s < 0.22 or (l > 0.8 and s < 0.4):
        if y > h_img * 0.9 and l < 0.5: return "ground"
        return "white" if l > 0.72 else "gray" if l > 0.45 else "darkgray"
    if y > h_img * 0.93 and 40 <= h * 360 <= 70 and l < 0.45: return "ground"
    hd = h * 360
    return min(HUES, key=lambda t: abs(t[1] - hd))[0]
ROOT = Path(__file__).resolve().parent.parent
im = Image.open(ROOT / 'logo/old-social-preview.jpg').convert('RGB').crop((25, 125, 465, 495))  # the rainbow snail
im = im.resize((round(im.width * SCALE), round(im.height * SCALE)), Image.LANCZOS).filter(ImageFilter.MedianFilter(3))
bg = (38, 38, 38)
src = im.load()
rgba = Image.new('RGBA', im.size); out = rgba.load()
for y in range(im.height):
    for x in range(im.width):
        R, G, B = src[x, y]
        if max(abs(R - bg[0]), abs(G - bg[1]), abs(B - bg[2])) < 16:
            out[x, y] = (0, 0, 0, 0)
        else:
            out[x, y] = (*PALETTE[classify(R, G, B, x, y, im.height)], 255)
rgba = rgba.filter(ImageFilter.ModeFilter(3))
tmp = Path(tempfile.mkdtemp())
rgba.save(tmp / 'quant.png')
vtracer.convert_image_to_svg_py(str(tmp / 'quant.png'), str(tmp / 'raw.svg'), colormode='color', hierarchical='stacked', mode='spline',
    filter_speckle=SPECK, color_precision=8, layer_difference=10, corner_threshold=60, length_threshold=4.0, max_iterations=10, splice_threshold=45, path_precision=1)
s = (tmp / 'raw.svg').read_text()
pal = list(PALETTE.values())
def snap(m):
    c = tuple(int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4))
    return 'fill="#%02x%02x%02x"' % min(pal, key=lambda p: sum((a - b) ** 2 for a, b in zip(p, c)))
s = re.sub(r'fill="#([0-9A-Fa-f]{6})"', snap, s)
# A viewBox so it scales, a title, and no generator boilerplate.
w, h = re.search(r'width="(\d+)" height="(\d+)"', s).groups()
s = re.sub(r'^[\s\S]*?<svg[^>]*>', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">\n<title>Rainbow snail</title>', s, count=1)
out = ROOT / 'static/examples/rainbow-snail.svg'
out.parent.mkdir(exist_ok=True)
out.write_text(s, encoding='utf-8')
print(f'wrote {out.relative_to(ROOT)}: {len(s) // 1024} KB, {s.count("<path")} paths, {len(set(re.findall(r"fill=.(#[0-9a-f]{6})", s)))} colors')
