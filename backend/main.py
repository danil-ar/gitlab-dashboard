import asyncio
import base64
import hashlib
import json
import re
import time
import uuid
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime
from urllib.parse import quote
from fastapi import FastAPI, Query, Cookie, HTTPException, Depends
from fastapi.responses import Response
from cryptography.fernet import Fernet
from pydantic import BaseModel
import httpx
import os
from dotenv import load_dotenv

import release_plan

load_dotenv()

_DEFAULT_URL   = os.environ.get("GITLAB_URL", "").rstrip("/")
_DEFAULT_GROUP = os.environ.get("GITLAB_DEFAULT_GROUP", "").strip()

_JIRA_URL            = os.environ.get("JIRA_URL", "").rstrip("/")
_JIRA_PROJECT        = os.environ.get("JIRA_PROJECT_KEY", "").strip()
_JIRA_RELEASE_STATUS = os.environ.get("JIRA_RELEASE_STATUS", "Включено в релиз").strip()

_raw_key = os.environ.get("SECRET_KEY", "")
if _raw_key:
    _fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(_raw_key.encode()).digest()))
else:
    _fernet = Fernet(Fernet.generate_key())
    print("WARNING: SECRET_KEY not set — sessions will reset on server restart")

_COOKIE = "gl_session"
_COOKIE_MAX_AGE = 60 * 60 * 24 * 365  # 1 year
_SECURE_COOKIE = os.environ.get("SECURE_COOKIE", "").lower() in ("1", "true", "yes")

_http: httpx.AsyncClient
_user_cache: dict[str, dict] = {}

_CACHE_TTL = 60  # seconds
_approvals_cache:   dict[tuple, tuple[float, list]]       = {}
_discussions_cache: dict[tuple, tuple[float, list]]       = {}
_pipeline_cache:    dict[tuple, tuple[float, dict | None]] = {}

_PLAN_CONCURRENCY = 8  # parallel calls per service while building one release plan

_RELEASE_SOURCE_BRANCH = "develop"
_RELEASE_TARGET_BRANCHES = ("master", "main")  # the first one that exists
_MERGE_CHECK_ATTEMPTS = 8  # GitLab works out mergeability in the background after an MR is created
_MERGE_CHECK_DELAY = 1  # seconds


def _cache_get(store: dict, key: tuple):
    entry = store.get(key)
    if entry and entry[0] > time.time():
        return entry[1]
    return None


def _cache_set(store: dict, key: tuple, value) -> None:
    store[key] = (time.time() + _CACHE_TTL, value)


# ─── session helpers ──────────────────────────────────────────────────────────

def _encrypt(data: dict) -> str:
    return _fernet.encrypt(json.dumps(data).encode()).decode()


def _decrypt(value: str) -> dict | None:
    try:
        return json.loads(_fernet.decrypt(value.encode()))
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
        samesite="lax",
        max_age=_COOKIE_MAX_AGE,
        path="/",
        secure=_SECURE_COOKIE,
    )


def _safe(profile: dict) -> dict:
    return {
        "id": profile["id"],
        "label": profile["label"],
        "gitlabUrl": profile["gitlabUrl"],
        "jiraConnected": bool(profile.get("jiraToken")),
    }


def _active_profile(session: dict) -> dict | None:
    active_id = session.get("activeId")
    return next((p for p in session.get("profiles", []) if p["id"] == active_id), None)


# ─── FastAPI app ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http
    _http = httpx.AsyncClient(timeout=30, follow_redirects=True)
    yield
    await _http.aclose()


app = FastAPI(title="GitLab Dashboard API", lifespan=lifespan)


@app.middleware("http")
async def log_timing(request, call_next):
    t = time.time()
    response = await call_next(request)
    elapsed = time.time() - t
    if not request.url.path.startswith("/api/health"):
        print(f"[timing] {request.method} {request.url.path} → {response.status_code} ({elapsed:.2f}s)", flush=True)
    return response


# ─── upstream clients ─────────────────────────────────────────────────────────

def _error_detail(r: httpx.Response) -> str:
    """Short reason from a GitLab or Jira error response; never a raw HTML page."""
    try:
        body = r.json()
    except ValueError:
        return f"HTTP {r.status_code}"
    if isinstance(body, dict):
        reason = body.get("message") or body.get("error") or body.get("errorMessages")
        if reason:
            return str(reason[0] if isinstance(reason, list) else reason)[:300]
    return f"HTTP {r.status_code}"


class GL:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token
        self.headers = {"PRIVATE-TOKEN": token}

    async def _request(self, method: str, path: str, params: dict | None = None) -> httpx.Response:
        try:
            r = await _http.request(method, f"{self.url}/api/v4{path}", headers=self.headers, params=params)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="GitLab API timeout")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"GitLab unreachable: {e}")
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=_error_detail(r))
        return r

    async def get(self, path: str, params: dict | None = None) -> httpx.Response:
        return await self._request("GET", path, params)

    async def post(self, path: str, params: dict | None = None) -> httpx.Response:
        return await self._request("POST", path, params)

    async def put(self, path: str, params: dict | None = None) -> httpx.Response:
        return await self._request("PUT", path, params)


class Jira:
    """Jira Server/Data Center client. Its failures never surface as 401, which the frontend reads as a dead GitLab token."""

    def __init__(self, token: str):
        self.headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    async def get(self, path: str, params: dict | None = None):
        try:
            r = await _http.get(f"{_JIRA_URL}/rest/api/2{path}", headers=self.headers, params=params, follow_redirects=False)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="Jira API timeout")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Jira unreachable: {e}")
        if r.status_code == 401 or r.is_redirect:
            raise HTTPException(status_code=403, detail="Jira rejected the token. Create a new Personal Access Token.")
        if r.status_code == 403:
            raise HTTPException(status_code=403, detail=f"Jira denied access: {_error_detail(r)}")
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=f"Jira: {_error_detail(r)}")
        try:
            return r.json()
        except ValueError:
            raise HTTPException(status_code=502, detail="Jira returned a non-JSON response. Check JIRA_URL.")


def get_gl(session: dict = Depends(_read_session)) -> GL:
    active = _active_profile(session)
    if not active:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return GL(active["gitlabUrl"], active["token"])


def get_jira(session: dict = Depends(_read_session)) -> Jira:
    if not _JIRA_URL or not _JIRA_PROJECT:
        raise HTTPException(status_code=404, detail="Jira integration is not configured")
    active = _active_profile(session)
    if not active:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not active.get("jiraToken"):
        raise HTTPException(status_code=403, detail="Connect Jira first")
    return Jira(active["jiraToken"])


async def _gather_settled(coros: list) -> list:
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


def _why(exc: Exception) -> str:
    return exc.detail if isinstance(exc, HTTPException) else repr(exc)


# ─── Pydantic models ──────────────────────────────────────────────────────────

class LoginBody(BaseModel):
    gitlab_url: str
    token: str
    label: str = ""


class SwitchBody(BaseModel):
    profile_id: str


class JiraConnectBody(BaseModel):
    token: str


class MRRef(BaseModel):
    project_id: int
    iid: int


class BuildTagBody(BaseModel):
    path: str
    tag: str
    source_sha: str


# ─── auth endpoints ───────────────────────────────────────────────────────────

@app.get("/api/auth/profiles")
async def auth_profiles(session: dict = Depends(_read_session)):
    profiles = session.get("profiles", [])
    return {
        "profiles": [_safe(p) for p in profiles],
        "activeId": session.get("activeId"),
        "jiraUrl": (_JIRA_URL if _JIRA_PROJECT else "") or None,
    }


@app.post("/api/auth/login")
async def auth_login(body: LoginBody, response: Response, session: dict = Depends(_read_session)):
    gl = GL(body.gitlab_url.strip().rstrip("/"), body.token.strip())
    try:
        r = await gl.get("/user")
    except HTTPException as e:
        # 401 from this API means the current session is dead; a bad token typed into the form is not that.
        if e.status_code == 401:
            raise HTTPException(status_code=400, detail="GitLab rejected this token")
        raise
    user = r.json()
    _user_cache[gl.token] = user

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

def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


async def _get_current_user(gl: GL) -> dict:
    if gl.token not in _user_cache:
        r = await gl.get("/user")
        _user_cache[gl.token] = r.json()
    return _user_cache[gl.token]


async def _find_approval_note(gl: GL, project_id: int, iid: int, user_id: int) -> str | None:
    t0 = time.time()
    page = 1
    while True:
        r = await gl.get(
            f"/projects/{project_id}/merge_requests/{iid}/notes",
            {"per_page": 100, "sort": "desc", "order_by": "created_at", "page": page},
        )
        for note in r.json():
            if (note.get("system") and
                    note.get("author", {}).get("id") == user_id and
                    note.get("body", "") == "approved this merge request"):
                print(f"[approval_note] project={project_id} iid={iid} pages={page} {time.time()-t0:.2f}s → found", flush=True)
                return note["created_at"]
        if page >= int(r.headers.get("X-Total-Pages", 1)):
            print(f"[approval_note] project={project_id} iid={iid} pages={page} {time.time()-t0:.2f}s → not found", flush=True)
            return None
        page += 1


async def _fetch_discussions(gl: GL, project_id: int, iid: int) -> list[dict]:
    key = (gl.url, project_id, iid)
    cached = _cache_get(_discussions_cache, key)
    if cached is not None:
        return cached
    r = await gl.get(f"/projects/{project_id}/merge_requests/{iid}/discussions", {"per_page": 100})
    result = r.json()
    _cache_set(_discussions_cache, key, result)
    return result


def _strip_markdown(text: str) -> str:
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^[\*\-\+]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\d+\.\s+', '', text, flags=re.MULTILINE)
    return text.strip()


def _truncate(text: str, max_len: int = 120) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len].rsplit(" ", 1)[0] + "…"


def _build_note_preview(notes: list[dict]) -> dict:
    first        = notes[0]
    body         = (first.get("body") or "").replace("\n", " ")
    position     = first.get("position") or {}
    user_replies = [n for n in notes[1:] if not n.get("system")]
    return {
        "note_id":    first.get("id"),
        "author":     first.get("author", {}).get("name", ""),
        "body":       _truncate(_strip_markdown(body), 500),
        "created_at": first.get("created_at"),
        "replies":    len(user_replies),
        "reply_notes": [
            {
                "note_id":    n.get("id"),
                "author":     n.get("author", {}).get("name", ""),
                "body":       _truncate(_strip_markdown((n.get("body") or "").replace("\n", " ")), 300),
                "created_at": n.get("created_at"),
            }
            for n in user_replies[:5]
        ],
        "file_path":  position.get("new_path") or position.get("old_path"),
        "line":       position.get("new_line") or position.get("old_line"),
    }


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
    return {
        "resolved":            resolved_count,
        "total":               total,
        "unresolved_previews": unresolved_previews,
        "resolved_previews":   resolved_previews,
    }


def _compute_new_threads(discussions: list[dict], since: datetime) -> tuple[int, list[dict]]:
    previews: list[dict] = []
    for d in discussions:
        notes = d.get("notes", [])
        if not notes or notes[0].get("system"):
            continue
        if _parse_dt(notes[0].get("created_at", "")) > since:
            previews.append(_build_note_preview(notes))
    return len(previews), previews


async def _activities_after_approval(
    gl: GL, project_id: int, iid: int, user_id: int, discussions: list[dict]
) -> dict | None:
    last_approval_at = await _find_approval_note(gl, project_id, iid, user_id)
    if last_approval_at is None:
        return None
    approval_dt = _parse_dt(last_approval_at)
    commits_r = await gl.get(f"/projects/{project_id}/merge_requests/{iid}/commits", {"per_page": 20})
    new_commits = [
        {"id": c.get("id", ""), "short_id": c.get("short_id", ""), "title": c.get("title", "")}
        for c in commits_r.json()
        if _parse_dt(c.get("committed_date", "")) > approval_dt
    ]
    new_threads, new_thread_previews = _compute_new_threads(discussions, approval_dt)
    if not new_commits and new_threads == 0:
        return None
    return {"commits": new_commits, "new_threads": new_threads, "new_thread_previews": new_thread_previews}


async def _approvals(gl: GL, project_id: int, iid: int) -> list[dict]:
    key = (gl.url, project_id, iid)
    cached = _cache_get(_approvals_cache, key)
    if cached is not None:
        return cached
    r = await gl.get(f"/projects/{project_id}/merge_requests/{iid}/approvals")
    result = [entry["user"] for entry in r.json().get("approved_by", [])]
    _cache_set(_approvals_cache, key, result)
    return result


async def _latest_pipeline(gl: GL, project_id: int, iid: int) -> dict | None:
    key = (gl.url, project_id, iid)
    cached = _cache_get(_pipeline_cache, key)
    if cached is not None:
        return cached
    r = await gl.get(f"/projects/{project_id}/merge_requests/{iid}/pipelines", {"per_page": 50})
    pipelines = r.json()
    result = None
    for p in pipelines:
        if p.get("source") != "merge_request_event":
            result = p
            break
    if result is None and pipelines:
        result = pipelines[0]
    _cache_set(_pipeline_cache, key, result)
    return result


def _merge_mr_batches(batches: list[list[dict]]) -> list[dict]:
    """Newest first, each MR once: the same MR can come back from several queries."""
    unique = {mr["id"]: mr for batch in batches for mr in batch}
    return sorted(unique.values(), key=lambda m: m.get("updated_at", ""), reverse=True)


async def _settled_mr_batches(coros: list, what: str, warnings: list[str]) -> list[dict]:
    """Merge MR queries, reporting partial failures. If every query failed there is nothing to show, so raise."""
    results = await _gather_settled(coros)
    failed = [res for res in results if isinstance(res, Exception)]
    if failed and len(failed) == len(results):
        raise failed[0]
    if failed:
        warnings.append(f"Could not load {len(failed)} of {len(results)} {what}: {_why(failed[0])}")
    return _merge_mr_batches([res for res in results if not isinstance(res, Exception)])


async def _fetch_project_mrs(gl: GL, project_id: int, params: dict) -> list[dict]:
    return (await gl.get(f"/projects/{project_id}/merge_requests", params)).json()


async def _fetch_global_mrs(gl: GL, params: dict) -> list[dict]:
    return (await gl.get("/merge_requests", params)).json()


async def _fetch_selected_mrs(gl: GL, ids: list[int], params: dict, warnings: list[str]) -> list[dict]:
    coros = [_fetch_project_mrs(gl, pid, {**params, "per_page": 100}) for pid in ids]
    return await _settled_mr_batches(coros, "selected projects", warnings)


async def _fetch_targeted_mrs(gl: GL, params: dict, warnings: list[str]) -> list[dict]:
    current_user = await _get_current_user(gl)
    user_id = current_user.get("id")
    p = {**params, "per_page": 100}
    coros = [
        _fetch_global_mrs(gl, {**p, "scope": "created_by_me"}),
        _fetch_global_mrs(gl, {**p, "scope": "assigned_to_me"}),
    ]
    if user_id:
        coros.append(_fetch_global_mrs(gl, {**p, "scope": "all", "reviewer_id": user_id}))
    return await _settled_mr_batches(coros, "MR queries", warnings)


async def _enrich(gl: GL, mr_list: list[dict], warnings: list[str] | None = None) -> list[dict]:
    """Attach approvals. approved_by_users is None when unknown, so a failed call can't pass for "no approvals"."""
    t0 = time.time()
    results = await _gather_settled([_approvals(gl, mr["project_id"], mr["iid"]) for mr in mr_list])
    print(f"[enrich] approvals for {len(mr_list)} MRs: {time.time()-t0:.2f}s", flush=True)

    failed = [res for res in results if isinstance(res, Exception)]
    for mr, res in zip(mr_list, results):
        mr["approved_by_users"] = None if isinstance(res, Exception) else res
    if failed and warnings is not None:
        warnings.append(f"Approvals unavailable for {len(failed)} MRs, so they may sit in the wrong bucket: {_why(failed[0])}")
    return mr_list


async def _per_mr_batch(refs: list[MRRef], fetch) -> dict:
    """Background per-MR data: a failed MR is logged and left out, and the row simply shows nothing for it."""
    results = await _gather_settled([fetch(ref) for ref in refs])
    out = {}
    for ref, res in zip(refs, results):
        if isinstance(res, Exception):
            print(f"[batch] project={ref.project_id} iid={ref.iid} error: {_why(res)}", flush=True)
        elif res is not None:
            out[f"{ref.project_id}_{ref.iid}"] = res
    return out


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


@app.get("/api/me")
async def me(gl: GL = Depends(get_gl)):
    r = await gl.get("/user")
    _user_cache[gl.token] = r.json()
    return r.json()


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
    return await _enrich(gl, mr_list)


@app.get("/api/projects")
async def projects(gl: GL = Depends(get_gl)):
    r = await gl.get("/projects", {
        "membership": True,
        "simple": True,
        "per_page": 100,
        "order_by": "last_activity_at",
        "sort": "desc",
    })
    return r.json()


@app.post("/api/merge-requests/activities")
async def mr_activities_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    if not refs:
        return {}
    current_user = await _get_current_user(gl)
    me_id = current_user.get("id")
    if not me_id:
        return {}

    async def fetch(ref: MRRef):
        # approvals are cached from the recent main enrich call
        approved_by = await _approvals(gl, ref.project_id, ref.iid)
        if not any(u.get("id") == me_id for u in approved_by):
            return None
        discussions = await _fetch_discussions(gl, ref.project_id, ref.iid)
        return await _activities_after_approval(gl, ref.project_id, ref.iid, me_id, discussions)

    return await _per_mr_batch(refs, fetch)


@app.post("/api/merge-requests/pipelines-batch")
async def mr_pipelines_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    return await _per_mr_batch(refs, lambda ref: _latest_pipeline(gl, ref.project_id, ref.iid))


@app.post("/api/merge-requests/discussion-stats-batch")
async def mr_discussion_stats_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    async def fetch(ref: MRRef):
        return _compute_discussion_stats(await _fetch_discussions(gl, ref.project_id, ref.iid))

    return await _per_mr_batch(refs, fetch)


async def _approval_action(gl: GL, project_id: int, iid: int, action: str) -> dict:
    try:
        await gl.post(f"/projects/{project_id}/merge_requests/{iid}/{action}")
    except HTTPException as e:
        # GitLab answers 401 here for "already approved" or "not allowed to approve", with a perfectly
        # valid token. Passed through as 401 it would read as a dead session.
        if e.status_code == 401:
            raise HTTPException(status_code=409, detail="GitLab refused: already approved, or you can't approve this MR")
        raise
    finally:
        _approvals_cache.pop((gl.url, project_id, iid), None)
    return {"ok": True}


@app.post("/api/merge-requests/{project_id}/{iid}/approve")
async def approve_mr(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    return await _approval_action(gl, project_id, iid, "approve")


@app.post("/api/merge-requests/{project_id}/{iid}/unapprove")
async def unapprove_mr(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    return await _approval_action(gl, project_id, iid, "unapprove")


@app.get("/api/todos")
async def todos_list(
    state: str = Query("pending", pattern="^(pending|done|all)$"),
    per_page: int = Query(50, ge=1, le=100),
    gl: GL = Depends(get_gl),
):
    params: dict = {"per_page": per_page}
    if state != "all":
        params["state"] = state
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


def _page_of(items: list, page: int, per_page: int) -> dict:
    start = (page - 1) * per_page
    return {
        "items":       items[start: start + per_page],
        "total":       len(items),
        "total_pages": max(1, -(-len(items) // per_page)),
    }


async def _gitlab_page(gl: GL, path: str, params: dict) -> dict:
    r = await gl.get(path, params)
    return {
        "items":       r.json(),
        "total":       int(r.headers.get("X-Total", 0)),
        "total_pages": int(r.headers.get("X-Total-Pages", 1)),
    }


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
    paged_params = {**base_params, "scope": scope, "page": page, "per_page": per_page}
    warnings: list[str] = []

    if triage:
        if ids:
            # Projects selected → fetch all MRs per project directly (shows everything, not just "mine")
            mr_list = await _fetch_selected_mrs(gl, ids, {**base_params, "scope": "all"}, warnings)
        else:
            # No project filter → targeted queries to avoid scope=all timeout on large instances
            mr_list = await _fetch_targeted_mrs(gl, base_params, warnings)
        result = {"items": mr_list, "total": len(mr_list), "total_pages": 1}
    elif project_id:
        result = await _gitlab_page(gl, f"/projects/{project_id}/merge_requests", paged_params)
    elif ids:
        all_mrs = await _fetch_selected_mrs(gl, ids, {**base_params, "scope": scope}, warnings)
        result = _page_of(all_mrs, page, per_page)
    elif scope == "all":
        # scope=all on large instances (e.g. gitlab.com) times out — use targeted queries
        result = _page_of(await _fetch_targeted_mrs(gl, base_params, warnings), page, per_page)
    else:
        result = await _gitlab_page(gl, "/merge_requests", paged_params)

    result["items"] = await _enrich(gl, result["items"], warnings)
    return {**result, "page": page, "warnings": warnings}


# ─── releases (Jira versions → GitLab tags) ───────────────────────────────────

@app.post("/api/jira/connect")
async def jira_connect(body: JiraConnectBody, response: Response, session: dict = Depends(_read_session)):
    if not _JIRA_URL:
        raise HTTPException(status_code=404, detail="Jira integration is not configured")
    active = _active_profile(session)
    if not active:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = body.token.strip()
    await Jira(token).get("/myself")
    profiles = [{**p, "jiraToken": token} if p["id"] == active["id"] else p for p in session["profiles"]]
    _write_cookie(response, {**session, "profiles": profiles})
    return {"ok": True}


@app.get("/api/jira/releases")
async def jira_releases(jira: Jira = Depends(get_jira)):
    versions = await jira.get(f"/project/{quote(_JIRA_PROJECT)}/versions")
    releases = []
    for v in versions:
        if v.get("archived"):
            continue
        issue = re.search(r"\b[A-Z][A-Z0-9]+-\d+\b", v.get("description") or "")
        releases.append({
            "id":            v["id"],
            "name":          v.get("name"),
            "released":      bool(v.get("released")),
            "release_date":  v.get("releaseDate"),
            "url":           f"{_JIRA_URL}/projects/{_JIRA_PROJECT}/versions/{v['id']}",
            "release_issue": issue[0] if issue else None,
            "release_issue_url": f"{_JIRA_URL}/browse/{issue[0]}" if issue else None,
        })
    # Upcoming first with the nearest on top, then shipped with the latest on top.
    upcoming = sorted((r for r in releases if not r["released"]), key=lambda r: r["release_date"] or "9999")
    shipped = sorted((r for r in releases if r["released"]), key=lambda r: r["release_date"] or "", reverse=True)
    return {"project": _JIRA_PROJECT, "status": _JIRA_RELEASE_STATUS, "releases": upcoming + shipped}


async def _version_issues(jira: Jira, version_id: int) -> list[dict]:
    jql = f'project = "{_JIRA_PROJECT}" AND fixVersion = {version_id} ORDER BY key'
    issues: list[dict] = []
    while True:
        page = await jira.get("/search", {
            "jql": jql,
            "fields": "summary,status,assignee,issuetype",
            "startAt": len(issues),
            "maxResults": 100,
        })
        batch = page.get("issues", [])
        issues += batch
        if not batch or len(issues) >= page.get("total", 0):
            return issues


def _change_from_link(gl: GL, link: dict, mrs: dict) -> dict:
    repo_url = f"{gl.url}/{link['path']}"
    if "sha" in link:
        return {
            "ref": link["sha"][:8], "kind": "commit", "title": None, "state": "commit",
            "url": f"{repo_url}/-/commit/{link['sha']}", "sha": link["sha"], "issues": [],
        }
    change = {
        "ref": f"!{link['iid']}", "kind": "mr", "url": f"{repo_url}/-/merge_requests/{link['iid']}", "issues": [],
    }
    mr = mrs[(link["path"], link["iid"])]
    if isinstance(mr, Exception):
        return {**change, "title": None, "state": "unknown", "sha": None, "error": _why(mr)}
    sha = None
    if mr.get("state") == "merged":
        sha = mr.get("merge_commit_sha") or mr.get("squash_commit_sha") or mr.get("sha")
    return {**change, "title": mr.get("title"), "state": mr.get("state"), "sha": sha}


async def _all_pages(gl: GL, sem: asyncio.Semaphore, path: str, params: dict | None = None) -> list:
    items: list = []
    page = "1"
    while page:
        async with sem:
            r = await gl.get(path, {**(params or {}), "per_page": 100, "page": page})
        items += r.json()
        page = r.headers.get("X-Next-Page")
    return items


async def _all_tag_names(gl: GL, sem: asyncio.Semaphore, enc_path: str) -> list[str]:
    """Every tag in the repo, read from GitLab: a page full of CI tags must not hide the latest release tag."""
    return [t["name"] for t in await _all_pages(gl, sem, f"/projects/{enc_path}/repository/tags")]


async def _plan_for_repo(gl: GL, gl_sem: asyncio.Semaphore, fetch, path: str, changes: list[dict]) -> dict:
    """Plan row for one repo. Closed MRs were never shipped, so they don't count as changes."""
    enc = quote(path, safe="")
    row = {"path": path, "name": path.rsplit("/", 1)[-1], "web_url": f"{gl.url}/{path}", "warnings": []}
    live = [c for c in changes if c["state"] != "closed"]

    tags_call, languages_call, *refs_calls = await _gather_settled([
        _all_tag_names(gl, gl_sem, enc),
        fetch(f"/projects/{enc}/languages"),
        *[fetch(f"/projects/{enc}/repository/commits/{c['sha']}/refs", {"type": "tag", "per_page": 100})
          for c in live if c["sha"]],
    ])
    row["group"] = release_plan.repo_group(row["name"], {} if isinstance(languages_call, Exception) else languages_call)
    row["changes"] = live
    row["issues"] = sorted({key for c in live for key in c["issues"]})
    if isinstance(tags_call, Exception):
        return {**row, "state": "error", "error": f"Could not read tags: {_why(tags_call)}",
                "latest_tag": None, "deploy_tag": None, "rollback_tag": None}

    refs_by_sha = dict(zip([c["sha"] for c in live if c["sha"]], refs_calls))
    containing = []
    for c in live:
        issues = ", ".join(c["issues"])
        refs = refs_by_sha.get(c["sha"], [])
        if isinstance(refs, Exception):
            row["warnings"].append(f"{c['ref']}: could not check tags, treated as untagged ({_why(refs)})")
            refs = []
        tags_of_change = [r["name"] for r in refs]
        containing.append(tags_of_change)
        c["tag"] = release_plan.first_tag(tags_of_change)
        if c["state"] in ("opened", "locked"):
            row["warnings"].append(f"{c['ref']} is not merged yet ({issues})")
        elif c["state"] == "unknown":
            row["warnings"].append(f"{c['ref']}: could not load the MR, treated as untagged ({c['error']})")
        elif c["kind"] == "commit" and not c["tag"]:
            row["warnings"].append(f"{c['ref']} is a commit with no MR and no tag, check it's on the release branch ({issues})")

    plan = release_plan.plan_repo(tags_call, containing)
    if plan["state"] == "older_tag":
        row["warnings"].append(
            f"Everything is already in {plan['deploy_tag']} and newer tags exist. "
            "Left out of the plan: include it if that tag belongs to this release."
        )
    if plan["state"] == "no_tags":
        row["warnings"].append(
            "GitLab has no vX.Y.Z tags here, so there is no version to continue from. "
            "Left out of the plan: tick it and enter a tag if this repo is deployed by tag."
        )
    elif not plan["rollback_tag"]:
        row["warnings"].append("No earlier vX.Y.Z tag to roll back to.")
    return {**row, **plan, "error": None}


@app.get("/api/jira/releases/{version_id}/plan")
async def jira_release_plan(version_id: int, jira: Jira = Depends(get_jira), gl: GL = Depends(get_gl)):
    wanted = _JIRA_RELEASE_STATUS.casefold()
    all_issues = await _version_issues(jira, version_id)
    issues = [i for i in all_issues if i["fields"]["status"]["name"].casefold() == wanted]
    other_statuses = Counter(
        i["fields"]["status"]["name"] for i in all_issues if i["fields"]["status"]["name"].casefold() != wanted
    )
    warnings: list[str] = []

    jira_sem, gl_sem = asyncio.Semaphore(_PLAN_CONCURRENCY), asyncio.Semaphore(_PLAN_CONCURRENCY)

    async def jira_links(key: str):
        async with jira_sem:
            return await jira.get(f"/issue/{quote(key)}/remotelink")

    async def fetch(path: str, params: dict | None = None):
        async with gl_sem:
            return (await gl.get(path, params)).json()

    # 1. Jira issue → the GitLab MRs and commits it mentions
    links_by_issue: dict[str, list[dict]] = {}
    for issue, res in zip(issues, await _gather_settled([jira_links(i["key"]) for i in issues])):
        if isinstance(res, Exception):
            warnings.append(f"{issue['key']}: could not read its GitLab links ({_why(res)})")
            links_by_issue[issue["key"]] = []
            continue
        parsed = [release_plan.parse_gitlab_link((l.get("object") or {}).get("url") or "", gl.url) for l in res]
        links_by_issue[issue["key"]] = list({(p["path"], p.get("iid"), p.get("sha")): p for p in parsed if p}.values())

    # 2. MR details: state and the commit that landed on the target branch
    mr_keys = sorted({(l["path"], l["iid"]) for links in links_by_issue.values() for l in links if "iid" in l})
    mr_results = await _gather_settled([fetch(f"/projects/{quote(p, safe='')}/merge_requests/{iid}") for p, iid in mr_keys])
    mrs = dict(zip(mr_keys, mr_results))

    # 3. Group by repo. An MR's branch commits may never reach a tag when it's squashed, so where an
    #    issue has an MR in a repo the MR alone says what ships. Commits count only for MR-less repos.
    repos: dict[str, dict[str, dict]] = {}
    for key, links in links_by_issue.items():
        repos_with_mr = {l["path"] for l in links if "iid" in l}
        for link in links:
            if "sha" in link and link["path"] in repos_with_mr:
                continue
            change = _change_from_link(gl, link, mrs)
            repos.setdefault(link["path"], {}).setdefault(change["ref"], change)["issues"].append(key)

    # 4. Tags per repo
    live_repos = {p: list(c.values()) for p, c in repos.items() if any(x["state"] != "closed" for x in c.values())}
    rows = await _gather_settled([_plan_for_repo(gl, gl_sem, fetch, p, c) for p, c in live_repos.items()])
    plan_rows = []
    for path, row in zip(live_repos, rows):
        if isinstance(row, Exception):
            warnings.append(f"{path}: could not build a plan ({_why(row)})")
        else:
            plan_rows.append(row)
    plan_rows.sort(key=lambda r: (r["group"], r["name"]))

    links_of = {i["key"]: [] for i in issues}
    for path, changes in repos.items():
        for c in changes.values():
            for key in c["issues"]:
                links_of[key].append({"ref": c["ref"], "url": c["url"], "state": c["state"], "path": path, "repo": path.rsplit("/", 1)[-1]})

    return {
        "issues": [
            {
                "key":      i["key"],
                "url":      f"{_JIRA_URL}/browse/{i['key']}",
                "summary":  i["fields"].get("summary"),
                "assignee": (i["fields"].get("assignee") or {}).get("displayName"),
                "type":     (i["fields"].get("issuetype") or {}).get("name"),
                "links":    links_of[i["key"]],
            }
            for i in issues
        ],
        "total_issues":   len(all_issues),
        "other_statuses": [{"name": name, "count": count} for name, count in other_statuses.most_common()],
        "repos":          plan_rows,
        "warnings":       warnings,
    }


# ─── building a release tag ───────────────────────────────────────────────────

async def _exists(gl: GL, path: str) -> bool:
    try:
        await gl.get(path)
        return True
    except HTTPException as e:
        if e.status_code == 404:
            return False
        raise


async def _release_target_branch(gl: GL, enc: str) -> str:
    for name in _RELEASE_TARGET_BRANCHES:
        if await _exists(gl, f"/projects/{enc}/repository/branches/{name}"):
            return name
    raise HTTPException(status_code=404, detail=f"The repo has no {' or '.join(_RELEASE_TARGET_BRANCHES)} branch")


async def _source_head(gl: GL, enc: str) -> str:
    r = await gl.get(f"/projects/{enc}/repository/branches/{_RELEASE_SOURCE_BRANCH}")
    return r.json()["commit"]["id"]


async def _commits_ahead(gl: GL, enc: str, target: str) -> list[dict]:
    range_ = f"{target}..{_RELEASE_SOURCE_BRANCH}"
    return await _all_pages(gl, asyncio.Semaphore(1), f"/projects/{enc}/repository/commits", {"ref_name": range_})


async def _open_release_mr(gl: GL, enc: str, target: str) -> dict | None:
    r = await gl.get(f"/projects/{enc}/merge_requests", {
        "state": "opened", "source_branch": _RELEASE_SOURCE_BRANCH, "target_branch": target, "per_page": 1,
    })
    mrs = r.json()
    return mrs[0] if mrs else None


def _tag_path(enc: str, tag: str) -> str:
    return f"/projects/{enc}/repository/tags/{quote(tag, safe='')}"


@app.get("/api/jira/releases/{version_id}/repo-preview")
async def release_repo_preview(
    version_id: int,
    path: str = Query(...),
    tag: str = Query(...),
    jira: Jira = Depends(get_jira),
    gl: GL = Depends(get_gl),
):
    """What building this tag would do, and everything that would reach the target branch with it."""
    if not release_plan.parse_tag(tag):
        raise HTTPException(status_code=400, detail="The tag must look like vX.Y.Z")
    enc = quote(path, safe="")
    target = await _release_target_branch(gl, enc)
    head = await _source_head(gl, enc)
    commits = await _commits_ahead(gl, enc, target)
    mr = await _open_release_mr(gl, enc, target)
    statuses = {i["key"]: i["fields"]["status"]["name"] for i in await _version_issues(jira, version_id)}
    return {
        "source": _RELEASE_SOURCE_BRANCH,
        "target": target,
        "source_sha": head,
        "ahead": len(commits),
        "open_mr": {"iid": mr["iid"], "url": mr["web_url"]} if mr else None,
        "tag_exists": await _exists(gl, _tag_path(enc, tag)),
        "commands": release_plan.manual_commands(_RELEASE_SOURCE_BRANCH, target, head, tag, bool(commits)),
        **release_plan.summarize_commits(commits, statuses, _JIRA_RELEASE_STATUS, _JIRA_PROJECT),
    }


def _write_refused(e: HTTPException) -> str:
    # GitLab answers 401 here for "not allowed", with a valid token. The reason goes back in a normal
    # response: passed through as 401 it would read as a dead session and sign the user out.
    return "GitLab refused: you don't have permission" if e.status_code == 401 else e.detail


async def _merge_release_mr(gl: GL, enc: str, target: str, tag: str, sha: str) -> dict:
    """Merge the source branch through an MR. Returns {"merged_sha"} or {"blocked", "mr_url"}."""
    mr = await _open_release_mr(gl, enc, target)
    if not mr:
        try:
            mr = (await gl.post(f"/projects/{enc}/merge_requests", {
                "source_branch": _RELEASE_SOURCE_BRANCH,
                "target_branch": target,
                "title": f"Release {tag}: {_RELEASE_SOURCE_BRANCH} into {target}",
                "remove_source_branch": False,
                "squash": False,
            })).json()
        except HTTPException as e:
            return {"blocked": f"Could not create the merge request: {_write_refused(e)}", "mr_url": None}

    mr_path = f"/projects/{enc}/merge_requests/{mr['iid']}"
    status = None
    for attempt in range(_MERGE_CHECK_ATTEMPTS):
        current = (await gl.get(mr_path)).json()
        status = current.get("detailed_merge_status") or current.get("merge_status")
        if status not in release_plan.MERGE_STATUS_PENDING:
            break
        await asyncio.sleep(_MERGE_CHECK_DELAY)
    if status not in release_plan.MERGE_STATUS_OK:
        return {"blocked": release_plan.merge_block_reason(status), "mr_url": mr["web_url"]}

    try:
        # sha: refuse if the branch moved after the preview. The other two keep develop in place whatever
        # the project defaults are, and keep its commits, so later releases can see which tag holds them.
        merged = (await gl.put(f"{mr_path}/merge", {
            "sha": sha, "should_remove_source_branch": False, "squash": False,
        })).json()
    except HTTPException as e:
        return {"blocked": f"GitLab did not merge it: {_write_refused(e)}", "mr_url": mr["web_url"]}
    return {"merged_sha": merged.get("merge_commit_sha") or merged.get("sha"), "mr_url": mr["web_url"]}


@app.post("/api/releases/build-tag")
async def build_release_tag(body: BuildTagBody, gl: GL = Depends(get_gl)):
    """Merge develop into master and tag the result. Safe to repeat: each step is skipped once it's done."""
    if not release_plan.parse_tag(body.tag):
        raise HTTPException(status_code=400, detail="The tag must look like vX.Y.Z")
    enc = quote(body.path, safe="")
    repo_url = f"{gl.url}/{body.path}"
    done = {
        "status": "done",
        "tag": body.tag,
        "tag_url": f"{repo_url}/-/tags/{quote(body.tag, safe='')}",
        "pipelines_url": f"{repo_url}/-/pipelines?ref={quote(body.tag, safe='')}",
    }
    if await _exists(gl, _tag_path(enc, body.tag)):
        return done

    target = await _release_target_branch(gl, enc)
    ref = target
    mr_url = None
    if await _commits_ahead(gl, enc, target):
        if await _source_head(gl, enc) != body.source_sha:
            return {"status": "changed"}
        merge = await _merge_release_mr(gl, enc, target, body.tag, body.source_sha)
        mr_url = merge["mr_url"]
        if "blocked" in merge:
            return {"status": "blocked", "reason": merge["blocked"], "mr_url": mr_url, "merged": False}
        ref = merge["merged_sha"] or target

    try:
        await gl.post(f"/projects/{enc}/repository/tags", {"tag_name": body.tag, "ref": ref})
    except HTTPException as e:
        return {"status": "blocked", "reason": f"Could not create the tag: {_write_refused(e)}", "mr_url": mr_url, "merged": ref != target}
    return {**done, "mr_url": mr_url}
