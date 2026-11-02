"""Rate limiting: per-IP sliding window, separate budgets, 429 with Retry-After."""

import pytest

from server.ratelimit import limiter


@pytest.fixture
def low_limits(monkeypatch):
    monkeypatch.setitem(limiter.limits, "work", 3)
    monkeypatch.setitem(limiter.limits, "map", 5)


def test_uploads_are_limited_per_ip(client, python_svg, low_limits):
    headers = {"content-type": "image/svg+xml", "x-real-ip": "203.0.113.7"}
    codes = [client.post("/api/recolor", content=python_svg, headers=headers).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    blocked = client.post("/api/recolor", content=python_svg, headers=headers)
    assert int(blocked.headers["retry-after"]) > 0 and "Too many requests" in blocked.json()["detail"]
    # Another client is unaffected.
    other = client.post("/api/recolor", content=python_svg, headers={**headers, "x-real-ip": "203.0.113.8"})
    assert other.status_code == 200


def test_map_colors_has_its_own_budget(client, python_svg, low_limits):
    ip = {"x-real-ip": "198.51.100.1"}
    for _ in range(3):
        client.post("/api/recolor", content=python_svg, headers={"content-type": "image/svg+xml", **ip})
    res = client.get("/api/map-colors", params={"colors": "5a9fd4", "mode": "grayscale"}, headers=ip)
    assert res.status_code == 200


def test_pages_and_docs_are_never_limited(client, low_limits):
    for _ in range(10):
        assert client.get("/llms.txt", headers={"x-real-ip": "192.0.2.1"}).status_code == 200


def test_mcp_is_limited(client, low_limits):
    msg = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    codes = [client.post("/mcp", json=msg, headers={"x-real-ip": "192.0.2.9"}).status_code for _ in range(4)]
    assert codes[-1] == 429


def test_zero_disables(client, python_svg, monkeypatch):
    monkeypatch.setitem(limiter.limits, "work", 0)
    for _ in range(80):
        assert client.post("/api/palette", content=python_svg, headers={"content-type": "image/svg+xml"}).status_code == 200
