"""Draws the SVG Recolor snail (logo, favicon source, default example).

Run: python scripts/make-snail.py   (then scripts/make-icons.mjs for the PNG icons)
"""
# An original rainbow snail, drawn for SVG Recolor. The shell is a spiral of
# semicircles that grow each half-turn; each one is its own path, so every band
# has its own color (seven colors give each recolor mode something to show).
cx, cy, d = 96, 138, 16
INK = "#1e1b4b"
colors = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7"]
paths = []
for i in range(7):
    rr = d / 2 * (i + 1)
    ccx = cx + (d / 2 if i % 2 == 0 else 0)
    sx, ex = (ccx - rr, ccx + rr) if i % 2 == 0 else (ccx + rr, ccx - rr)
    paths.append(f'<path d="M{sx:g} {cy}A{rr:g} {rr:g} 0 0 1 {ex:g} {cy}" stroke="{colors[i]}"/>')
R = d / 2 * 7 + d / 2 - 2
scx = cx + d / 4
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <title>SVG Recolor snail</title>
  <path d="M14 222C14 206 40 200 70 198L176 196C190 195 194 184 192 168C190 148 200 134 216 134C234 134 244 150 242 172C240 204 214 224 178 226L30 230C20 230 14 228 14 222Z" fill="#8b5cf6" stroke="{INK}" stroke-width="7" stroke-linejoin="round"/>
  <path d="M207 138L198 76M226 139L240 82" stroke="{INK}" stroke-width="7" stroke-linecap="round" fill="none"/>
  <circle cx="197" cy="68" r="13" fill="#fff" stroke="{INK}" stroke-width="6"/>
  <circle cx="241" cy="74" r="13" fill="#fff" stroke="{INK}" stroke-width="6"/>
  <circle cx="200" cy="69" r="5.5" fill="{INK}"/>
  <circle cx="244" cy="75" r="5.5" fill="{INK}"/>
  <path d="M211 178Q221 186 231 176" stroke="{INK}" stroke-width="5" stroke-linecap="round" fill="none"/>
  <circle cx="{scx:g}" cy="{cy}" r="{R:g}" fill="{INK}"/>
  <g fill="none" stroke-width="{d - 2:g}" stroke-linecap="round">
    {(chr(10) + "    ").join(paths)}
  </g>
  <circle cx="{scx:g}" cy="{cy}" r="{R:g}" fill="none" stroke="{INK}" stroke-width="7"/>
</svg>
'''
if __name__ == "__main__":
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    # One file: the header logo, the favicon, "Try an example" and the style thumbnails.
    (root / "static/logo.svg").write_text(svg, encoding="utf-8")
    print("wrote static/logo.svg")
