import hashlib
import io
import ipaddress
import json
import os
import re
import socket
import subprocess
import zipfile
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote, urlparse

import httpx
import sentry_sdk
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from starlette.staticfiles import StaticFiles

import recolor as engine

sentry_sdk.init(
    dsn="https://98b39a4523a365e1bbc2639fbb075633@o4508424099856384.ingest.de.sentry.io/4508424101363792",
    # Set traces_sample_rate to 1.0 to capture 100%
    # of transactions for tracing.
    traces_sample_rate=1.0,
    _experiments={
        # Set continuous_profiling_auto_start to True
        # to automatically start the profiler on when
        # possible.
        "continuous_profiling_auto_start": True,
    },
)

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
    version="2.0.0",
    openapi_tags=[
        {"name": "Recolor", "description": "Recolor SVGs from uploads, raw bodies or URLs."},
        {"name": "Inspect", "description": "Look at an SVG's colors and the available modes."},
        {"name": "Legacy", "description": "Kept for backwards compatibility."},
    ],
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")

# Cache policy. `s-maxage` lets the hosting CDN (Vercel's edge network) answer repeat
# requests without running the function, which keeps cost flat as traffic grows.
CACHE_PAGE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"
CACHE_STATIC = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800"
CACHE_DOCS = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
CACHE_REMOTE = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800"
# Mapping results depend only on the query (which includes the engine version).
CACHE_IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable"


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if response.status_code == 200 and "cache-control" not in response.headers:
        if path.startswith("/static/"):
            response.headers["Cache-Control"] = CACHE_STATIC
        elif path in ("/llms.txt", "/api", "/api/modes", "/openapi.json"):
            response.headers["Cache-Control"] = CACHE_DOCS
    return response

# Served SVGs are user content. Stop any embedded script from running if the
# response is opened directly on this origin.
SVG_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
}

ModeParam = Annotated[
    Literal["tint", "colorize", "hue", "solid", "grayscale", "adjust"],
    Query(description="How to recolor. See GET /api/modes."),
]
ColorParam = Annotated[
    str,
    Query(
        description="Target color: hex (ff0066, #ff0066, f06), RGB (255,0,102), rgb()/hsl() or a CSS name.",
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


# --------------------------------------------------------------------------
# Website
# --------------------------------------------------------------------------


@app.get("/", include_in_schema=False)
async def landing_page():
    return HTMLResponse(content=_landing_html(), headers={"Cache-Control": CACHE_PAGE})


_landing_cache: str | None = None


def _landing_html() -> str:
    global _landing_cache
    if _landing_cache is None or os.environ.get("SVG_RECOLOR_DEV"):
        html = (BASE_DIR / "main.html").read_text(encoding="utf-8")
        # Content hashes in asset URLs: browsers and the CDN can cache them, and a
        # deploy that changes a file changes its URL.
        for placeholder, asset in (("__APP_CSS_V__", "app.css"), ("__APP_JS_V__", "app.js"), ("__FORMATS_JS_V__", "formats.js")):
            digest = hashlib.sha256((BASE_DIR / "static" / asset).read_bytes()).hexdigest()[:12]
            html = html.replace(placeholder, digest)
        _landing_cache = html.replace("__ENGINE_VERSION__", engine.ENGINE_VERSION)
    return _landing_cache


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _base_url(request: Request) -> str:
    """Public base URL, honoring the proxy headers set by the hosting platform."""
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host.split(',')[0].strip()}"


def _bad_request(e: Exception, status: int = 400):
    raise HTTPException(status_code=status, detail=str(e))


def _options(mode, color, hue, saturation, lightness) -> engine.Options:
    try:
        return engine.Options(
            mode=mode, color=color, hue=hue, saturation=saturation, lightness=lightness
        ).validate()
    except engine.RecolorError as e:
        _bad_request(e)


def _safe_stem(name: str | None) -> str:
    stem = Path(name or "image.svg").stem or "image"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", stem)[:80] or "image"


def _output_name(stem: str, opts: engine.Options) -> str:
    suffix = opts.mode
    if engine.MODES[opts.mode]["uses_color"]:
        suffix += "_" + engine.rgb_to_hex(engine.parse_color(opts.color))[1:]
    return f"{stem}_recolored_{suffix}.svg"


async def _run(svg_text: str, opts: engine.Options) -> engine.Result:
    try:
        return await run_in_threadpool(engine.recolor, svg_text, opts)
    except engine.RecolorError as e:
        _bad_request(e)
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:  # svgray/svgshift failed
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=f"Error processing the SVG file: {e}")


def _respond(result: engine.Result, opts, filename: str, fmt: str, download: bool, cache: bool = False):
    if fmt == "json":
        return JSONResponse(
            {
                "filename": filename,
                "mode": opts.mode,
                "color": engine.rgb_to_hex(engine.parse_color(opts.color))
                if engine.MODES[opts.mode]["uses_color"]
                else None,
                "adjustments": {"hue": opts.hue, "saturation": opts.saturation, "lightness": opts.lightness},
                "palette": result.palette(),
                "svg": result.svg,
            },
            headers={"Access-Control-Allow-Origin": "*"},
        )
    headers = dict(SVG_HEADERS)
    disposition = "attachment" if download else "inline"
    headers["Content-Disposition"] = f"{disposition}; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}"
    if cache:
        headers["Cache-Control"] = CACHE_REMOTE
    return Response(result.svg, media_type="image/svg+xml", headers=headers)


def _decode(data: bytes) -> str:
    try:
        return engine.decode_svg(data)
    except engine.RecolorError as e:
        _bad_request(e, 413 if len(data) > engine.MAX_SVG_BYTES else 415)


# --------------------------------------------------------------------------
# Fetching SVGs from links
# --------------------------------------------------------------------------


def _github_raw(url: str) -> str:
    """Turn github.com/<owner>/<repo>/blob/<ref>/<path> into the raw file URL."""
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/blob/(.+)$", url)
    return f"https://raw.githubusercontent.com/{m[1]}/{m[2]}/{m[3]}" if m else url


def _check_public_host(host: str, port: int):
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise HTTPException(400, f"Could not resolve the host '{host}'.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise HTTPException(400, "Links to private or local network addresses are not allowed.")


FETCH_HEADERS = {
    "User-Agent": "svg-recolor (+https://svg-recolor.jorgenkh.no)",
    "Accept": "image/svg+xml,*/*;q=0.8",
}


async def fetch_svg(url: str) -> tuple[str, str]:
    """Download an SVG from a public http(s) URL. Returns (svg_text, filename)."""
    url = _github_raw(url.strip())
    for _ in range(4):  # initial request + up to 3 redirects, each re-validated
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise HTTPException(400, "The link must start with http:// or https://.")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        await run_in_threadpool(_check_public_host, parsed.hostname, port)
        try:
            async with (
                httpx.AsyncClient(timeout=10, follow_redirects=False) as client,
                client.stream("GET", url, headers=FETCH_HEADERS) as resp,
            ):
                if resp.is_redirect and "location" in resp.headers:
                    url = str(resp.url.join(resp.headers["location"]))
                    continue
                if resp.status_code >= 400:
                    raise HTTPException(400, f"The link returned HTTP {resp.status_code}.")
                data = b""
                async for chunk in resp.aiter_bytes():
                    data += chunk
                    if len(data) > engine.MAX_SVG_BYTES:
                        raise HTTPException(413, "The linked file is larger than 2 MB.")
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Could not download the link: {e.__class__.__name__}.")
        name = Path(urlparse(url).path).name or "image.svg"
        return _decode(data), name
    raise HTTPException(400, "The link redirected too many times.")


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

OPTION_FIELDS = ("color", "mode", "hue", "saturation", "lightness", "format", "download")


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
            return _decode(await upload.read()), upload.filename or name, options
        if form.get("svg"):
            return _decode(str(form["svg"]).encode()), str(form.get("filename") or name), options
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
            return _decode(data["svg"].encode()), str(data.get("filename") or name), options
        if isinstance(data.get("url"), str) and data["url"].strip():
            svg_text, name = await fetch_svg(data["url"])
            return svg_text, name, options
        raise HTTPException(400, 'The JSON body needs an "svg" string with the SVG markup, or a "url" string.')
    if not body:
        raise HTTPException(400, "The request body is empty. Send an SVG file, JSON, or a multipart form.")
    return _decode(body), name, {}


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
    color: ColorParam = "ff0066",
    mode: ModeParam = "tint",
    hue: HueParam = 0,
    saturation: SatParam = 0,
    lightness: LightParam = 0,
    format: FormatParam = "svg",
    download: DownloadParam = False,
):
    """Fetches the SVG at `url` and returns it recolored. Responses are cacheable, so you can
    use the endpoint directly as an image source:

    `<img src="https://svg-recolor.jorgenkh.no/api/recolor?url=https://.../icon.svg&color=tomato&mode=solid">`
    """
    opts = _options(mode, color, hue, saturation, lightness)
    svg_text, name = await fetch_svg(url)
    result = await _run(svg_text, opts)
    return _respond(result, opts, _output_name(_safe_stem(name), opts), format, download, cache=True)


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
    color: ColorParam = "ff0066",
    mode: ModeParam = "tint",
    hue: HueParam = 0,
    saturation: SatParam = 0,
    lightness: LightParam = 0,
    format: FormatParam = "svg",
    download: DownloadParam = False,
):
    """Send the SVG in any of these ways:

    - multipart form: a `file` field, an `svg` field with the markup, or a `url` field
    - JSON: `{"svg": "<svg ...>", "color": "tomato", "mode": "solid"}` (or `"url"`)
    - raw body with `Content-Type: image/svg+xml`

    Options in a form or JSON body override the query string."""
    svg_text, name, body_opts = await _read_source(request)
    params = {"color": color, "mode": mode, "hue": hue, "saturation": saturation,
              "lightness": lightness, "format": format, "download": download} | body_opts
    if params["format"] not in ("svg", "json"):
        raise HTTPException(400, "'format' must be 'svg' or 'json'.")
    opts = _options(params["mode"], params["color"], params["hue"], params["saturation"], params["lightness"])
    result = await _run(svg_text, opts)
    download_flag = str(params["download"]).lower() in ("1", "true", "yes")
    return _respond(result, opts, _output_name(_safe_stem(name), opts), params["format"], download_flag)


def _parse_colors(raw) -> list[str]:
    if isinstance(raw, str):
        raw = [c for c in re.split(r"[\s,]+", raw) if c]
    if not isinstance(raw, list) or not raw:
        raise HTTPException(400, "Send at least one color, e.g. colors=5a9fd4,306998.")
    return [str(c) for c in raw]


async def _map_response(colors: list[str], opts: engine.Options, cache: bool):
    try:
        mapping = await run_in_threadpool(engine.map_colors, colors, opts)
    except engine.RecolorError as e:
        _bad_request(e)
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=f"Error processing the colors: {e}")
    headers = {"Access-Control-Allow-Origin": "*"}
    if cache:
        headers["Cache-Control"] = CACHE_IMMUTABLE
    return JSONResponse(
        {"engine": engine.ENGINE_VERSION, "mode": opts.mode, "mapping": {f"#{k}": f"#{v}" for k, v in mapping.items()}},
        headers=headers,
    )


@app.get("/api/map-colors", tags=["Recolor"], operation_id="mapColors", summary="Recolor a list of colors")
async def map_colors_get(
    colors: Annotated[str, Query(description="Comma-separated 6-digit hex colors, with or without '#'.", examples=["5a9fd4,306998,ffd43b"])],
    color: ColorParam = "ff0066",
    mode: ModeParam = "tint",
    hue: HueParam = 0,
    saturation: SatParam = 0,
    lightness: LightParam = 0,
    v: Annotated[str | None, Query(description="Engine version; pass the `engine` value from a previous response to get a long-lived cacheable URL.")] = None,
):
    """Runs only the colors through the engine and returns the old-to-new mapping. The cheapest way
    to recolor: the website extracts an SVG's palette in the browser, calls this endpoint, and
    applies the mapping itself. Responses are cached by the CDN, so identical requests are free.

    Also handy for design tokens or theme colors."""
    opts = _options(mode, color, hue, saturation, lightness)
    return await _map_response(_parse_colors(colors), opts, cache=v == engine.ENGINE_VERSION)


@app.post("/api/map-colors", tags=["Recolor"], operation_id="mapColorsPost", summary="Recolor a list of colors (JSON)")
async def map_colors_post(request: Request):
    """Same as `GET /api/map-colors`, for long palettes: send
    `{"colors": ["#5a9fd4", ...], "color": "tomato", "mode": "colorize"}`."""
    try:
        data = json.loads(await request.body() or b"{}")
    except ValueError:
        raise HTTPException(400, "The JSON body could not be parsed.")
    if not isinstance(data, dict):
        raise HTTPException(400, "The JSON body must be an object.")
    opts = _options(data.get("mode") or engine.DEFAULT_MODE, data.get("color") or "ff0066",
                    data.get("hue", 0), data.get("saturation", 0), data.get("lightness", 0))
    return await _map_response(_parse_colors(data.get("colors")), opts, cache=False)


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
    color: ColorParam = "ff0066",
    mode: ModeParam = "tint",
    hue: HueParam = 0,
    saturation: SatParam = 0,
    lightness: LightParam = 0,
):
    """Applies the same settings to every file and returns a ZIP archive."""
    if len(files) > 50:
        raise HTTPException(400, "Send at most 50 files per batch.")
    opts = _options(mode, color, hue, saturation, lightness)
    buf = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            data = await f.read()
            try:
                svg_text = engine.decode_svg(data)
            except engine.RecolorError as e:
                raise HTTPException(400, f"{f.filename}: {e}")
            result = await _run(svg_text, opts)
            out = _output_name(_safe_stem(f.filename), opts)
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
    headers["Content-Disposition"] = f"inline; filename=\"{_safe_stem(name)}.svg\""
    headers["Cache-Control"] = CACHE_REMOTE
    return Response(svg_text, media_type="image/svg+xml", headers=headers)


def _modes_info() -> dict:
    return {
        "default": engine.DEFAULT_MODE,
        "modes": [{"id": k, **v} for k, v in engine.MODES.items()],
        "adjustments": {
            "hue": {"min": -360, "max": 360, "unit": "degrees"},
            "saturation": {"min": -100, "max": 100, "unit": "percentage points"},
            "lightness": {"min": -100, "max": 100, "unit": "percentage points"},
        },
    }


@app.get("/api/modes", tags=["Inspect"], operation_id="listModes", summary="List the recolor modes")
async def list_modes():
    return _modes_info()


@app.get("/api", tags=["Inspect"], operation_id="apiIndex", summary="List the API endpoints")
async def api_index(request: Request):
    """A machine-readable starting point: every endpoint with a one-line description."""
    base = _base_url(request)
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
        **_modes_info(),
    }


# --------------------------------------------------------------------------
# AI agents: llms.txt and an MCP server
# --------------------------------------------------------------------------


def _llms_txt(base: str) -> str:
    modes = "\n".join(f"- `{k}`: {v['description']}" for k, v in engine.MODES.items())
    return f"""# SVG Recolor

> Recolor SVG files (icons, logos, illustrations) over HTTP. No API key. Powered by svgray
> (grayscale) and svgshift (RGB/HSL color operations).

Base URL: {base}

## Quick reference

- Recolor from a link: `GET {base}/api/recolor?url=<svg-url>&color=<color>&mode=<mode>` → `image/svg+xml`
- Recolor markup: `POST {base}/api/recolor` with `Content-Type: application/json` and
  `{{"svg": "<svg ...>", "color": "tomato", "mode": "solid", "format": "json"}}`
  → `{{"svg": "...", "palette": [{{"from": "#5a9fd4", "to": "#ff6347", "count": 3}}], "filename": "..."}}`
- Recolor a file: `POST {base}/api/recolor?color=ff0066` with multipart field `file`
- Many files: `POST {base}/api/recolor/batch` with multipart fields `files` → ZIP
- Just colors: `GET {base}/api/map-colors?colors=5a9fd4,306998&color=tomato&mode=colorize`
  → `{{"mapping": {{"#5a9fd4": "#…"}}}}`. Use this when you already have the colors (design tokens, themes).
- List colors: `GET {base}/api/palette?url=<svg-url>` or `POST {base}/api/palette` (same bodies as above)
- Modes and limits: `GET {base}/api/modes`
- OpenAPI: {base}/openapi.json
- MCP server (streamable HTTP, no auth): {base}/mcp
  Tools: `recolor_svg`, `list_svg_colors`, `list_recolor_modes`.
  Claude Code: `claude mcp add --transport http svg-recolor {base}/mcp`

## Parameters

- `color`: `ff0066`, `#ff0066` (encode `#` as `%23` in URLs), `f06`, `255,0,102`,
  `rgb(255 0 102)`, `hsl(330 100% 50%)`, or a CSS name like `tomato`. Default `ff0066`.
- `mode`: one of {", ".join(f"`{k}`" for k in engine.MODES)}. Default `{engine.DEFAULT_MODE}`.
- `hue`: rotate hue, -360..360 degrees. `saturation`, `lightness`: -100..100 points. Applied after the mode.
- `format`: `svg` (default) or `json`. `download`: `true` to get an attachment.

## Modes

{modes}

Pick `solid` for single-color icons, `colorize` to keep shading in multi-color art,
`hue` to change hue only, `adjust` (with `hue`/`saturation`/`lightness`) to tweak.

## Limits and errors

- SVGs up to 2 MB. Links must be public http(s); private and local addresses are refused.
- GitHub file links (github.com/.../blob/...) are converted to raw links.
- Errors are JSON: `{{"detail": "human-readable message"}}` with status 400 (bad input),
  413 (too large), 415 (not an SVG), 422 (invalid parameter) or 500.
"""


@app.get("/llms.txt", tags=["Inspect"], operation_id="llmsTxt", summary="Plain-text guide for AI agents", response_class=PlainTextResponse)
async def llms_txt(request: Request):
    return PlainTextResponse(_llms_txt(_base_url(request)), headers={"Access-Control-Allow-Origin": "*"})


MCP_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
_COLOR_SCHEMA = {"type": "string", "description": "Target color: hex (ff0066, #f06), '255,0,102', rgb()/hsl() or a CSS name. Ignored by grayscale/adjust.", "default": "ff0066"}
_SOURCE_PROPS = {
    "svg": {"type": "string", "description": "SVG markup. Give this or `url`."},
    "url": {"type": "string", "description": "Public http(s) link to an SVG. Give this or `svg`."},
}
MCP_TOOLS = [
    {
        "name": "recolor_svg",
        "title": "Recolor SVG",
        "description": "Recolor an SVG (from markup or a link) and return the new SVG markup plus the old-to-new color mapping. "
        "Modes: " + "; ".join(f"{k}: {v['description']}" for k, v in engine.MODES.items()),
        "inputSchema": {
            "type": "object",
            "properties": {
                **_SOURCE_PROPS,
                "color": _COLOR_SCHEMA,
                "mode": {"type": "string", "enum": list(engine.MODES), "default": engine.DEFAULT_MODE},
                "hue": {"type": "integer", "minimum": -360, "maximum": 360, "default": 0, "description": "Rotate hue (degrees), applied after the mode."},
                "saturation": {"type": "integer", "minimum": -100, "maximum": 100, "default": 0},
                "lightness": {"type": "integer", "minimum": -100, "maximum": 100, "default": 0},
            },
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": True},
    },
    {
        "name": "list_svg_colors",
        "title": "List SVG colors",
        "description": "List the distinct colors in an SVG (from markup or a link) with how often each occurs.",
        "inputSchema": {"type": "object", "properties": dict(_SOURCE_PROPS)},
        "annotations": {"readOnlyHint": True, "openWorldHint": True},
    },
    {
        "name": "list_recolor_modes",
        "title": "List recolor modes",
        "description": "Describe the available recolor modes and the ranges of the hue/saturation/lightness options.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    },
]


async def _mcp_source(args: dict) -> tuple[str, str]:
    if isinstance(args.get("svg"), str) and args["svg"].strip():
        return _decode(args["svg"].encode()), "image.svg"
    if isinstance(args.get("url"), str) and args["url"].strip():
        return await fetch_svg(args["url"])
    raise HTTPException(400, "Provide either `svg` (SVG markup) or `url` (a link to an SVG).")


async def _mcp_call(name: str, args: dict) -> dict:
    try:
        if name == "list_recolor_modes":
            info = _modes_info()
            return {"content": [{"type": "text", "text": json.dumps(info, indent=2)}], "structuredContent": info}
        if name == "list_svg_colors":
            svg_text, _ = await _mcp_source(args)
            data = {"colors": engine.palette(svg_text)}
            return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}
        if name == "recolor_svg":
            opts = _options(args.get("mode") or engine.DEFAULT_MODE, args.get("color") or "ff0066",
                            args.get("hue", 0), args.get("saturation", 0), args.get("lightness", 0))
            svg_text, src_name = await _mcp_source(args)
            result = await _run(svg_text, opts)
            data = {"filename": _output_name(_safe_stem(src_name), opts), "palette": result.palette(), "svg": result.svg}
            summary = ", ".join(f"{p['from']}→{p['to']}" for p in data["palette"][:20])
            return {
                "content": [
                    {"type": "text", "text": result.svg},
                    {"type": "text", "text": f"Mode {opts.mode}. Color mapping: {summary or 'no colors found'}."},
                ],
                "structuredContent": data,
            }
    except HTTPException as e:
        return {"content": [{"type": "text", "text": f"Error: {e.detail}"}], "isError": True}
    raise KeyError(name)


async def _mcp_handle(msg) -> dict | None:
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
    method, mid, params = msg["method"], msg.get("id"), msg.get("params") or {}
    if "id" not in msg:  # notification, e.g. notifications/initialized
        return None

    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def err(code, message):
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}

    if method == "initialize":
        requested = params.get("protocolVersion")
        version = requested if requested in MCP_PROTOCOL_VERSIONS else MCP_PROTOCOL_VERSIONS[0]
        return ok({
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "svg-recolor", "title": "SVG Recolor", "version": app.version},
            "instructions": "Recolor SVG icons and illustrations. Call recolor_svg with `svg` markup or a `url`, "
            "a `color` and a `mode` (solid for one-color icons, colorize to keep shading). "
            "The first text block of the result is the recolored SVG.",
        })
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": MCP_TOOLS})
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if not isinstance(args, dict):
            return err(-32602, "arguments must be an object")
        try:
            return ok(await _mcp_call(name, args))
        except KeyError:
            return err(-32602, f"Unknown tool: {name}")
    return err(-32601, f"Method not found: {method}")


@app.post("/mcp", tags=["Inspect"], operation_id="mcp", summary="MCP server (streamable HTTP, JSON responses)")
async def mcp_endpoint(request: Request):
    """Model Context Protocol endpoint for AI agents. Stateless; send JSON-RPC 2.0 messages.
    Tools: `recolor_svg`, `list_svg_colors`, `list_recolor_modes`."""
    try:
        payload = json.loads(await request.body())
    except ValueError:
        return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}, status_code=400)
    if isinstance(payload, list):
        replies = [r for r in [await _mcp_handle(m) for m in payload] if r is not None]
        return JSONResponse(replies) if replies else Response(status_code=202)
    reply = await _mcp_handle(payload)
    return JSONResponse(reply) if reply is not None else Response(status_code=202)


@app.get("/mcp", include_in_schema=False)
async def mcp_get():
    # No server-initiated stream; clients fall back to plain POST requests.
    return Response(status_code=405, headers={"Allow": "POST"})


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
    opts = _options(mode, color, 0, 0, 0)
    svg_text = _decode(await icon.read())
    result = await _run(svg_text, opts)
    return _respond(result, opts, _output_name(_safe_stem(icon.filename), opts), "svg", True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
