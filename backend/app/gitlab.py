"""The GitLab HTTP client.

Every outbound call funnels through `GL` so the concurrency limit, error
mapping, call counting and cache namespacing apply in exactly one place.
"""
import asyncio
import hashlib
from contextvars import ContextVar
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

from .config import CA_BUNDLE, CONCURRENCY, log

_http: httpx.AsyncClient | None = None
_slots: asyncio.Semaphore | None = None

# A one-element list, not an int: asyncio tasks copy the context but share the
# object inside it, so fan-out calls still count towards the originating request.
_calls: ContextVar[list] = ContextVar("gitlab_calls")


_DEFAULT_PORTS = {"http": 80, "https": 443}


def origin_of(url: str) -> tuple[str, str, int] | None:
    """(scheme, host, port), or None if the URL is not one we would ever call."""
    parts = urlsplit(url)
    if parts.scheme not in _DEFAULT_PORTS or not parts.hostname:
        return None
    try:
        port = parts.port
    except ValueError:
        return None  # malformed port, e.g. "gitlab.example.com:443.attacker.tld"
    return (parts.scheme, parts.hostname.lower(), port or _DEFAULT_PORTS[parts.scheme])


async def _keep_token_home(request: httpx.Request) -> None:
    """Drop the token when a redirect leaves its GitLab, say for the object storage that serves avatars.

    httpx only does this for Authorization, and PRIVATE-TOKEN would otherwise go along to any host.
    The one move allowed is the upgrade of the same address from http to https.
    """
    home = request.extensions.get("token_home")
    if home is None:
        return
    target = origin_of(str(request.url))
    upgrade = home[0] == "http" and home[2] == 80 and target == ("https", home[1], 443)
    if target != home and not upgrade:
        request.headers.pop("PRIVATE-TOKEN", None)


async def startup() -> None:
    global _http, _slots
    _http = httpx.AsyncClient(
        timeout=30,
        follow_redirects=True,
        event_hooks={"request": [_keep_token_home]},
        verify=CA_BUNDLE or True,
        limits=httpx.Limits(max_connections=CONCURRENCY * 2, max_keepalive_connections=CONCURRENCY),
    )
    _slots = asyncio.Semaphore(CONCURRENCY)


async def shutdown() -> None:
    if _http is not None:
        await _http.aclose()


def start_call_counter() -> list:
    """Begin counting GitLab calls for the current request; returns the counter."""
    counter = [0]
    _calls.set(counter)
    return counter


def _count_call() -> None:
    try:
        _calls.get()[0] += 1
    except LookupError:
        pass


_ERRORS = {
    401: "GitLab rejected the token",
    403: "Access denied by GitLab",
    404: "Not found in GitLab",
    429: "GitLab rate limit reached — try again shortly",
}


def error_reason(r: httpx.Response) -> str | None:
    """The server's own short explanation, if it gave one; never a raw HTML page."""
    try:
        body = r.json()
    except ValueError:
        return None
    if isinstance(body, dict):
        reason = body.get("message") or body.get("error") or body.get("errorMessages")
        if reason:
            return str(reason[0] if isinstance(reason, list) else reason)[:300]
    return None


def gitlab_error(r: httpx.Response, path: str) -> HTTPException:
    log.warning("gitlab %s → %s: %s", path, r.status_code, r.text[:300])
    reason, known = error_reason(r), _ERRORS.get(r.status_code)
    # "403 Forbidden" says nothing new, but "this tag is protected" is the actual answer.
    if known and reason and not reason.startswith(str(r.status_code)):
        return HTTPException(status_code=r.status_code, detail=f"{known}: {reason}")
    return HTTPException(status_code=r.status_code, detail=known or reason or f"GitLab returned {r.status_code}")


async def gather_settled(coros: list) -> list:
    """Run calls concurrently so one failure can't sink the rest; failed items come back as the exception.

    A 401 means the token is dead, so every other result is moot and it propagates.
    """
    results = await asyncio.gather(*coros, return_exceptions=True)
    for res in results:
        if isinstance(res, HTTPException) and res.status_code == 401:
            raise res
        if isinstance(res, BaseException) and not isinstance(res, Exception):
            raise res
    return results


def why(exc: Exception) -> str:
    return exc.detail if isinstance(exc, HTTPException) else repr(exc)


def http() -> httpx.AsyncClient:
    """The shared client, for the other services that sit behind the same certificates (Jira)."""
    assert _http is not None, "gitlab.startup() was not called"
    return _http


def fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:16]


class GL:
    """Per-request GitLab context."""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token
        self.headers = {"PRIVATE-TOKEN": token}
        # Caches are namespaced per token: two people sharing one backend must
        # never read each other's projects out of the cache.
        self.fp = fingerprint(token)
        self.origin = origin_of(self.url)

    def key(self, *parts) -> tuple:
        return (self.fp, self.url, *parts)

    def _api(self, path: str) -> str:
        return f"{self.url}/api/v4{path}"

    async def _send(self, method: str, url: str, **kw) -> httpx.Response:
        _count_call()
        assert _http is not None and _slots is not None, "gitlab.startup() was not called"
        async with _slots:
            try:
                return await _http.request(method, url, headers=self.headers, extensions={"token_home": self.origin}, **kw)
            except httpx.TimeoutException:
                raise HTTPException(status_code=504, detail="GitLab API timeout")
            except httpx.RequestError as e:
                log.warning("gitlab %s %s failed: %s", method, url, e)
                raise HTTPException(status_code=502, detail="GitLab is unreachable")

    async def get(self, path: str, params: dict | None = None) -> httpx.Response:
        r = await self._send("GET", self._api(path), params=params)
        if r.status_code >= 400:
            raise gitlab_error(r, path)
        return r

    async def try_get(self, path: str, params: dict | None = None) -> httpx.Response | None:
        """GET that degrades to None — for per-MR extras where one failing
        project must not take down the whole dashboard."""
        try:
            r = await self._send("GET", self._api(path), params=params)
        except HTTPException as e:
            log.debug("gitlab %s unavailable: %s", path, e.detail)
            return None
        if r.status_code >= 400:
            log.debug("gitlab %s → %s", path, r.status_code)
            return None
        return r

    async def fetch_url(self, url: str) -> httpx.Response:
        """GET an absolute GitLab URL (avatars and other non-/api/v4 assets)."""
        return await self._send("GET", url)

    async def post(self, path: str, params: dict | None = None, ok: tuple[int, ...] = (200, 201, 204)) -> httpx.Response:
        r = await self._send("POST", self._api(path), params=params)
        if r.status_code not in ok:
            raise gitlab_error(r, path)
        return r

    async def put(self, path: str, params: dict | None = None) -> httpx.Response:
        r = await self._send("PUT", self._api(path), params=params)
        if r.status_code >= 400:
            raise gitlab_error(r, path)
        return r

    async def get_all(self, path: str, params: dict, max_pages: int, strict: bool = False) -> list:
        """Follow GitLab pagination instead of silently returning only page 1.

        A failed page is skipped unless `strict`, which raises: use it where a
        list that came back short would be taken for the whole truth.
        """
        read = self.get if strict else self.try_get
        params = {**params, "per_page": params.get("per_page", 100), "page": 1}
        first = await read(path, params)
        if first is None:
            return []
        items = first.json()
        if not isinstance(items, list):
            return []
        try:
            total_pages = int(first.headers.get("X-Total-Pages") or 1)
        except ValueError:
            total_pages = 1
        if total_pages > max_pages:
            log.info("%s has %s pages, capped at %s", path, total_pages, max_pages)
            total_pages = max_pages
        if total_pages <= 1:
            return items
        rest = await asyncio.gather(
            *[read(path, {**params, "page": p}) for p in range(2, total_pages + 1)]
        )
        for r in rest:
            if r is None:
                continue
            chunk = r.json()
            if isinstance(chunk, list):
                items.extend(chunk)
        return items


async def fetch_public(url: str) -> httpx.Response:
    """Fetch a public URL with no credentials attached."""
    assert _http is not None and _slots is not None, "gitlab.startup() was not called"
    _count_call()
    async with _slots:
        return await _http.get(url)
