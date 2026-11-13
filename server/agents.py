"""AI agent access: /llms.txt (a plain-text guide) and /mcp (an MCP server).

The MCP endpoint speaks stateless streamable HTTP with JSON responses and
exposes three tools: recolor_svg, list_svg_colors and list_recolor_modes.
"""

import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response

import recolor as engine
from server.common import (
    APP_VERSION,
    EXTRA_FIELDS,
    base_url,
    decode,
    modes_info,
    options,
    output_name,
    run,
    safe_stem,
)
from server.fetching import fetch_svg

router = APIRouter()


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
  (or `modes=tint,solid,...` for several styles in one call, returned as `mappings`)
  → `{{"mapping": {{"#5a9fd4": "#…"}}}}`. Use this when you already have the colors (design tokens, themes).
- List colors: `GET {base}/api/palette?url=<svg-url>` or `POST {base}/api/palette` (same bodies as above)
- Modes and limits: `GET {base}/api/modes`
- OpenAPI: {base}/openapi.json
- MCP server (streamable HTTP, no auth): {base}/mcp
  Tools: `recolor_svg`, `list_svg_colors`, `list_recolor_modes`.
  Claude Code: `claude mcp add --transport http svg-recolor {base}/mcp`

## Parameters

- `color`: `ff0066`, `#ff0066` (encode `#` as `%23` in URLs), `f06`, `255,0,102`,
  `rgb(255 0 102)`, `hsl(330 100% 50%)`, or a CSS name like `tomato`. Default `ff0066`. `auto` takes the SVG's
  most prominent color (the one seen most; shades of one color count together), each file of a batch its own.
  The result's `color` (with `format=json`) says which. For devicon icons: what their wiki asks for.
- `mode`: one of {", ".join(f"`{k}`" for k in engine.MODES)}. Default `{engine.DEFAULT_MODE}`.
- `hue`: rotate hue, -360..360 degrees. `saturation`, `lightness`: -100..100 points. Applied after the mode.
- `format`: `svg` (default) or `json`. `download`: `true` to get an attachment.
- Per-color edits on top of the mode, keyed by the original colors (see `/api/palette`):
  `replace=5e97f6:ff0000,...` gives single colors their own new color; `hide=ffffff,...` makes colors
  invisible (shapes stay, painted `none`); `remove=ffffff,...` deletes the shapes painted with them
  (a shape keeps its stroke or fill when only the other is removed). In JSON and MCP, `replace` is an
  object and `hide`/`remove` are lists. In the JSON palette, `to` is then `"none"` or `"removed"`.
  One-color icon (like a devicon "plain" version): `mode=solid&color=000000&remove=ffffff`.
- Shapes, canvas and optimizing (the same code as the editor; in JSON and MCP, lists and numbers):
  - `cut=dce0df,...`: those colors become real gaps (cut through what's below). One path per color, so
    `mode=solid&cut=...` is one path. For logos with outlines between their parts. Palette `to`: `"cut"`.
  - `holes=light`: near-white colors (every channel >= 224, or pale tints close to gray, like #d4eef1) become holes too, unless edited. With `mode=solid`
    this makes a one-color icon whose white parts stay see-through (like devicon's plain icons).
  - `outlines=gap`: an outline color (its visible part thin, between thicker parts of other colors) becomes a gap
    too, so a one-color version keeps the parts apart (Docker's dark outline).
  - `gap=2`: a gap of that width wherever two original colors meet. For logos whose parts just touch.
  - `line=3`: a line version (like devicon's line icons), only a band of that width along the edges.
    Devicon's line icons mostly use about 1 unit on the 128 canvas: `line=1` with `canvas=128x128`.
    `lines=outer` draws just the outline (default `all`: also between colors); `keep=ffffff,...` stays filled.
  - `unit`: `px` (default; the SVG's own units) or `pct` (percent of the icon) for `gap` and `line`.
  - `canvas=128x128`: a new viewBox size, drawing centered. `place=x,y,scale` moves and scales it;
    `fit=1` scales and centers the visible drawing (strokes included) with that padding.
  - `optimize=true`: SVGO 3.3.2 with devicon's settings (precision 3, multipass); `precision=0..8`.
  - Cut, gaps and lines need shapes (no text, images or masks) and flat colors; when everything ends up one color
    (like `mode=solid`), gradients and transparency are fine.
    The server gives them 20 s; very complex drawings may need the editor, which has no limit.
  - Devicon plain version: `mode=solid&color=...&holes=light&canvas=128x128&fit=0&optimize=true` (add `gap=1.5&unit=pct`
    when the parts just touch, `cut=<outlines>` for dark outlines). Line version: the same with `line=1`.

## Modes

{modes}

Pick `solid` for single-color icons, `colorize` to keep shading in multi-color art,
`hue` to change hue only, `adjust` (with `hue`/`saturation`/`lightness`) to tweak.

## Limits and errors

- SVGs up to 2 MB. Links must be public http(s); private and local addresses are refused.
- GitHub file links (github.com/.../blob/...) are converted to raw links.
- Errors are JSON: `{{"detail": "human-readable message"}}` with status 400 (bad input),
  413 (too large), 415 (not an SVG), 422 (invalid parameter), 429 (rate limited; see the
  Retry-After header) or 500.
- Rate limits per IP: about 60 uploads, link fetches or MCP calls per minute, and 600
  /api/map-colors requests per minute. Cached GET responses don't count.
"""


@router.get("/llms.txt", tags=["Inspect"], operation_id="llmsTxt", summary="Plain-text guide for AI agents", response_class=PlainTextResponse)
async def llms_txt(request: Request):
    return PlainTextResponse(_llms_txt(base_url(request)), headers={"Access-Control-Allow-Origin": "*"})


MCP_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
_COLOR_SCHEMA = {"type": "string", "description": "Target color: hex (ff0066, #f06), '255,0,102', rgb()/hsl() or a CSS name; 'auto' = the SVG's most prominent color. Ignored by grayscale/adjust.", "default": "ff0066"}
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
                "replace": {"type": "object", "additionalProperties": {"type": "string"},
                            "description": "Give single original colors their own new color, on top of the mode: {\"#5e97f6\": \"#ff0000\"}."},
                "hide": {"type": "array", "items": {"type": "string"}, "description": "Original colors to make invisible (shapes stay)."},
                "remove": {"type": "array", "items": {"type": "string"},
                           "description": "Original colors whose shapes are deleted. For a one-color icon: mode solid plus remove the background color."},
                "cut": {"type": "array", "items": {"type": "string"},
                        "description": "Original colors that become real gaps (cut through what's below). The result is one path per color; "
                                       "solid + cut = one path. For logos with outlines between their parts."},
                "gap": {"type": "number", "minimum": 0,
                        "description": "Cut a gap of this width wherever two original colors meet (in `unit`s). With solid, the parts stay apart."},
                "line": {"type": "number", "minimum": 0,
                         "description": "Make a line version (like devicon's line icons): only a band of this width along the edges is kept."},
                "lines": {"type": "string", "enum": ["all", "outer"],
                          "description": "With line: 'all' (default) also between colors, 'outer' only the outline."},
                "keep": {"type": "array", "items": {"type": "string"}, "description": "With line: original colors that stay filled."},
                "holes": {"type": "string", "enum": ["light", "none"],
                          "description": "'light': near-white colors become holes (cut out), unless edited. With mode solid: a one-color icon whose white parts stay see-through."},
                "outlines": {"type": "string", "enum": ["gap", "none"],
                             "description": "'gap': outline colors (thin, between thicker parts) become gaps, so a one-color version keeps the parts apart."},
                "unit": {"type": "string", "enum": ["px", "pct"],
                         "description": "Unit of gap and line: px (default, the SVG's own units) or pct (percent of the icon)."},
                "canvas": {"type": "string", "description": "A new canvas (viewBox) size, 'WxH', e.g. '128x128'. The drawing stays centered."},
                "place": {"type": "string", "description": "Where the drawing goes on the canvas: 'x,y,scale' (x,y = where its original top-left lands)."},
                "fit": {"type": "number", "minimum": 0,
                        "description": "Scale and center the visible drawing to fill the canvas with this padding. Devicon (no padding): canvas '128x128', fit 0."},
                "optimize": {"type": "boolean", "description": "Optimize the result with SVGO (the editor's default settings, the same as devicon's)."},
                "precision": {"type": "integer", "minimum": 0, "maximum": 8, "description": "With optimize: decimals kept (default 3)."},
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
        return decode(args["svg"].encode()), "image.svg"
    if isinstance(args.get("url"), str) and args["url"].strip():
        return await fetch_svg(args["url"])
    raise HTTPException(400, "Provide either `svg` (SVG markup) or `url` (a link to an SVG).")


async def _mcp_call(name: str, args: dict) -> dict:
    try:
        if name == "list_recolor_modes":
            info = modes_info()
            return {"content": [{"type": "text", "text": json.dumps(info, indent=2)}], "structuredContent": info}
        if name == "list_svg_colors":
            svg_text, _ = await _mcp_source(args)
            data = {"colors": engine.palette(svg_text)}
            return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}
        if name == "recolor_svg":
            opts = options(args.get("mode") or engine.DEFAULT_MODE, args.get("color") or "ff0066",
                           args.get("hue", 0), args.get("saturation", 0), args.get("lightness", 0),
                           args.get("replace"), args.get("hide"), args.get("remove"),
                           **{k: args.get(k) for k in EXTRA_FIELDS})
            svg_text, src_name = await _mcp_source(args)
            result = await run(svg_text, opts)
            data = {"filename": output_name(safe_stem(src_name), opts, result), "palette": result.palette(), "svg": result.svg}
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


async def _mcp_handle(msg) -> Optional[dict]:
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
            "serverInfo": {"name": "svg-recolor", "title": "SVG Recolor", "version": APP_VERSION},
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


@router.post("/mcp", tags=["Inspect"], operation_id="mcp", summary="MCP server (streamable HTTP, JSON responses)")
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


@router.get("/mcp", include_in_schema=False)
async def mcp_get():
    # No server-initiated stream; clients fall back to plain POST requests.
    return Response(status_code=405, headers={"Allow": "POST"})
