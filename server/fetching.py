"""Downloading SVGs from user-supplied links, safely.

Only public http(s) hosts are allowed (checked again after every redirect),
downloads are capped at 2 MB with a 10 s timeout, and GitHub file pages are
turned into raw links.
"""

import ipaddress
import re
import socket
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool

import recolor as engine
from server.common import decode


def github_raw(url: str) -> str:
    """Turn github.com/<owner>/<repo>/blob/<ref>/<path> into the raw file URL."""
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/blob/(.+)$", url)
    return f"https://raw.githubusercontent.com/{m[1]}/{m[2]}/{m[3]}" if m else url


def check_public_host(host: str, port: int):
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise HTTPException(400, f"Could not resolve the host '{host}'.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise HTTPException(400, "Links to private or local network addresses are not allowed.")


FETCH_HEADERS = {
    "User-Agent": "svg-recolor (+https://svg-recolor.jorgenkh.no)",
    "Accept": "image/svg+xml,*/*;q=0.8",
}


async def fetch_svg(url: str) -> tuple[str, str]:
    """Download an SVG from a public http(s) URL. Returns (svg_text, filename)."""
    url = github_raw(url.strip())
    for _ in range(4):  # initial request + up to 3 redirects, each re-validated
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise HTTPException(400, "The link must start with http:// or https://.")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        await run_in_threadpool(check_public_host, parsed.hostname, port)
        try:
            async with (
                httpx.AsyncClient(timeout=10, follow_redirects=False) as client,
                client.stream("GET", url, headers=FETCH_HEADERS) as resp,
            ):
                if resp.is_redirect and "location" in resp.headers:
                    url = str(resp.url.join(resp.headers["location"]))
                    continue
                if resp.status_code >= 400:
                    raise HTTPException(400, f"The link returned HTTP {resp.status_code}.")
                data = b""
                async for chunk in resp.aiter_bytes():
                    data += chunk
                    if len(data) > engine.MAX_SVG_BYTES:
                        raise HTTPException(413, "The linked file is larger than 2 MB.")
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Could not download the link: {e.__class__.__name__}.")
        name = Path(urlparse(url).path).name or "image.svg"
        return decode(data), name
    raise HTTPException(400, "The link redirected too many times.")
