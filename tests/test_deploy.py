"""Guards for the Vercel deployment."""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_vercel_installs_the_locked_dependencies():
    # Vercel's Python builder reads pyproject.toml before Pipfile.lock. One without
    # [project] dependencies deploys with nothing installed and every request fails.
    pyproject = ROOT / "pyproject.toml"
    if pyproject.exists():
        assert "dependencies" in pyproject.read_text(), "pyproject.toml would hide Pipfile.lock from Vercel"
    lock = json.loads((ROOT / "Pipfile.lock").read_text())
    assert {"fastapi", "httpx", "sentry-sdk", "python-multipart"} <= set(lock["default"])


def test_svgshift_binary_is_executable_and_static():
    exe = ROOT / "svgshift-linux.exe"
    assert os.access(exe, os.X_OK)
    # A dynamically linked binary needs the host's glibc (Vercel's may be older than the
    # build machine's); it has a PT_INTERP program header pointing at ld-linux.
    data = exe.read_bytes()
    assert data[:5] == b"\x7fELF\x02"  # 64-bit ELF
    phoff = int.from_bytes(data[0x20:0x28], "little")
    phentsize = int.from_bytes(data[0x36:0x38], "little")
    phnum = int.from_bytes(data[0x38:0x3A], "little")
    types = [int.from_bytes(data[phoff + i * phentsize:][:4], "little") for i in range(phnum)]
    assert 3 not in types, "svgshift-linux.exe is dynamically linked; build it with scripts/build-svgshift.sh"


def _vercel():
    return json.loads((ROOT / "vercel.json").read_text())


def test_vercel_config_lives_in_the_repo():
    # The FastAPI preset (not the legacy "builds"), so Vercel finds `app` in main.py itself
    # and serves /static from the CDN; the codebase, not the dashboard, decides.
    cfg = _vercel()
    assert cfg["framework"] == "fastapi"
    assert "builds" not in cfg and "routes" not in cfg, "legacy keys make Vercel ignore the project settings"
    assert "\napp = FastAPI(" in (ROOT / "main.py").read_text()


def test_cdn_static_headers_match_the_app():
    # The CDN serves /static without the app, so vercel.json must send the same headers
    # the app's middleware would (see cache_headers in main.py).
    from server.common import CACHE_IMMUTABLE, CACHE_STATIC

    rules = {("v" in str(r.get("has", ""))): {h["key"]: h["value"] for h in r["headers"]}
             for r in _vercel()["headers"] if r["source"] == "/static/(.*)"}
    assert rules[True]["Cache-Control"] == CACHE_IMMUTABLE  # content-hashed ?v= URLs
    assert rules[False]["Cache-Control"] == CACHE_STATIC
    assert all(r["X-Content-Type-Options"] == "nosniff" for r in rules.values())


def test_vercelignore_keeps_what_the_app_needs():
    ignored = {line.strip() for line in (ROOT / ".vercelignore").read_text().splitlines()
               if line.strip() and not line.startswith("#")}
    needed = {"main.py", "main.html", "recolor.py", "server", "static", "svgshift-linux.exe",
              "submodules", "submodules/svgray", "submodules/svgshift", "Pipfile", "Pipfile.lock"}
    assert not ignored & needed
