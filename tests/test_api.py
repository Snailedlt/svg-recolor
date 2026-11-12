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


def test_connection_to_private_address_is_refused_even_if_dns_check_passes(monkeypatch):
    """DNS rebinding: the name passes the pre-check but the connection lands on a
    private address. The peer check on the open connection must still refuse it."""
    import asyncio
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from fastapi import HTTPException

    from server import fetching

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(fetching, "check_public_host", lambda host, port: None)  # "rebinding" passes the pre-check
    for var in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    try:
        with pytest.raises(HTTPException) as err:
            asyncio.run(fetching.fetch_svg(f"http://127.0.0.1:{server.server_port}/x.svg"))
        assert err.value.status_code == 400 and "private" in err.value.detail
    finally:
        server.shutdown()


def test_public_fetch_path_still_works(monkeypatch):
    """With the peer check stubbed to 'public', a local server is fetched normally,
    proving the check is what refuses the request above."""
    import asyncio
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from server import fetching

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(fetching, "check_public_host", lambda host, port: None)
    monkeypatch.setattr(fetching, "is_public_ip", lambda value: True)
    for var in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    try:
        svg, name = asyncio.run(fetching.fetch_svg(f"http://127.0.0.1:{server.server_port}/icons/x.svg"))
        assert name == "x.svg" and "<rect" in svg
    finally:
        server.shutdown()


def test_page_has_strict_security_headers(client):
    import base64
    import hashlib
    import re

    res = client.get("/")
    csp = res.headers["content-security-policy"]
    assert "script-src 'self' 'sha256-" in csp and "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]
    assert "frame-ancestors 'none'" in csp and res.headers["x-frame-options"] == "DENY"
    for body in re.findall(r"<script>([\s\S]*?)</script>", res.text):  # every inline script is allowed by hash
        digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
        assert f"'sha256-{digest}'" in csp


def test_full_batch_of_50(client, python_svg):
    files = [("files", (f"icon{i}.svg", python_svg, "image/svg+xml")) for i in range(50)]
    res = client.post("/api/recolor/batch?mode=solid&color=red", files=files)
    assert res.status_code == 200 and len(zipfile.ZipFile(io.BytesIO(res.content)).namelist()) == 50
    too_many = files + [("files", ("x.svg", python_svg, "image/svg+xml"))]
    assert client.post("/api/recolor/batch", files=too_many).status_code == 400


def test_map_colors_limits(client):
    colors = [f"#{i:06x}" for i in range(r.MAX_PALETTE)]
    assert client.post("/api/map-colors", json={"colors": colors, "mode": "grayscale"}).status_code == 200
    assert client.post("/api/map-colors", json={"colors": colors + ["#ffffff"], "mode": "grayscale"}).status_code == 400


def test_map_colors_many_modes_in_one_call(client):
    res = client.get("/api/map-colors", params={"colors": "5a9fd4,306998", "modes": "tint,solid,grayscale", "color": "red", "v": r.ENGINE_VERSION})
    data = res.json()
    assert set(data["mappings"]) == {"tint", "solid", "grayscale"} and "mapping" not in data
    assert data["mappings"]["solid"] == {"#5a9fd4": "#ff0000", "#306998": "#ff0000"}
    single = client.get("/api/map-colors", params={"colors": "5a9fd4,306998", "mode": "tint", "color": "red"}).json()["mapping"]
    assert single == data["mappings"]["tint"]
    assert client.get("/api/map-colors", params={"colors": "5a9fd4", "modes": "tint,nope"}).status_code == 400
    posted = client.post("/api/map-colors", json={"colors": ["#5a9fd4"], "modes": ["hue", "solid"], "color": "teal"}).json()
    assert set(posted["mappings"]) == {"hue", "solid"}


def test_page_needs_few_requests(client):
    import re

    html = client.get("/").text
    scripts = re.findall(r'<script src="([^"]+)"', html)
    assert len(scripts) == 1 and scripts[0].startswith("/assets/app.js?v=")  # one bundle
    assert 'src="/static/logo-56.webp"' not in html and "data:image/webp;base64," in html  # small images inlined
    config = re.search(r"window\.SVG_RECOLOR = (\{.*?\});</script>", html).group(1)
    assert '"seed"' in config and "color=ff0066&mode=colorize" in config  # thumbnails need no API call on load
    bundle = client.get(scripts[0])
    assert "SvgEngine" in bundle.text and "immutable" in bundle.headers["cache-control"]


def test_root_files_browsers_ask_for_are_cached(client):
    for path in ("/favicon.ico", "/apple-touch-icon.png", "/robots.txt"):
        res = client.get(path)
        assert res.status_code == 200 and "s-maxage" in res.headers["cache-control"], path
    assert "Disallow: /api" in client.get("/robots.txt").text
    assert "immutable" in client.get("/static/app.css?v=abc").headers["cache-control"]
    assert "immutable" not in client.get("/static/app.css").headers["cache-control"]


def test_landing_page_loads_even_if_the_tools_fail(client, monkeypatch):
    import main

    def broken(*args, **kwargs):
        raise RuntimeError("svgshift exited with 127")

    monkeypatch.setattr(main, "_landing_cache", None)
    monkeypatch.setattr(r, "map_colors", broken)
    res = client.get("/")
    assert res.status_code == 200
    assert '"seed":{}' in res.text  # the browser fetches the thumbnails itself


def test_health_reports_working_tools(client):
    res = client.get("/api/health")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] and body["svgray"]["result"] and body["svgshift"]["result"] == "ff0000"
    assert res.headers["cache-control"] == "no-store"


def test_health_reports_broken_tools(client, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("svgshift exited with 127")

    monkeypatch.setattr(r, "svgshift", broken)
    res = client.get("/api/health")
    assert res.status_code == 503
    assert res.json()["svgshift"]["error"] == "RuntimeError: svgshift exited with 127"


@pytest.mark.parametrize("path", ["/", "/robots.txt", "/sitemap.xml", "/llms.txt", "/api/modes", "/api/health", "/favicon.ico", "/static/app.css"])
def test_head_answers_like_get_without_a_body(client, path):
    get, head = client.get(path), client.head(path)
    assert get.status_code == 200 and head.status_code == 200, (path, head.status_code)
    assert head.content == b""
    assert head.headers["content-type"] == get.headers["content-type"]
    assert head.headers.get("cache-control") == get.headers.get("cache-control")


def test_head_on_a_missing_page_is_still_404(client):
    assert client.head("/nope").status_code == 404
    assert client.head("/nope").content == b""


def test_post_only_routes_still_reject_head(client):
    # /api/recolor/batch only takes POST: HEAD runs as GET there, which isn't allowed either.
    assert client.head("/api/recolor/batch").status_code == 405


def test_web_analytics_is_on_the_page_and_allowed_by_the_csp(client):
    import base64
    import hashlib
    import re

    res = client.get("/")
    assert '<script defer src="/_vercel/insights/script.js"></script>' in res.text
    csp = res.headers["content-security-policy"]
    inline = re.findall(r"<script>([\s\S]*?)</script>", res.text)
    assert any("window.va=" in body for body in inline), "the queue stub runs before the script loads"
    for body in inline:  # every inline script, the analytics stub included, is allowed by its hash
        digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
        assert f"'sha256-{digest}'" in csp
    # The script and its beacons are same-origin (/_vercel/insights/...), so 'self' covers both.
    assert "script-src 'self'" in csp and "connect-src 'self'" in csp


EDIT_SVG = ('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff" width="9" height="9"/>'
            '<path fill="#5e97f6" d="M0 0h4v4z"/><path fill="#e879f9" d="M5 5h4v4z"/></svg>')


def test_color_edits_in_the_query_string(client):
    res = client.post("/api/recolor?mode=solid&color=000000&remove=ffffff&replace=e879f9:red", content=EDIT_SVG, headers=SVG_CT)
    assert res.status_code == 200
    assert "<rect" not in res.text and 'fill="#ff0000"' in res.text and 'fill="#000000" d="M0 0h4v4z"' in res.text


def test_color_edits_in_json_with_palette(client):
    res = client.post("/api/recolor", json={"svg": EDIT_SVG, "mode": "adjust", "hide": ["#fff"],
                                            "replace": {"5e97f6": "teal"}, "remove": "e879f9", "format": "json"})
    palette = {p["from"]: p["to"] for p in res.json()["palette"]}
    assert palette == {"#000000": "#000000", "#ffffff": "none", "#5e97f6": "#008080", "#e879f9": "removed"}


def test_color_edits_in_a_form(client):
    res = client.post("/api/recolor", data={"svg": EDIT_SVG, "mode": "solid", "color": "black", "remove": "white"})
    assert res.status_code == 200 and "<rect" not in res.text


@pytest.mark.parametrize("query", ["hide=fff&remove=white", "replace=oops", "remove=notacolor"])
def test_bad_color_edits_are_400(client, query):
    res = client.post("/api/recolor?" + query, content=EDIT_SVG, headers=SVG_CT)
    assert res.status_code == 400 and res.json()["detail"]


def test_cut_is_editor_only_with_a_clear_error(client):
    res = client.post("/api/recolor?cut=ffffff", content=EDIT_SVG, headers=SVG_CT)
    assert res.status_code == 400 and "only available in the editor" in res.json()["detail"]
    res = client.post("/api/recolor", json={"svg": EDIT_SVG, "cut": ["ffffff"]})
    assert res.status_code == 400
    res = client.post("/api/recolor?gap=2", content=EDIT_SVG, headers=SVG_CT)
    assert res.status_code == 400 and "gap" in res.json()["detail"]
    assert client.post("/api/recolor?gap=0", content=EDIT_SVG, headers=SVG_CT).status_code == 200
    res = client.post("/api/recolor", json={"svg": EDIT_SVG, "line": 2})
    assert res.status_code == 400 and "line" in res.json()["detail"]


def test_geometry_bundle_is_served_hashed_and_cached(client):
    import re

    url = re.search(r'"geometryUrl":"([^"]+)"', client.get("/").text).group(1)
    assert url.startswith("/assets/geometry.js?v=")
    res = client.get(url)
    assert res.status_code == 200 and "immutable" in res.headers["cache-control"]
    assert "SvgGeometry" in res.text and "Paper.js" in res.text and "PaperOffset" in res.text
