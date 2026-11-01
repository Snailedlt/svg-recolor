import io
import ipaddress
import re
import socket
import zipfile
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote, urlparse

import httpx
import sentry_sdk
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse, Response
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
    return HTMLResponse(content=(BASE_DIR / "main.html").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


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
    except Exception as e:  # tool failure
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
        headers["Cache-Control"] = "public, max-age=86400"
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
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                async with client.stream(
                    "GET", url, headers={"User-Agent": "svg-recolor (+https://svg-recolor.jorgenkh.no)", "Accept": "image/svg+xml,*/*;q=0.8"}
                ) as resp:
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

RECOLOR_BODY = {
    "requestBody": {
        "content": {
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
    """Send the SVG as a multipart `file` field, as a multipart `url` field, or as the raw
    request body (`Content-Type: image/svg+xml`)."""
    opts = _options(mode, color, hue, saturation, lightness)
    content_type = request.headers.get("content-type", "")
    name = "image.svg"
    if content_type.startswith("multipart/form-data") or content_type.startswith("application/x-www-form-urlencoded"):
        form = await request.form()
        upload = form.get("file") or form.get("icon")
        if upload is not None and hasattr(upload, "read"):
            svg_text = _decode(await upload.read())
            name = upload.filename or name
        elif form.get("url"):
            svg_text, name = await fetch_svg(str(form.get("url")))
        else:
            raise HTTPException(400, "Send the SVG as a 'file' field or a link as a 'url' field.")
    else:
        body = await request.body()
        if not body:
            raise HTTPException(400, "The request body is empty. Send an SVG file.")
        svg_text = _decode(body)
    result = await _run(svg_text, opts)
    return _respond(result, opts, _output_name(_safe_stem(name), opts), format, download)


@app.post(
    "/api/recolor/batch",
    tags=["Recolor"],
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


@app.post("/api/palette", tags=["Inspect"], summary="List the colors in an uploaded SVG", openapi_extra=RECOLOR_BODY)
async def palette_upload(request: Request):
    """Returns every distinct color in the SVG (after normalizing named colors, rgb()/hsl()
    and short hex) with how often it occurs."""
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file") or form.get("icon")
        if upload is not None and hasattr(upload, "read"):
            svg_text = _decode(await upload.read())
        elif form.get("url"):
            svg_text, _ = await fetch_svg(str(form.get("url")))
        else:
            raise HTTPException(400, "Send the SVG as a 'file' field or a link as a 'url' field.")
    else:
        svg_text = _decode(await request.body())
    return JSONResponse({"colors": engine.palette(svg_text)}, headers={"Access-Control-Allow-Origin": "*"})


@app.get("/api/palette", tags=["Inspect"], summary="List the colors in an SVG from a link")
async def palette_url(url: Annotated[str, Query(description="Public http(s) link to an SVG.")]):
    svg_text, _ = await fetch_svg(url)
    return JSONResponse({"colors": engine.palette(svg_text)}, headers={"Access-Control-Allow-Origin": "*"})


@app.get("/api/fetch", tags=["Inspect"], summary="Download an SVG from a link without changing it", response_class=Response)
async def fetch_original(url: Annotated[str, Query(description="Public http(s) link to an SVG.")]):
    """Used by the website to preview linked SVGs. Applies the same safety checks as
    `GET /api/recolor`."""
    svg_text, name = await fetch_svg(url)
    headers = dict(SVG_HEADERS)
    headers["Content-Disposition"] = f"inline; filename=\"{_safe_stem(name)}.svg\""
    return Response(svg_text, media_type="image/svg+xml", headers=headers)


@app.get("/api/modes", tags=["Inspect"], summary="List the recolor modes")
async def list_modes():
    return {
        "default": engine.DEFAULT_MODE,
        "modes": [{"id": k, **v} for k, v in engine.MODES.items()],
        "adjustments": {
            "hue": {"min": -360, "max": 360, "unit": "degrees"},
            "saturation": {"min": -100, "max": 100, "unit": "percentage points"},
            "lightness": {"min": -100, "max": 100, "unit": "percentage points"},
        },
    }


# --------------------------------------------------------------------------
# Legacy endpoint (used by older clients)
# --------------------------------------------------------------------------


@app.post("/colorize", tags=["Legacy"], summary="Recolor an uploaded SVG (legacy)", response_class=Response)
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
