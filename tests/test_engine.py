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
