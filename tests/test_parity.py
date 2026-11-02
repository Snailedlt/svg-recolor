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
]


def cases():
    svgs = [p.read_text(encoding="utf-8") for p in sorted(FIXTURES.glob("*.svg"))] + EXTRA
    out = []
    for svg in svgs:
        for opts in (r.Options(mode="colorize", color="teal", hue=15), r.Options(mode="tint", color="#ff0066")):
            res = r.recolor(svg, opts)
            norm = r.normalize_svg(svg)
            out.append({
                "svg": svg,
                "mapping": res.mapping,
                "expected": {"norm": norm, "palette": [[c, n] for c, n in r.extract_palette(norm).items()], "out": res.svg},
            })
    return out


def test_browser_engine_matches_python():
    data = cases()
    proc = subprocess.run(
        [NODE, str(CLI)], input=json.dumps([{"svg": c["svg"], "mapping": c["mapping"]} for c in data]),
        capture_output=True, text=True, check=True, timeout=60,
    )
    results = json.loads(proc.stdout)
    assert len(results) == len(data)
    for case, got in zip(data, results):
        assert got == case["expected"], case["svg"][:80]
