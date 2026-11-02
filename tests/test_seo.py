"""Search and link-preview metadata: present, consistent, and pointing at real files."""

import json
import re
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://svg-recolor.jorgenkh.no"


def meta(html: str, attr: str, name: str) -> str:
    m = re.search(rf'<meta {attr}="{re.escape(name)}" content="([^"]*)"', html)
    assert m, f"missing <meta {attr}={name}>"
    return m.group(1)


def test_title_description_and_canonical(client):
    html = client.get("/").text
    title = re.search(r"<title>([^<]+)</title>", html).group(1)
    assert 30 <= len(title) <= 60, title  # what search results show without cutting off
    assert 70 <= len(meta(html, "name", "description")) <= 160
    assert f'<link rel="canonical" href="{SITE}/">' in html
    assert "index, follow" in meta(html, "name", "robots")


def test_link_previews_point_at_a_real_1200x630_image(client):
    html = client.get("/").text
    image = meta(html, "property", "og:image")
    assert image == meta(html, "name", "twitter:image")
    assert image.startswith(SITE + "/static/")
    png = (ROOT / image.removeprefix(SITE + "/")).read_bytes()
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", png[16:24])
    assert (width, height) == (1200, 630)
    assert (meta(html, "property", "og:image:width"), meta(html, "property", "og:image:height")) == ("1200", "630")
    assert meta(html, "property", "og:image:alt") and meta(html, "name", "twitter:card") == "summary_large_image"
    assert client.get(image.removeprefix(SITE)).status_code == 200


def test_structured_data_is_valid_json(client):
    html = client.get("/").text
    block = re.search(r'<script type="application/ld\+json">([\s\S]*?)</script>', html).group(1)
    data = json.loads(block)
    assert data["@type"] == "WebApplication" and data["url"] == SITE + "/"
    assert data["offers"]["price"] == "0"


def test_every_icon_and_manifest_entry_exists(client):
    html = client.get("/").text
    for href in re.findall(r'<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"?]+)', html):
        assert client.get(href).status_code == 200, href
    manifest = json.loads((ROOT / "static/favicon/site.webmanifest").read_text())
    for icon in manifest["icons"]:
        assert client.get(icon["src"]).status_code == 200, icon["src"]
    assert client.get("/favicon.ico").status_code == 200


def test_robots_points_to_the_sitemap(client):
    robots = client.get("/robots.txt", headers={"host": "svg-recolor.jorgenkh.no", "x-forwarded-proto": "https"}).text
    assert f"Sitemap: {SITE}/sitemap.xml" in robots
    assert "Disallow: /api" in robots
    res = client.get("/sitemap.xml", headers={"host": "svg-recolor.jorgenkh.no", "x-forwarded-proto": "https"})
    assert res.headers["content-type"].startswith("application/xml")
    assert f"<loc>{SITE}/</loc>" in res.text


def test_rainbow_snail_previews_every_style(client):
    html = client.get("/").text
    assert "data:image/webp;base64," in html  # header logo (the original) inlined
    config = json.loads(re.search(r"window\.SVG_RECOLOR = (\{.*?\});</script>", html).group(1).replace("<\\/", "</"))
    # The thumbnails' sample is the rainbow snail: a cacheable URL, not text in every page...
    assert config["sampleUrl"].startswith("/static/examples/rainbow-snail.svg?v=")
    assert "sample" not in config
    # ...with its colors already recolored in all six styles, so first load needs no API call.
    assert len(config["seed"]) == 6
    import recolor as r

    snail = (ROOT / "static/examples/rainbow-snail.svg").read_text()
    colors = set(r.extract_palette(r.normalize_svg(snail)))
    assert all(set(m) == colors for m in config["seed"].values())
    res = client.get(config["sampleUrl"])
    assert res.status_code == 200 and "immutable" in res.headers["cache-control"]


def test_rainbow_snail_is_optimized(client):
    res = client.get("/static/examples/rainbow-snail.svg")
    assert res.status_code == 200
    assert res.text.startswith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">')
    assert len(res.content) < 80_000  # optimized: one path per color
    import recolor as r

    assert 8 <= len(r.extract_palette(r.normalize_svg(res.text))) <= 30  # enough colors to show every style
