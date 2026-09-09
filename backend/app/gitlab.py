"""The GitLab HTTP client.

Every outbound call funnels through `GL` so the concurrency limit, error
mapping, call counting and cache namespacing apply in exactly one place.
"""
import asyncio
import hashlib
from contextvars import ContextVar

import httpx
from fastapi import HTTPException

from .config import CA_BUNDLE, CONCURRENCY, log

_http: httpx.AsyncClient | None = None
_slots: asyncio.Semaphore | None = None

# A one-element list, not an int: asyncio tasks copy the context but share the
# object inside it, so fan-out calls still count towards the originating request.
_calls: ContextVar[list] = ContextVar("gitlab_calls")


async def startup() -> None:
    global _http, _slots
    _http = httpx.AsyncClient(
        timeout=30,
        follow_redirects=True,
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


def gitlab_error(r: httpx.Response, path: str) -> HTTPException:
    log.warning("gitlab %s → %s: %s", path, r.status_code, r.text[:300])
    return HTTPException(status_code=r.status_code, detail=_ERRORS.get(r.status_code, f"GitLab returned {r.status_code}"))


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

    def key(self, *parts) -> tuple:
        return (self.fp, self.url, *parts)

    def _api(self, path: str) -> str:
        return f"{self.url}/api/v4{path}"

    async def _send(self, method: str, url: str, **kw) -> httpx.Response:
        _count_call()
        assert _http is not None and _slots is not None, "gitlab.startup() was not called"
        async with _slots:
            try:
                return await _http.request(method, url, headers=self.headers, **kw)
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

    async def post(self, path: str, ok: tuple[int, ...] = (200, 201, 204)) -> httpx.Response:
        r = await self._send("POST", self._api(path))
        if r.status_code not in ok:
            raise gitlab_error(r, path)
        return r

    async def get_all(self, path: str, params: dict, max_pages: int) -> list:
        """Follow GitLab pagination instead of silently returning only page 1."""
        params = {**params, "per_page": params.get("per_page", 100), "page": 1}
        first = await self.try_get(path, params)
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
            *[self.try_get(path, {**params, "page": p}) for p in range(2, total_pages + 1)]
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
