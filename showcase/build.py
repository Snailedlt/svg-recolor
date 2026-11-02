"""Build the standalone showcase page (one HTML file, no server needed).

The page is the real editor (main.html + static/*) with everything inlined and
the server calls replaced by an in-browser port of the color math
(demo-color-math.js). Linking to SVGs and downloading are disabled because a
standalone page can't do them.

Usage (needs Pillow):
    python showcase/build.py [output.html]     # default: showcase/dist/svg-recolor-showcase.html
"""

import base64
import io
import json
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
SITE = "https://svg-recolor.jorgenkh.no"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def data_uri(path: Path, width: int, crop_height: int | None = None, fmt: str = "JPEG") -> str:
    im = Image.open(path).convert("RGB")
    if crop_height:
        im = im.crop((0, 0, im.width, min(im.height, crop_height)))
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, fmt, **({"quality": 80} if fmt == "JPEG" else {}))
    return f"data:image/{fmt.lower()};base64," + base64.b64encode(buf.getvalue()).decode()


def replace(src: str, old: str, new: str) -> str:
    if old not in src:
        raise SystemExit(f"showcase/build.py is out of date with the source; missing:\n{old[:200]}")
    return src.replace(old, new, 1)


def build() -> str:
    example = read("static/examples/python.svg")
    js = read("static/app.js")

    # Server calls -> in-browser color math; demo defaults; no URL updates.
    js = replace(js, "const SITE = location.origin.startsWith('http') ? location.origin : 'https://svg-recolor.jorgenkh.no';",
                 f"const SITE = '{SITE}';\n    const EXAMPLE_SVG = {json.dumps(example)};\n" + (HERE / "demo-color-math.js").read_text(encoding="utf-8"))
    js = replace(js, "    async function fetchAllModes(colors) {", """    // Showcase: the color math runs in the browser instead of on the server.
    async function fetchAllModes(colors) {
        const shared = sharedParams();
        const p = Object.fromEntries(shared);
        const mappings = {};
        for (const mode of MODE_KEYS) {
            const m = DemoEngine.mapColors(colors, { mode, color: '#' + (p.color || 'ff0066'), hue: +p.hue || 0, saturation: +p.saturation || 0, lightness: +p.lightness || 0 });
            mappings[mode] = Object.fromEntries(Object.entries(m).map(([k, v]) => ['#' + k, '#' + v]));
        }
        await new Promise((r) => setTimeout(r, 30));
        storeMappings(mappings, shared);
    }
    async function fetchAllModesFromServer(colors) {""")
    js = replace(js, "            const res = await fetch('/api/fetch?url=' + encodeURIComponent(url));",
                 "            throw new Error('This demo can\\'t download from other sites. On " + SITE.split('//')[1]
                 + " the server fetches links for you; here, upload a file or try the example.');\n"
                 "            const res = await fetch('/api/fetch?url=' + encodeURIComponent(url));")
    js = replace(js, """            const res = await fetch('/static/examples/python.svg');
            if (!res.ok) throw new Error();
            const text = await res.text();""", "            const text = EXAMPLE_SVG;")
    js = replace(js, "try { history.replaceState(null, '', location.pathname + '?' + shareParams().toString() + location.hash); } catch (e) { /* ignore */ }",
                 "/* showcase: the page address is not updated */")
    js = replace(js, "    if (start.get('url')) {", """    setColor('#7C5CFF', false);
    loadText(EXAMPLE_SVG, 'python.svg', new Blob([EXAMPLE_SVG]).size, null);
    if (start.get('url')) {""")

    html = read("main.html")
    head_end = html.index("</head>")
    body = html[html.index("<body>") + 6 : html.index("</body>")]
    theme_script = html[html.index("        <script>\n            // Apply the saved") : head_end]
    # The showcase is a single file, so it loads the fonts from Google Fonts instead of /static/fonts.
    fonts = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
             '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">')
    css = re.sub(r"@font-face \{[^}]*\}\s*", "", read("static/app.css"))
    head = (
        '<title>SVG Recolor Redesign</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n'
        + fonts + "\n<style>\n" + css + (HERE / "showcase.css").read_text(encoding="utf-8") + "</style>\n" + theme_script
    )

    body = replace(body, "/static/logo-56.webp", data_uri(ROOT / "static/logo-56.webp", 56, fmt="PNG"))
    body = replace(body, "/static/avatar-48.webp", data_uri(ROOT / "static/avatar-48.webp", 48, fmt="PNG"))
    for path in ("/docs", "/redoc", "/llms.txt", "/openapi.json", "/api"):
        body = body.replace(f'href="{path}"', f'href="{SITE}{path}"')
    body = replace(body, '<h1 class="brand"><a href="/">', f'<h1 class="brand"><a href="{SITE}" target="_blank" rel="noopener">')
    body = replace(body, '<a class="btn btn-primary btn-sm" id="download-btn"', '<span hidden class="btn btn-primary btn-sm" id="download-btn"')
    body = replace(body, "                                Download\n                            </a>", "                                Download\n                            </span>")
    body = replace(body, '<div class="app-grid">', '''<div class="demo-note" role="note"><span class="tag">Demo</span><span>A working copy of the editor. Here the <b>whole recolor runs in your browser</b>; on the live site only the palette goes to the server. Links and downloads need the live site.</span></div>
                <div class="app-grid">''')

    libs = "".join(f"\n<script>\n{read('static/' + name)}\n</script>" for name in ("engine.js", "icons.js", "formats.js", "snippets.js"))
    body, count = re.subn(
        r'\s*<script>window\.SVG_RECOLOR[^<]*</script>\s*(<!--[^>]*-->\s*)?<script src="/assets/app\.js\?v=__HASH__" defer></script>',
        lambda m: libs + "\n<script>\n" + js + "\n</script>\n", body,
    )
    if count != 1 or "/static/" in body:
        raise SystemExit("showcase/build.py could not inline the scripts; main.html changed?")
    return head + "\n" + body


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "dist" / "svg-recolor-showcase.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build(), encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size // 1024} KB)")
