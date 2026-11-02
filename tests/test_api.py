"""HTTP API: inputs, outputs, errors, caching and security headers."""

import io
import zipfile

import pytest

import recolor as r
from tests.conftest import fixture_svg

SVG_CT = {"content-type": "image/svg+xml"}


def test_recolor_multipart_upload(client, python_svg):
    res = client.post("/api/recolor?color=ff0066&mode=colorize", files={"file": ("py.svg", python_svg, "image/svg+xml")})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("image/svg+xml")
    assert 'filename="py_recolored_colorize_ff0066.svg"' in res.headers["content-disposition"]


def test_recolor_raw_body_matches_engine(client, python_svg):
    res = client.post("/api/recolor?color=tomato&mode=solid", content=python_svg, headers=SVG_CT)
    assert res.text == r.recolor(python_svg, r.Options(mode="solid", color="tomato")).svg


def test_recolor_json_body_with_mapping(client, python_svg):
    res = client.post("/api/recolor?format=json", json={"svg": python_svg, "mode": "solid", "color": "red"})
    data = res.json()
    assert data["mode"] == "solid" and data["color"] == "#ff0000"
    assert {p["to"] for p in data["palette"]} == {"#ff0000"}


def test_recolor_form_field_svg(client, python_svg):
    res = client.post("/api/recolor", data={"svg": python_svg, "mode": "grayscale"})
    assert res.status_code == 200


def test_legacy_colorize_endpoint(client, python_svg):
    res = client.post("/colorize?color=%23FF0066", files={"icon": ("py.svg", python_svg, "image/svg+xml")})
    assert res.status_code == 200
    assert res.headers["content-disposition"].startswith("attachment")


@pytest.mark.parametrize(
    ("kwargs", "status"),
    [
        ({"content": b"hello", "headers": SVG_CT}, 415),
        ({"content": b"<svg>" + b" " * (2 * 1024 * 1024 + 1), "headers": SVG_CT}, 413),
        ({"json": {"nope": 1}}, 400),
        ({"content": b"", "headers": SVG_CT}, 400),
    ],
)
def test_recolor_input_errors(client, kwargs, status):
    res = client.post("/api/recolor", **kwargs)
    assert res.status_code == status
    assert isinstance(res.json()["detail"], str)


def test_recolor_bad_options(client, python_svg):
    assert client.post("/api/recolor?color=zzz", content=python_svg, headers=SVG_CT).status_code == 400
    assert client.post("/api/recolor?mode=nope", content=python_svg, headers=SVG_CT).status_code == 422
    assert client.post("/api/recolor?hue=999", content=python_svg, headers=SVG_CT).status_code == 422


def test_svg_responses_are_sandboxed(client, python_svg):
    res = client.post("/api/recolor", content=python_svg, headers=SVG_CT)
    assert "sandbox" in res.headers["content-security-policy"]
    assert res.headers["x-content-type-options"] == "nosniff"


def test_batch_returns_zip_with_unique_names(client, python_svg):
    files = [("files", ("a.svg", python_svg, "image/svg+xml")), ("files", ("a.svg", python_svg, "image/svg+xml"))]
    res = client.post("/api/recolor/batch?mode=grayscale", files=files)
    names = zipfile.ZipFile(io.BytesIO(res.content)).namelist()
    assert names == ["a_recolored_grayscale.svg", "a_recolored_grayscale_2.svg"]


def test_map_colors_get_is_cacheable_with_engine_version(client):
    params = {"colors": "5a9fd4,#306998", "mode": "solid", "color": "red", "v": r.ENGINE_VERSION}
    res = client.get("/api/map-colors", params=params)
    assert res.json()["mapping"] == {"#5a9fd4": "#ff0000", "#306998": "#ff0000"}
    assert "immutable" in res.headers["cache-control"]
    params.pop("v")
    assert "cache-control" not in client.get("/api/map-colors", params=params).headers


def test_map_colors_post_and_errors(client):
    res = client.post("/api/map-colors", json={"colors": ["#5a9fd4"], "mode": "grayscale"})
    assert res.json()["mapping"]["#5a9fd4"] == "#909090"
    assert client.get("/api/map-colors", params={"colors": "zzz"}).status_code == 400


def test_palette_endpoint(client, python_svg):
    colors = client.post("/api/palette", content=python_svg, headers=SVG_CT).json()["colors"]
    assert {"color": "#5a9fd4", "count": 1} in colors


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/x.svg",
        "http://localhost/x.svg",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/x.svg",
        "http://10.0.0.1/x.svg",
        "file:///etc/passwd",
        "ftp://example.com/x.svg",
    ],
)
def test_links_to_private_hosts_are_refused(client, url):
    res = client.get("/api/recolor", params={"url": url})
    assert res.status_code == 400


def test_recolor_from_url(client, python_svg, monkeypatch):
    import main

    async def fake_fetch(url):
        assert url == "https://example.com/icons/py.svg"
        return python_svg, "py.svg"

    monkeypatch.setattr(main, "fetch_svg", fake_fetch)
    res = client.get("/api/recolor", params={"url": "https://example.com/icons/py.svg", "mode": "solid", "color": "red"})
    assert res.status_code == 200
    assert "s-maxage" in res.headers["cache-control"]


def test_github_blob_links_become_raw():
    from server.fetching import github_raw

    assert github_raw("https://github.com/a/b/blob/main/x.svg") == "https://raw.githubusercontent.com/a/b/main/x.svg"
    assert github_raw("https://example.com/x.svg") == "https://example.com/x.svg"


def test_landing_page_has_hashed_assets_and_cache_headers(client):
    res = client.get("/")
    assert "__HASH__" not in res.text and "__ENGINE_VERSION__" not in res.text
    assert "s-maxage" in res.headers["cache-control"]
    assert "s-maxage" in client.get("/static/app.js").headers["cache-control"]


def test_discovery_endpoints(client):
    assert client.get("/api/modes").json()["default"] == r.DEFAULT_MODE
    assert any(e["path"] == "/api/map-colors" for e in client.get("/api").json()["endpoints"])
    assert "/mcp" in client.get("/llms.txt").text
    ops = {op.get("operationId") for p in client.get("/openapi.json").json()["paths"].values() for op in p.values()}
    assert {"recolorSvg", "recolorFromUrl", "mapColors", "listModes"} <= ops


def test_absolute_urls_honor_proxy_headers(client):
    res = client.get("/llms.txt", headers={"x-forwarded-proto": "https", "x-forwarded-host": "svg-recolor.jorgenkh.no"})
    assert "Base URL: https://svg-recolor.jorgenkh.no" in res.text


def test_every_fixture_recolors(client):
    for name in ("python.svg", "github.svg", "firefox.svg", "edge-cases.svg"):
        res = client.post("/api/recolor?mode=colorize&color=teal", content=fixture_svg(name), headers=SVG_CT)
        assert res.status_code == 200, name
