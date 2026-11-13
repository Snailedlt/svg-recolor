"""Cut out, gaps, line versions, canvas and SVGO for the API and MCP.

The editor does these in the browser with paper.js, paperjs-offset and SVGO. The API
runs the very same code (static/geometry.js and the vendored builds in static/vendor)
in QuickJS, a small JavaScript engine, so both give the same result:

- picosvg turns the SVG into plain filled paths in paint order (transforms, strokes,
  clip paths and inheritance resolved): what the browser gets from the DOM.
- geometry.js's compute() cuts, gaps and draws lines; boundsOfShapes() measures for Fit.
- SVGO optimizes, with the same default settings as the editor (devicon's).

A small pool of threads, each with its own QuickJS context (QuickJS isn't thread-safe), so
one heavy request doesn't hold up the others. Each call has a time and
memory limit per call.
"""

from __future__ import annotations

import contextlib
import html
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import recolor as engine

STATIC = Path(__file__).resolve().parent.parent / "static"
TIME_LIMIT = 20  # seconds for one request's JavaScript work, in total
MEMORY_LIMIT = 768 * 1024 * 1024
MAX_SHAPES = 1500  # same as the editor

# What a browser worker has and paper.js expects. Timers are only used to yield.
PRELUDE = """var self = globalThis; self.navigator = { userAgent: '' };
self.setTimeout = (f) => { Promise.resolve().then(f); return 0; }; self.clearTimeout = () => {};
self.setInterval = () => 0; self.clearInterval = () => {};"""
SVGO_EXPORT = "export{svgo as default,optimize_1 as optimize};"

# The editor's default SVGO settings (devicon's svg-icons svgo.config.js), plus a newline at the end.
SVGO_PRECISION = 3


def svgo_config(precision: int = SVGO_PRECISION) -> dict:
    return {
        "multipass": True,
        "floatPrecision": precision,
        "plugins": [
            {"name": "preset-default", "params": {"overrides": {
                "removeViewBox": False,
                "inlineStyles": {"onlyMatchedOnce": False},
                "convertColors": {"shortname": False},
                "cleanupIds": {"minify": True},
            }}},
            "removeDimensions", "removeStyleElement", "convertStyleToAttrs", "removeScriptElement",
            "removeOffCanvasPaths", "convertOneStopGradients",
            {"name": "removeAttrs", "params": {"attrs": "svg:(x|y)"}},
        ],
    }


# --------------------------------------------------------------------------
# Options
# --------------------------------------------------------------------------
@dataclass
class Extras:
    cut: tuple = ()  # colors that become gaps
    holes: bool = False  # light colors (near white) become gaps too, unless edited
    outlines: bool = False  # outline colors (thin, between thicker parts) become gaps, or the lines
    gap: float = 0  # gap width between colors
    line: float = 0  # line version: band width along the edges
    line_inner: bool = True  # lines also between colors
    line_plain: bool = False  # lines of the one-colour version (after holes, outline gaps, gaps)
    keep: tuple = ()  # colors that stay filled in the line version
    gap_split: str = ""  # "top": the shape on top keeps its shape, the gap comes out of what's under it
    gaps: str = ""  # "auto": no gaps when the one-colour drawing already shows its parts through holes
    line_align: str = "inside"  # lines inside the edge, or "center": straddling it (a stroke turned to a shape)
    merge: float = 0  # simplify: colors within this RGB distance count as one part
    detail: float = 0  # simplify: pieces and holes smaller than detail x detail go
    unit: str = "px"  # gap and line sizes: px (the SVG's units) or % of the icon
    canvas: Optional[tuple] = None  # (w, h) of a new viewBox
    place: Optional[tuple] = None  # (x, y, scale) of the drawing on the canvas
    fit: Optional[float] = None  # fit the drawing to the canvas with this padding
    optimize: bool = False
    precision: int = SVGO_PRECISION
    _geometry: bool = field(default=False, repr=False)

    @property
    def geometry(self) -> bool:
        return bool(self.cut or self.gap or self.line or self.merge or self.detail)

    @property
    def active(self) -> bool:
        return self.geometry or self.holes or self.outlines or self.canvas is not None or self.place is not None or self.fit is not None or self.optimize


def _number(name: str, value, lo: float, hi: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise engine.RecolorError(f"'{name}' must be a number.")
    if not lo <= v <= hi:
        raise engine.RecolorError(f"'{name}' must be between {lo:g} and {hi:g}.")
    return v


def _numbers(name: str, value, count: int, example: str, sep: str) -> tuple:
    if isinstance(value, (list, tuple)):
        parts = list(value)
    else:
        parts = [p for p in re.split(r"[\s" + re.escape(sep) + r",]+", str(value).strip()) if p]
    try:
        nums = tuple(float(p) for p in parts)
    except (TypeError, ValueError):
        nums = ()
    if len(nums) != count or not all(abs(n) < 1e7 for n in nums):
        raise engine.RecolorError(f"'{name}' must be {count} numbers, like {example}.")
    return nums


def _flag(value) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def is_light(color: str) -> bool:
    """Near white: what `holes=light` cuts out. Every channel at least 224, or a pale tint close to
    gray (every channel at least 200, within 48 of each other: Docker's #d4eef1). As in app.js."""
    c = color.lstrip("#")
    if len(c) != 6:
        return False
    x = [int(c[i:i + 2], 16) for i in (0, 2, 4)]
    return min(x) >= 0xE0 or (min(x) >= 0xC8 and max(x) - min(x) <= 48)


def parse_extras(edit_list, cut=None, gap=None, line=None, lines=None, keep=None, unit=None,
                 canvas=None, place=None, fit=None, optimize=None, precision=None, holes=None, outlines=None,
                 merge=None, detail=None, linealign=None, gaps=None, gapsplit=None) -> Extras:
    """Extras from request values (strings from query strings and forms, or JSON values)."""
    ex = Extras()
    ex.cut = tuple(engine._edit_key(c) for c in edit_list(cut))
    if holes not in (None, "", False):
        v = str(holes).strip().lower()
        if holes is not True and v not in ("light", "none"):
            raise engine.RecolorError("'holes' must be 'light' (near-white colors become holes) or 'none'.")
        ex.holes = holes is True or v == 'light'
    if outlines not in (None, "", False):
        v = str(outlines).strip().lower()
        if outlines is not True and v not in ("gap", "none"):
            raise engine.RecolorError("'outlines' must be 'gap' (outline colors become gaps) or 'none'.")
        ex.outlines = outlines is True or v == "gap"
    ex.keep = tuple(engine._edit_key(c) for c in edit_list(keep))
    if unit not in (None, ""):
        u = str(unit).strip().lower()
        if u not in ("px", "pct", "%", "percent"):
            raise engine.RecolorError("'unit' must be 'px' or 'pct' (percent of the icon).")
        ex.unit = "%" if u != "px" else "px"
    hi = 50 if ex.unit == "%" else 1e6
    if gap not in (None, ""):
        ex.gap = _number("gap", gap, 0, hi)
    if line not in (None, ""):
        ex.line = _number("line", line, 0, hi)
    if gapsplit not in (None, ""):
        v = str(gapsplit).strip().lower()
        if v not in ("top", "smaller"):
            raise engine.RecolorError("'gapsplit' must be 'top' (the shape on top stays whole) or 'smaller' (the smaller part gives up the gap).")
        ex.gap_split = "top" if v == "top" else ""
    if gaps not in (None, ""):
        v = str(gaps).strip().lower()
        if v not in ("auto", "always"):
            raise engine.RecolorError("'gaps' must be 'auto' (only where the parts don't already show) or 'always'.")
        ex.gaps = "auto" if v == "auto" else ""
    if linealign not in (None, ""):
        v = str(linealign).strip().lower()
        if v not in ("inside", "center"):
            raise engine.RecolorError("'linealign' must be 'inside' (lines inside the edge) or 'center' (on the edge).")
        ex.line_align = v
    if merge not in (None, ""):
        ex.merge = _number("merge", merge, 0, 442)
    if detail not in (None, ""):
        ex.detail = _number("detail", detail, 0, hi)
    if lines not in (None, ""):
        v = str(lines).strip().lower()
        if v not in ("all", "outer", "plain"):
            raise engine.RecolorError("'lines' must be 'all' (also between colors), 'outer' (just the outline) "
                                      "or 'plain' (the outlines of the one-colour version).")
        ex.line_inner = v != "outer"
        ex.line_plain = v == "plain"
    if canvas not in (None, ""):
        w, h = _numbers("canvas", canvas, 2, "128x128", "x")
        if w <= 0 or h <= 0:
            raise engine.RecolorError("'canvas' must be two positive numbers, like 128x128.")
        ex.canvas = (w, h)
    if place not in (None, ""):
        x, y, s = _numbers("place", place, 3, "1,1,0.5 (x, y, scale)", ",")
        if s <= 0:
            raise engine.RecolorError("The scale in 'place' must be positive.")
        ex.place = (x, y, s)
    if fit is not None and fit is not False and fit != "":  # fit=0 is a fit with no padding
        ex.fit = 0.0 if fit is True or str(fit).lower() == "true" else _number("fit", fit, 0, 1e6)
    if optimize not in (None, ""):
        v = str(optimize).strip().lower()
        if optimize is not True and optimize is not False and v not in ("1", "0", "true", "false", "yes", "no", "on", "off"):
            raise engine.RecolorError("'optimize' must be true or false.")
        ex.optimize = optimize is True or _flag(optimize)
    if precision not in (None, ""):
        ex.precision = int(_number("precision", precision, 0, 8))
    return ex


def check_conflicts(opts: engine.Options, ex: Extras) -> None:
    taken = set(opts.replace) | set(opts.hide) | set(opts.remove)
    both = sorted(taken & set(ex.cut))
    if both:
        raise engine.RecolorError(f"#{both[0]} can't be cut out and also replaced, hidden or removed.")


# --------------------------------------------------------------------------
# JavaScript (QuickJS) on one thread
# --------------------------------------------------------------------------
POOL = int(os.environ.get("SVG_GEOMETRY_WORKERS", "3"))
_executor = ThreadPoolExecutor(max_workers=POOL, thread_name_prefix="svg-geometry")
_local = threading.local()  # .ctx: this thread's QuickJS context


def _load():
    import quickjs

    c = quickjs.Context()
    c.set_memory_limit(MEMORY_LIMIT)
    c.eval(PRELUDE)
    c.eval((STATIC / "vendor/paper-core.min.js").read_text(encoding="utf-8"))
    c.eval("self.window = self;")  # paperjs-offset puts PaperOffset on window
    c.eval((STATIC / "vendor/paperjs-offset.min.js").read_text(encoding="utf-8"))
    c.eval((STATIC / "geometry.js").read_text(encoding="utf-8"))
    svgo = (STATIC / "vendor/svgo.browser.js").read_text(encoding="utf-8")
    if SVGO_EXPORT not in svgo:
        raise RuntimeError("Unexpected SVGO build: its export statement changed.")
    c.eval(svgo.replace(SVGO_EXPORT, "self.SVGO = { optimize: optimize_1 };"))
    return c


def _run_js(expr: str, args: list, deadline: Optional[float] = None):
    """Evaluate `expr` (an async function of `args`) and return its JSON result."""
    import quickjs

    if getattr(_local, "ctx", None) is None:
        _local.ctx = _load()
    c = _local.ctx
    # QuickJS's limit counts per call, and async work runs as many calls (jobs): keep one
    # deadline for the whole thing, and give each job only the time that's left.
    deadline = deadline or time.monotonic() + TIME_LIMIT
    c.set_time_limit(TIME_LIMIT)
    try:
        c.set("__args", json.dumps(args))
        c.eval("var __out = null, __err = null; (async (args) => (" + expr + "))(JSON.parse(__args))"
               ".then((r) => { __out = JSON.stringify(r === undefined ? null : r); },"
               " (e) => { __err = String((e && e.message) || e); });")
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                _local.ctx = None
                raise engine.RecolorError(f"This SVG took too long (over {TIME_LIMIT} s). Try a simpler one, or the editor.")
            c.set_time_limit(max(1, int(left + 0.999)))
            if not c.execute_pending_job():
                break
        err, out = c.eval("__err"), c.eval("__out")
    except quickjs.JSException as e:
        _local.ctx = None  # start clean next time
        if "interrupted" in str(e).lower():
            raise engine.RecolorError(f"This SVG took too long (over {TIME_LIMIT} s). Try a simpler one, or the editor.")
        if "out of memory" in str(e).lower():
            raise engine.RecolorError("This SVG needs too much memory for the server. Try the editor.")
        raise RuntimeError(f"Geometry failed: {e}")
    finally:
        c.set_time_limit(-1)
    if err:
        if "interrupted" in err.lower():  # the time limit, hit inside an async step
            _local.ctx = None
            raise engine.RecolorError(f"This SVG took too long (over {TIME_LIMIT} s). Try a simpler one, or the editor.")
        raise engine.RecolorError(err)
    return json.loads(out) if out else None


def js(expr: str, *args, deadline: Optional[float] = None):
    """Run `expr` in QuickJS. `deadline` (time.monotonic()) shares one time budget between calls."""
    return _executor.submit(_run_js, expr, list(args), deadline).result()


# --------------------------------------------------------------------------
# Reading shapes (what the browser does with the DOM)
# --------------------------------------------------------------------------
def _root_attrs(svg: str) -> dict:
    m = re.search(r"<svg\b[^>]*>", svg, re.IGNORECASE)
    tag = m.group(0) if m else ""
    attrs = {}
    for name in ("viewBox", "width", "height"):
        a = re.search(r"\s" + name + r"\s*=\s*(\"([^\"]*)\"|'([^']*)')", tag, re.IGNORECASE)
        if a:
            attrs[name] = (a.group(2) if a.group(2) is not None else a.group(3)).strip()
    return attrs


def _alpha(v) -> float:
    return 1.0 if v is None or v == "" else float(v)


def _middles(root) -> dict:
    """Each gradient's color at its middle, by id (following href to the stops), as geometry.js."""
    by_id = {el.get("id"): el for el in root.iter() if isinstance(el.tag, str) and el.get("id")}

    def stops_of(el, hops=0):
        stops = [k for k in el if isinstance(k.tag, str) and k.tag.split("}")[-1] == "stop"]
        if stops or hops > 8:
            return stops
        ref = el.get("href") or el.get("{http://www.w3.org/1999/xlink}href") or ""
        nxt = by_id.get(ref.lstrip("#")) if ref.startswith("#") else None
        return stops_of(nxt, hops + 1) if nxt is not None else []

    out = {}
    for gid, el in by_id.items():
        if not el.tag.split("}")[-1].endswith("Gradient"):
            continue
        stops = []
        for s in stops_of(el):
            style = dict(kv.split(":", 1) for kv in (s.get("style") or "").split(";") if ":" in kv)
            color = (style.get("stop-color") or s.get("stop-color") or "#000").strip()
            off = str(s.get("offset") or "0").strip()
            try:
                at = float(off[:-1]) / 100 if off.endswith("%") else float(off)
                stops.append([min(1.0, max(0.0, at)), engine.rgb_to_hex(engine.parse_color(color))[1:].lower()])
            except (ValueError, engine.RecolorError):
                continue
        if not stops:
            continue
        for i in range(1, len(stops)):
            stops[i][0] = max(stops[i][0], stops[i - 1][0])
        i = next((k for k, s in enumerate(stops) if s[0] >= 0.5), -1)
        if i <= 0:
            out[gid] = stops[0 if i == 0 else -1][1]
            continue
        (a_at, a), (b_at, b) = stops[i - 1], stops[i]
        f = 0 if b_at == a_at else (0.5 - a_at) / (b_at - a_at)
        out[gid] = "".join(f"{round(int(a[k:k + 2], 16) + (int(b[k:k + 2], 16) - int(a[k:k + 2], 16)) * f):02x}"
                           for k in (0, 2, 4))
    return out


def read_shapes(svg: str, lenient: bool = False, flat: Optional[str] = None, mids: bool = False) -> dict:
    """Plain filled paths in paint order, as geometry.js's compute() takes them.
    lenient: for measuring (Fit), where gradients, transparency, masks and text don't matter.
    flat: when everything ends up this one color (like Solid), gradients and transparency
    don't matter either: such paints become it, partial transparency counts as solid."""
    from picosvg.svg import SVG

    if not lenient and re.search(r"<text\b", svg, re.IGNORECASE):
        raise engine.RecolorError("Cut out, gaps and lines work on shapes, and this SVG has text. "
                                  "Convert the text to paths first (in Inkscape: Path → Object to Path).")
    if not lenient and re.search(r"<image\b", svg, re.IGNORECASE):
        raise engine.RecolorError("Cut out, gaps and lines work on shapes, and this SVG has an embedded image.")
    if not lenient and re.search(r"\smask\s*=|[\"';\s]mask\s*:", svg, re.IGNORECASE):
        raise engine.RecolorError("Cut out, gaps and lines don't support masks yet.")
    if lenient:  # picosvg can't apply masks; for measuring, the unmasked drawing is close enough
        svg = re.sub(r"\smask\s*=\s*(\"[^\"]*\"|'[^']*')", "", svg)
    # Lengths with a unit picosvg can't read ("0.497px" in CachyOS): px is the user unit anyway.
    svg = re.sub(r"(\d|\.)px\b", r"\1", svg)
    try:
        pico = SVG.fromstring(svg).topicosvg()
    except Exception as e:  # noqa: BLE001 - picosvg raises many kinds; all mean "can't read this"
        msg = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
        raise engine.RecolorError(f"This SVG could not be read for cut out, gaps or lines: {msg[:200]}")
    shapes = []
    middles = _middles(pico.svg_root) if mids or flat else {}
    # flat: each gradient a color of its own: its middle color, nudged until unused (outlines are told
    # by how dark they are), else any unused color. As in geometry.js.
    stand: dict = {}
    used = set()
    if flat:
        for s in pico.shapes():
            with contextlib.suppress(Exception):  # url(), none, currentColor: not a color in use
                used.add(engine.rgb_to_hex(engine.parse_color((s.fill or "").strip()))[1:].lower())
    nxt = [0x0A0B0C]

    def stand_in(paint: str) -> str:
        if paint not in stand:
            m = re.match(r"url\(\s*[\"']?#([^\"')]+)", paint)
            c = middles.get(m.group(1)) if m else None
            for _ in range(256):
                if not c or c not in used:
                    break
                c = c[:4] + f"{(int(c[4:], 16) + 1) % 256:02x}"
            if not c or c in used:
                while True:
                    nxt[0] = (nxt[0] + 0x050301) % 0x1000000
                    c = f"{nxt[0]:06x}"
                    if c not in used:
                        break
            used.add(c)
            stand[paint] = "#" + c
        return stand[paint]

    for s in pico.shapes():
        fill = (s.fill or "").strip()
        if not fill or fill == "none":
            continue
        if lenient:
            if s.d:
                shapes.append({"d": s.d, "rule": s.fill_rule or "nonzero", "color": "000000"})
            continue
        if fill.startswith("url(") and mids:
            m = re.match(r"url\(\s*[\"']?#([^\"')]+)", fill)
            if not m or m.group(1) not in middles:
                continue
            fill = "#" + middles[m.group(1)]
        if fill.startswith("url(") and flat:
            fill = stand_in(re.sub(r"\s+", "", fill))
        if fill.startswith("url("):
            raise engine.RecolorError("Cut out, gaps and lines work with flat colors, and this SVG uses gradients or patterns.")
        alpha = min(_alpha(getattr(s, "opacity", None)), _alpha(getattr(s, "fill_opacity", None)))
        if (flat or mids) and alpha < 0.5:
            continue  # one color: mostly see-through (shadows, glows) goes, the rest counts as solid
        if not flat and not mids and alpha < 1:
            raise engine.RecolorError("Cut out, gaps and lines don't support semi-transparent colors yet.")
        if fill.lower() == "currentcolor":
            fill = "#000000"  # what a browser shows for it (the default text color)
        try:
            color = engine.rgb_to_hex(engine.parse_color(fill))[1:].lower()
        except engine.RecolorError:
            continue
        if s.d:
            shapes.append({"d": s.d, "rule": s.fill_rule or "nonzero", "color": color})
        if len(shapes) > MAX_SHAPES:
            raise engine.RecolorError(f"This SVG has too many shapes for cut out, gaps and lines (over {MAX_SHAPES}).")
    attrs = _root_attrs(svg)
    box = orig_box(svg)
    # As the browser's DOM would give them (compute() escapes them again for the output).
    raw = {k: html.unescape(v) for k, v in attrs.items()}
    return {"shapes": shapes, "viewBox": raw.get("viewBox"), "width": raw.get("width"),
            "height": raw.get("height"), "bounds": [box[2], box[3]],
            "standIns": [c.lstrip("#").lower() for c in stand.values()]}


# --------------------------------------------------------------------------
# Canvas (the same text change as the editor's placed())
# --------------------------------------------------------------------------
def _fmt(n: float) -> str:
    v = round(float(n), 3)
    return ("%f" % v).rstrip("0").rstrip(".") if v != int(v) else str(int(v))


def orig_box(svg: str) -> tuple:
    """The SVG's own box: its viewBox, else width and height, else 128 x 128."""
    attrs = _root_attrs(svg)
    vb = [p for p in re.split(r"[\s,]+", attrs.get("viewBox", "")) if p]
    try:
        x, y, w, h = (float(p) for p in vb)
        if w > 0 and h > 0:
            return (x, y, w, h)
    except ValueError:
        pass

    def num(name):
        m = re.match(r"^([\d.]+)(px)?$", attrs.get(name, ""))
        return float(m.group(1)) if m else 0.0

    w, h = num("width"), num("height")
    return (0.0, 0.0, w, h) if w > 0 and h > 0 else (0.0, 0.0, 128.0, 128.0)


def placement(svg: str, canvas, place) -> tuple:
    _, _, w0, h0 = orig_box(svg)
    W, H = canvas or (w0, h0)
    return place or ((W - w0) / 2, (H - h0) / 2, 1.0)


def placed(svg: str, canvas, place) -> str:
    if canvas is None and place is None:
        return svg
    m = re.search(r"<svg\b[^>]*>", svg, re.IGNORECASE)
    end = svg.rfind("</svg")
    if not m or end < m.end():
        return svg
    x0, y0, w0, h0 = orig_box(svg)
    W, H = canvas or (w0, h0)
    tx, ty, s = placement(svg, canvas, place)
    tag = re.sub(r"\sviewBox\s*=\s*(\"[^\"]*\"|'[^']*')", "", m.group(0), flags=re.IGNORECASE)
    tag = re.sub(r"(\s(width|height)\s*=\s*[\"']?\s*)([\d.]+)",
                 lambda a: a.group(1) + _fmt(float(a.group(3)) * (W / w0 if a.group(2).lower() == "width" else H / h0)),
                 tag, flags=re.IGNORECASE)
    tag = re.sub(r"^<svg\b", f'<svg viewBox="0 0 {_fmt(W)} {_fmt(H)}"', tag, flags=re.IGNORECASE)
    g = '<g transform="matrix(' + " ".join(_fmt(v) for v in (s, 0, 0, s, tx - s * x0, ty - s * y0)) + ')">'
    return svg[: m.start()] + tag + g + svg[m.end(): end] + "</g>" + svg[end:]


def fit_place(svg_edited: str, canvas, pad: float, deadline: Optional[float] = None) -> tuple:
    """Scale and center the visible drawing to fill the canvas, minus the padding."""
    try:
        shapes = read_shapes(svg_edited, lenient=True)["shapes"]
    except engine.RecolorError:  # can't measure the drawing: fit the SVG's own box instead
        shapes = None
    if shapes is None:
        x0, y0, w0, h0 = orig_box(svg_edited)
        box = [x0, y0, w0, h0]
    else:
        box = js("SvgGeometry.boundsOfShapes(args[0])", shapes, deadline=deadline)
    if not box:
        raise engine.RecolorError("Nothing visible to fit.")
    x0, y0, w0, h0 = orig_box(svg_edited)
    W, H = canvas or (w0, h0)
    bx, by, bw, bh = box
    s = min((W - 2 * pad) / bw, (H - 2 * pad) / bh)
    if s <= 0:
        raise engine.RecolorError("The padding leaves no room on this canvas.")
    return ((W - s * bw) / 2 - s * (bx - x0), (H - s * bh) / 2 - s * (by - y0), s)


def prominent_color(svg: str) -> str:
    """The most prominent color (hex, no #): the one seen most, as the editor's color "Auto"."""
    norm = engine.normalize_svg(svg)
    try:
        found = js("SvgGeometry.prominent(args[0])", read_shapes(norm, mids=True), deadline=time.monotonic() + TIME_LIMIT)
    except engine.RecolorError:
        found = None
    if not found:  # nothing to measure: the most used color
        counts = engine.extract_palette(norm)
        found = max(counts, key=counts.get) if counts else "000000"
    return found


# --------------------------------------------------------------------------
# The whole recolor, like the editor
# --------------------------------------------------------------------------
def recolor(svg: str, opts: engine.Options) -> engine.Result:
    ex: Extras = opts.extras
    check_conflicts(opts, ex)
    deadline = time.monotonic() + TIME_LIMIT  # one budget for the whole request
    norm = engine.normalize_svg(svg)
    counts = engine.extract_palette(norm)
    mapping = {**engine.map_colors(list(counts), opts), **{c: v for c, v in opts.replace.items() if c in counts}}
    canvas, place = ex.canvas, ex.place
    # holes=light: near-white colors not edited otherwise become holes where they're drawn against
    # other colors, and stay parts of the logo where they stand on their own (geometry.js decides).
    edited_colors = set(opts.replace) | set(opts.hide) | set(opts.remove) | set(ex.cut)
    holes = tuple(c for c in counts if ex.holes and is_light(c) and c not in edited_colors)
    cut = tuple(ex.cut)
    holed: set = set()
    if ex.fit is not None:
        canvas = canvas or orig_box(norm)[2:]
        hidden = tuple(opts.hide) + tuple(opts.remove) + cut + holes
        place = fit_place(engine.apply_edits(norm, remove=hidden), canvas, ex.fit, deadline)
    edited = engine.apply_edits(placed(norm, canvas, place), hide=opts.hide, remove=opts.remove)
    if cut or holes or ex.outlines or ex.gap or ex.line or ex.merge or ex.detail:
        geo = {"cut": list(cut), "holes": list(holes), "outlines": ex.outlines, "map": mapping, "gap": ex.gap, "line": ex.line,
               "lineInner": ex.line_inner, "linePlain": ex.line_plain, "keep": list(ex.keep), "unit": ex.unit, "flat": None,
               "merge": ex.merge, "detail": ex.detail, "lineAlign": ex.line_align, "gaps": ex.gaps or None,
               "lightHoles": bool(ex.holes), "gapSplit": ex.gap_split or None}
        # Everything one color (like Solid)? Then gradients and transparency don't matter.
        gone = set(opts.hide) | set(opts.remove) | set(cut) | set(holes)
        outs = {mapping.get(c, c) for c in counts if c not in gone}
        flat = next(iter(outs)) if len(outs) == 1 else None
        geo["flat"] = flat
        out = js("SvgGeometry.compute(args[0], args[1])", read_shapes(edited, flat=flat), geo, deadline=deadline)
        m = re.search(r"<!--holes:([^>]*)-->", out)
        holed = set(filter(None, m.group(1).split(","))) if m else set()
        out = re.sub(r"<!--holes:[^>]*-->", "", out)
    else:
        out = engine.apply_mapping(edited, mapping)
    if ex.optimize:
        out = js("SVGO.optimize(args[0], args[1]).data", out, svgo_config(ex.precision), deadline=deadline).rstrip() + "\n"
    return engine.Result(svg=out, mapping=mapping, counts=counts, hidden=set(opts.hide) & set(counts),
                         removed=set(opts.remove) & set(counts), cut=(set(cut) | holed) & set(counts))
