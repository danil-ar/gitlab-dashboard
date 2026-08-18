import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import datetime
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from fastapi import Cookie, Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

load_dotenv()

_LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(level=_LOG_LEVEL, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("dashboard")


class _DropHealthChecks(logging.Filter):
    """The container healthcheck hits /api/health every 10s; that is six access
    log lines a minute saying nothing."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/api/health" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_DropHealthChecks())

# httpx logs one line per outbound call at INFO. With a dashboard that fans out
# across every project that buries our own logs, so it only speaks up on DEBUG.
for _noisy in ("httpx", "httpcore"):
    logging.getLogger(_noisy).setLevel(logging.DEBUG if _LOG_LEVEL == "DEBUG" else logging.WARNING)

_DEFAULT_URL   = os.environ.get("GITLAB_URL", "").rstrip("/")
_DEFAULT_GROUP = os.environ.get("GITLAB_DEFAULT_GROUP", "").strip()

_COOKIE = "gl_session"
_COOKIE_MAX_AGE = 60 * 60 * 24 * 365  # 1 year
_SECURE_COOKIE = os.environ.get("SECURE_COOKIE", "").lower() in ("1", "true", "yes")

_raw_key = os.environ.get("SECRET_KEY", "")
if _raw_key:
    _fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(_raw_key.encode()).digest()))
elif _SECURE_COOKIE:
    raise RuntimeError("SECRET_KEY is required when SECURE_COOKIE is enabled")
else:
    _fernet = Fernet(Fernet.generate_key())
    log.warning("SECRET_KEY not set — sessions will reset on every server restart")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        log.warning("%s is not a number, falling back to %s", name, default)
        return default


_CACHE_TTL         = _env_int("CACHE_TTL", 60)          # short-lived GitLab reads
_APPROVAL_TTL      = _env_int("APPROVAL_TTL", 900)      # keyed by mr.updated_at, safe to keep longer
_CACHE_MAXSIZE     = _env_int("CACHE_MAXSIZE", 4096)
_CONCURRENCY       = _env_int("GITLAB_CONCURRENCY", 10)
_MAX_PROJECT_PAGES = _env_int("MAX_PROJECT_PAGES", 10)  # /projects, 100 per page
_MAX_MR_PAGES      = _env_int("MAX_MR_PAGES", 5)        # per merge-request query
_MAX_NOTE_PAGES    = _env_int("MAX_NOTE_PAGES", 20)     # approval-note scan

_http: httpx.AsyncClient
_gitlab_slots: asyncio.Semaphore


# ─── cache ────────────────────────────────────────────────────────────────────

_MISS = object()


class TTLCache:
    """Bounded LRU cache with per-entry expiry.

    `None` is a cacheable value: misses come back as the `_MISS` sentinel so an
    MR without a pipeline is not re-fetched on every single refresh.
    """

    __slots__ = ("_ttl", "_maxsize", "_data")

    def __init__(self, ttl: int, maxsize: int = _CACHE_MAXSIZE):
        self._ttl = ttl
        self._maxsize = maxsize
        self._data: OrderedDict[tuple, tuple[float, object]] = OrderedDict()

    def get(self, key: tuple):
        entry = self._data.get(key)
        if entry is None:
            return _MISS
        expires, value = entry
        if expires <= time.monotonic():
            self._data.pop(key, None)
            return _MISS
        self._data.move_to_end(key)
        return value

    def set(self, key: tuple, value) -> None:
        self._data[key] = (time.monotonic() + self._ttl, value)
        self._data.move_to_end(key)
        while len(self._data) > self._maxsize:
            self._data.popitem(last=False)

    def delete(self, key: tuple) -> None:
        self._data.pop(key, None)

    def __len__(self) -> int:
        return len(self._data)


_user_cache        = TTLCache(_CACHE_TTL * 5, maxsize=256)
_approvals_cache   = TTLCache(_CACHE_TTL)
_discussions_cache = TTLCache(_CACHE_TTL)
_pipeline_cache    = TTLCache(_CACHE_TTL)
_approval_at_cache = TTLCache(_APPROVAL_TTL)
_activities_cache  = TTLCache(_APPROVAL_TTL)


# ─── session helpers ──────────────────────────────────────────────────────────

def _encrypt(data: dict) -> str:
    return _fernet.encrypt(json.dumps(data).encode()).decode()


def _decrypt(value: str) -> dict | None:
    try:
        return json.loads(_fernet.decrypt(value.encode(), ttl=_COOKIE_MAX_AGE))
    except Exception:
        return None


def _read_session(gl_session: str | None = Cookie(None)) -> dict:
    if not gl_session:
        return {"profiles": [], "activeId": None}
    data = _decrypt(gl_session)
    return data if data else {"profiles": [], "activeId": None}


def _write_cookie(response: Response, session: dict) -> None:
    response.set_cookie(
        _COOKIE,
        _encrypt(session),
        httponly=True,
        # "lax" (not "strict") on purpose: it already blocks cross-site POSTs, and
        # "strict" would drop the cookie when someone opens the dashboard from a
        # link in Confluence/Slack, dumping them on the login screen.
        samesite="lax",
        max_age=_COOKIE_MAX_AGE,
        path="/",
        secure=_SECURE_COOKIE,
    )


def _safe(profile: dict) -> dict:
    return {"id": profile["id"], "label": profile["label"], "gitlabUrl": profile["gitlabUrl"]}


# ─── FastAPI app ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http, _gitlab_slots
    _http = httpx.AsyncClient(
        timeout=30,
        follow_redirects=True,
        limits=httpx.Limits(max_connections=_CONCURRENCY * 2, max_keepalive_connections=_CONCURRENCY),
    )
    _gitlab_slots = asyncio.Semaphore(_CONCURRENCY)
    log.info("started — concurrency=%s cache_ttl=%ss", _CONCURRENCY, _CACHE_TTL)
    yield
    await _http.aclose()


app = FastAPI(title="GitLab Dashboard API", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


# A one-element list, not an int: asyncio tasks copy the context but share the
# object inside it, so fan-out calls still count towards the originating request.
_gitlab_calls: ContextVar[list] = ContextVar("gitlab_calls")


def _count_gitlab_call() -> None:
    try:
        _gitlab_calls.get()[0] += 1
    except LookupError:
        pass


@app.middleware("http")
async def log_timing(request, call_next):
    calls = [0]
    _gitlab_calls.set(calls)
    t = time.monotonic()
    response = await call_next(request)
    elapsed = time.monotonic() - t
    if not request.url.path.startswith("/api/health"):
        # Fan-out is this dashboard's main cost, so the count sits next to the
        # duration: "slow" and "slow because it made 90 calls" need different fixes.
        level = logging.INFO if elapsed > 1 or calls[0] > 20 else logging.DEBUG
        log.log(level, "%s %s → %s (%.2fs, %d GitLab calls)",
                request.method, request.url.path, response.status_code, elapsed, calls[0])
    return response


# Same-origin in every supported setup (nginx proxies /api, vite proxies it in dev),
# so CORS stays off unless an origin is opted in explicitly.
_cors_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )
    log.info("CORS enabled for %s", _cors_origins)


# ─── GitLab client ────────────────────────────────────────────────────────────

_GITLAB_ERRORS = {
    401: "GitLab rejected the token",
    403: "Access denied by GitLab",
    404: "Not found in GitLab",
    429: "GitLab rate limit reached — try again shortly",
}


def _gitlab_error(r: httpx.Response, path: str) -> HTTPException:
    log.warning("gitlab %s → %s: %s", path, r.status_code, r.text[:300])
    detail = _GITLAB_ERRORS.get(r.status_code, f"GitLab returned {r.status_code}")
    return HTTPException(status_code=r.status_code, detail=detail)


def _fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:16]


class GL:
    """Per-request GitLab context. All outbound calls funnel through here so the
    concurrency limit, error mapping and cache namespacing apply everywhere."""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token
        self.headers = {"PRIVATE-TOKEN": token}
        # Caches are namespaced per token: two people sharing one backend must
        # never read each other's projects out of the cache.
        self.fp = _fingerprint(token)

    def key(self, *parts) -> tuple:
        return (self.fp, self.url, *parts)

    def _api(self, path: str) -> str:
        return f"{self.url}/api/v4{path}"

    async def _send(self, method: str, url: str, **kw) -> httpx.Response:
        _count_gitlab_call()
        async with _gitlab_slots:
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
            raise _gitlab_error(r, path)
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
            raise _gitlab_error(r, path)
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


def get_gl(session: dict = Depends(_read_session)) -> GL:
    profiles = session.get("profiles", [])
    active_id = session.get("activeId")
    active = next((p for p in profiles if p["id"] == active_id), None)
    if not active:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return GL(active["gitlabUrl"], active["token"])


# ─── Pydantic models ──────────────────────────────────────────────────────────

class LoginBody(BaseModel):
    gitlab_url: str
    token: str
    label: str = ""


class SwitchBody(BaseModel):
    profile_id: str


class MRRef(BaseModel):
    project_id: int
    iid: int
    # Lets the expensive post-approval lookups be cached until the MR actually
    # changes, instead of expiring on a timer.
    updated_at: str = ""


# ─── auth endpoints ───────────────────────────────────────────────────────────

@app.get("/api/auth/profiles")
async def auth_profiles(session: dict = Depends(_read_session)):
    profiles = session.get("profiles", [])
    return {
        "profiles": [_safe(p) for p in profiles],
        "activeId": session.get("activeId"),
    }


@app.post("/api/auth/login")
async def auth_login(body: LoginBody, response: Response, session: dict = Depends(_read_session)):
    gl = GL(body.gitlab_url.strip().rstrip("/"), body.token.strip())
    r = await gl.get("/user")
    user = r.json()
    _user_cache.set(gl.key("user"), user)

    existing = next(
        (p for p in session.get("profiles", []) if p["token"] == gl.token and p["gitlabUrl"] == gl.url),
        None,
    )
    if existing:
        _write_cookie(response, {**session, "activeId": existing["id"]})
        return {"profile": _safe(existing), "user": user}

    profile = {
        "id": str(uuid.uuid4()),
        "label": body.label.strip() or user.get("name") or user.get("username", ""),
        "gitlabUrl": gl.url,
        "token": gl.token,
    }

    profiles = [*session.get("profiles", []), profile]
    new_session = {"profiles": profiles, "activeId": profile["id"]}
    _write_cookie(response, new_session)

    return {"profile": _safe(profile), "user": user}


@app.post("/api/auth/switch")
async def auth_switch(body: SwitchBody, response: Response, session: dict = Depends(_read_session)):
    profiles = session.get("profiles", [])
    if not any(p["id"] == body.profile_id for p in profiles):
        raise HTTPException(status_code=404, detail="Profile not found")
    _write_cookie(response, {**session, "activeId": body.profile_id})
    return {"ok": True}


@app.delete("/api/auth/profiles/{profile_id}")
async def auth_remove(profile_id: str, response: Response, session: dict = Depends(_read_session)):
    profiles = [p for p in session.get("profiles", []) if p["id"] != profile_id]
    active_id = session.get("activeId")
    if active_id == profile_id:
        active_id = profiles[0]["id"] if profiles else None
    new_session = {"profiles": profiles, "activeId": active_id}
    if profiles:
        _write_cookie(response, new_session)
    else:
        response.delete_cookie(_COOKIE, path="/", secure=_SECURE_COOKIE)
    return {"ok": True, "activeId": active_id}


@app.post("/api/auth/logout")
async def auth_logout(response: Response):
    response.delete_cookie(_COOKIE, path="/", secure=_SECURE_COOKIE)
    return {"ok": True}


# ─── domain helpers ───────────────────────────────────────────────────────────

def _parse_dt(s: str) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _get_current_user(gl: GL) -> dict:
    key = gl.key("user")
    cached = _user_cache.get(key)
    if cached is not _MISS:
        return cached
    r = await gl.get("/user")
    user = r.json()
    _user_cache.set(key, user)
    return user


async def _find_approval_note(gl: GL, project_id: int, iid: int, user_id: int, updated_at: str) -> str | None:
    """Timestamp of the newest 'approved this merge request' system note.

    The scan pages through an MR's whole note history, so both hits and misses
    are cached — a miss is the expensive case and used to be repeated on every
    single refresh.
    """
    key = gl.key("approval_at", project_id, iid, user_id, updated_at)
    cached = _approval_at_cache.get(key)
    if cached is not _MISS:
        return cached

    t0 = time.monotonic()
    found: str | None = None
    page = 1
    while page <= _MAX_NOTE_PAGES:
        r = await gl.try_get(
            f"/projects/{project_id}/merge_requests/{iid}/notes",
            {"per_page": 100, "sort": "desc", "order_by": "created_at", "page": page},
        )
        if r is None:
            return None  # transient failure: do not cache a wrong answer
        notes = r.json()
        if not notes:
            break
        found = next(
            (
                n["created_at"]
                for n in notes
                if n.get("system")
                and n.get("author", {}).get("id") == user_id
                and n.get("body", "") == "approved this merge request"
            ),
            None,
        )
        if found:
            break
        try:
            total_pages = int(r.headers.get("X-Total-Pages") or 1)
        except ValueError:
            total_pages = 1
        if page >= total_pages:
            break
        page += 1

    log.debug(
        "approval note %s!%s pages=%s %.2fs → %s",
        project_id, iid, page, time.monotonic() - t0, "found" if found else "none",
    )
    _approval_at_cache.set(key, found)
    return found


async def _fetch_discussions(gl: GL, project_id: int, iid: int) -> list[dict]:
    key = gl.key("discussions", project_id, iid)
    cached = _discussions_cache.get(key)
    if cached is not _MISS:
        return cached
    r = await gl.try_get(f"/projects/{project_id}/merge_requests/{iid}/discussions", {"per_page": 100})
    if r is None:
        return []
    result = r.json()
    if not isinstance(result, list):
        return []
    _discussions_cache.set(key, result)
    return result


_MD_HEADING = re.compile(r"^#{1,6}\s+", re.MULTILINE)
_MD_RULE    = re.compile(r"^[-*_]{3,}\s*$", re.MULTILINE)
_MD_BULLET  = re.compile(r"^[\*\-\+]\s+", re.MULTILINE)
_MD_NUMBER  = re.compile(r"^\d+\.\s+", re.MULTILINE)


def _strip_markdown(text: str) -> str:
    for pattern in (_MD_HEADING, _MD_RULE, _MD_BULLET, _MD_NUMBER):
        text = pattern.sub("", text)
    return text.strip()


def _truncate(text: str, max_len: int = 120) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len].rsplit(" ", 1)[0] + "…"


def _clean(body: str | None, max_len: int) -> str:
    return _truncate(_strip_markdown((body or "").replace("\n", " ")), max_len)


def _build_note_preview(notes: list[dict], since: datetime | None = None) -> dict:
    """Preview of one discussion thread.

    With `since`, the reply list is narrowed to what arrived after that moment —
    that is what makes 'new replies on a thread you already read' visible.
    """
    first        = notes[0]
    position     = first.get("position") or {}
    user_replies = [n for n in notes[1:] if not n.get("system")]
    new_replies  = (
        [n for n in user_replies if _is_after(n.get("created_at"), since)] if since else []
    )
    shown = new_replies if since else user_replies
    return {
        "note_id":     first.get("id"),
        "author":      first.get("author", {}).get("name", ""),
        "body":        _clean(first.get("body"), 500),
        "created_at":  first.get("created_at"),
        "replies":     len(user_replies),
        "new_replies": len(new_replies),
        "reply_notes": [
            {
                "note_id":    n.get("id"),
                "author":     n.get("author", {}).get("name", ""),
                "body":       _clean(n.get("body"), 300),
                "created_at": n.get("created_at"),
            }
            for n in shown[-5:]
        ],
        "file_path":  position.get("new_path") or position.get("old_path"),
        "line":       position.get("new_line") or position.get("old_line"),
    }


def _is_after(iso: str | None, since: datetime | None) -> bool:
    if since is None or not iso:
        return False
    dt = _parse_dt(iso)
    return dt is not None and dt > since


def _sort_previews(previews: list[dict]) -> None:
    previews.sort(key=lambda p: p.get("created_at") or "", reverse=True)


def _compute_discussion_stats(discussions: list[dict]) -> dict:
    total = resolved_count = 0
    unresolved_previews: list[dict] = []
    resolved_previews:   list[dict] = []
    for d in discussions:
        notes      = d.get("notes", [])
        resolvable = [n for n in notes if n.get("resolvable")]
        if not resolvable:
            continue
        total += 1
        preview = _build_note_preview(notes)
        if all(n.get("resolved") for n in resolvable):
            resolved_count += 1
            resolved_previews.append(preview)
        else:
            unresolved_previews.append(preview)
    _sort_previews(unresolved_previews)
    _sort_previews(resolved_previews)
    return {
        "resolved":            resolved_count,
        "total":               total,
        "unresolved_previews": unresolved_previews,
        "resolved_previews":   resolved_previews,
    }


def _compute_new_threads(discussions: list[dict], since: datetime) -> tuple[int, int, list[dict]]:
    """Discussion activity after `since`.

    Counts both brand-new threads and replies landing on threads that already
    existed — a reply on an old thread is exactly the kind of "answer my review
    comment" event that must not be missed.
    """
    new_threads = 0
    new_replies = 0
    previews: list[dict] = []
    for d in discussions:
        notes = d.get("notes", [])
        if not notes or notes[0].get("system"):
            continue
        if _is_after(notes[0].get("created_at"), since):
            new_threads += 1
            previews.append(_build_note_preview(notes))
            continue
        preview = _build_note_preview(notes, since=since)
        if preview["new_replies"] > 0:
            new_replies += preview["new_replies"]
            previews.append(preview)
    _sort_previews(previews)
    return new_threads, new_replies, previews


async def _activities_after_approval(gl: GL, project_id: int, iid: int, user_id: int, updated_at: str) -> dict | None:
    key = gl.key("activities", project_id, iid, user_id, updated_at)
    cached = _activities_cache.get(key)
    if cached is not _MISS:
        return cached

    last_approval_at = await _find_approval_note(gl, project_id, iid, user_id, updated_at)
    if last_approval_at is None:
        return None
    approval_dt = _parse_dt(last_approval_at)
    if approval_dt is None:
        return None

    commits_r, discussions = await asyncio.gather(
        gl.try_get(f"/projects/{project_id}/merge_requests/{iid}/commits", {"per_page": 20}),
        _fetch_discussions(gl, project_id, iid),
    )
    new_commits = []
    if commits_r is not None:
        for c in commits_r.json():
            if _is_after(c.get("committed_date"), approval_dt):
                new_commits.append({
                    "id":       c.get("id", ""),
                    "short_id": c.get("short_id", ""),
                    "title":    c.get("title", ""),
                })
    new_threads, new_replies, previews = _compute_new_threads(discussions, approval_dt)
    if not new_commits and not new_threads and not new_replies:
        _activities_cache.set(key, None)
        return None
    result = {
        "commits":             new_commits,
        "new_threads":         new_threads,
        "new_replies":         new_replies,
        "new_thread_previews": previews,
    }
    _activities_cache.set(key, result)
    return result


async def _approvals(gl: GL, project_id: int, iid: int) -> list[dict]:
    key = gl.key("approvals", project_id, iid)
    cached = _approvals_cache.get(key)
    if cached is not _MISS:
        return cached
    r = await gl.try_get(f"/projects/{project_id}/merge_requests/{iid}/approvals")
    if r is None:
        return []
    result = [entry["user"] for entry in r.json().get("approved_by", [])]
    _approvals_cache.set(key, result)
    return result


async def _latest_pipeline(gl: GL, project_id: int, iid: int) -> dict | None:
    key = gl.key("pipeline", project_id, iid)
    cached = _pipeline_cache.get(key)
    if cached is not _MISS:
        return cached
    r = await gl.try_get(f"/projects/{project_id}/merge_requests/{iid}/pipelines", {"per_page": 50})
    if r is None:
        return None
    pipelines = r.json()
    result = next((p for p in pipelines if p.get("source") != "merge_request_event"), None)
    if result is None and pipelines:
        result = pipelines[0]
    _pipeline_cache.set(key, result)
    return result


async def _fetch_project_mrs(gl: GL, project_id: int, params: dict) -> list[dict]:
    return await gl.get_all(f"/projects/{project_id}/merge_requests", params, _MAX_MR_PAGES)


async def _fetch_global_mrs(gl: GL, params: dict) -> list[dict]:
    return await gl.get_all("/merge_requests", params, _MAX_MR_PAGES)


def _dedupe(batches: list[list[dict]]) -> list[dict]:
    seen: set = set()
    result: list[dict] = []
    for batch in batches:
        for mr in batch:
            if mr["id"] not in seen:
                seen.add(mr["id"])
                result.append(mr)
    result.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
    return result


async def _fetch_targeted_mrs(gl: GL, params: dict) -> list[dict]:
    """scope=all times out on big instances, so ask three targeted questions."""
    current_user = await _get_current_user(gl)
    user_id = current_user.get("id")
    p = {**params, "per_page": 100}
    queries = [
        _fetch_global_mrs(gl, {**p, "scope": "created_by_me"}),
        _fetch_global_mrs(gl, {**p, "scope": "assigned_to_me"}),
    ]
    if user_id:
        queries.append(_fetch_global_mrs(gl, {**p, "scope": "all", "reviewer_id": user_id}))
    return _dedupe(await asyncio.gather(*queries))


async def _enrich(gl: GL, mr_list: list[dict], with_details: bool = False) -> list[dict]:
    """Attach approvers to every MR; `with_details` also attaches pipeline and
    discussion stats for lists the client cannot patch in afterwards."""
    if not mr_list:
        return []

    t0 = time.monotonic()
    approved_by_list = await asyncio.gather(
        *[_approvals(gl, mr["project_id"], mr["iid"]) for mr in mr_list]
    )
    for mr, approved_by in zip(mr_list, approved_by_list):
        mr["approved_by_users"] = approved_by

    if with_details:
        pipelines, discussions = await asyncio.gather(
            asyncio.gather(*[_latest_pipeline(gl, mr["project_id"], mr["iid"]) for mr in mr_list]),
            asyncio.gather(*[_fetch_discussions(gl, mr["project_id"], mr["iid"]) for mr in mr_list]),
        )
        for mr, pipeline, threads in zip(mr_list, pipelines, discussions):
            mr["pipeline"] = pipeline
            mr["discussion_stats"] = _compute_discussion_stats(threads)

    log.debug("enriched %s MRs in %.2fs (details=%s)", len(mr_list), time.monotonic() - t0, with_details)
    return mr_list


# ─── API endpoints ────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/config")
async def config():
    return {
        "gitlab_url":    _DEFAULT_URL   or None,
        "default_group": _DEFAULT_GROUP or None,
    }


_GRAVATAR_HOSTS = {"secure.gravatar.com", "www.gravatar.com"}
_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(url: str) -> tuple[str, str, int] | None:
    """(scheme, host, port), or None if the URL is not one we would ever call."""
    parts = urlsplit(url)
    if parts.scheme not in _DEFAULT_PORTS or not parts.hostname:
        return None
    try:
        port = parts.port
    except ValueError:
        return None  # malformed port, e.g. "gitlab.example.com:443.attacker.tld"
    return (parts.scheme, parts.hostname.lower(), port or _DEFAULT_PORTS[parts.scheme])


@app.get("/api/avatar")
async def proxy_avatar(url: str = Query(..., max_length=2048), gl: GL = Depends(get_gl)):
    # Full-origin equality, not a string prefix: this request carries the user's
    # token, and "gitlab.example.com.attacker.tld" starts with the GitLab URL
    # while being a completely different server.
    target = _origin(url)
    if target is None:
        raise HTTPException(status_code=400, detail="URL not allowed")

    if target == _origin(gl.url):
        r = await gl.fetch_url(url)
    elif target[0] == "https" and target[1] in _GRAVATAR_HOSTS:
        async with _gitlab_slots:
            r = await _http.get(url)  # public host — never send credentials
    else:
        raise HTTPException(status_code=400, detail="URL not allowed")

    if r.status_code != 200:
        raise HTTPException(status_code=404, detail="Avatar not available")
    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "image/png"),
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/api/me")
async def me(gl: GL = Depends(get_gl)):
    r = await gl.get("/user")
    user = r.json()
    _user_cache.set(gl.key("user"), user)
    return user


@app.get("/api/mentions")
async def mentions(gl: GL = Depends(get_gl)):
    r = await gl.get("/todos", {"action": "mentioned", "state": "pending", "per_page": 50})
    seen: set = set()
    mr_list: list = []
    for todo in r.json():
        if todo.get("target_type") != "MergeRequest":
            continue
        target = todo.get("target") or {}
        mid = target.get("id")
        if mid and mid not in seen:
            seen.add(mid)
            mr_list.append(target)
    # These MRs live outside the main list, so the client never patches pipeline
    # and thread stats into them — they have to arrive complete.
    return await _enrich(gl, mr_list, with_details=True)


@app.get("/api/projects")
async def projects(gl: GL = Depends(get_gl)):
    return await gl.get_all("/projects", {
        "membership": True,
        "simple": True,
        "per_page": 100,
        "order_by": "last_activity_at",
        "sort": "desc",
    }, _MAX_PROJECT_PAGES)


@app.post("/api/merge-requests/activities")
async def mr_activities_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    if not refs:
        return {}
    current_user = await _get_current_user(gl)
    me_id = current_user.get("id")
    if not me_id:
        return {}

    # approvals are cached from the recent main enrich call
    approved_by_list = await asyncio.gather(
        *[_approvals(gl, ref.project_id, ref.iid) for ref in refs]
    )
    approved_refs = [
        ref for ref, approved_by in zip(refs, approved_by_list)
        if any(u.get("id") == me_id for u in approved_by)
    ]
    if not approved_refs:
        return {}

    activities_list = await asyncio.gather(
        *[_activities_after_approval(gl, ref.project_id, ref.iid, me_id, ref.updated_at)
          for ref in approved_refs]
    )
    return {
        f"{ref.project_id}_{ref.iid}": result
        for ref, result in zip(approved_refs, activities_list)
        if result
    }


@app.post("/api/merge-requests/pipelines-batch")
async def mr_pipelines_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    if not refs:
        return {}
    pipeline_list = await asyncio.gather(
        *[_latest_pipeline(gl, ref.project_id, ref.iid) for ref in refs]
    )
    return {
        f"{ref.project_id}_{ref.iid}": pipeline
        for ref, pipeline in zip(refs, pipeline_list)
        if pipeline is not None
    }


@app.post("/api/merge-requests/discussion-stats-batch")
async def mr_discussion_stats_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    if not refs:
        return {}
    discussions_list = await asyncio.gather(
        *[_fetch_discussions(gl, ref.project_id, ref.iid) for ref in refs]
    )
    return {
        f"{ref.project_id}_{ref.iid}": _compute_discussion_stats(discussions)
        for ref, discussions in zip(refs, discussions_list)
    }


@app.get("/api/projects/{project_id}/merge_requests/{iid}/discussion-stats")
async def mr_discussion_stats(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    discussions = await _fetch_discussions(gl, project_id, iid)
    return _compute_discussion_stats(discussions)


def _invalidate_approval(gl: GL, project_id: int, iid: int) -> None:
    """Own approval just changed — drop the cached approver list so the refresh
    that follows shows the new state instead of a minute-old one."""
    _approvals_cache.delete(gl.key("approvals", project_id, iid))


@app.post("/api/merge-requests/{project_id}/{iid}/approve")
async def approve_mr(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    await gl.post(f"/projects/{project_id}/merge_requests/{iid}/approve", ok=(200, 201))
    _invalidate_approval(gl, project_id, iid)
    return {"ok": True}


@app.post("/api/merge-requests/{project_id}/{iid}/unapprove")
async def unapprove_mr(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    await gl.post(f"/projects/{project_id}/merge_requests/{iid}/unapprove", ok=(200, 201, 204))
    _invalidate_approval(gl, project_id, iid)
    return {"ok": True}


_TODO_ACTIONS = {
    "assigned", "review_requested", "mentioned", "directly_addressed",
    "approval_required", "build_failed", "unmergeable", "marked",
}


@app.get("/api/todos")
async def todos_list(
    state: str = Query("pending", pattern="^(pending|done|all)$"),
    action: str = Query(""),
    target_type: str = Query(""),
    per_page: int = Query(50, ge=1, le=100),
    gl: GL = Depends(get_gl),
):
    params: dict = {"per_page": per_page}
    if state != "all":
        params["state"] = state
    if action and action in _TODO_ACTIONS:
        params["action"] = action
    if target_type:
        params["type"] = target_type
    r = await gl.get("/todos", params)
    return r.json()


@app.post("/api/todos/mark_all_done")
async def mark_all_todos_done(gl: GL = Depends(get_gl)):
    await gl.post("/todos/mark_as_done")
    return {"ok": True}


@app.post("/api/todos/{todo_id}/done")
async def mark_todo_done(todo_id: int, gl: GL = Depends(get_gl)):
    await gl.post(f"/todos/{todo_id}/mark_as_done")
    return {"ok": True}


@app.get("/api/merge-requests")
async def merge_requests(
    state: str = Query("opened", pattern="^(opened|merged|closed|all)$"),
    scope: str = Query("all", pattern="^(all|created_by_me|assigned_to_me)$"),
    triage: bool = Query(False),
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=100),
    search: str = Query(""),
    project_id: int | None = Query(None),
    project_ids: str = Query(""),
    gl: GL = Depends(get_gl),
):
    base_params: dict = {
        "state":    state,
        "order_by": "updated_at",
        "sort":     "desc",
    }
    if search:
        base_params["search"] = search

    ids = [int(x) for x in project_ids.split(",") if x.strip().isdigit()] if project_ids else []

    def paginate(all_mrs: list[dict]) -> tuple[list[dict], int, int]:
        total = len(all_mrs)
        total_pages = max(1, -(-total // per_page))
        start = (page - 1) * per_page
        return all_mrs[start: start + per_page], total, total_pages

    if triage:
        if ids:
            # Projects selected → fetch all MRs per project directly (shows everything, not just "mine")
            batches = await asyncio.gather(
                *[_fetch_project_mrs(gl, pid, {**base_params, "scope": "all", "per_page": 100}) for pid in ids]
            )
            mr_list = _dedupe(list(batches))
        else:
            # No project filter → targeted queries to avoid scope=all timeout on large instances
            mr_list = await _fetch_targeted_mrs(gl, base_params)
        total = len(mr_list)
        total_pages = 1
    elif project_id:
        r = await gl.get(f"/projects/{project_id}/merge_requests", {**base_params, "scope": scope, "page": page, "per_page": per_page})
        mr_list    = r.json()
        total      = int(r.headers.get("X-Total") or 0)
        total_pages = int(r.headers.get("X-Total-Pages") or 1)
    elif ids:
        per_project_params = {**base_params, "scope": scope, "per_page": 100}
        batches = await asyncio.gather(*[_fetch_project_mrs(gl, pid, per_project_params) for pid in ids])
        mr_list, total, total_pages = paginate(_dedupe(list(batches)))
    elif scope == "all":
        # scope=all on large instances (e.g. gitlab.com) times out — use targeted queries
        mr_list, total, total_pages = paginate(await _fetch_targeted_mrs(gl, base_params))
    else:
        r = await gl.get("/merge_requests", {**base_params, "scope": scope, "page": page, "per_page": per_page})
        mr_list    = r.json()
        total      = int(r.headers.get("X-Total") or 0)
        total_pages = int(r.headers.get("X-Total-Pages") or 1)

    return {
        "items":       await _enrich(gl, mr_list),
        "total":       total,
        "total_pages": total_pages,
        "page":        page,
    }
