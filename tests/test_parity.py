"""The browser (static/engine.js) and server (recolor.py) engines must agree byte for byte.

The website normalizes SVGs and applies mappings in the browser, so any drift
would make the editor's output differ from the API's.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import recolor as r
from tests.conftest import FIXTURES

NODE = shutil.which("node")
CLI = Path(__file__).parent / "js" / "engine-cli.mjs"

pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is not installed")

EXTRA = [
    '<svg xmlns="http://www.w3.org/2000/svg"><path stroke="currentColor" fill="none"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg><rect style="fill: hsl(210 50% 40%); stroke: rgb(12.5%, 50%, 100%)"/><circle fill="#ABC" stroke="hsla(10,80%,30%,0.5)"/></svg>',
    '<svg><rect fill="rgb(9**9**9, 0, 0)"/><stop stop-color="Transparent"/><a href="#abcdef"/></svg>',
    # Per-color edits: inheritance, own vs style paint, strokes, defs, text, nesting, comments
    ('<svg><g fill="#fff"><path d="M0"/><path fill="red" d="M1"/><g><rect/></g></g><text fill="#fff">hi<tspan>x</tspan></text>'
     '<!-- <path fill="#fff"/> --><path style="fill:#fff;stroke:#000" d="M1"/><line stroke="#fff"/><circle stroke="#fff" fill="none"/></svg>'),
    ('<svg><defs><clipPath id="c"><rect fill="#fff"/></clipPath><linearGradient id="g"><stop stop-color="#fff"/></linearGradient></defs>'
     '<rect fill="url(#g)" stroke="#fff" clip-path="url(#c)"/><style>.a{fill:#fff}</style><path class="a" fill = \'#FFF\'/></svg>'),
    ('<svg><defs><style>/* x */.cls-1{fill:#5e97f6;}.cls-2,.cls-3{fill:#fff;stroke:#000}.cls-3{stroke:none} svg .cls-1{fill:red}</style></defs>'
     '<path class="cls-1" d="M0"/><path class="cls-2" d="M1"/><path class=" cls-1  cls-3 " d="M2"/><path class="cls-9" fill="#fff"/></svg>'),
]


def cases():
    svgs = [p.read_text(encoding="utf-8") for p in sorted(FIXTURES.glob("*.svg"))] + EXTRA
    out = []
    for svg in svgs:
        norm = r.normalize_svg(svg)
        colors = list(r.extract_palette(norm))
        edited = r.Options(mode="solid", color="#222222", remove=colors[:1], hide=colors[1:2],
                           replace={c: "#ff0066" for c in colors[2:3]})
        for opts in (r.Options(mode="colorize", color="teal", hue=15), r.Options(mode="tint", color="#ff0066"), edited):
            res = r.recolor(svg, opts)
            out.append({
                "svg": svg,
                "mapping": res.mapping,
                "hide": list(opts.hide),
                "remove": list(opts.remove),
                "expected": {"norm": norm, "palette": [[c, n] for c, n in r.extract_palette(norm).items()], "out": res.svg},
            })
    return out


def test_browser_engine_matches_python():
    data = cases()
    proc = subprocess.run(
        [NODE, str(CLI)], input=json.dumps([{k: c[k] for k in ("svg", "mapping", "hide", "remove")} for c in data]),
        capture_output=True, text=True, check=True, timeout=60,
    )
    results = json.loads(proc.stdout)
    assert len(results) == len(data)
    for case, got in zip(data, results):
        assert got == case["expected"], case["svg"][:80]
