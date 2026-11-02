"""Answer HEAD for every GET route.

FastAPI routes only answer the methods they declare, so HEAD on a GET page gave
405. Crawlers, link checkers and uptime monitors often use HEAD, so this runs
the request as GET and sends the same status and headers without the body
(HTTP's definition of HEAD). Static files already handled HEAD themselves.
"""


class HeadAsGetMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "HEAD":
            return await self.app(scope, receive, send)

        async def send_headers_only(message):
            if message["type"] == "http.response.body":
                if not message.get("more_body", False):
                    await send({"type": "http.response.body", "body": b"", "more_body": False})
                return
            await send(message)

        await self.app(dict(scope, method="GET"), receive, send_headers_only)
