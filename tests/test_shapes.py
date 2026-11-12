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


# --- From the CodeRabbit review --------------------------------------------------------
def test_color_functions_in_edit_lists_and_bad_replace(client):
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff" width="1" height="1"/><circle fill="#000" r="1"/></svg>'
    res = client.post("/api/recolor?mode=adjust&remove=rgb(255,255,255)", content=svg, headers=SVG_CT)
    assert res.status_code == 200 and "<rect" not in res.text and "<circle" in res.text
    res = client.post("/api/recolor", json={"svg": svg, "replace": ["fff:red"]})
    assert res.status_code == 400, res.text


def test_output_attributes_are_escaped(client):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="40&quot; onload=&quot;alert(1)" height="20">'
           '<rect width="20" height="20" fill="#5e97f6"/><rect x="20" width="20" height="20" fill="#9c27b0"/></svg>')
    res = client.post("/api/recolor?mode=adjust&gap=2", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    assert ' onload="' not in res.text and "&quot;" in res.text


def test_masks_are_refused_not_dropped(client):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><defs><mask id="m"><rect width="10" height="20" fill="#fff"/></mask></defs>'
           '<rect width="20" height="20" fill="#00f"/><rect width="20" height="20" fill="#f00" mask="url(#m)"/></svg>')
    res = client.post("/api/recolor?mode=adjust&gap=1", content=svg, headers=SVG_CT)
    assert res.status_code == 400 and "masks" in res.json()["detail"]


def test_root_transform_and_non_uniform_stroke_scale(client):
    # A transform on the root <svg>: the drawing moves by it (x 10 -> 20).
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" transform="translate(10 0)">'
           '<rect x="10" width="10" height="20" fill="#5e97f6"/><rect x="0" width="10" height="20" fill="#9c27b0"/></svg>')
    res = client.post("/api/recolor?mode=adjust&gap=0.0001", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    assert "M20," in res.text or "M30," in res.text, res.text
    # A 2-wide stroke inside scale(10 1): 2 high, not 2 x sqrt(10).
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><g transform="scale(10 1)">'
           '<path d="M0 10H10" stroke="#5e97f6" stroke-width="2" fill="none"/></g><rect x="0" y="0" width="1" height="1" fill="#000"/></svg>')
    res = client.post("/api/recolor?mode=adjust&gap=0.0001", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    stroke = next(d for c, d in paths(res.text) if c == "5e97f6")
    assert re.search(r"(^|[^\d.])(9|11)(?!\.?\d)", stroke), stroke  # from y=9 to y=11


def test_percent_units_with_a_spaced_viewbox(client):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100 " overflow="visible">'
           '<rect x="0" y="0" width="10" height="10" fill="#5e97f6"/></svg>')
    res = client.post("/api/recolor?mode=adjust&line=10&unit=pct", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    # 10 % of 100 = a 10-unit band: the whole 10 x 10 square stays filled.
    assert paths(res.text)[0][1] in ("M0,0h10v10h-10z", "M0,10v-10h10v10z", "M10,0v10h-10v-10z", "M0,0h10l0,10l-10,0z"), res.text


def test_fit_measures_gradients_and_bad_values_are_refused(client):
    gradient = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><defs><linearGradient id="g"><stop stop-color="#f00"/>'
                '<stop offset="1" stop-color="#00f"/></linearGradient></defs><rect x="10" y="10" width="20" height="20" fill="url(#g)"/></svg>')
    res = client.post("/api/recolor?mode=adjust&canvas=128x128&fit=0", content=gradient, headers=SVG_CT)
    assert res.status_code == 200, res.text
    assert '<g transform="matrix(6.4 0 0 6.4 -64 -64)">' in res.text  # 20 x 20 at 10,10 fills 128 x 128
    assert client.post("/api/recolor?cut=notacolor", content=CUT_SVG, headers=SVG_CT).status_code == 400
    assert client.post("/api/recolor", json={"svg": CUT_SVG, "optimize": "maybe"}).status_code == 400
