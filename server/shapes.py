"""Cut out, gaps, line versions, canvas and SVGO for the API and MCP.

The editor does these in the browser with paper.js, paperjs-offset and SVGO. The API
runs the very same code (static/geometry.js and the vendored builds in static/vendor)
in QuickJS, a small JavaScript engine, so both give the same result:

- picosvg turns the SVG into plain filled paths in paint order (transforms, strokes,
  clip paths and inheritance resolved): what the browser gets from the DOM.
- geometry.js's compute() cuts, gaps and draws lines; boundsOfShapes() measures for Fit.
- SVGO optimizes, with the same default settings as the editor (devicon's).

One QuickJS context lives on its own thread (QuickJS isn't thread-safe), with a time and
memory limit per call.
"""

from __future__ import annotations

import html
import json
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
    gap: float = 0  # gap width between colors
    line: float = 0  # line version: band width along the edges
    line_inner: bool = True  # lines also between colors
    keep: tuple = ()  # colors that stay filled in the line version
    unit: str = "px"  # gap and line sizes: px (the SVG's units) or % of the icon
    canvas: Optional[tuple] = None  # (w, h) of a new viewBox
    place: Optional[tuple] = None  # (x, y, scale) of the drawing on the canvas
    fit: Optional[float] = None  # fit the drawing to the canvas with this padding
    optimize: bool = False
    precision: int = SVGO_PRECISION
    _geometry: bool = field(default=False, repr=False)

    @property
    def geometry(self) -> bool:
        return bool(self.cut or self.gap or self.line)

    @property
    def active(self) -> bool:
        return self.geometry or self.canvas is not None or self.place is not None or self.fit is not None or self.optimize


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


def parse_extras(edit_list, cut=None, gap=None, line=None, lines=None, keep=None, unit=None,
                 canvas=None, place=None, fit=None, optimize=None, precision=None) -> Extras:
    """Extras from request values (strings from query strings and forms, or JSON values)."""
    ex = Extras()
    ex.cut = tuple(engine._edit_key(c) for c in edit_list(cut))
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
    if lines not in (None, ""):
        v = str(lines).strip().lower()
        if v not in ("all", "outer"):
            raise engine.RecolorError("'lines' must be 'all' (also between colors) or 'outer' (just the outline).")
        ex.line_inner = v == "all"
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
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="svg-geometry")
_ctx = None
_lock = threading.Lock()


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
    global _ctx
    import quickjs

    if _ctx is None:
        _ctx = _load()
    c = _ctx
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
                _ctx = None
                raise engine.RecolorError(f"This SVG took too long (over {TIME_LIMIT} s). Try a simpler one, or the editor.")
            c.set_time_limit(max(1, int(left + 0.999)))
            if not c.execute_pending_job():
                break
        err, out = c.eval("__err"), c.eval("__out")
    except quickjs.JSException as e:
        _ctx = None  # start clean next time
        if "interrupted" in str(e).lower():
            raise engine.RecolorError(f"This SVG took too long (over {TIME_LIMIT} s). Try a simpler one, or the editor.")
        if "out of memory" in str(e).lower():
            raise engine.RecolorError("This SVG needs too much memory for the server. Try the editor.")
        raise RuntimeError(f"Geometry failed: {e}")
    finally:
        c.set_time_limit(-1)
    if err:
        if "interrupted" in err.lower():  # the time limit, hit inside an async step
            _ctx = None
            raise engine.RecolorError(f"This SVG took too long (over {TIME_LIMIT} s). Try a simpler one, or the editor.")
        raise engine.RecolorError(err)
    return json.loads(out) if out else None


def js(expr: str, *args, deadline: Optional[float] = None):
    """Run `expr` in QuickJS. `deadline` (time.monotonic()) shares one time budget between calls."""
    with _lock:
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


def read_shapes(svg: str, lenient: bool = False) -> dict:
    """Plain filled paths in paint order, as geometry.js's compute() takes them.
    lenient: for measuring (Fit), where gradients, transparency, masks and text don't matter."""
    from picosvg.svg import SVG

    if not lenient and re.search(r"<text\b", svg, re.IGNORECASE):
        raise engine.RecolorError("Cut out, gaps and lines work on shapes, and this SVG has text. "
                                  "Convert the text to paths first (in Inkscape: Path → Object to Path).")
    if not lenient and re.search(r"<image\b", svg, re.IGNORECASE):
        raise engine.RecolorError("Cut out, gaps and lines work on shapes, and this SVG has an embedded image.")
    if not lenient and re.search(r"\smask\s*=|[\"';\s]mask\s*:", svg, re.IGNORECASE):
        raise engine.RecolorError("Cut out, gaps and lines don't support masks yet.")
    try:
        pico = SVG.fromstring(svg).topicosvg()
    except Exception as e:  # noqa: BLE001 - picosvg raises many kinds; all mean "can't read this"
        msg = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
        raise engine.RecolorError(f"This SVG could not be read for cut out, gaps or lines: {msg[:200]}")
    shapes = []
    for s in pico.shapes():
        fill = (s.fill or "").strip()
        if not fill or fill == "none":
            continue
        if lenient:
            if s.d:
                shapes.append({"d": s.d, "rule": s.fill_rule or "nonzero", "color": "000000"})
            continue
        if fill.startswith("url("):
            raise engine.RecolorError("Cut out, gaps and lines work with flat colors, and this SVG uses gradients or patterns.")
        if min(float(getattr(s, "opacity", 1) or 1), float(getattr(s, "fill_opacity", 1) or 1)) < 1:
            raise engine.RecolorError("Cut out, gaps and lines don't support semi-transparent colors yet.")
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
            "height": raw.get("height"), "bounds": [box[2], box[3]]}


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
    box = js("SvgGeometry.boundsOfShapes(args[0])", read_shapes(svg_edited, lenient=True)["shapes"], deadline=deadline)
    if not box:
        raise engine.RecolorError("Nothing visible to fit.")
    x0, y0, w0, h0 = orig_box(svg_edited)
    W, H = canvas or (w0, h0)
    bx, by, bw, bh = box
    s = min((W - 2 * pad) / bw, (H - 2 * pad) / bh)
    if s <= 0:
        raise engine.RecolorError("The padding leaves no room on this canvas.")
    return ((W - s * bw) / 2 - s * (bx - x0), (H - s * bh) / 2 - s * (by - y0), s)


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
    if ex.fit is not None:
        canvas = canvas or orig_box(norm)[2:]
        hidden = tuple(opts.hide) + tuple(opts.remove) + tuple(ex.cut)
        place = fit_place(engine.apply_edits(norm, remove=hidden), canvas, ex.fit, deadline)
    edited = engine.apply_edits(placed(norm, canvas, place), hide=opts.hide, remove=opts.remove)
    if ex.geometry:
        geo = {"cut": list(ex.cut), "map": mapping, "gap": ex.gap, "line": ex.line, "lineInner": ex.line_inner,
               "keep": list(ex.keep), "unit": ex.unit}
        out = js("SvgGeometry.compute(args[0], args[1])", read_shapes(edited), geo, deadline=deadline)
    else:
        out = engine.apply_mapping(edited, mapping)
    if ex.optimize:
        out = js("SVGO.optimize(args[0], args[1]).data", out, svgo_config(ex.precision), deadline=deadline).rstrip() + "\n"
    return engine.Result(svg=out, mapping=mapping, counts=counts, hidden=set(opts.hide) & set(counts),
                         removed=set(opts.remove) & set(counts), cut=set(ex.cut) & set(counts))
