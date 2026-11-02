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
  413 (too large), 415 (not an SVG), 422 (invalid parameter), 429 (rate limited; see the
  Retry-After header) or 500.
- Rate limits per IP: about 60 uploads, link fetches or MCP calls per minute, and 600
  /api/map-colors requests per minute. Cached GET responses don't count.
"""


@router.get("/llms.txt", tags=["Inspect"], operation_id="llmsTxt", summary="Plain-text guide for AI agents", response_class=PlainTextResponse)
async def llms_txt(request: Request):
    return PlainTextResponse(_llms_txt(base_url(request)), headers={"Access-Control-Allow-Origin": "*"})


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
                            args.get("hue", 0), args.get("saturation", 0), args.get("lightness", 0))
            svg_text, src_name = await _mcp_source(args)
            result = await run(svg_text, opts)
            data = {"filename": output_name(safe_stem(src_name), opts), "palette": result.palette(), "svg": result.svg}
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
