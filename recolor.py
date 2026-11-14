"""Core recoloring engine for SVG Recolor.

The heavy lifting is done by the two tools bundled as submodules:

* ``svgray`` converts colors to grayscale (luminance, NTSC/PAL weights).
* ``svgshift`` sets/adds/subtracts RGB or HSL channels of hex colors.

Instead of streaming the whole SVG through the tools, the engine:

1. normalizes every color in the SVG to 6- or 8-digit hex (named colors,
   ``rgb()``/``hsl()`` functions and short hex are converted), so the tools see
   colors they understand;
2. extracts the unique palette;
3. runs the palette through svgray/svgshift (one tiny file per operation);
4. maps the old colors to the new ones in the SVG.

Working on the palette avoids svgshift's chunked-reader edge cases on large
files, keeps ``url(#id)``/``href="#id"`` references intact, and lets the API
report exactly which color became which.
"""

from __future__ import annotations

import colorsys
import importlib.util
import os
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).resolve().parent
SVGRAY_PATH = BASE_DIR / "submodules" / "svgray" / ".svgray.py"
SVGSHIFT_PATH = BASE_DIR / f"svgshift-{platform.system().lower()}.exe"
SVGSHIFT_SOURCE = BASE_DIR / "submodules" / "svgshift" / "svgshift.c"

MAX_SVG_BYTES = 2 * 1024 * 1024


class RecolorError(ValueError):
    """Raised for invalid input (bad color, not an SVG, bad options)."""


# --------------------------------------------------------------------------
# Modes
# --------------------------------------------------------------------------

MODES: dict[str, dict] = {
    "tint": {
        "label": "Tint",
        "uses_color": True,
        "description": "Converts to grayscale, then adds the color. Dark areas take on the color "
        "and highlights stay light. This is the classic SVG Recolor look.",
        "tools": ["svgray", "svgshift addrgb"],
    },
    "colorize": {
        "label": "Colorize",
        "uses_color": True,
        "description": "Sets every color's hue and saturation to the target color while keeping "
        "its lightness, so shading and contrast are preserved.",
        "tools": ["svgshift sethsl H S x"],
    },
    "hue": {
        "label": "Hue",
        "uses_color": True,
        "description": "Sets only the hue. Saturation and lightness stay as they were, so muted "
        "colors stay muted.",
        "tools": ["svgshift sethsl H x x"],
    },
    "solid": {
        "label": "Solid",
        "uses_color": True,
        "description": "Replaces every color with exactly the target color. Best for single-color "
        "icons and logos.",
        "tools": ["svgshift setrgb R G B"],
    },
    "grayscale": {
        "label": "Grayscale",
        "uses_color": False,
        "description": "Converts every color to its gray equivalent.",
        "tools": ["svgray"],
    },
    "adjust": {
        "label": "Adjust",
        "uses_color": False,
        "description": "Keeps the original colors and only applies the hue, saturation and "
        "lightness shifts.",
        "tools": ["svgshift addhsl/subhsl"],
    },
}
DEFAULT_MODE = "tint"

# Bump when the color math changes, so cached results (CDN, browsers) are not reused.
ENGINE_VERSION = "2"
MAX_PALETTE = 4096
MAX_EDITS = 256


# --------------------------------------------------------------------------
# Color parsing
# --------------------------------------------------------------------------

# CSS Color Module Level 4 named colors.
NAMED_COLORS = {
    "aliceblue": "f0f8ff", "antiquewhite": "faebd7", "aqua": "00ffff", "aquamarine": "7fffd4",
    "azure": "f0ffff", "beige": "f5f5dc", "bisque": "ffe4c4", "black": "000000",
    "blanchedalmond": "ffebcd", "blue": "0000ff", "blueviolet": "8a2be2", "brown": "a52a2a",
    "burlywood": "deb887", "cadetblue": "5f9ea0", "chartreuse": "7fff00", "chocolate": "d2691e",
    "coral": "ff7f50", "cornflowerblue": "6495ed", "cornsilk": "fff8dc", "crimson": "dc143c",
    "cyan": "00ffff", "darkblue": "00008b", "darkcyan": "008b8b", "darkgoldenrod": "b8860b",
    "darkgray": "a9a9a9", "darkgreen": "006400", "darkgrey": "a9a9a9", "darkkhaki": "bdb76b",
    "darkmagenta": "8b008b", "darkolivegreen": "556b2f", "darkorange": "ff8c00",
    "darkorchid": "9932cc", "darkred": "8b0000", "darksalmon": "e9967a", "darkseagreen": "8fbc8f",
    "darkslateblue": "483d8b", "darkslategray": "2f4f4f", "darkslategrey": "2f4f4f",
    "darkturquoise": "00ced1", "darkviolet": "9400d3", "deeppink": "ff1493",
    "deepskyblue": "00bfff", "dimgray": "696969", "dimgrey": "696969", "dodgerblue": "1e90ff",
    "firebrick": "b22222", "floralwhite": "fffaf0", "forestgreen": "228b22", "fuchsia": "ff00ff",
    "gainsboro": "dcdcdc", "ghostwhite": "f8f8ff", "gold": "ffd700", "goldenrod": "daa520",
    "gray": "808080", "green": "008000", "greenyellow": "adff2f", "grey": "808080",
    "honeydew": "f0fff0", "hotpink": "ff69b4", "indianred": "cd5c5c", "indigo": "4b0082",
    "ivory": "fffff0", "khaki": "f0e68c", "lavender": "e6e6fa", "lavenderblush": "fff0f5",
    "lawngreen": "7cfc00", "lemonchiffon": "fffacd", "lightblue": "add8e6",
    "lightcoral": "f08080", "lightcyan": "e0ffff", "lightgoldenrodyellow": "fafad2",
    "lightgray": "d3d3d3", "lightgreen": "90ee90", "lightgrey": "d3d3d3", "lightpink": "ffb6c1",
    "lightsalmon": "ffa07a", "lightseagreen": "20b2aa", "lightskyblue": "87cefa",
    "lightslategray": "778899", "lightslategrey": "778899", "lightsteelblue": "b0c4de",
    "lightyellow": "ffffe0", "lime": "00ff00", "limegreen": "32cd32", "linen": "faf0e6",
    "magenta": "ff00ff", "maroon": "800000", "mediumaquamarine": "66cdaa", "mediumblue": "0000cd",
    "mediumorchid": "ba55d3", "mediumpurple": "9370db", "mediumseagreen": "3cb371",
    "mediumslateblue": "7b68ee", "mediumspringgreen": "00fa9a", "mediumturquoise": "48d1cc",
    "mediumvioletred": "c71585", "midnightblue": "191970", "mintcream": "f5fffa",
    "mistyrose": "ffe4e1", "moccasin": "ffe4b5", "navajowhite": "ffdead", "navy": "000080",
    "oldlace": "fdf5e6", "olive": "808000", "olivedrab": "6b8e23", "orange": "ffa500",
    "orangered": "ff4500", "orchid": "da70d6", "palegoldenrod": "eee8aa", "palegreen": "98fb98",
    "paleturquoise": "afeeee", "palevioletred": "db7093", "papayawhip": "ffefd5",
    "peachpuff": "ffdab9", "peru": "cd853f", "pink": "ffc0cb", "plum": "dda0dd",
    "powderblue": "b0e0e6", "purple": "800080", "rebeccapurple": "663399", "red": "ff0000",
    "rosybrown": "bc8f8f", "royalblue": "4169e1", "saddlebrown": "8b4513", "salmon": "fa8072",
    "sandybrown": "f4a460", "seagreen": "2e8b57", "seashell": "fff5ee", "sienna": "a0522d",
    "silver": "c0c0c0", "skyblue": "87ceeb", "slateblue": "6a5acd", "slategray": "708090",
    "slategrey": "708090", "snow": "fffafa", "springgreen": "00ff7f", "steelblue": "4682b4",
    "tan": "d2b48c", "teal": "008080", "thistle": "d8bfd8", "tomato": "ff6347",
    "turquoise": "40e0d0", "violet": "ee82ee", "wheat": "f5deb3", "white": "ffffff",
    "whitesmoke": "f5f5f5", "yellow": "ffff00", "yellowgreen": "9acd32",
}

_NUM = r"[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?"
_HEX_RE = re.compile(r"#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])", re.IGNORECASE)
_FUNC_RE = re.compile(r"\b(rgba?|hsla?)\(\s*([^()]{1,80}?)\s*\)", re.IGNORECASE)
_NAMED_CTX_RE = re.compile(
    r"(?P<prefix>\b(?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*"
    r"(?:=\s*[\"']\s*|:\s*))(?P<name>[a-z]+)\b(?!\s*\()",
    re.IGNORECASE,
)
_REF_BEFORE_RE = re.compile(r"(?:url\(\s*[\"']?|href\s*=\s*[\"']\s*)$", re.IGNORECASE)


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _to_hex(r: float, g: float, b: float) -> str:
    return "".join(f"{round(_clamp(c, 0, 255)):02x}" for c in (r, g, b))


def _parse_func(kind: str, args: str) -> Optional[tuple[str, Optional[float]]]:
    """Parse rgb()/rgba()/hsl()/hsla() arguments strictly. Returns (hex6, alpha)."""
    parts = [p for p in re.split(r"[\s,/]+", args.strip()) if p]
    if len(parts) not in (3, 4):
        return None
    vals = []
    for p in parts:
        m = re.fullmatch(rf"({_NUM})(%|deg)?", p, re.IGNORECASE)
        if not m:
            return None
        vals.append((float(m.group(1)), (m.group(2) or "").lower()))
    alpha = None
    if len(vals) == 4:
        a, unit = vals[3]
        alpha = _clamp(a / 100 if unit == "%" else a, 0, 1)
    kind = kind.lower()
    if kind.startswith("rgb"):
        rgb = [v * 2.55 if u == "%" else v for v, u in vals[:3]]
        return _to_hex(*rgb), alpha
    (h, _), (s, _), (light, _) = vals[:3]
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360, _clamp(light, 0, 100) / 100, _clamp(s, 0, 100) / 100)
    return _to_hex(r * 255, g * 255, b * 255), alpha


def parse_color(value: str) -> tuple[int, int, int]:
    """Parse a user-supplied color: '#ff0066', 'ff0066', '#f06', '255,0,102',
    'rgb(255 0 102)', 'hsl(330 100% 50%)' or a CSS color name."""
    if value is None:
        raise RecolorError("A color is required for this mode.")
    v = value.strip().lower()
    if v in NAMED_COLORS:
        v = "#" + NAMED_COLORS[v]
    m = re.fullmatch(r"#?([0-9a-f]{6}|[0-9a-f]{3})", v)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))
    m = re.fullmatch(r"(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})", v)
    if m:
        rgb = tuple(int(x) for x in m.groups())
        if all(0 <= c <= 255 for c in rgb):
            return rgb
    m = _FUNC_RE.fullmatch(v)
    if m:
        parsed = _parse_func(m.group(1), m.group(2))
        if parsed:
            h = parsed[0]
            return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))
    raise RecolorError(
        f"Invalid color '{value}'. Use hex (#FF0066, FF0066, #F06), RGB (255,0,102), "
        "rgb()/hsl() notation, or a CSS color name like 'tomato'."
    )


def rgb_to_hex(rgb) -> str:
    return "#" + _to_hex(*rgb)


def _svgshift_hsl(rgb) -> tuple[int, int, int]:
    """HSL on svgshift's scale (H 0-360, S/L 0-100)."""
    h, light, s = colorsys.rgb_to_hls(*(c / 255 for c in rgb))
    return round(h * 360), round(s * 100), round(light * 100)


# --------------------------------------------------------------------------
# Tool wrappers
# --------------------------------------------------------------------------

_svgray = None


def _load_svgray():
    global _svgray
    if _svgray is None:
        if not SVGRAY_PATH.exists():
            raise RuntimeError(
                "svgray is missing. Run `git submodule update --init` to fetch it."
            )
        spec = importlib.util.spec_from_file_location("svgray", SVGRAY_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _svgray = module
    return _svgray


def svgray_gray(hex6: str) -> str:
    """Grayscale one 6-digit hex color using svgray's conversion."""
    return _load_svgray().convert("#" + hex6)[1:].lower()


_svgshift_exe: Optional[str] = None


def _svgshift_executable() -> str:
    """Locate a runnable svgshift binary. Copies it to a temp dir and marks it
    executable when the checked-in file lacks the executable bit (e.g. on
    serverless deploys), and compiles it from the submodule as a last resort."""
    global _svgshift_exe
    if _svgshift_exe and os.path.exists(_svgshift_exe):
        return _svgshift_exe
    if SVGSHIFT_PATH.exists() and os.access(SVGSHIFT_PATH, os.X_OK):
        _svgshift_exe = str(SVGSHIFT_PATH)
        return _svgshift_exe
    target = Path(tempfile.gettempdir()) / f"svgshift-{os.getpid()}"
    if SVGSHIFT_PATH.exists():
        shutil.copyfile(SVGSHIFT_PATH, target)
    elif SVGSHIFT_SOURCE.exists() and shutil.which("gcc"):
        subprocess.run(["gcc", str(SVGSHIFT_SOURCE), "-o", str(target)], check=True)
    else:
        raise RuntimeError(f"svgshift binary not found at {SVGSHIFT_PATH}.")
    target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    _svgshift_exe = str(target)
    return _svgshift_exe


def svgshift(op: str, values, colors: list[str]) -> list[str]:
    """Run svgshift on a list of 6-digit hex colors.

    ``op`` is e.g. 'setrgb', 'addhsl', 'subhsl'. ``values`` holds three ints or
    None (svgshift's ``x``, leave channel unchanged)."""
    if not colors:
        return []
    args = ["x" if v is None else str(int(v)) for v in values]
    if any(a.startswith("-") for a in args):
        raise ValueError("svgshift values must be non-negative")
    # One color per line; 8 bytes per line keeps every code inside svgshift's
    # 2048-byte read buffer.
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write("".join(f"#{c}\n" for c in colors))
        path = f.name
    try:
        proc = subprocess.run(
            [_svgshift_executable(), op, *args, path],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"svgshift exited with {proc.returncode}: {proc.stderr.strip()[:300]}")
        out = proc.stdout
    finally:
        os.remove(path)
    result = re.findall(r"#([0-9a-fA-F]{6})", out)
    if len(result) != len(colors):
        raise RuntimeError("svgshift returned an unexpected number of colors")
    return [c.lower() for c in result]


# --------------------------------------------------------------------------
# SVG normalization and palette
# --------------------------------------------------------------------------


def looks_like_svg(text: str) -> bool:
    return re.search(r"<svg[\s>]", text[:200_000], re.IGNORECASE) is not None


def decode_svg(data: bytes) -> str:
    if len(data) > MAX_SVG_BYTES:
        raise RecolorError("The SVG must be smaller than 2 MB. Try optimizing it with SVGO first.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise RecolorError("The file is not valid UTF-8 text, so it can't be an SVG.")
    if not looks_like_svg(text):
        raise RecolorError("That doesn't look like an SVG: no <svg> element was found.")
    return text


def _is_reference(text: str, start: int) -> bool:
    return _REF_BEFORE_RE.search(text[max(0, start - 30) : start]) is not None


def normalize_svg(svg: str) -> str:
    """Rewrite every color to lowercase 6- or 8-digit hex so svgray/svgshift can
    process it, and make the implicit black default explicit."""

    def named(m):
        hex6 = NAMED_COLORS.get(m.group("name").lower())
        return m.group("prefix") + "#" + hex6 if hex6 else m.group(0)

    svg = _NAMED_CTX_RE.sub(named, svg)

    def func(m):
        parsed = _parse_func(m.group(1), m.group(2))
        if not parsed:
            return m.group(0)
        hex6, alpha = parsed
        if alpha is None or alpha >= 1:
            return "#" + hex6
        return f"#{hex6}{round(alpha * 255):02x}"

    svg = _FUNC_RE.sub(func, svg)

    def hexes(m):
        if _is_reference(svg_ref, m.start()):
            return m.group(0)
        h = m.group(1).lower()
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        return "#" + h

    svg_ref = svg
    svg = _HEX_RE.sub(hexes, svg)

    # Shapes without a fill render black. Make that explicit on the root so the
    # black is recolored too; the same goes for currentColor.
    root = re.search(r"<svg\b[^>]*>", svg, re.IGNORECASE)
    if root:
        tag = root.group(0)
        additions = ""
        if not re.search(r"\sfill\s*=|[\s;\"']fill\s*:", tag, re.IGNORECASE):
            additions += ' fill="#000000"'
        if "currentcolor" in svg.lower() and not re.search(r"\scolor\s*=|[\s;\"']color\s*:", tag, re.IGNORECASE):
            additions += ' color="#000000"'
        if additions:
            end = len(tag) - (2 if tag.endswith("/>") else 1)
            svg = svg[: root.start()] + tag[:end] + additions + tag[end:] + svg[root.end() :]
    return svg


def extract_palette(normalized_svg: str) -> dict[str, int]:
    """Unique 6-digit hex colors (lowercase, no '#') with occurrence counts."""
    counts: dict[str, int] = {}
    for m in _HEX_RE.finditer(normalized_svg):
        if _is_reference(normalized_svg, m.start()) or len(m.group(1)) not in (6, 8):
            continue
        c = m.group(1)[:6].lower()
        counts[c] = counts.get(c, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


def apply_mapping(normalized_svg: str, mapping: dict[str, str]) -> str:
    def sub(m):
        if _is_reference(normalized_svg, m.start()) or len(m.group(1)) not in (6, 8):
            return m.group(0)
        h = m.group(1).lower()
        return "#" + mapping.get(h[:6], h[:6]) + h[6:]

    return _HEX_RE.sub(sub, normalized_svg)


# --------------------------------------------------------------------------
# Per-color edits: hide a color, or remove the shapes painted with it
# --------------------------------------------------------------------------
# Edits work on the normalized SVG (lowercase hex colors) before the mapping, and
# static/engine.js does exactly the same (tests/test_parity.py).

_TOKEN_RE = re.compile(r"""<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>""")
_SHAPES = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "use"}
# Shapes in these are geometry for clipping, masks, markers, patterns and <use>: never deleted.
_DEFS = {"defs", "clippath", "mask", "marker", "pattern", "symbol", "lineargradient", "radialgradient", "filter"}
_HEX_PAINT_RE = re.compile(r"#([0-9a-f]{6})(?:[0-9a-f]{2})?$")
_PAINT_CTX_RE = re.compile(r"(?:fill|stroke)\s*(?:=\s*[\"']\s*|:\s*)$", re.IGNORECASE)


def _class_rules(svg: str) -> dict:
    """fill/stroke set by simple class rules in <style> (".a{fill:#..}", ".a,.b{..}"):
    {class: {prop: (rule order, value)}}. Other selectors are ignored."""
    rules: dict = {}
    order = 0
    for block in re.finditer(r"<style\b[^>]*>([\s\S]*?)</style>", svg, re.IGNORECASE):
        css = re.sub(r"/\*[\s\S]*?\*/", "", block.group(1))
        for rule in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
            order += 1
            for selector in rule.group(1).split(","):
                cls = re.fullmatch(r"\s*\.([\w-]+)\s*", selector)
                if not cls:
                    continue
                for prop in ("fill", "stroke"):
                    decls = re.findall(r"(?:^|;)\s*" + prop + r"\s*:\s*([^;]+)", rule.group(2), re.IGNORECASE)
                    if decls:  # the last declaration wins, as in CSS
                        rules.setdefault(cls.group(1), {})[prop] = (order, decls[-1])
    return rules


def _paint(attrs: str, prop: str, rules: Optional[dict] = None) -> Optional[str]:
    """The tag's own fill or stroke: a 6-digit hex, "none", "other" (url(), currentColor, ...) or None if unset.
    Looks where CSS does: the style attribute, then class rules, then the attribute."""
    value = None
    style = re.search(r"""\sstyle\s*=\s*(["'])([\s\S]*?)\1""", attrs, re.IGNORECASE)
    if style:
        decls = re.findall(r"(?:^|;)\s*" + prop + r"\s*:\s*([^;]+)", style.group(2), re.IGNORECASE)
        if decls:  # the last declaration wins, as in CSS
            value = decls[-1]
    if value is None and rules:
        cls = re.search(r"""\sclass\s*=\s*(["'])([\s\S]*?)\1""", attrs, re.IGNORECASE)
        if cls:
            best = None
            for name in cls.group(2).split():
                hit = rules.get(name, {}).get(prop)
                if hit and (best is None or hit[0] > best[0]):
                    best = hit
            if best:
                value = best[1]
    if value is None:
        m = re.search(r"""\s""" + prop + r"""\s*=\s*(["'])([\s\S]*?)\1""", attrs, re.IGNORECASE)
        if m:
            value = m.group(2)
    if value is None:
        return None
    v = value.strip().lower()
    m = _HEX_PAINT_RE.match(v)
    if m:
        return m.group(1)
    return "none" if v in ("none", "transparent") else "other"


def _paint_off(attrs: str, prop: str) -> str:
    """Set the tag's fill or stroke to none, wherever it is set (style or attribute)."""
    found = False

    def style_sub(m):
        nonlocal found

        def decl(d):
            nonlocal found
            found = True
            return d.group(1) + "none"

        return m.group(1) + re.sub(r"((?:^|;)\s*" + prop + r"\s*:\s*)[^;]+", decl, m.group(3), flags=re.IGNORECASE) + m.group(4)

    attrs = re.sub(r"""(\sstyle\s*=\s*(["']))([\s\S]*?)(\2)""", style_sub, attrs, count=1, flags=re.IGNORECASE)

    def attr_sub(m):
        nonlocal found
        found = True
        return m.group(1) + "none" + m.group(4)

    attrs = re.sub(r"""(\s""" + prop + r"""\s*=\s*(["']))([\s\S]*?)(\2)""", attr_sub, attrs, count=1, flags=re.IGNORECASE)
    if not found:
        closing = re.search(r"\s*/$", attrs)
        at = closing.start() if closing else len(attrs)
        attrs = attrs[:at] + f' {prop}="none"' + attrs[at:]
    return attrs


def _painted_children(svg: str, start: int, name: str, rules: dict) -> bool:
    """Whether the element whose start tag ends at `start` has a descendant with its own
    fill or stroke (like a <tspan> with its own color inside a <text>)."""
    depth = 1
    for t in _TOKEN_RE.finditer(svg, start):
        closing, tag, attrs = t.group(1), t.group(2), t.group(3)
        if tag is None:
            continue
        lname = tag.lower()
        if closing:
            if lname == name:
                depth -= 1
                if depth == 0:
                    return False
            continue
        if lname == name and not attrs.rstrip().endswith("/"):
            depth += 1
        if _paint(attrs, "fill", rules) is not None or _paint(attrs, "stroke", rules) is not None:
            return True
    return False


def apply_edits(normalized_svg: str, hide=(), remove=()) -> str:
    """Hide colors (they become none/transparent) and remove the shapes painted with others.

    A shape is removed when everything it paints (fill and stroke, own or inherited)
    is a removed color; when only its fill or only its stroke is, that part is turned
    off. Any other use of a hidden or removed color (groups, gradient stops, CSS)
    becomes "none" for fill and stroke, else "transparent"."""
    hide, remove = set(hide), set(remove)
    if not hide and not remove:
        return normalized_svg
    svg = normalized_svg
    if remove:
        out, pos = [], 0
        stack = [("", "000000", "none", False)]  # (name, fill, stroke, inside defs)
        rules = _class_rules(svg)
        skip_name, skip_depth = None, 0
        for m in _TOKEN_RE.finditer(svg):
            closing, name, attrs = m.group(1), m.group(2), m.group(3)
            if name is None:  # comment or CDATA
                continue
            lname = name.lower()
            self_closing = attrs.rstrip().endswith("/")
            if skip_name is not None:  # inside a removed element: find its end
                if lname == skip_name and not self_closing:
                    skip_depth += -1 if closing else 1
                    if skip_depth == 0:
                        pos, skip_name = m.end(), None
                continue
            if closing:
                if len(stack) > 1 and stack[-1][0] == lname:
                    stack.pop()
                continue
            parent = stack[-1]
            fill = _paint(attrs, "fill", rules)
            stroke = _paint(attrs, "stroke", rules)
            fill = parent[1] if fill is None else fill
            stroke = parent[2] if stroke is None else stroke
            in_defs = parent[3] or lname in _DEFS
            if lname in _SHAPES and not parent[3]:
                fill_hit, stroke_hit = fill in remove, stroke in remove
                fill_shows = fill != "none" and not fill_hit and lname != "line"
                stroke_shows = stroke != "none" and not stroke_hit
                gone = (fill_hit or stroke_hit) and not fill_shows and not stroke_shows
                # A shape with children painted their own way (a <tspan> in a <text>) stays, unpainted.
                if gone and (self_closing or not _painted_children(svg, m.end(), lname, rules)):
                    out.append(svg[pos : m.start()])
                    if self_closing:
                        pos = m.end()
                    else:
                        skip_name, skip_depth, pos = lname, 1, m.end()
                    continue
                new_attrs = attrs
                if fill_hit:
                    new_attrs, fill = _paint_off(new_attrs, "fill"), "none"
                if stroke_hit:
                    new_attrs, stroke = _paint_off(new_attrs, "stroke"), "none"
                if new_attrs != attrs:
                    out.append(svg[pos : m.start(3)] + new_attrs)
                    pos = m.end(3)
            if not self_closing:
                stack.append((lname, fill, stroke, in_defs))
        out.append(svg[pos:] if skip_name is None else "")
        svg = "".join(out)
    gone = hide | remove
    ref = svg

    def sub(m):
        if _is_reference(ref, m.start()) or len(m.group(1)) not in (6, 8) or m.group(1)[:6].lower() not in gone:
            return m.group(0)
        return "none" if _PAINT_CTX_RE.search(ref[max(0, m.start() - 30) : m.start()]) else "transparent"

    return _HEX_RE.sub(sub, svg)


# --------------------------------------------------------------------------
# Recoloring
# --------------------------------------------------------------------------


@dataclass
class Options:
    mode: str = DEFAULT_MODE
    color: Optional[str] = "#FF0066"
    hue: int = 0  # hue rotation in degrees, -360..360
    saturation: int = 0  # saturation shift in percentage points, -100..100
    lightness: int = 0  # lightness shift in percentage points, -100..100
    # Per-color edits, applied on top of the mode, keyed by original color:
    replace: dict = field(default_factory=dict)  # {"5e97f6": "ff0000"}: give one color its own new color
    hide: tuple = ()  # colors to make invisible (none/transparent); the shapes stay
    remove: tuple = ()  # colors whose shapes are deleted
    # Cut out, gaps, lines, canvas and SVGO: server.shapes.Extras, used by the API (not by this engine).
    extras: object = None

    def validate(self) -> Options:
        self.mode = (self.mode or DEFAULT_MODE).lower()
        if self.mode not in MODES:
            raise RecolorError(
                f"Unknown mode '{self.mode}'. Choose one of: {', '.join(MODES)}."
            )
        for name, lo, hi in (("hue", -360, 360), ("saturation", -100, 100), ("lightness", -100, 100)):
            v = getattr(self, name)
            try:
                v = int(v or 0)
            except (TypeError, ValueError):
                raise RecolorError(f"'{name}' must be a whole number.")
            if not lo <= v <= hi:
                raise RecolorError(f"'{name}' must be between {lo} and {hi}.")
            setattr(self, name, v)
        if MODES[self.mode]["uses_color"] and str(self.color).strip().lower() != "auto":
            parse_color(self.color)
        if str(self.color).strip().lower() == "auto":
            self.color = "auto"  # the most prominent color, resolved per SVG (server/common.py)
        edits = {}
        try:
            self.replace = {_edit_key(k): rgb_to_hex(parse_color(v))[1:] for k, v in dict(self.replace or {}).items()}
            self.hide = tuple(dict.fromkeys(_edit_key(c) for c in (self.hide or ())))
            self.remove = tuple(dict.fromkeys(_edit_key(c) for c in (self.remove or ())))
        except (TypeError, ValueError, AttributeError) as e:
            raise RecolorError(f"Could not read the color edits: {e}")
        for kind, colors in (("replace", self.replace), ("hide", self.hide), ("remove", self.remove)):
            for c in colors:
                if c in edits:
                    raise RecolorError(f"#{c} is in both '{edits[c]}' and '{kind}'. Give each color one edit.")
                edits[c] = kind
        if len(edits) > MAX_EDITS:
            raise RecolorError(f"Too many color edits ({len(edits)}). The limit is {MAX_EDITS}.")
        return self


@dataclass
class Result:
    svg: str
    mapping: dict[str, str] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)
    hidden: set = field(default_factory=set)
    removed: set = field(default_factory=set)
    cut: set = field(default_factory=set)
    color: Optional[str] = None  # with color "auto": the color it chose (hex, no #)

    def palette(self) -> list[dict]:
        """Each original color and what it became: a hex color, "none" (hidden), "removed" or "cut"."""
        def to(c):
            if c in self.cut:
                return "cut"
            return "removed" if c in self.removed else "none" if c in self.hidden else "#" + self.mapping.get(c, c)

        return [{"from": "#" + c, "to": to(c), "count": n} for c, n in self.counts.items()]


def _rotate_hue(colors: list[str], degrees: int) -> list[str]:
    """Rotate hue with wrap-around. svgshift clamps hue at 0/360, so colors are
    grouped by whether the rotation crosses the boundary, and each group gets
    an add or a sub pass."""
    d = degrees % 360
    if d == 0:
        return colors
    out = list(colors)
    plain, wrap = [], []
    for i, c in enumerate(colors):
        h, s, _ = _svgshift_hsl(tuple(int(c[j : j + 2], 16) for j in (0, 2, 4)))
        if s == 0:
            continue  # grays have no hue
        (plain if h + d < 360 else wrap).append(i)
    for idx, (op, amount) in ((plain, ("addhsl", d)), (wrap, ("subhsl", 360 - d))):
        if idx:
            new = svgshift(op, (amount, None, None), [colors[i] for i in idx])
            for i, c in zip(idx, new):
                out[i] = c
    return out


def _shift(colors: list[str], saturation: int, lightness: int) -> list[str]:
    add = (None, saturation if saturation > 0 else None, lightness if lightness > 0 else None)
    sub = (None, -saturation if saturation < 0 else None, -lightness if lightness < 0 else None)
    if add[1] is not None or add[2] is not None:
        colors = svgshift("addhsl", add, colors)
    if sub[1] is not None or sub[2] is not None:
        colors = svgshift("subhsl", sub, colors)
    return colors


def transform_palette(colors: list[str], opts: Options) -> list[str]:
    mode = opts.mode
    if mode in ("tint", "grayscale"):
        colors = [svgray_gray(c) for c in colors]
    if MODES[mode]["uses_color"]:
        rgb = parse_color(opts.color)
        if mode == "tint":
            colors = svgshift("addrgb", rgb, colors)
        elif mode == "solid":
            colors = svgshift("setrgb", rgb, colors)
        else:
            h, s, _ = _svgshift_hsl(rgb)
            values = (h, s, None) if mode == "colorize" else (h, None, None)
            colors = svgshift("sethsl", values, colors)
    if opts.hue:
        colors = _rotate_hue(colors, opts.hue)
    if opts.saturation or opts.lightness:
        colors = _shift(colors, opts.saturation, opts.lightness)
    return colors


# Every operation works on each color independently, so results are cached per
# (settings, color). Icons share most of their colors, so warm instances rarely
# need to start svgray/svgshift at all.
_CACHE_SIZE = 100_000
_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()


def _settings_key(opts: Options) -> tuple:
    color = rgb_to_hex(parse_color(opts.color)) if MODES[opts.mode]["uses_color"] else None
    return (opts.mode, color, opts.hue, opts.saturation, opts.lightness)


def map_colors(colors: list[str], opts: Options) -> dict[str, str]:
    """Map 6-digit hex colors (lowercase, no '#') to their recolored values."""
    opts.validate()
    key = _settings_key(opts)
    unique = list(dict.fromkeys(c.lower().lstrip("#") for c in colors))
    bad = [c for c in unique if not re.fullmatch(r"[0-9a-f]{6}", c)]
    if bad:
        raise RecolorError(f"Colors must be 6-digit hex values; got '{bad[0]}'.")
    if len(unique) > MAX_PALETTE:
        raise RecolorError(f"At most {MAX_PALETTE} distinct colors are supported.")
    with _cache_lock:
        missing = [c for c in unique if (key, c) not in _cache]
    if missing:
        computed = transform_palette(missing, opts)
        with _cache_lock:
            for c, new in zip(missing, computed):
                _cache[(key, c)] = new
            while len(_cache) > _CACHE_SIZE:
                _cache.popitem(last=False)
    result = {}
    with _cache_lock:
        for c in unique:
            value = _cache.get((key, c))
            if value is None:  # evicted by a concurrent request; recompute below
                break
            _cache.move_to_end((key, c))
            result[c] = value
    if len(result) != len(unique):
        result = dict(zip(unique, transform_palette(unique, opts)))
    return result


def _edit_key(color) -> str:
    """An original color to edit, as 6-digit lowercase hex without '#'."""
    return rgb_to_hex(parse_color(str(color)))[1:]


def parse_edit_list(value: Optional[str]) -> tuple:
    """'ffffff,000000' (or with #) -> ("ffffff", "000000"). For query strings and forms.
    Commas inside a color function stay: 'rgb(255,0,102),fff' is two colors."""
    if value is None:
        return ()
    if not isinstance(value, str):
        raise RecolorError("Color lists must be text like 'ffffff,000000' (or a JSON list of colors).")
    return tuple(c.strip() for c in re.split(r",(?![^()]*\))", value) if c.strip())


def parse_replace(value) -> dict:
    """'5e97f6:ff0000,ffffff:teal' or a dict -> {"5e97f6": "ff0000", ...}."""
    if isinstance(value, dict):
        return value
    if value is not None and not isinstance(value, str):
        raise RecolorError("'replace' must be an object like {\"5e97f6\": \"ff0000\"} or text like '5e97f6:ff0000'.")
    out = {}
    for pair in parse_edit_list(value):
        old, sep, new = pair.partition(":")
        if not sep or not old.strip() or not new.strip():
            raise RecolorError(f"'{pair}' in 'replace' should look like old:new, for example 5e97f6:ff0000.")
        out[old.strip()] = new.strip()
    return out


def recolor(svg: str, opts: Optional[Options] = None) -> Result:
    opts = (opts or Options()).validate()
    normalized = normalize_svg(svg)
    counts = extract_palette(normalized)
    mapping = {**map_colors(list(counts), opts), **{c: v for c, v in opts.replace.items() if c in counts}}
    edited = apply_edits(normalized, hide=opts.hide, remove=opts.remove)
    return Result(svg=apply_mapping(edited, mapping), mapping=mapping, counts=counts,
                  hidden=set(opts.hide) & set(counts), removed=set(opts.remove) & set(counts))


def palette(svg: str) -> list[dict]:
    counts = extract_palette(normalize_svg(svg))
    return [{"color": "#" + c, "count": n} for c, n in counts.items()]
