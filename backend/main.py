import asyncio
import base64
import hashlib
import json
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from fastapi import FastAPI, Query, Cookie, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from cryptography.fernet import Fernet
from pydantic import BaseModel
import httpx
import os
from dotenv import load_dotenv

load_dotenv()

_DEFAULT_URL   = os.environ.get("GITLAB_URL", "").rstrip("/")
_DEFAULT_GROUP = os.environ.get("GITLAB_DEFAULT_GROUP", "").strip()

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
    return {"id": profile["id"], "label": profile["label"], "gitlabUrl": profile["gitlabUrl"]}


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


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


# ─── GitLab context ───────────────────────────────────────────────────────────

class GL:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token
        self.headers = {"PRIVATE-TOKEN": token}

    async def get(self, path: str, params: dict | None = None) -> httpx.Response:
        try:
            r = await _http.get(f"{self.url}/api/v4{path}", headers=self.headers, params=params)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="GitLab API timeout")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"GitLab unreachable: {e}")
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        return r


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
    pages_fetched = 0
    page = 1
    while True:
        r = await _http.get(
            f"{gl.url}/api/v4/projects/{project_id}/merge_requests/{iid}/notes",
            headers=gl.headers,
            params={"per_page": 100, "sort": "desc", "order_by": "created_at", "page": page},
        )
        pages_fetched += 1
        if r.status_code != 200:
            print(f"[approval_note] project={project_id} iid={iid} pages={pages_fetched} {time.time()-t0:.2f}s → not found (http {r.status_code})", flush=True)
            return None
        notes = r.json()
        if not notes:
            print(f"[approval_note] project={project_id} iid={iid} pages={pages_fetched} {time.time()-t0:.2f}s → not found", flush=True)
            return None
        for note in notes:
            if (note.get("system") and
                    note.get("author", {}).get("id") == user_id and
                    note.get("body", "") == "approved this merge request"):
                print(f"[approval_note] project={project_id} iid={iid} pages={pages_fetched} {time.time()-t0:.2f}s → found", flush=True)
                return note["created_at"]
        total_pages = int(r.headers.get("X-Total-Pages", 1))
        if page >= total_pages:
            print(f"[approval_note] project={project_id} iid={iid} pages={pages_fetched} {time.time()-t0:.2f}s → not found (all pages)", flush=True)
            return None
        page += 1


async def _fetch_discussions(gl: GL, project_id: int, iid: int) -> list[dict]:
    key = (gl.url, project_id, iid)
    cached = _cache_get(_discussions_cache, key)
    if cached is not None:
        return cached
    try:
        r = await _http.get(
            f"{gl.url}/api/v4/projects/{project_id}/merge_requests/{iid}/discussions",
            headers=gl.headers,
            params={"per_page": 100},
        )
        if r.status_code == 200:
            result = r.json()
            _cache_set(_discussions_cache, key, result)
            return result
    except Exception as e:
        print(f"[discussions] project={project_id} iid={iid} error: {e}")
    return []


def _strip_markdown(text: str) -> str:
    import re
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
    try:
        last_approval_at = await _find_approval_note(gl, project_id, iid, user_id)
        if last_approval_at is None:
            return None
        approval_dt = _parse_dt(last_approval_at)
        commits_r = await _http.get(
            f"{gl.url}/api/v4/projects/{project_id}/merge_requests/{iid}/commits",
            headers=gl.headers,
            params={"per_page": 20},
        )
        new_commits = []
        if commits_r.status_code == 200:
            for c in commits_r.json():
                if _parse_dt(c.get("committed_date", "")) > approval_dt:
                    new_commits.append({
                        "id":       c.get("id", ""),
                        "short_id": c.get("short_id", ""),
                        "title":    c.get("title", ""),
                    })
        new_threads, new_thread_previews = _compute_new_threads(discussions, approval_dt)
        if not new_commits and new_threads == 0:
            return None
        return {"commits": new_commits, "new_threads": new_threads, "new_thread_previews": new_thread_previews}
    except Exception as e:
        print(f"[activities_after_approval] project={project_id} iid={iid} error: {e}")
        return None


async def _approvals(gl: GL, project_id: int, iid: int) -> list[dict]:
    key = (gl.url, project_id, iid)
    cached = _cache_get(_approvals_cache, key)
    if cached is not None:
        return cached
    try:
        r = await _http.get(
            f"{gl.url}/api/v4/projects/{project_id}/merge_requests/{iid}/approvals",
            headers=gl.headers,
        )
        if r.status_code == 200:
            result = [entry["user"] for entry in r.json().get("approved_by", [])]
            _cache_set(_approvals_cache, key, result)
            return result
    except Exception:
        pass
    return []


async def _latest_pipeline(gl: GL, project_id: int, iid: int) -> dict | None:
    key = (gl.url, project_id, iid)
    cached = _cache_get(_pipeline_cache, key)
    if cached is not None:
        return cached
    try:
        r = await _http.get(
            f"{gl.url}/api/v4/projects/{project_id}/merge_requests/{iid}/pipelines",
            headers=gl.headers,
            params={"per_page": 50},
        )
        if r.status_code == 200:
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
    except Exception as e:
        print(f"[pipeline] project={project_id} iid={iid} error: {e}")
    return None


async def _fetch_project_mrs(gl: GL, project_id: int, params: dict) -> list[dict]:
    try:
        r = await _http.get(
            f"{gl.url}/api/v4/projects/{project_id}/merge_requests",
            headers=gl.headers,
            params=params,
        )
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return []


async def _fetch_targeted_mrs(gl: GL, params: dict) -> list[dict]:
    current_user = await _get_current_user(gl)
    user_id = current_user.get("id")
    p = {**params, "per_page": 100}
    batches = await asyncio.gather(
        _fetch_global_mrs(gl, {**p, "scope": "created_by_me"}),
        _fetch_global_mrs(gl, {**p, "scope": "assigned_to_me"}),
        _fetch_global_mrs(gl, {**p, "scope": "all", "reviewer_id": user_id}) if user_id else asyncio.sleep(0),
    )
    seen: set = set()
    result: list = []
    for batch in batches:
        if not batch:
            continue
        for mr in batch:
            if mr["id"] not in seen:
                seen.add(mr["id"])
                result.append(mr)
    result.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
    return result


async def _fetch_global_mrs(gl: GL, params: dict) -> list[dict]:
    try:
        r = await _http.get(
            f"{gl.url}/api/v4/merge_requests",
            headers=gl.headers,
            params=params,
        )
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return []


async def _enrich(gl: GL, mr_list: list[dict]) -> list[dict]:
    if not mr_list:
        return []

    t0 = time.time()
    approved_by_list = await asyncio.gather(
        *[_approvals(gl, mr["project_id"], mr["iid"]) for mr in mr_list]
    )
    print(f"[enrich] approvals for {len(mr_list)} MRs: {time.time()-t0:.2f}s", flush=True)

    for mr, approved_by in zip(mr_list, approved_by_list):
        mr["approved_by_users"] = approved_by

    return mr_list


_GRAVATAR_ORIGINS = ("https://secure.gravatar.com", "https://www.gravatar.com")


async def _fetch_gitlab_avatar(gl: GL, url: str) -> httpx.Response | None:
    sep = "&" if "?" in url else "?"
    attempts = [
        (url, {"headers": {"Authorization": f"Bearer {gl.token}"}}),
        (url, {"headers": gl.headers}),
        (f"{url}{sep}private_token={gl.token}", {}),
    ]
    for fetch_url, kwargs in attempts:
        r = await _http.get(fetch_url, **kwargs)
        if r.status_code == 200:
            return r
    return None


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


@app.get("/api/avatar")
async def proxy_avatar(url: str = Query(...), gl: GL = Depends(get_gl)):
    allowed = (gl.url,) + _GRAVATAR_ORIGINS
    if not any(url.startswith(o) for o in allowed):
        raise HTTPException(status_code=400, detail="URL not allowed")
    if url.startswith(gl.url):
        r = await _fetch_gitlab_avatar(gl, url)
        if r is None:
            raise HTTPException(status_code=404)
    else:
        r = await _http.get(url)
        if r.status_code != 200:
            raise HTTPException(status_code=404)
    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "image/png"),
        headers={"Cache-Control": "public, max-age=3600"},
    )


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

    discussions_list = await asyncio.gather(
        *[_fetch_discussions(gl, ref.project_id, ref.iid) for ref in approved_refs]
    )
    activities_list = await asyncio.gather(
        *[_activities_after_approval(gl, ref.project_id, ref.iid, me_id, discussions)
          for ref, discussions in zip(approved_refs, discussions_list)]
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


@app.post("/api/merge-requests/{project_id}/{iid}/approve")
async def approve_mr(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    r = await _http.post(
        f"{gl.url}/api/v4/projects/{project_id}/merge_requests/{iid}/approve",
        headers=gl.headers,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return {"ok": True}


@app.post("/api/merge-requests/{project_id}/{iid}/unapprove")
async def unapprove_mr(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    r = await _http.post(
        f"{gl.url}/api/v4/projects/{project_id}/merge_requests/{iid}/unapprove",
        headers=gl.headers,
    )
    if r.status_code not in (200, 201, 204):
        raise HTTPException(status_code=r.status_code, detail=r.text)
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
    r = await _http.post(f"{gl.url}/api/v4/todos/mark_as_done", headers=gl.headers)
    if r.status_code not in (200, 201, 204):
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return {"ok": True}


@app.post("/api/todos/{todo_id}/done")
async def mark_todo_done(todo_id: int, gl: GL = Depends(get_gl)):
    r = await _http.post(
        f"{gl.url}/api/v4/todos/{todo_id}/mark_as_done",
        headers=gl.headers,
    )
    if r.status_code not in (200, 201, 204):
        raise HTTPException(status_code=r.status_code, detail=r.text)
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

    if triage:
        if ids:
            # Projects selected → fetch all MRs per project directly (shows everything, not just "mine")
            batches = await asyncio.gather(
                *[_fetch_project_mrs(gl, pid, {**base_params, "scope": "all", "per_page": 100}) for pid in ids]
            )
            seen: set = set()
            mr_list: list = []
            for batch in batches:
                for mr in batch:
                    if mr["id"] not in seen:
                        seen.add(mr["id"])
                        mr_list.append(mr)
            mr_list.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
        else:
            # No project filter → targeted queries to avoid scope=all timeout on large instances
            mr_list = await _fetch_targeted_mrs(gl, base_params)
        total = len(mr_list)
        total_pages = 1
    elif project_id:
        r = await gl.get(f"/projects/{project_id}/merge_requests", {**base_params, "scope": scope, "page": page, "per_page": per_page})
        mr_list    = r.json()
        total      = int(r.headers.get("X-Total", 0))
        total_pages = int(r.headers.get("X-Total-Pages", 1))
    elif ids:
        per_project_params = {**base_params, "scope": scope, "per_page": 100}
        all_mrs: list = []
        for batch in await asyncio.gather(*[_fetch_project_mrs(gl, pid, per_project_params) for pid in ids]):
            all_mrs.extend(batch)
        all_mrs.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
        total       = len(all_mrs)
        total_pages = max(1, -(-total // per_page))
        start       = (page - 1) * per_page
        mr_list     = all_mrs[start: start + per_page]
    elif scope == "all":
        # scope=all on large instances (e.g. gitlab.com) times out — use targeted queries
        all_mrs     = await _fetch_targeted_mrs(gl, base_params)
        total       = len(all_mrs)
        total_pages = max(1, -(-total // per_page))
        start       = (page - 1) * per_page
        mr_list     = all_mrs[start: start + per_page]
    else:
        r = await gl.get("/merge_requests", {**base_params, "scope": scope, "page": page, "per_page": per_page})
        mr_list    = r.json()
        total      = int(r.headers.get("X-Total", 0))
        total_pages = int(r.headers.get("X-Total-Pages", 1))

    return {
        "items":       await _enrich(gl, mr_list),
        "total":       total,
        "total_pages": total_pages,
        "page":        page,
    }
