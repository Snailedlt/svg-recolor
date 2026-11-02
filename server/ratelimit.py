"""A small in-memory rate limiter (sliding window per client IP).

Defense in depth: on serverless hosting each instance keeps its own counts, so
this bounds abuse per instance rather than globally. Put a real limit at the
edge too (for example a Vercel Firewall rule), see the README.

Limits are requests per minute, configurable with environment variables:
  RATE_LIMIT_WORK   uploads, link fetches, MCP calls (default 60)
  RATE_LIMIT_MAP    GET/POST /api/map-colors, used by the editor (default 600)
Set a limit to 0 to disable it.
"""

import os
import threading
import time
from collections import OrderedDict, deque
from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse

WINDOW_SECONDS = 60
MAX_TRACKED_CLIENTS = 20_000


def _limit(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


class RateLimiter:
    def __init__(self) -> None:
        self.limits = {"work": _limit("RATE_LIMIT_WORK", 60), "map": _limit("RATE_LIMIT_MAP", 600)}
        self._hits: OrderedDict[tuple[str, str], deque] = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def bucket(request: Request) -> Optional[str]:
        path, method = request.url.path, request.method
        if path.startswith("/api/map-colors"):
            return "map"
        if path == "/mcp" and method == "POST":
            return "work"
        if path == "/colorize" or (path.startswith("/api/") and method == "POST"):
            return "work"
        # GETs that may fetch a remote link (the CDN absorbs repeats).
        if method == "GET" and path in ("/api/recolor", "/api/fetch", "/api/palette"):
            return "work"
        return None

    @staticmethod
    def client_ip(request: Request) -> str:
        # Behind Vercel the edge sets x-real-ip / x-forwarded-for.
        forwarded = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[0]
        return forwarded.strip() or (request.client.host if request.client else "unknown")

    def check(self, bucket: str, client: str) -> Optional[float]:
        """Record a hit. Returns seconds to wait if over the limit, else None."""
        limit = self.limits.get(bucket, 0)
        if not limit:
            return None
        now = time.monotonic()
        key = (bucket, client)
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                hits = self._hits[key] = deque()
                while len(self._hits) > MAX_TRACKED_CLIENTS:
                    self._hits.popitem(last=False)
            else:
                self._hits.move_to_end(key)
            while hits and now - hits[0] >= WINDOW_SECONDS:
                hits.popleft()
            if len(hits) >= limit:
                return WINDOW_SECONDS - (now - hits[0])
            hits.append(now)
        return None

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()


async def rate_limit_middleware(request: Request, call_next):
    bucket = limiter.bucket(request)
    if bucket:
        wait = limiter.check(bucket, limiter.client_ip(request))
        if wait is not None:
            return JSONResponse(
                {"detail": f"Too many requests. Try again in {int(wait) + 1} seconds."},
                status_code=429,
                headers={"Retry-After": str(int(wait) + 1), "Access-Control-Allow-Origin": "*"},
            )
    return await call_next(request)
