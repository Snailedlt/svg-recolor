"""The recolor engine: color parsing, normalization, modes and caching."""

import time

import pytest

import recolor as r
from tests.conftest import fixture_svg


def channels(hex6: str) -> tuple[int, int, int]:
    return tuple(int(hex6[i : i + 2], 16) for i in (0, 2, 4))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("#ff0066", (255, 0, 102)),
        ("FF0066", (255, 0, 102)),
        ("#f06", (255, 0, 102)),
        ("255,0,102", (255, 0, 102)),
        ("rgb(255 0 102)", (255, 0, 102)),
        ("tomato", (255, 99, 71)),
        ("hsl(0 100% 50%)", (255, 0, 0)),
    ],
)
def test_parse_color(value, expected):
    assert r.parse_color(value) == expected


@pytest.mark.parametrize("value", ["", "zzz", "#12345", "256,0,0", "rgb(1,2)", None])
def test_parse_color_rejects_invalid(value):
    with pytest.raises(r.RecolorError):
        r.parse_color(value)


def test_normalize_converts_every_color_notation():
    out = r.normalize_svg(fixture_svg("edge-cases.svg"))
    assert 'stop-color="#ff000080"' in out  # rgb() with 50% alpha -> 8-digit hex
    assert "stop-color:#008000" in out  # hsl()
    assert 'stroke="#ff0066"' in out  # short hex
    assert 'stroke="#663399"' in out  # named color, any case
    assert 'fill="#aabbccdd"' in out  # 4-digit hex with alpha
    assert 'fill="url(#abc)"' in out and 'href="#abc"' in out  # references untouched
    assert 'fill="#000000"' in out  # implicit black fill made explicit
    assert 'color="#000000"' not in out  # root already sets color via style


def test_current_color_gets_explicit_black():
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><path stroke="currentColor"/></svg>'
    assert 'color="#000000"' in r.normalize_svg(svg)


def test_root_fill_not_added_when_present():
    svg = '<svg xmlns="http://www.w3.org/2000/svg" fill="none"><path stroke="#123456"/></svg>'
    assert r.normalize_svg(svg).count("fill=") == 1


def test_palette_counts_and_order(python_svg):
    counts = r.extract_palette(r.normalize_svg(python_svg))
    values = list(counts.values())
    assert values == sorted(values, reverse=True)  # most used first
    assert "5a9fd4" in counts and "ffd43b" in counts


def test_solid_maps_every_color_to_target(python_svg):
    res = r.recolor(python_svg, r.Options(mode="solid", color="#3ecf8e"))
    assert set(res.mapping.values()) == {"3ecf8e"}
    assert "#5a9fd4" not in res.svg


def test_grayscale_is_gray(python_svg):
    res = r.recolor(python_svg, r.Options(mode="grayscale"))
    for value in res.mapping.values():
        red, green, blue = channels(value)
        assert red == green == blue


def test_adjust_without_shifts_keeps_colors(python_svg):
    res = r.recolor(python_svg, r.Options(mode="adjust"))
    assert all(k == v for k, v in res.mapping.items())


def test_colorize_keeps_lightness_order(python_svg):
    res = r.recolor(python_svg, r.Options(mode="colorize", color="teal"))
    dark, light = res.mapping["306998"], res.mapping["ffe873"]
    assert sum(channels(dark)) < sum(channels(light))


def test_hue_rotation_wraps_around():
    # Pure red (hue 0) rotated by -30 should wrap to hue 330 (pink), not clamp at 0.
    mapped = r.map_colors(["ff0000"], r.Options(mode="adjust", hue=-30))["ff0000"]
    red, green, blue = channels(mapped)
    assert red > 200 and blue > 100 and green < 30


def test_tint_matches_original_tool_behavior(python_svg):
    # Before this engine existed, svg-recolor ran svgray then `svgshift addrgb`.
    res = r.recolor(python_svg, r.Options(mode="tint", color="#ff0066"))
    assert res.mapping["5a9fd4"] == "ff90f6"


def test_map_colors_validates_input():
    with pytest.raises(r.RecolorError):
        r.map_colors(["nothex"], r.Options(mode="solid", color="red"))
    with pytest.raises(r.RecolorError):
        r.Options(mode="nope").validate()
    with pytest.raises(r.RecolorError):
        r.Options(mode="adjust", hue=999).validate()


def test_map_colors_cache_returns_same_result():
    opts = r.Options(mode="colorize", color="#123abc", lightness=7)
    first = r.map_colors(["5a9fd4", "306998"], opts)
    assert r.map_colors(["306998", "5a9fd4"], opts) == first


def test_rgb_function_payload_is_not_evaluated():
    # svgray used to eval() rgb() arguments; this would hang for minutes.
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="rgb(9**9**9, 0, 0)"/><rect fill="#00ff00"/></svg>'
    start = time.monotonic()
    res = r.recolor(svg, r.Options(mode="grayscale"))
    assert time.monotonic() - start < 2
    assert "rgb(9**9**9, 0, 0)" in res.svg


def test_large_real_world_svg_keeps_structure():
    svg = fixture_svg("firefox.svg")
    res = r.recolor(svg, r.Options(mode="hue", color="#3ecf8e"))
    assert res.svg.count("<path") == svg.count("<path")
    assert len(res.mapping) > 50


def test_decode_svg_rejects_non_svg_and_large_files():
    with pytest.raises(r.RecolorError):
        r.decode_svg(b"hello")
    with pytest.raises(r.RecolorError):
        r.decode_svg(b"<svg>" + b" " * (r.MAX_SVG_BYTES + 1))


def _many_colors(n: int) -> str:
    return '<svg xmlns="http://www.w3.org/2000/svg">' + "".join(f'<rect fill="#{i * 2654435761 % 0xFFFFFF:06x}"/>' for i in range(n)) + "</svg>"


def test_palette_at_the_limit_is_fast():
    svg = _many_colors(r.MAX_PALETTE)
    start = time.monotonic()
    res = r.recolor(svg, r.Options(mode="colorize", color="teal", hue=30, lightness=-5))
    assert len(res.mapping) == r.MAX_PALETTE
    assert time.monotonic() - start < 5


def test_palette_over_the_limit_is_refused():
    with pytest.raises(r.RecolorError):
        r.recolor(_many_colors(r.MAX_PALETTE + 1), r.Options(mode="solid", color="red"))


def test_largest_allowed_file_is_fast():
    svg = '<svg xmlns="http://www.w3.org/2000/svg">' + '<path fill="#5a9fd4" d="M0 0h1v1z"/>' * 55_000 + "</svg>"
    assert len(svg.encode()) < r.MAX_SVG_BYTES
    start = time.monotonic()
    res = r.recolor(r.decode_svg(svg.encode()), r.Options(mode="hue", color="red"))
    assert res.svg.count("<path") == 55_000
    assert time.monotonic() - start < 5


# --------------------------------------------------------------------------
# Per-color edits (replace / hide / remove)
# --------------------------------------------------------------------------

def edited(svg, **kw):
    return r.recolor(svg, r.Options(mode="adjust", **kw)).svg


def test_remove_deletes_shapes_painted_with_the_color():
    svg = '<svg><rect fill="#fff"/><path fill="#5E97F6" d="M0"/><circle style="fill: white"/></svg>'
    assert edited(svg, remove=["white"]) == '<svg fill="#000000"><path fill="#5e97f6" d="M0"/></svg>'


def test_remove_follows_inheritance_and_keeps_other_paint():
    svg = ('<svg><g fill="#fff"><path d="M0"/><path fill="red" d="M1"/></g>'
           '<path fill="#fff" stroke="#000" d="M2"/><path stroke="#fff" fill="#000" d="M3"/></svg>')
    out = edited(svg, remove=["fff"])
    assert '<path d="M0"/>' not in out and 'fill="#ff0000" d="M1"' in out
    assert '<path fill="none" stroke="#000000" d="M2"/>' in out  # fill gone, stroke stays
    assert '<path stroke="none" fill="#000000" d="M3"/>' in out  # stroke gone, fill stays


def test_remove_reads_simple_class_rules():
    svg = '<svg><style>.a{fill:#fff}.b{fill:#00f}</style><path class="a" d="M0"/><path class="b" d="M1"/></svg>'
    out = edited(svg, remove=["fff"])
    assert 'class="a"' not in out and 'class="b"' in out and ".a{fill:none}" in out


def test_remove_never_deletes_clip_paths_or_gradient_stops():
    svg = ('<svg><defs><clipPath id="c"><rect fill="#fff"/></clipPath><linearGradient id="g">'
           '<stop stop-color="#fff"/></linearGradient></defs><rect fill="url(#g)" clip-path="url(#c)"/></svg>')
    out = edited(svg, remove=["fff"])
    assert '<clipPath id="c"><rect fill="none"/></clipPath>' in out
    assert '<stop stop-color="transparent"/>' in out and 'fill="url(#g)"' in out


def test_remove_deletes_whole_text_elements():
    out = edited('<svg><text fill="#fff">Hi <tspan>there</tspan></text><path d="M0"/></svg>', remove=["fff"])
    assert "<text" not in out and "there" not in out and '<path d="M0"/>' in out


def test_hide_keeps_shapes_but_makes_them_invisible():
    out = edited('<svg><path fill="#fff" d="M0"/><stop stop-color="#fff"/></svg>', hide=["fff"])
    assert '<path fill="none" d="M0"/>' in out and 'stop-color="transparent"' in out


def test_replace_overrides_the_mode_for_one_color():
    res = r.recolor('<svg><path fill="#5e97f6"/><path fill="#e879f9"/></svg>',
                    r.Options(mode="solid", color="000000", replace={"#e879f9": "tomato"}))
    assert 'fill="#000000"' in res.svg and 'fill="#ff6347"' in res.svg


def test_one_color_icon_recipe():
    # A devicon-style "plain" version: one color, the background removed.
    svg = '<svg viewBox="0 0 2 1"><rect fill="#fff" width="2" height="1"/><path fill="#5e97f6" d="M0"/><path fill="#e879f9" d="M1"/></svg>'
    res = r.recolor(svg, r.Options(mode="solid", color="000000", remove=["ffffff"]))
    assert "rect" not in res.svg and res.svg.count('fill="#000000"') == 3  # root + two paths
    assert {p["from"]: p["to"] for p in res.palette()}["#ffffff"] == "removed"


@pytest.mark.parametrize("kw", [{"hide": ["fff"], "remove": ["white"]}, {"replace": {"#fff": "red"}, "hide": ["fff"]},
                                {"remove": ["nope"]}, {"replace": {"fff": "nope"}}])
def test_bad_edits_are_rejected(kw):
    with pytest.raises(r.RecolorError):
        r.Options(**kw).validate()


def test_no_edits_changes_nothing():
    svg = '<svg><path fill="#5e97f6"/></svg>'
    assert r.apply_edits(r.normalize_svg(svg)) == r.normalize_svg(svg)


def test_remove_uses_the_last_declaration_like_css():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:#fff;fill:#000" width="1"/>'
           '<style>.b{fill:#fff;fill:#000}</style><circle class="b" r="1"/><path fill="#fff" d="M0"/></svg>')
    out = r.apply_edits(r.normalize_svg(svg), remove=["ffffff"])
    assert "<rect" in out and "<circle" in out, "black (the last declaration) is not removed"
    assert "<path" not in out


def test_remove_keeps_children_painted_their_own_way():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg"><text fill="#fff">White<tspan fill="#000">Black</tspan></text>'
           '<text fill="#fff">plain</text></svg>')
    out = r.apply_edits(r.normalize_svg(svg), remove=["ffffff"])
    assert out.count("<text") == 1 and '<tspan fill="#000000">Black</tspan>' in out
    assert 'fill="none"' in out, "the kept <text> stops painting white itself"
    assert "plain" not in out


def test_edit_lists_keep_color_functions_whole():
    assert r.parse_edit_list("rgb(255,0,102), fff,hsl(1, 2%, 3%)") == ("rgb(255,0,102)", "fff", "hsl(1, 2%, 3%)")
    assert r.parse_replace("rgb(255,0,102):red,fff:000") == {"rgb(255,0,102)": "red", "fff": "000"}
    with pytest.raises(r.RecolorError):
        r.parse_replace(["fff:red"])
