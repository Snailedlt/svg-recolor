"""Cut out, gaps, lines, canvas and SVGO in the API and MCP: the editor's own code
(static/geometry.js, paper.js, SVGO) run in QuickJS, so the numbers here are the same
as in the editor's browser tests (tests/e2e/editor.test.mjs)."""

import re

import pytest

from server import shapes
from tests.test_mcp import rpc

SVG_CT = {"content-type": "image/svg+xml"}

# Two facets with an outline over their shared edge, like the JAX logo.
CUT_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20">'
           '<rect x="0" y="0" width="20" height="20" fill="#5e97f6"/><rect x="20" y="0" width="20" height="20" fill="#9c27b0"/>'
           '<rect x="19" y="0" width="2" height="20" fill="#dce0df"/></svg>')
# Four touching squares, like the rqlite logo.
GAP_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
           '<rect width="64" height="64" fill="#013397"/><rect x="64" width="64" height="64" fill="#0169c9"/>'
           '<rect y="64" width="64" height="64" fill="#0197fd"/><rect x="64" y="64" width="64" height="64" fill="#b3defd"/></svg>')
LINE_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
            '<rect width="128" height="128" fill="#0169c9"/><rect x="32" y="32" width="64" height="64" fill="#ffffff"/></svg>')
STROKED = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">'
           '<rect x="10" y="10" width="20" height="20" fill="#5e97f6" stroke="#0f766e" stroke-width="2"/></svg>')

paths = lambda svg: re.findall(r'<path fill="#(\w+)" d="([^"]+)"', svg)


def test_cut_makes_a_gap_and_one_path_per_color(client):
    res = client.post("/api/recolor", json={"svg": CUT_SVG, "mode": "solid", "color": "000000", "cut": ["dce0df"], "format": "json"})
    assert res.status_code == 200, res.text
    data = res.json()
    assert len(paths(data["svg"])) == 1, "solid + cut = one path"
    assert 'viewBox="0 0 40 20"' in data["svg"]
    assert {p["from"]: p["to"] for p in data["palette"]}["#dce0df"] == "cut"
    # The outline is a gap: the facets end at 19 and start again at 21.
    assert paths(data["svg"])[0][1] == "M0,0h19v20h-19zM40,0v20h-19v-20z"


def test_gaps_between_touching_colors(client):
    res = client.post("/api/recolor?mode=solid&color=0169c9&gap=4", content=GAP_SVG, headers=SVG_CT)
    assert res.status_code == 200, res.text
    (color, d), = paths(res.text)
    assert color == "0169c9"
    # Each 64-unit square gives up 2 on each side that touches another: 0..62 and 66..128.
    assert d == "M0,0h62l0,62l-62,0zM128,0v62l-62,0v-62zM0,128v-62h62l0,62zM128,128h-62v-62h62z"


def test_line_version_keep_and_outline_only(client):
    res = client.post("/api/recolor?mode=solid&color=000000&line=8", content=LINE_SVG, headers=SVG_CT)
    assert res.status_code == 200, res.text
    all_lines = paths(res.text)[0][1]
    res = client.post("/api/recolor?mode=solid&color=000000&line=8&lines=outer", content=LINE_SVG, headers=SVG_CT)
    outer = paths(res.text)[0][1]
    assert outer != all_lines and "28" in all_lines and "36" in all_lines, "a line centered on the inner edge (32 ± 4)"
    res = client.post("/api/recolor?mode=solid&color=000000&line=8&keep=ffffff", content=LINE_SVG, headers=SVG_CT)
    assert res.status_code == 200 and paths(res.text)[0][1] != all_lines


def test_canvas_and_fit_with_padding_count_strokes(client):
    res = client.post("/api/recolor?mode=adjust&canvas=128x128&fit=1", content=STROKED, headers=SVG_CT)
    assert res.status_code == 200, res.text
    assert 'viewBox="0 0 128 128"' in res.text
    assert '<g transform="matrix(5.727 0 0 5.727 -50.545 -50.545)">' in res.text  # the editor's numbers
    res = client.post("/api/recolor?mode=adjust&canvas=200x100", content=STROKED, headers=SVG_CT)
    assert '<g transform="matrix(1 0 0 1 50 25)">' in res.text, "a bigger canvas keeps the drawing centered"


def test_optimize_with_the_editors_svgo_settings(client):
    svg = ('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" '
           'viewBox="0 0 128 128"><title>t</title><g><rect x="0" y="0" width="64.123456" height="64" fill="#5e97f6"/></g></svg>')
    res = client.post("/api/recolor?mode=adjust&optimize=true", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    out = res.text
    assert not re.search(r"<title>|<!--|<\?xml|width=", out)
    assert 'viewBox="0 0 128 128"' in out and "64.123" in out and out.endswith("</svg>\n")
    res = client.post("/api/recolor?mode=adjust&optimize=true&precision=1", content=svg, headers=SVG_CT)
    assert "64.1" in res.text and "64.12" not in res.text


def test_clear_errors(client):
    gradient = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop stop-color="#f00"/>'
                '</linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><rect width="4" height="4" fill="#00ff00"/></svg>')
    res = client.post("/api/recolor?cut=00ff00", content=gradient, headers=SVG_CT)
    assert res.status_code == 400 and "gradients" in res.json()["detail"]
    assert client.post("/api/recolor?canvas=128", content=CUT_SVG, headers=SVG_CT).status_code == 400
    res = client.post("/api/recolor?cut=dce0df&remove=dce0df", content=CUT_SVG, headers=SVG_CT)
    assert res.status_code == 400 and "cut out" in res.json()["detail"]
    assert client.post("/api/recolor?unit=em&gap=1", content=CUT_SVG, headers=SVG_CT).status_code == 422


def test_mcp_does_the_same(client):
    res = rpc(client, "tools/call", {"name": "recolor_svg", "arguments": {
        "svg": STROKED, "mode": "solid", "color": "000000", "canvas": "128x128", "fit": 1, "optimize": True}})["result"]
    assert not res.get("isError"), res
    assert 'viewBox="0 0 128 128"' in res["structuredContent"]["svg"]
    res = rpc(client, "tools/call", {"name": "recolor_svg", "arguments": {
        "svg": CUT_SVG, "mode": "solid", "color": "000000", "cut": ["#dce0df"]}})["result"]
    assert len(paths(res["structuredContent"]["svg"])) == 1


@pytest.mark.parametrize("value", ["128x128", "128 128", [128, 128]])
def test_canvas_formats(value):
    assert shapes.parse_extras(lambda v: v or [], canvas=value).canvas == (128.0, 128.0)
