"""Traces the rainbow snail from the old link-preview image into a recolorable SVG.

The art only exists as a JPG (logo/old-social-preview.jpg). Two steps:

1. This script maps each pixel to a small fixed palette (outlines, grays and eight
   vivid hues) on a transparent background, so the SVG ends up with about 15 colors
   for the recolor modes to work with.
2. vectorize.js from the svg-icons agent skill (devicons/devicon#2824) traces each
   color with potrace, stacks the layers without seams, fits the result to
   0 0 128 128 and optimizes it with SVGO: one path per color, about 50 KB.

Run:
    pip install pillow
    python scripts/trace-snail.py --skill path/to/devicon/.claude/skills/svg-icons
    (without --skill it only writes the classified PNG and prints the command)
"""
import argparse
import colorsys
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageFilter

SCALE = 1.5
# vectorize.js settings: trace at 512 px with light smoothing (keeps the thin lines).
TRACE_SIZE, SMOOTH = 512, 2
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
args = argparse.ArgumentParser(description=__doc__.splitlines()[0])
args.add_argument("--skill", help="path to the svg-icons skill (with its scripts/ installed: npm install)")
opts = args.parse_args()

png = Path(tempfile.mkdtemp()) / "rainbow-snail-classified.png"
rgba.save(png)
out = ROOT / "static/examples/rainbow-snail.svg"
palette = ",".join("#%02x%02x%02x" % c for c in PALETTE.values())
cmd = ["node", "vectorize.js", str(png), "--out", str(out), "--palette", palette,
       "--size", str(TRACE_SIZE), "--smooth", str(SMOOTH)]
if not opts.skill:
    print(f"wrote {png}\nnow run, in <svg-icons skill>/scripts:\n  " + " ".join(f"'{c}'" if "," in c else c for c in cmd))
else:
    subprocess.run(cmd, cwd=Path(opts.skill) / "scripts", check=True)
    print(f"wrote {out.relative_to(ROOT)}: {out.stat().st_size // 1024} KB")
