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
    # Of two touching parts the smaller (here: the later) gives up the whole gap, so one keeps its
    # exact shape: the first square stays 0..64, the others start 4 further on.
    assert d.startswith("M0,0h64v64h-64z") and d.count("M") == 4, d
    assert abs(_area(d) - (64 * 64 + 2 * 60 * 64 + 60 * 60)) < 1


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


def test_one_color_results_ignore_gradients_and_transparency(client):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><defs><linearGradient id="g"><stop stop-color="#f00"/>'
           '<stop offset="1" stop-color="#00f"/></linearGradient></defs><rect width="20" height="20" fill="url(#g)"/>'
           '<rect x="20" width="20" height="20" fill="#9c27b0" fill-opacity=".5"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&gap=2", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    assert len(paths(res.text)) == 1 and "url(" not in res.text
    # Several colors in the result: a gradient still can't be one flat color.
    res = client.post("/api/recolor?mode=colorize&gap=2", content=svg, headers=SVG_CT)
    assert res.status_code == 400 and "gradients" in res.json()["detail"]


def test_holes_light_cuts_near_white_colors(client):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#e44d26"/>'
           '<rect x="10" y="10" width="20" height="20" fill="#ebebeb"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&holes=light", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    ps = paths(res.text)
    assert len(ps) == 1 and "ebebeb" not in res.text.lower()
    assert ps[0][1].count("M") + ps[0][1].count("m") >= 2, "the light square is a hole"
    # An edited light color is left alone.
    res = client.post("/api/recolor?mode=solid&color=000000&holes=light&replace=ebebeb:ff0000", content=svg, headers=SVG_CT)
    assert res.status_code == 200 and "ff0000" in res.text.lower()
    assert client.post("/api/recolor?holes=dark", content=svg, headers=SVG_CT).status_code in (400, 422)


def test_one_color_keeps_the_parts_of_gradients_apart(client):
    # Two touching gradient halves: in one color, a gap still runs between them.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><defs>'
           '<linearGradient id="a"><stop stop-color="#f00"/><stop offset="1" stop-color="#0f0"/></linearGradient>'
           '<linearGradient id="b"><stop stop-color="#00f"/><stop offset="1" stop-color="#ff0"/></linearGradient></defs>'
           '<rect width="20" height="20" fill="url(#a)"/><rect x="20" width="20" height="20" fill="url(#b)"/>'
           '<ellipse cx="20" cy="19" rx="18" ry="1" fill="#000" opacity=".3"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&gap=2", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    ps = paths(res.text)
    assert len(ps) == 1
    assert ps[0][1].count("M") + ps[0][1].count("m") == 2, "two parts, the faint shadow dropped"


def test_a_sliver_joins_its_neighbor_instead_of_notching_it(client):
    # B covers A all but a 0.05 strip along the top: that strip can't be a part of its own, so no
    # gap runs under it (Node's notch). Two parts: top (B and the strip) and bottom (C).
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#ff0000"/>'
           '<rect y="0.05" width="40" height="19.95" fill="#00ff00"/><rect y="20" width="40" height="20" fill="#0000ff"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&gap=2", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    (_, d), = paths(res.text)
    assert d.count("M") + d.count("m") == 2, d
    from picosvg.svg_types import SVGPath
    assert SVGPath(d=d).bounding_box().y < 0.01, "the top edge stays at y=0: " + d


def test_outlines_without_z_get_their_last_edge(client):
    # A fill closes an outline without `z`; the line version must too (Android's arm lost its top-left).
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="#a4c439" d="M10 10H30V30H10"/></svg>'
    res = client.post("/api/recolor?mode=solid&color=000000&line=2", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    (_, d), = paths(res.text)
    assert d.count("M") + d.count("m") == 2, "a closed ring (outline and hole), not a U: " + d


def test_color_auto_takes_the_most_prominent_color(client):
    # Three shades of blue (each smaller than the gray) count together; white doesn't count.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#ffffff"/>'
           '<rect width="18" height="40" fill="#3a4d54"/><rect x="18" width="8" height="40" fill="#00acd3"/>'
           '<rect x="26" width="7" height="40" fill="#019bc6"/><rect x="33" width="7" height="40" fill="#23c2ee"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=auto&format=json", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["color"].lower() in ("#00acd3", "#019bc6", "#23c2ee"), data["color"]
    assert data["filename"].endswith(data["color"][1:].lower() + ".svg")
    # A gradient counts as its middle color.
    grad = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g">'
            '<stop stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>'
            '<rect width="10" height="10" fill="url(#g)"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=auto&format=json", content=grad, headers=SVG_CT)
    assert res.status_code == 200 and res.json()["color"].lower() == "#800080", res.text


def test_pale_tints_count_as_light_but_pastels_do_not():
    assert shapes.is_light("ffffff") and shapes.is_light("ebebeb") and shapes.is_light("d4eef1")  # Docker's eye
    assert not shapes.is_light("bfdbe0")  # Docker's belly shine stays
    assert not shapes.is_light("ffc0cb") and not shapes.is_light("ffd43b")  # pink, Python's yellow


def test_light_colors_are_holes_only_where_drawn_against_other_colors(client):
    # The white square sits on the red: a hole. The gray square stands apart (CMake's middle): a part.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="20" height="20" fill="#e44d26"/>'
           '<rect x="5" y="5" width="10" height="10" fill="#ffffff"/><rect x="25" y="5" width="10" height="10" fill="#cccccc"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&holes=light&format=json", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    data = res.json()
    to = {p["from"]: p["to"] for p in data["palette"]}
    assert to["#ffffff"] == "cut" and to["#cccccc"] == "#000000", to
    (_, d), = paths(data["svg"])
    assert d.count("M") + d.count("m") == 3, "red with a hole, and the gray part: " + d
    assert "holes:" not in data["svg"]


def test_outline_colors_become_gaps(client):
    # Two blue boxes in a dark frame, a dark stripe between them: the dark is an outline.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="10" y="10" width="108" height="108" fill="#3a4d54"/>'
           '<rect x="12" y="12" width="51" height="104" fill="#019bc6"/><rect x="65" y="12" width="51" height="104" fill="#00acd3"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&outlines=gap&format=json", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    data = res.json()
    assert {p["from"]: p["to"] for p in data["palette"]}["#3a4d54"] == "cut"
    (_, d), = paths(data["svg"])
    # The stripe between the boxes is a gap; the frame along the edge stays ink (the silhouette
    # keeps its size), so the frame is one path with the two boxes' areas inside.
    from picosvg.svg_types import SVGPath
    box = SVGPath(d=d).bounding_box()
    assert abs(box.x - 10) < 0.1 and abs(box.w - 108) < 0.1, box
    from picosvg.svg_pathops import skia_path
    area = abs(skia_path(SVGPath(d=d).as_cmd_seq(), "nonzero").area)
    assert 108 * 108 - 2 * 104 - 60 < area < 108 * 108 - 150, area  # the frame, less the stripe
    # Line art (thin lines that are the drawing, by a thick part) isn't an outline.
    art = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="100" cy="64" r="20" fill="#019bc6"/>'
           '<path d="M10 20H80M10 64H80M10 108H80" stroke="#00bd9f" stroke-width="2" fill="none"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&outlines=gap&format=json", content=art, headers=SVG_CT)
    assert res.status_code == 200, res.text
    assert {p["from"]: p["to"] for p in res.json()["palette"]}["#00bd9f"] != "cut"


def test_lighter_thin_parts_are_not_outlines(client):
    # A thin pink stripe between two red parts (like an octopus's tentacle undersides) is lighter
    # than them: part of the drawing, not an outline. The same stripe in dark gray is an outline.
    def svg(stripe):
        return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="10" y="10" width="108" height="108" '
                f'fill="{stripe}"/><rect x="10" y="10" width="53" height="108" fill="#c62828"/>'
                '<rect x="65" y="10" width="53" height="108" fill="#e3373b"/></svg>')
    for stripe, cut in (("#f389a4", False), ("#3a4d54", True)):
        res = client.post("/api/recolor?mode=solid&color=000000&outlines=gap&format=json", content=svg(stripe), headers=SVG_CT)
        assert res.status_code == 200, res.text
        assert ({p["from"]: p["to"] for p in res.json()["palette"]}[stripe] == "cut") is cut, stripe


def test_lines_of_the_one_colour_version(client):
    # Two touching squares of different colours, a gap between them: lines=plain outlines each part
    # (two rings), where lines=outer draws one ring around both.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="34" width="60" height="60" fill="#e44d26"/>'
           '<rect x="64" y="34" width="60" height="60" fill="#f16529"/></svg>')
    def rings(q):
        res = client.post(f"/api/recolor?mode=solid&color=000000&line=2&{q}", content=svg, headers=SVG_CT)
        assert res.status_code == 200, res.text
        (_, d), = paths(res.text)
        return d.count("M") + d.count("m")
    assert rings("lines=outer") == 2  # one ring: its outside and its hole
    assert rings("lines=plain&gap=4") == 4  # two rings
    assert client.post("/api/recolor?line=2&lines=nope", content=svg, headers=SVG_CT).status_code in (400, 422)


def test_a_spike_in_an_outline_does_not_fill_a_line_version(client):
    # An outline that runs along a curve and straight back (left where two shapes shared an edge).
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#1867c0" d="M128.063 8.565 96.054 '
           '64.031l-32.022 55.468S91.796 48.396 79.692 8.566c12.104 39.831-15.66 110.933-15.66 110.933L39.853 77.596l39.839-69.03z"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&line=1", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    from picosvg.svg_pathops import skia_path
    from picosvg.svg_types import SVGPath
    (_, d), = paths(res.text)
    assert abs(skia_path(SVGPath(d=d).as_cmd_seq(), "nonzero").area) < 1500, "lines, not the filled shape (about 4350)"


def _area(d):
    from picosvg.svg_pathops import skia_path
    from picosvg.svg_types import SVGPath
    return abs(skia_path(SVGPath(d=d).as_cmd_seq(), "nonzero").area)


def test_simplify_merges_shades_and_drops_specks(client):
    # A square in two close blues (a highlight), a far red one, and a 6x6 speck.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="4" width="60" height="60" fill="#1867c0"/>'
           '<rect x="64" y="4" width="60" height="60" fill="#2a78d0"/><rect x="4" y="70" width="60" height="50" fill="#e33333"/>'
           '<rect x="100" y="100" width="6" height="6" fill="#e33333"/></svg>')
    def parts(q):
        res = client.post(f"/api/recolor?mode=solid&color=000000&gap=4&{q}", content=svg, headers=SVG_CT)
        assert res.status_code == 200, res.text
        (_, d), = paths(res.text)
        return d.count("M") + d.count("m")
    assert parts("") == 4  # two blues apart, red, speck
    assert parts("merge=40") == 3  # the blues are one part: no gap between them
    assert parts("merge=40&detail=7") == 2  # and the speck is gone
    for bad in ("merge=-1", "merge=x", "detail=-2"):
        assert client.post(f"/api/recolor?gap=4&{bad}", content=svg, headers=SVG_CT).status_code in (400, 422), bad


def test_a_thin_ring_gets_one_line_down_its_middle(client):
    # A ring 6 wide: with line=3 its two edge lines would sit 0 apart (a filled ring);
    # it becomes one line 3 wide down its middle instead.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#1867c0" fill-rule="evenodd" '
           'd="M64 14a50 50 0 1 0 0.001 0zM64 20a44 44 0 1 0 0.001 0z"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&line=3", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    (_, d), = paths(res.text)
    ring = 3.14159 * (50 ** 2 - 44 ** 2)  # about 1772
    center = 3.14159 * (48.5 ** 2 - 45.5 ** 2)  # about 886
    assert abs(_area(d) - center) < 0.15 * center, (_area(d), ring)


def test_gaps_keep_parts_thinner_than_the_gap(client):
    # Two squares joined by a bar 3 wide in another colour: a gap of 4 would cut the bar away.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="34" width="50" height="60" fill="#1867c0"/>'
           '<rect x="74" y="34" width="50" height="60" fill="#1867c0"/><rect x="54" y="62" width="20" height="3" fill="#e33333"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&gap=4", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    (_, d), = paths(res.text)
    assert _area(d) > 2 * 50 * 60 + 40, "the bar stays (joined to the squares)"


def test_a_hairline_along_the_edge_joins_the_part_beside_it(client):
    # A square with a second colour drawn over its lower half, 0.4 short of the edge (like
    # Bitbucket's facet): the gaps must not leave the 0.4 strip as a stray line.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="4" width="120" height="120" fill="#2684ff"/>'
           '<rect x="4.4" y="64" width="119.2" height="59.6" fill="#0052cc"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&gap=4", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    (_, d), = paths(res.text)
    assert d.count("M") + d.count("m") == 2, d  # two parts, no hairlines


def test_centered_lines_straddle_the_edge(client):
    # A 60x60 square, line 4: inside the edge the outline spans 34..94; centered, 32..96.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="34" y="34" width="60" height="60" fill="#1867c0"/></svg>')
    def box(q):
        res = client.post(f"/api/recolor?mode=solid&color=000000&line=4{q}", content=svg, headers=SVG_CT)
        assert res.status_code == 200, res.text
        (_, d), = paths(res.text)
        return d, _area(d)
    d_in, a_in = box("")
    d_c, a_c = box("&linealign=center")
    assert "M34,34" in d_in.replace(" ", "") and abs(a_in - (60 * 60 - 52 * 52)) < 1
    assert "32" in d_c and abs(a_c - (64 * 64 - 56 * 56)) < 5, (d_c, a_c)  # round outer corners
    assert client.post("/api/recolor?line=4&linealign=middle", content=svg, headers=SVG_CT).status_code in (400, 422)


def test_auto_gaps_leave_a_mesh_alone(client):
    # Slots cut into one colour and a second colour over half of it: the holes already
    # show the parts, so gaps=auto adds none; a plain shape with no holes still gets them.
    holes = "".join(f"M{x} 14h2v100h-2z" for x in range(10, 62, 5))
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#1867c0" fill-rule="evenodd" d="M4 4h120v120H4z{holes}"/>'
           '<rect x="64" y="4" width="60" height="120" fill="#e33333" fill-opacity="0.999"/></svg>')
    def area(q, s=svg):
        res = client.post(f"/api/recolor?mode=solid&color=000000&gap=4{q}", content=s, headers=SVG_CT)
        assert res.status_code == 200, res.text
        return sum(_area(d) for _, d in paths(res.text))
    full = area("&gaps=auto")
    assert area("") < full - 100, "with gaps always, a strip goes"
    plain = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="4" width="60" height="120" fill="#1867c0"/>'
             '<rect x="64" y="4" width="60" height="120" fill="#e33333"/></svg>')
    assert area("&gaps=auto", plain) < 120 * 120 - 100, "no holes: the gap stays"
    assert client.post("/api/recolor?gap=4&gaps=sometimes", content=plain, headers=SVG_CT).status_code in (400, 422)


def test_a_light_gradient_becomes_a_hole_with_light_holes(client):
    # Pale gradient "letters" (a bar) on a blue square, like Azure SQL's: with holes=light they're
    # cut out like a white fill would be.
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g">'
           '<stop offset="0" stop-color="#f2f2f2"/><stop offset="1" stop-color="#e6e6e6"/></linearGradient></defs>'
           '<rect x="4" y="4" width="120" height="120" fill="#0078d4"/><rect x="34" y="54" width="60" height="20" fill="url(#g)"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&holes=light&gap=2", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    (_, d), = paths(res.text)
    assert abs(_area(d) - (120 * 120 - 60 * 20)) < 40, _area(d)


def test_knockout_keeps_the_outer_edge_as_an_outline(client):
    # A pale disc with a black outline ring and a black bar across the middle (like GCC's egg and
    # text): knocked out, the bar becomes a hole and the ring stays (the drawing keeps its edge).
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="60" fill="#000000"/>'
           '<circle cx="64" cy="64" r="58" fill="#ffcfab"/><rect x="34" y="58" width="60" height="12" fill="#000000"/></svg>')
    res = client.post("/api/recolor?mode=solid&color=000000&knockout=000000", content=svg, headers=SVG_CT)
    assert res.status_code == 200, res.text
    (_, d), = paths(res.text)
    disc, bar = 3.14159 * 60 * 60, 60 * 12
    assert abs(_area(d) - (disc - bar)) < 0.03 * disc, (_area(d), disc - bar)
    res = client.post("/api/recolor?mode=solid&color=000000&cut=000000", content=svg, headers=SVG_CT)
    (_, d2), = paths(res.text)
    assert _area(d2) < _area(d) - 300, "cut takes the ring too"
