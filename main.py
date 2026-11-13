import base64
import functools
import hashlib
import io
import json
import logging
import os
import re
import subprocess
import zipfile
from pathlib import Path
from typing import Annotated, Literal, Optional

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
)
from starlette.middleware.gzip import GZipMiddleware
from starlette.staticfiles import StaticFiles

import recolor as engine
from server.agents import router as agents_router
from server.common import (
    APP_VERSION,
    CACHE_DOCS,
    CACHE_IMMUTABLE,
    CACHE_PAGE,
    CACHE_REMOTE,
    CACHE_STATIC,
    EXTRA_FIELDS,
    SVG_HEADERS,
    bad_request,
    base_url,
    decode,
    modes_info,
    options,
    output_name,
    respond,
    run,
    safe_stem,
)
from server.fetching import fetch_svg
from server.head import HeadAsGetMiddleware
from server.ratelimit import rate_limit_middleware

# Errors are logged to stderr, which Vercel shows in the project's Logs tab. The
# uptime check (.github/workflows/uptime.yml) is what tells you when the site breaks.
log = logging.getLogger("svg_recolor")

BASE_DIR = Path(__file__).resolve().parent

API_DESCRIPTION = """
Recolor SVG files over HTTP. Every endpoint is powered by the same engine as the website:
[svgray](https://github.com/snailedlt/svgray) for grayscale and
[svgshift](https://github.com/snailedlt/svgshift) for RGB/HSL color operations.

**Quick start**

```sh
# Upload a file
curl -X POST "https://svg-recolor.jorgenkh.no/api/recolor?color=ff0066&mode=colorize" \\
  -F "file=@icon.svg" -o icon-pink.svg

# Or point at a URL; works directly in <img src="...">
curl "https://svg-recolor.jorgenkh.no/api/recolor?url=https://example.com/icon.svg&color=tomato" -o icon.svg
```

**Colors** can be `ff0066`, `#ff0066` (URL-encode `#` as `%23`), `f06`, `255,0,102`,
`rgb(255 0 102)`, `hsl(330 100% 50%)` or a CSS color name like `tomato`.

**Modes**: `tint` (default), `colorize`, `hue`, `solid`, `grayscale`, `adjust`. See `GET /api/modes`.

**Fine-tuning**: `hue` (-360..360 degrees), `saturation` and `lightness` (-100..100) are applied after the mode.

**JSON in, JSON out**: `POST /api/recolor` also accepts `application/json` like
`{"svg": "<svg ...>", "color": "tomato", "mode": "solid"}` (or `"url"` instead of `"svg"`).
Add `format=json` to get the SVG plus the old-to-new color mapping back.

**AI agents**: a plain-text guide is at [`/llms.txt`](/llms.txt) and an MCP server
(streamable HTTP) is at `/mcp`.
"""

app = FastAPI(
    title="SVG Recolor API",
    description=API_DESCRIPTION,
    version=APP_VERSION,
    openapi_tags=[
        {"name": "Recolor", "description": "Recolor SVGs from uploads, raw bodies or URLs."},
        {"name": "Inspect", "description": "Look at an SVG's colors and the available modes."},
        {"name": "Legacy", "description": "Kept for backwards compatibility."},
    ],
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")



app.middleware("http")(rate_limit_middleware)
# Compress text responses (HTML, JS, CSS, SVG, JSON). The CDN serves the compressed copy.
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if response.status_code == 200 and "cache-control" not in response.headers:
        if path.startswith("/static/"):
            versioned = "v=" in request.url.query  # content-hashed URL from the page
            response.headers["Cache-Control"] = CACHE_IMMUTABLE if versioned else CACHE_STATIC
        elif path in ("/llms.txt", "/api", "/api/modes", "/openapi.json", "/docs", "/redoc"):
            response.headers["Cache-Control"] = CACHE_DOCS
    return response


# Outermost, so every layer below (rate limits, compression, cache headers) sees a GET.
app.add_middleware(HeadAsGetMiddleware)



ModeParam = Annotated[
    Literal["tint", "colorize", "hue", "solid", "grayscale", "adjust"],
    Query(description="How to recolor. See GET /api/modes."),
]
ColorParam = Annotated[
    str,
    Query(
        description="Target color: hex (ff0066, #ff0066, f06), RGB (255,0,102), rgb()/hsl() or a CSS name. `auto`: the SVG's "
                    "most prominent color (the one seen most; shades of one color count together).",
        examples=["ff0066"],
    ),
]
HueParam = Annotated[int, Query(ge=-360, le=360, description="Rotate hue by this many degrees.")]
SatParam = Annotated[int, Query(ge=-100, le=100, description="Shift saturation by this many points.")]
LightParam = Annotated[int, Query(ge=-100, le=100, description="Shift lightness by this many points.")]
FormatParam = Annotated[
    Literal["svg", "json"],
    Query(description="`svg` returns the file; `json` returns the SVG plus the color mapping."),
]
DownloadParam = Annotated[bool, Query(description="Send as an attachment instead of inline.")]
ReplaceParam = Annotated[Optional[str], Query(
    description="Give single colors their own new color, applied on top of the mode: `old:new` pairs, "
                "comma-separated. Colors in any format (hex, rgb(), names).",
    examples=["5e97f6:ff0000,ffffff:000000"])]
HideParam = Annotated[Optional[str], Query(
    description="Colors to make invisible (they become `none`/`transparent`; the shapes stay), comma-separated.",
    examples=["ffffff"])]
RemoveParam = Annotated[Optional[str], Query(
    description="Colors whose shapes are deleted, comma-separated (handy for a one-color icon: "
                "`mode=solid&remove=ffffff`). A shape whose fill or stroke alone is that color keeps the other.",
    examples=["ffffff"])]


def extra_query(
    cut: Annotated[Optional[str], Query(
        description="Colors that become real gaps: cut through what's below them, comma-separated. The result is "
                    "one path per color (Solid + cut = one path). For logos with outlines between their parts.",
        examples=["dce0df"])] = None,
    gap: Annotated[Optional[float], Query(
        description="Cut a gap of this width wherever two original colors meet (in `unit`s). With `mode=solid` "
                    "the color areas stay apart. For logos whose parts just touch.", ge=0, examples=[2])] = None,
    gaps: Annotated[Optional[str], Query(
        description="With `gap`: `auto` leaves the gaps out when the one-color drawing already shows its parts "
                    "through its holes (a mesh, line art, a grid), where gaps would only cut it up; `always` (default).",
        pattern="^(auto|always)$")] = None,
    gapsplit: Annotated[Optional[str], Query(
        description="With `gap`: `smaller` (default) cuts each gap out of the smaller of the two parts; `top` keeps "
                    "the shape drawn on top whole and cuts the gap out of what's under it (stacked shapes).",
        pattern="^(top|smaller)$")] = None,
    line: Annotated[Optional[float], Query(
        description="Make a line version (like devicon's line icons): only a band of this width along the edges "
                    "is kept (in `unit`s).", ge=0, examples=[3])] = None,
    lines: Annotated[Optional[str], Query(
        description="With `line`: `all` (default) also draws lines between colors, `outer` only the outline, "
                    "`plain` the outlines of the one-colour version (made first, with its holes and gaps).",
        pattern="^(all|outer|plain)$")] = None,
    linealign: Annotated[Optional[str], Query(
        description="With `line`: `inside` (default) draws the lines inside the edges, so the drawing keeps its size; "
                    "`center` on the edges, half outside, like a stroke turned into a shape (devicon's guide: Inkscape's "
                    "Stroke to Path). Leave room with `fit` (half a line).", pattern="^(inside|center)$")] = None,
    keep: Annotated[Optional[str], Query(
        description="With `line`: colors that stay filled, comma-separated.", examples=["ffffff"])] = None,
    holes: Annotated[Optional[str], Query(
        description="`light`: near-white colors (every channel 224 or more, or a pale tint close to gray) become holes, like `cut`, unless "
                    "edited otherwise. For one-color icons whose white parts should stay see-through.",
        pattern="^(light|none)$")] = None,
    outlines: Annotated[Optional[str], Query(
        description="`gap`: an outline color (its visible part thin, between thicker parts of other colors) "
                    "becomes a gap, so a one-color version keeps the parts it outlined apart (like Docker's).",
        pattern="^(gap|none)$")] = None,
    merge: Annotated[Optional[float], Query(
        description="Simplify: original colors this close (RGB distance, 0-442) count as one part, so shading "
                    "and highlights get no gaps or lines of their own. Try 40-80.", ge=0, le=442, examples=[60])] = None,
    detail: Annotated[Optional[float], Query(
        description="Simplify: pieces and holes smaller than this size squared (in `unit`s) are dropped (a hole "
                    "fills in), so specks get no gaps or lines.", ge=0, examples=[2])] = None,
    unit: Annotated[Optional[str], Query(
        description="Unit of `gap` and `line`: `px` (default; the SVG's own units) or `pct` (percent of the "
                    "icon's larger side).", pattern="^(px|pct)$")] = None,
    canvas: Annotated[Optional[str], Query(
        description="A new canvas (viewBox) size, `WxH`. The drawing stays centered unless `place` or `fit` "
                    "says otherwise.", examples=["128x128"])] = None,
    place: Annotated[Optional[str], Query(
        description="Where the drawing goes on the canvas: `x,y,scale`, where x,y is where its original "
                    "top-left corner lands.", examples=["0,0,0.5"])] = None,
    fit: Annotated[Optional[float], Query(
        description="Scale and center the visible drawing (strokes included) to fill the canvas, leaving this "
                    "padding on every side. Devicon (no padding): `canvas=128x128&fit=0`.", ge=0, examples=[0])] = None,
    optimize: Annotated[Optional[bool], Query(
        description="Optimize the result with SVGO 3.3.2, with the editor's default settings (multipass, "
                    "every preset plugin but removeViewBox, ...; the same as devicon's).")] = None,
    precision: Annotated[Optional[int], Query(
        description="With `optimize`: decimals kept in numbers (default 3).", ge=0, le=8)] = None,
) -> dict:
    """Cut out, gaps, lines, canvas and SVGO: the same code as the editor (see server/shapes.py)."""
    return {"cut": cut, "holes": holes, "outlines": outlines, "merge": merge, "detail": detail, "gap": gap, "gaps": gaps, "gapsplit": gapsplit, "line": line, "lines": lines, "linealign": linealign, "keep": keep, "unit": unit, "canvas": canvas,
            "place": place, "fit": fit, "optimize": optimize, "precision": precision}


ExtraQuery = Annotated[dict, Depends(extra_query)]


# --------------------------------------------------------------------------
# Website
# --------------------------------------------------------------------------


@app.get("/", include_in_schema=False)
async def landing_page():
    html = _landing_html()
    return HTMLResponse(content=html, headers={"Cache-Control": CACHE_PAGE, **_page_security_headers(html)})


def _page_security_headers(html: str) -> dict:
    """Strict CSP for the editor: only our own scripts plus the inline ones in
    main.html, allowed by hash. SVG previews are blob: images, so any script
    inside an uploaded SVG can't run."""
    inline_hashes = " ".join(
        "'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'"
        for body in re.findall(r"<script>([\s\S]*?)</script>", html)
    )
    csp = "; ".join([
        "default-src 'self'",
        f"script-src 'self' {inline_hashes}",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ])
    return {
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Frame-Options": "DENY",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    }


_landing_cache: Optional[str] = None
_bundle_cache: Optional[tuple[str, str]] = None

# Scripts served as one bundle (/assets/app.js) to save requests. Order matters.
BUNDLE = ("engine.js", "icons.js", "formats.js", "snippets.js", "highlight.js", "app.js")
# Small images inlined into the page as data: URIs, saving a request each.
INLINE_IMAGES = ("/static/logo-56.webp", "/static/avatar-48.webp")
# The style thumbnails' sample and "Try an example".
SAMPLE_PATH = "/static/examples/rainbow-snail.svg"


def _bundle() -> tuple[str, str]:
    """(javascript, short content hash) of the concatenated editor scripts."""
    global _bundle_cache
    if _bundle_cache is None or os.environ.get("SVG_RECOLOR_DEV"):
        js = "\n;\n".join((BASE_DIR / "static" / name).read_text(encoding="utf-8") for name in BUNDLE)
        _bundle_cache = (js, hashlib.sha256(js.encode()).hexdigest()[:12])
    return _bundle_cache


# "Cut out" geometry (paper.js + offsets + static/geometry.js), loaded by the editor only
# when someone cuts a color out. Vendored copies: static/vendor (scripts/vendor-geometry.sh).
GEOMETRY = ("vendor/paper-core.min.js", "vendor/paperjs-offset.min.js", "geometry.js")
_geometry_cache: Optional[tuple[str, str]] = None


@functools.lru_cache(maxsize=1)
def _optimize_version() -> str:
    """One hash for the SVGO worker and the SVGO build it imports (both under /static)."""
    h = hashlib.sha256()
    for name in ("optimize-worker.js", "vendor/svgo.browser.js"):
        h.update((BASE_DIR / "static" / name).read_bytes())
    return h.hexdigest()[:12]


def _geometry() -> tuple[str, str]:
    global _geometry_cache
    if _geometry_cache is None or os.environ.get("SVG_RECOLOR_DEV"):
        # The same file also runs as a Web Worker. paper.js handles that itself; paperjs-offset
        # (loaded after it) only needs a `window` to put PaperOffset on.
        parts = [(BASE_DIR / "static" / name).read_text(encoding="utf-8") for name in GEOMETRY]
        parts.insert(1, "self.window = self.window || self;")
        js = "\n;\n".join(parts)
        _geometry_cache = (js, hashlib.sha256(js.encode()).hexdigest()[:12])
    return _geometry_cache


def _page_config() -> str:
    """window.SVG_RECOLOR: the engine version, the sample image's URL (the rainbow
    snail, also "Try an example") and its colors in every style, so the style
    thumbnails need no API call on page load. The file itself is fetched from the
    CDN with a content hash, so it isn't inlined into every page."""
    sample_file = BASE_DIR / SAMPLE_PATH.lstrip("/")
    data = sample_file.read_bytes()
    colors = list(engine.extract_palette(engine.normalize_svg(data.decode("utf-8"))))
    seed = {}
    try:
        for mode, info in engine.MODES.items():
            key = ("color=ff0066&" if info["uses_color"] else "") + f"mode={mode}"
            seed[key] = engine.map_colors(colors, engine.Options(mode=mode, color="ff0066"))
    except Exception:  # the page must load even if the tools can't run
        # Without the seed the browser fetches the thumbnails itself; /api/health says why.
        log.exception("Could not precompute the style thumbnails")
        seed = {}
    sample_url = f"{SAMPLE_PATH}?v={hashlib.sha256(data).hexdigest()[:12]}"
    config = {"engineVersion": engine.ENGINE_VERSION, "sampleUrl": sample_url, "seed": seed,
              "geometryUrl": f"/assets/geometry.js?v={_geometry()[1]}",
              "optimizeUrl": f"/static/optimize-worker.js?v={_optimize_version()}"}
    return json.dumps(config, separators=(",", ":")).replace("</", "<\\/")


def _landing_html() -> str:
    global _landing_cache
    if _landing_cache is None or os.environ.get("SVG_RECOLOR_DEV"):
        html = (BASE_DIR / "main.html").read_text(encoding="utf-8")
        # Content hashes in asset URLs (/static/x.css?v=__HASH__): browsers and the
        # CDN cache them forever, and a deploy that changes a file changes its URL.
        def asset_hash(m: re.Match) -> str:
            digest = hashlib.sha256((BASE_DIR / m.group(1).lstrip("/")).read_bytes()).hexdigest()[:12]
            return f"{m.group(1)}?v={digest}"

        html = re.sub(r"(/static/[\w./-]+)\?v=__HASH__", asset_hash, html)
        html = html.replace("/assets/app.js?v=__HASH__", f"/assets/app.js?v={_bundle()[1]}")
        for path in INLINE_IMAGES:
            data = base64.b64encode((BASE_DIR / path.lstrip("/")).read_bytes()).decode()
            mime = "image/svg+xml" if path.endswith(".svg") else "image/webp"
            html = html.replace(f'src="{path}"', f'src="data:{mime};base64,{data}"')
        _landing_cache = html.replace("__CONFIG__", _page_config())
    return _landing_cache


@app.get("/assets/geometry.js", include_in_schema=False)
async def geometry_bundle(v: Optional[str] = None):
    js, digest = _geometry()
    cache = CACHE_IMMUTABLE if v == digest else CACHE_STATIC
    return Response(js, media_type="text/javascript; charset=utf-8", headers={"Cache-Control": cache})


@app.get("/assets/app.js", include_in_schema=False)
async def app_bundle(v: Optional[str] = None):
    js, digest = _bundle()
    cache = CACHE_IMMUTABLE if v == digest else CACHE_STATIC
    return Response(js, media_type="text/javascript; charset=utf-8", headers={"Cache-Control": cache})


# Browsers ask for these at the site root on their own; serve them from the CDN
# instead of letting every request fall through to a 404 in the function.
@app.get("/favicon.ico", include_in_schema=False)
async def favicon_ico():
    return FileResponse(BASE_DIR / "static/favicon/favicon.ico", headers={"Cache-Control": CACHE_STATIC})


@app.get("/apple-touch-icon.png", include_in_schema=False)
@app.get("/apple-touch-icon-precomposed.png", include_in_schema=False)
async def apple_touch_icon():
    return FileResponse(BASE_DIR / "static/favicon/apple-touch-icon.png", headers={"Cache-Control": CACHE_STATIC})


@app.get("/api/health", tags=["Inspect"], operation_id="health", summary="Check that the recolor tools work on this server")
async def health():
    """Runs svgray and svgshift on one color and reports what works. Not cached."""
    import platform

    report = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "libc": " ".join(platform.libc_ver()).strip() or None,
        "engine": engine.ENGINE_VERSION,
        "svgray": {"path": str(engine.SVGRAY_PATH), "exists": engine.SVGRAY_PATH.exists()},
        "svgshift": {"path": str(engine.SVGSHIFT_PATH), "exists": engine.SVGSHIFT_PATH.exists(),
                     "executable": os.access(engine.SVGSHIFT_PATH, os.X_OK)},
    }
    checks = {
        "svgray": lambda: engine.svgray_gray("5a9fd4"),
        "svgshift": lambda: engine.svgshift("setrgb", (255, 0, 0), ["5a9fd4"])[0],
    }
    ok = True
    for name, check in checks.items():
        try:
            report[name]["result"] = await run_in_threadpool(check)
        except Exception as e:  # noqa: BLE001 - report every failure, whatever it is
            report[name]["error"] = f"{type(e).__name__}: {e}"
            ok = False
    report["ok"] = ok
    return JSONResponse(report, status_code=200 if ok else 503, headers={"Cache-Control": "no-store"})


@app.get("/robots.txt", include_in_schema=False)
async def robots_txt(request: Request):
    # Keep crawlers on the page and off the API, which would only burn function time.
    body = (
        "User-agent: *\nAllow: /$\nAllow: /llms.txt\nAllow: /static/\n"
        "Disallow: /api\nDisallow: /mcp\nDisallow: /colorize\nDisallow: /docs\nDisallow: /redoc\n"
        f"\nSitemap: {base_url(request)}/sitemap.xml\n"
    )
    return PlainTextResponse(body, headers={"Cache-Control": CACHE_DOCS})


@app.get("/sitemap.xml", include_in_schema=False)
async def sitemap_xml(request: Request):
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"  <url><loc>{base_url(request)}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>\n"
        "</urlset>\n"
    )
    return Response(body, media_type="application/xml", headers={"Cache-Control": CACHE_DOCS})


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

OPTION_FIELDS = ("color", "mode", "hue", "saturation", "lightness", "format", "download", "replace", "hide", "remove") + EXTRA_FIELDS


async def _read_source(request: Request) -> tuple[str, str, dict]:
    """Read the SVG from a multipart form, a JSON body or a raw SVG body.

    Returns (svg_text, filename, options). Options found in a form or JSON body
    (color, mode, ...) override the query string."""
    content_type = request.headers.get("content-type", "").lower()
    name = "image.svg"
    if content_type.startswith(("multipart/form-data", "application/x-www-form-urlencoded")):
        form = await request.form()
        options = {k: form[k] for k in OPTION_FIELDS if form.get(k) not in (None, "")}
        upload = form.get("file") or form.get("icon")
        if upload is not None and hasattr(upload, "read"):
            return decode(await upload.read()), upload.filename or name, options
        if form.get("svg"):
            return decode(str(form["svg"]).encode()), str(form.get("filename") or name), options
        if form.get("url"):
            svg_text, name = await fetch_svg(str(form["url"]))
            return svg_text, name, options
        raise HTTPException(400, "Send the SVG as a 'file' field, its markup as an 'svg' field, or a link as a 'url' field.")
    body = await request.body()
    if content_type.startswith("application/json"):
        try:
            data = json.loads(body or b"{}")
        except ValueError:
            raise HTTPException(400, "The JSON body could not be parsed.")
        if not isinstance(data, dict):
            raise HTTPException(400, "The JSON body must be an object.")
        options = {k: data[k] for k in OPTION_FIELDS if data.get(k) is not None}
        if isinstance(data.get("svg"), str) and data["svg"].strip():
            return decode(data["svg"].encode()), str(data.get("filename") or name), options
        if isinstance(data.get("url"), str) and data["url"].strip():
            svg_text, name = await fetch_svg(data["url"])
            return svg_text, name, options
        raise HTTPException(400, 'The JSON body needs an "svg" string with the SVG markup, or a "url" string.')
    if not body:
        raise HTTPException(400, "The request body is empty. Send an SVG file, JSON, or a multipart form.")
    return decode(body), name, {}


JSON_BODY_SCHEMA = {
    "type": "object",
    "properties": {
        "svg": {"type": "string", "description": "The SVG markup."},
        "url": {"type": "string", "description": "Alternatively, a public link to an SVG."},
        "filename": {"type": "string", "description": "Used to name the output file."},
        "color": {"type": "string", "example": "ff0066"},
        "mode": {"type": "string", "enum": list(engine.MODES)},
        "hue": {"type": "integer", "minimum": -360, "maximum": 360},
        "saturation": {"type": "integer", "minimum": -100, "maximum": 100},
        "lightness": {"type": "integer", "minimum": -100, "maximum": 100},
        "format": {"type": "string", "enum": ["svg", "json"]},
        "replace": {"oneOf": [{"type": "object", "additionalProperties": {"type": "string"}}, {"type": "string"}],
                    "description": "Per-color new colors: {\"5e97f6\": \"ff0000\"} or \"5e97f6:ff0000,...\"."},
        "hide": {"oneOf": [{"type": "array", "items": {"type": "string"}}, {"type": "string"}],
                 "description": "Colors to make invisible."},
        "remove": {"oneOf": [{"type": "array", "items": {"type": "string"}}, {"type": "string"}],
                   "description": "Colors whose shapes are deleted."},
        "cut": {"oneOf": [{"type": "array", "items": {"type": "string"}}, {"type": "string"}],
                "description": "Colors that become real gaps (one path per color)."},
        "gap": {"type": "number", "minimum": 0, "description": "Gap width where two original colors meet."},
        "line": {"type": "number", "minimum": 0, "description": "Line version: band width along the edges."},
        "lines": {"type": "string", "enum": ["all", "outer", "plain"]},
        "linealign": {"type": "string", "enum": ["inside", "center"], "description": "Lines inside the edges (default) or centered on them."},
        "gaps": {"type": "string", "enum": ["auto", "always"], "description": "auto: no gaps when the parts already show through holes."},
        "gapsplit": {"type": "string", "enum": ["top", "smaller"], "description": "top: the shape on top stays whole; smaller (default): the smaller part gives up the gap."},
        "keep": {"oneOf": [{"type": "array", "items": {"type": "string"}}, {"type": "string"}],
                 "description": "With line: colors that stay filled."},
        "unit": {"type": "string", "enum": ["px", "pct"]},
        "holes": {"type": "string", "enum": ["light", "none"], "description": "light: near-white colors become holes."},
        "outlines": {"type": "string", "enum": ["gap", "none"], "description": "gap: outline colors become gaps."},
        "merge": {"type": "number", "minimum": 0, "maximum": 442, "description": "Simplify: colors this close (RGB distance) are one part."},
        "detail": {"type": "number", "minimum": 0, "description": "Simplify: pieces and holes smaller than this size squared go."},
        "canvas": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "number"}}],
                   "description": "New canvas (viewBox) size: \"128x128\" or [128, 128]."},
        "place": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "number"}}],
                  "description": "Drawing position and scale: \"x,y,scale\" or [x, y, scale]."},
        "fit": {"type": "number", "minimum": 0, "description": "Fit the visible drawing to the canvas with this padding."},
        "optimize": {"type": "boolean", "description": "Optimize with SVGO (default settings)."},
        "precision": {"type": "integer", "minimum": 0, "maximum": 8},
    },
}

RECOLOR_BODY = {
    "requestBody": {
        "content": {
            "application/json": {
                "schema": JSON_BODY_SCHEMA,
                "example": {"svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>', "color": "tomato", "mode": "solid", "format": "json"},
            },
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "properties": {
                        "file": {"type": "string", "format": "binary", "description": "The SVG file."},
                        "url": {"type": "string", "description": "Alternatively, a link to an SVG."},
                    },
                }
            },
            "image/svg+xml": {"schema": {"type": "string"}, "example": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#5a9fd4"/></svg>'},
        },
        "required": False,
    }
}


@app.get(
    "/api/recolor",
    tags=["Recolor"],
    summary="Recolor an SVG from a link",
    operation_id="recolorFromUrl",
    response_class=Response,
    responses={200: {"content": {"image/svg+xml": {}}}},
)
async def recolor_from_url(
    url: Annotated[str, Query(description="Public http(s) link to an SVG. GitHub 'blob' links are converted to raw links.")],
    extra: ExtraQuery,
    color: ColorParam = "ff0066",
    mode: ModeParam = "tint",
    hue: HueParam = 0,
    saturation: SatParam = 0,
    lightness: LightParam = 0,
    format: FormatParam = "svg",
    download: DownloadParam = False,
    replace: ReplaceParam = None,
    hide: HideParam = None,
    remove: RemoveParam = None,
):
    """Fetches the SVG at `url` and returns it recolored. Responses are cacheable, so you can
    use the endpoint directly as an image source:

    `<img src="https://svg-recolor.jorgenkh.no/api/recolor?url=https://.../icon.svg&color=tomato&mode=solid">`
    """
    opts = options(mode, color, hue, saturation, lightness, replace, hide, remove, **extra)
    svg_text, name = await fetch_svg(url)
    result = await run(svg_text, opts)
    return respond(result, opts, output_name(safe_stem(name), opts, result), format, download, cache=True)


@app.post(
    "/api/recolor",
    tags=["Recolor"],
    summary="Recolor an uploaded SVG",
    operation_id="recolorSvg",
    response_class=Response,
    responses={200: {"content": {"image/svg+xml": {}}}},
    openapi_extra=RECOLOR_BODY,
)
async def recolor_upload(
    request: Request,
    extra: ExtraQuery,
    color: ColorParam = "ff0066",
    mode: ModeParam = "tint",
    hue: HueParam = 0,
    saturation: SatParam = 0,
    lightness: LightParam = 0,
    format: FormatParam = "svg",
    download: DownloadParam = False,
    replace: ReplaceParam = None,
    hide: HideParam = None,
    remove: RemoveParam = None,
):
    """Send the SVG in any of these ways:

    - multipart form: a `file` field, an `svg` field with the markup, or a `url` field
    - JSON: `{"svg": "<svg ...>", "color": "tomato", "mode": "solid"}` (or `"url"`)
    - raw body with `Content-Type: image/svg+xml`

    Options in a form or JSON body override the query string."""
    svg_text, name, body_opts = await _read_source(request)
    params = {"color": color, "mode": mode, "hue": hue, "saturation": saturation,
              "lightness": lightness, "format": format, "download": download,
              "replace": replace, "hide": hide, "remove": remove} | extra | body_opts
    if params["format"] not in ("svg", "json"):
        raise HTTPException(400, "'format' must be 'svg' or 'json'.")
    opts = options(params["mode"], params["color"], params["hue"], params["saturation"], params["lightness"],
                   params["replace"], params["hide"], params["remove"], **{k: params.get(k) for k in EXTRA_FIELDS})
    result = await run(svg_text, opts)
    download_flag = str(params["download"]).lower() in ("1", "true", "yes")
    return respond(result, opts, output_name(safe_stem(name), opts, result), params["format"], download_flag)


def _parse_colors(raw) -> list[str]:
    if isinstance(raw, str):
        raw = [c for c in re.split(r"[\s,]+", raw) if c]
    if not isinstance(raw, list) or not raw:
        raise HTTPException(400, "Send at least one color, e.g. colors=5a9fd4,306998.")
    return [str(c) for c in raw]


def _parse_modes(raw) -> list[str]:
    modes = [m for m in re.split(r"[\s,]+", raw) if m] if isinstance(raw, str) else list(raw or [])
    unknown = [m for m in modes if m not in engine.MODES]
    if unknown or not modes:
        raise HTTPException(400, f"'modes' must list modes from: {', '.join(engine.MODES)}.")
    return list(dict.fromkeys(modes))


async def _map_response(colors: list[str], opts_by_mode: dict[str, engine.Options], cache: bool, single: Optional[str]):
    def compute():
        return {mode: engine.map_colors(colors, opts) for mode, opts in opts_by_mode.items()}

    try:
        results = await run_in_threadpool(compute)
    except engine.RecolorError as e:
        bad_request(e)
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        log.exception("Recolor tools failed")
        raise HTTPException(status_code=500, detail=f"Error processing the colors: {e}")
    headers = {"Access-Control-Allow-Origin": "*"}
    if cache:
        headers["Cache-Control"] = CACHE_IMMUTABLE
    as_hex = {mode: {f"#{k}": f"#{v}" for k, v in m.items()} for mode, m in results.items()}
    body = {"engine": engine.ENGINE_VERSION}
    body.update({"mode": single, "mapping": as_hex[single]} if single else {"mappings": as_hex})
    return JSONResponse(body, headers=headers)


@app.get("/api/map-colors", tags=["Recolor"], operation_id="mapColors", summary="Recolor a list of colors")
async def map_colors_get(
    colors: Annotated[str, Query(description="Comma-separated 6-digit hex colors, with or without '#'.", examples=["5a9fd4,306998,ffd43b"])],
    color: ColorParam = "ff0066",
    mode: ModeParam = "tint",
    hue: HueParam = 0,
    saturation: SatParam = 0,
    lightness: LightParam = 0,
    modes: Annotated[Optional[str], Query(description="Comma-separated modes to compute in one call; the response then has `mappings` per mode instead of `mapping`.", examples=["tint,colorize,solid"])] = None,
    v: Annotated[Optional[str], Query(description="Engine version; pass the `engine` value from a previous response to get a long-lived cacheable URL.")] = None,
):
    """Runs only the colors through the engine and returns the old-to-new mapping. The cheapest way
    to recolor: the website extracts an SVG's palette in the browser, calls this endpoint once for
    all styles (`modes=`), and applies the mapping itself. Responses are cached by the CDN, so
    identical requests are free.

    Also handy for design tokens or theme colors."""
    names = _parse_modes(modes) if modes else [mode]
    opts_by_mode = {m: options(m, color, hue, saturation, lightness) for m in names}
    return await _map_response(_parse_colors(colors), opts_by_mode, cache=v == engine.ENGINE_VERSION, single=None if modes else mode)


@app.post("/api/map-colors", tags=["Recolor"], operation_id="mapColorsPost", summary="Recolor a list of colors (JSON)")
async def map_colors_post(request: Request):
    """Same as `GET /api/map-colors`, for long palettes: send
    `{"colors": ["#5a9fd4", ...], "color": "tomato", "mode": "colorize"}` (or `"modes": [...]`)."""
    try:
        data = json.loads(await request.body() or b"{}")
    except ValueError:
        raise HTTPException(400, "The JSON body could not be parsed.")
    if not isinstance(data, dict):
        raise HTTPException(400, "The JSON body must be an object.")
    single = None if data.get("modes") else (data.get("mode") or engine.DEFAULT_MODE)
    names = _parse_modes(data["modes"]) if data.get("modes") else [single]
    opts_by_mode = {m: options(m, data.get("color") or "ff0066", data.get("hue", 0), data.get("saturation", 0), data.get("lightness", 0)) for m in names}
    return await _map_response(_parse_colors(data.get("colors")), opts_by_mode, cache=False, single=single)


@app.post(
    "/api/recolor/batch",
    tags=["Recolor"],
    operation_id="recolorBatch",
    summary="Recolor several SVGs at once",
    response_class=Response,
    responses={200: {"content": {"application/zip": {}}}},
)
async def recolor_batch(
    files: Annotated[list[UploadFile], File(description="Up to 50 SVG files.")],
    extra: ExtraQuery,
    color: ColorParam = "ff0066",
    mode: ModeParam = "tint",
    hue: HueParam = 0,
    saturation: SatParam = 0,
    lightness: LightParam = 0,
    replace: ReplaceParam = None,
    hide: HideParam = None,
    remove: RemoveParam = None,
):
    """Applies the same settings to every file and returns a ZIP archive."""
    if len(files) > 50:
        raise HTTPException(400, "Send at most 50 files per batch.")
    opts = options(mode, color, hue, saturation, lightness, replace, hide, remove, **extra)
    buf = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            data = await f.read()
            try:
                svg_text = engine.decode_svg(data)
            except engine.RecolorError as e:
                raise HTTPException(400, f"{f.filename}: {e}")
            result = await run(svg_text, opts)
            out = output_name(safe_stem(f.filename), opts, result)
            base, n = out, 2
            while out in used:
                out = base.replace(".svg", f"_{n}.svg")
                n += 1
            used.add(out)
            zf.writestr(out, result.svg)
    return Response(
        buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="svg-recolor.zip"', "Access-Control-Allow-Origin": "*"},
    )


@app.post("/api/palette", tags=["Inspect"], operation_id="listColors", summary="List the colors in an uploaded SVG", openapi_extra=RECOLOR_BODY)
async def palette_upload(request: Request):
    """Returns every distinct color in the SVG (after normalizing named colors, rgb()/hsl()
    and short hex) with how often it occurs."""
    svg_text, _, _ = await _read_source(request)
    return JSONResponse({"colors": engine.palette(svg_text)}, headers={"Access-Control-Allow-Origin": "*"})


@app.get("/api/palette", tags=["Inspect"], operation_id="listColorsFromUrl", summary="List the colors in an SVG from a link")
async def palette_url(url: Annotated[str, Query(description="Public http(s) link to an SVG.")]):
    svg_text, _ = await fetch_svg(url)
    return JSONResponse({"colors": engine.palette(svg_text)}, headers={"Access-Control-Allow-Origin": "*"})


@app.get("/api/fetch", tags=["Inspect"], operation_id="fetchSvg", summary="Download an SVG from a link without changing it", response_class=Response)
async def fetch_original(url: Annotated[str, Query(description="Public http(s) link to an SVG.")]):
    """Used by the website to preview linked SVGs. Applies the same safety checks as
    `GET /api/recolor`."""
    svg_text, name = await fetch_svg(url)
    headers = dict(SVG_HEADERS)
    headers["Content-Disposition"] = f"inline; filename=\"{safe_stem(name)}.svg\""
    headers["Cache-Control"] = CACHE_REMOTE
    return Response(svg_text, media_type="image/svg+xml", headers=headers)


@app.get("/api/modes", tags=["Inspect"], operation_id="listModes", summary="List the recolor modes")
async def list_modes():
    return modes_info()


@app.get("/api", tags=["Inspect"], operation_id="apiIndex", summary="List the API endpoints")
async def api_index(request: Request):
    """A machine-readable starting point: every endpoint with a one-line description."""
    base = base_url(request)
    return {
        "name": "SVG Recolor API",
        "docs": {"openapi": f"{base}/openapi.json", "swagger": f"{base}/docs", "redoc": f"{base}/redoc", "llms_txt": f"{base}/llms.txt"},
        "mcp": f"{base}/mcp",
        "endpoints": [
            {"method": "GET", "path": "/api/recolor", "description": "Recolor an SVG from a link (?url=). Cacheable; works as <img src>."},
            {"method": "POST", "path": "/api/recolor", "description": "Recolor an SVG sent as multipart, JSON {svg|url, ...} or a raw image/svg+xml body."},
            {"method": "POST", "path": "/api/recolor/batch", "description": "Recolor many files (multipart 'files'), get a ZIP."},
            {"method": "GET", "path": "/api/map-colors", "description": "Recolor just a list of colors (?colors=5a9fd4,306998). CDN-cached; cheapest option."},
            {"method": "GET", "path": "/api/palette", "description": "List the colors in an SVG from a link (?url=)."},
            {"method": "POST", "path": "/api/palette", "description": "List the colors in an uploaded SVG."},
            {"method": "GET", "path": "/api/modes", "description": "List recolor modes and option ranges."},
        ],
        **modes_info(),
    }


app.include_router(agents_router)


# --------------------------------------------------------------------------
# Legacy endpoint (used by older clients)
# --------------------------------------------------------------------------


@app.post("/colorize", tags=["Legacy"], operation_id="colorizeLegacy", deprecated=True, summary="Recolor an uploaded SVG (legacy)", response_class=Response)
async def colorize(
    icon: Annotated[UploadFile, File(description="The SVG file.")],
    color: str = "#FF0066",
    mode: ModeParam = "tint",
):
    """Original endpoint. Prefer `POST /api/recolor`, which takes the same `color` and
    supports more options."""
    opts = options(mode, color, 0, 0, 0)
    svg_text = decode(await icon.read())
    result = await run(svg_text, opts)
    return respond(result, opts, output_name(safe_stem(icon.filename), opts, result), "svg", True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
