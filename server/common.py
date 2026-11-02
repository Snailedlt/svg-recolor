"""Shared helpers for the HTTP API: options, responses, cache policy."""

import re
import subprocess
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import sentry_sdk
from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response

import recolor as engine

APP_VERSION = "2.0.0"

# Cache policy. `s-maxage` lets the hosting CDN (Vercel's edge network) answer repeat
# requests without running the function, which keeps cost flat as traffic grows.
# Vercel purges its CDN cache on every deploy, so long s-maxage values are safe.
CACHE_PAGE = "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800"
CACHE_STATIC = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800"
CACHE_DOCS = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
CACHE_REMOTE = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800"
# Mapping results depend only on the query (which includes the engine version).
CACHE_IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable"

# Served SVGs are user content. Stop any embedded script from running if the
# response is opened directly on this origin.
SVG_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
}


def base_url(request: Request) -> str:
    """Public base URL, honoring the proxy headers set by the hosting platform."""
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host.split(',')[0].strip()}"


def bad_request(e: Exception, status: int = 400):
    raise HTTPException(status_code=status, detail=str(e))


def options(mode, color, hue, saturation, lightness) -> engine.Options:
    try:
        return engine.Options(
            mode=mode, color=color, hue=hue, saturation=saturation, lightness=lightness
        ).validate()
    except engine.RecolorError as e:
        bad_request(e)


def safe_stem(name: Optional[str]) -> str:
    stem = Path(name or "image.svg").stem or "image"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", stem)[:80] or "image"


def output_name(stem: str, opts: engine.Options) -> str:
    suffix = opts.mode
    if engine.MODES[opts.mode]["uses_color"]:
        suffix += "_" + engine.rgb_to_hex(engine.parse_color(opts.color))[1:]
    return f"{stem}_recolored_{suffix}.svg"


async def run(svg_text: str, opts: engine.Options) -> engine.Result:
    try:
        return await run_in_threadpool(engine.recolor, svg_text, opts)
    except engine.RecolorError as e:
        bad_request(e)
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:  # svgray/svgshift failed
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=f"Error processing the SVG file: {e}")


def respond(result: engine.Result, opts, filename: str, fmt: str, download: bool, cache: bool = False):
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


def decode(data: bytes) -> str:
    try:
        return engine.decode_svg(data)
    except engine.RecolorError as e:
        bad_request(e, 413 if len(data) > engine.MAX_SVG_BYTES else 415)


def modes_info() -> dict:
    return {
        "default": engine.DEFAULT_MODE,
        "modes": [{"id": k, **v} for k, v in engine.MODES.items()],
        "adjustments": {
            "hue": {"min": -360, "max": 360, "unit": "degrees"},
            "saturation": {"min": -100, "max": 100, "unit": "percentage points"},
            "lightness": {"min": -100, "max": 100, "unit": "percentage points"},
        },
    }
