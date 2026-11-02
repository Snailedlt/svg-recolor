"""Downloading SVGs from user-supplied links, safely.

Only public http(s) hosts are allowed. The host is checked before connecting,
and the address actually connected to is checked again, which also stops DNS
rebinding (a name that resolves to a public address for the check and a
private one for the connection). Every redirect is re-validated, downloads are
capped at 2 MB with a 10 s timeout, and GitHub file pages become raw links.
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


def is_public_ip(value: str) -> bool:
    ip = ipaddress.ip_address(value.split("%")[0])
    return ip.is_global and not ip.is_multicast


def check_public_host(host: str, port: int):
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise HTTPException(400, f"Could not resolve the host '{host}'.")
    for info in infos:
        if not is_public_ip(info[4][0]):
            raise HTTPException(400, PRIVATE_ADDRESS)


PRIVATE_ADDRESS = "Links to private or local network addresses are not allowed."


def check_connected_peer(client: httpx.AsyncClient, resp: httpx.Response) -> None:
    """Refuse the response if the connection went to a non-public address.

    Skipped when the request went through an HTTP proxy: then the peer is the
    proxy, and the DNS check above is what applies."""
    try:
        proxied = client._transport_for_url(resp.request.url) is not client._transport
    except AttributeError:  # httpx internals changed; fall back to checking the peer
        proxied = False
    stream = resp.extensions.get("network_stream")
    if proxied or stream is None:
        return
    addr = stream.get_extra_info("server_addr")
    if addr and not is_public_ip(str(addr[0])):
        raise HTTPException(400, PRIVATE_ADDRESS)


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
                check_connected_peer(client, resp)
                if resp.is_redirect and "location" in resp.headers:
                    url = str(resp.url.join(resp.headers["location"]))
                    continue
                if resp.status_code >= 400:
                    raise HTTPException(400, f"The link returned HTTP {resp.status_code}.")
                data = bytearray()
                async for chunk in resp.aiter_bytes():
                    data += chunk
                    if len(data) > engine.MAX_SVG_BYTES:
                        raise HTTPException(413, "The linked file is larger than 2 MB.")
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Could not download the link: {e.__class__.__name__}.")
        name = Path(urlparse(url).path).name or "image.svg"
        return decode(bytes(data)), name
    raise HTTPException(400, "The link redirected too many times.")
