import asyncio
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import httpx
import os
from dotenv import load_dotenv

load_dotenv()

GITLAB_URL = os.environ["GITLAB_URL"].rstrip("/")
GITLAB_TOKEN = os.environ["GITLAB_TOKEN"]
_HEADERS = {"PRIVATE-TOKEN": GITLAB_TOKEN}

app = FastAPI(title="GitLab Dashboard API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


async def _get(client: httpx.AsyncClient, path: str, params: dict | None = None) -> httpx.Response:
    r = await client.get(f"{GITLAB_URL}/api/v4{path}", headers=_HEADERS, params=params)
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r


async def _approvals(client: httpx.AsyncClient, project_id: int, iid: int) -> list[dict]:
    try:
        r = await client.get(
            f"{GITLAB_URL}/api/v4/projects/{project_id}/merge_requests/{iid}/approvals",
            headers=_HEADERS,
        )
        if r.status_code == 200:
            return [entry["user"] for entry in r.json().get("approved_by", [])]
    except Exception:
        pass
    return []


async def _discussion_stats(client: httpx.AsyncClient, project_id: int, iid: int) -> dict:
    try:
        r = await client.get(
            f"{GITLAB_URL}/api/v4/projects/{project_id}/merge_requests/{iid}/discussions",
            headers=_HEADERS,
            params={"per_page": 100},
        )
        if r.status_code == 200:
            total = 0
            resolved_count = 0
            for d in r.json():
                notes = d.get("notes", [])
                resolvable_notes = [n for n in notes if n.get("resolvable")]
                if resolvable_notes:
                    total += 1
                    if all(n.get("resolved") for n in resolvable_notes):
                        resolved_count += 1
            return {"resolved": resolved_count, "total": total}
    except Exception as e:
        print(f"[discussion_stats] project={project_id} iid={iid} error: {e}")
    return {"resolved": 0, "total": 0}


@app.get("/api/health")
async def health():
    return {"status": "ok"}


_AVATAR_ALLOWED = (GITLAB_URL, "https://secure.gravatar.com", "https://www.gravatar.com")

async def _fetch_avatar(url: str) -> httpx.Response | None:
    sep = "&" if "?" in url else "?"
    attempts = [
        dict(headers={"Authorization": f"Bearer {GITLAB_TOKEN}"}),
        dict(headers=_HEADERS),
        dict(url=f"{url}{sep}private_token={GITLAB_TOKEN}"),
    ]
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        for kwargs in attempts:
            fetch_url = kwargs.pop("url", url)
            r = await client.get(fetch_url, **kwargs)
            if r.status_code == 200:
                return r
    return None

@app.get("/api/avatar")
async def proxy_avatar(url: str = Query(...)):
    if not any(url.startswith(o) for o in _AVATAR_ALLOWED):
        raise HTTPException(status_code=400, detail="URL not allowed")
    if url.startswith(GITLAB_URL):
        r = await _fetch_avatar(url)
        if r is None:
            raise HTTPException(status_code=404)
    else:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            r = await client.get(url)
        if r.status_code != 200:
            raise HTTPException(status_code=404)
    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "image/png"),
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/api/me")
async def me():
    async with httpx.AsyncClient(timeout=10) as client:
        r = await _get(client, "/user")
    return r.json()


@app.get("/api/mentions")
async def mentions():
    async with httpx.AsyncClient(timeout=20) as client:
        r = await _get(client, "/todos", {
            "action": "mentioned",
            "state": "pending",
            "per_page": 50,
        })
        todos = r.json()
    seen: set = set()
    mr_list: list = []
    for todo in todos:
        if todo.get("target_type") != "MergeRequest":
            continue
        target = todo.get("target") or {}
        mid = target.get("id")
        if mid and mid not in seen:
            seen.add(mid)
            mr_list.append(target)
    async with httpx.AsyncClient(timeout=30) as client:
        mr_list = await _enrich(client, mr_list)
    return mr_list


@app.get("/api/projects")
async def projects():
    async with httpx.AsyncClient(timeout=15) as client:
        r = await _get(client, "/projects", {
            "membership": True,
            "simple": True,
            "per_page": 100,
            "order_by": "last_activity_at",
            "sort": "desc",
        })
    return r.json()


async def _fetch_project_mrs(
    client: httpx.AsyncClient, project_id: int, params: dict
) -> list[dict]:
    try:
        r = await client.get(
            f"{GITLAB_URL}/api/v4/projects/{project_id}/merge_requests",
            headers=_HEADERS,
            params=params,
        )
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return []


async def _latest_pipeline(client: httpx.AsyncClient, project_id: int, iid: int) -> dict | None:
    try:
        r = await client.get(
            f"{GITLAB_URL}/api/v4/projects/{project_id}/merge_requests/{iid}/pipelines",
            headers=_HEADERS,
            params={"per_page": 50},
        )
        if r.status_code == 200:
            pipelines = r.json()
            for p in pipelines:
                if p.get("source") != "merge_request_event":
                    return p
            if pipelines:
                return pipelines[0]
    except Exception as e:
        print(f"[pipeline] project={project_id} iid={iid} error: {e}")
    return None


async def _enrich(client: httpx.AsyncClient, mr_list: list[dict]) -> list[dict]:
    if not mr_list:
        return []
    approved_by_list, discussion_stats_list, pipeline_list = await asyncio.gather(
        asyncio.gather(*[_approvals(client, mr["project_id"], mr["iid"]) for mr in mr_list]),
        asyncio.gather(*[_discussion_stats(client, mr["project_id"], mr["iid"]) for mr in mr_list]),
        asyncio.gather(*[_latest_pipeline(client, mr["project_id"], mr["iid"]) for mr in mr_list]),
    )
    for mr, approved_by, discussion_stats, pipeline in zip(mr_list, approved_by_list, discussion_stats_list, pipeline_list):
        mr["approved_by_users"] = approved_by
        mr["discussion_stats"] = discussion_stats
        mr["pipeline"] = pipeline
    return mr_list


@app.post("/api/merge-requests/{project_id}/{iid}/approve")
async def approve_mr(project_id: int, iid: int):
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{GITLAB_URL}/api/v4/projects/{project_id}/merge_requests/{iid}/approve",
            headers=_HEADERS,
        )
    if r.status_code not in (200, 201):
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
):
    params: dict = {"per_page": per_page}
    if state != "all":
        params["state"] = state
    if action and action in _TODO_ACTIONS:
        params["action"] = action
    if target_type:
        params["type"] = target_type
    async with httpx.AsyncClient(timeout=20) as client:
        r = await _get(client, "/todos", params)
    return r.json()


@app.post("/api/todos/mark_all_done")
async def mark_all_todos_done():
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{GITLAB_URL}/api/v4/todos/mark_as_done",
            headers=_HEADERS,
        )
    if r.status_code not in (200, 201, 204):
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return {"ok": True}


@app.post("/api/todos/{todo_id}/done")
async def mark_todo_done(todo_id: int):
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{GITLAB_URL}/api/v4/todos/{todo_id}/mark_as_done",
            headers=_HEADERS,
        )
    if r.status_code not in (200, 201, 204):
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return {"ok": True}


@app.get("/api/merge-requests")
async def merge_requests(
    state: str = Query("opened", pattern="^(opened|merged|closed|all)$"),
    scope: str = Query("all", pattern="^(all|created_by_me|assigned_to_me)$"),
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=100),
    search: str = Query(""),
    project_id: int | None = Query(None),
    project_ids: str = Query(""),
):
    base_params: dict = {
        "state": state,
        "scope": scope,
        "order_by": "updated_at",
        "sort": "desc",
    }
    if search:
        base_params["search"] = search

    ids = [int(x) for x in project_ids.split(",") if x.strip().isdigit()] if project_ids else []

    async with httpx.AsyncClient(timeout=30) as client:
        if project_id:
            # Single project — normal paginated request
            r = await _get(client, f"/projects/{project_id}/merge_requests", {**base_params, "page": page, "per_page": per_page})
            mr_list = r.json()
            total = int(r.headers.get("X-Total", 0))
            total_pages = int(r.headers.get("X-Total-Pages", 1))
        elif ids:
            # Multiple selected projects — fetch in parallel, merge and paginate in-memory
            per_project_params = {**base_params, "per_page": 100}
            all_mrs = []
            for batch in await asyncio.gather(*[_fetch_project_mrs(client, pid, per_project_params) for pid in ids]):
                all_mrs.extend(batch)
            all_mrs.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
            total = len(all_mrs)
            total_pages = max(1, -(-total // per_page))  # ceil division
            start = (page - 1) * per_page
            mr_list = all_mrs[start: start + per_page]
        else:
            # Global — no project filter
            r = await _get(client, "/merge_requests", {**base_params, "page": page, "per_page": per_page})
            mr_list = r.json()
            total = int(r.headers.get("X-Total", 0))
            total_pages = int(r.headers.get("X-Total-Pages", 1))

        mr_list = await _enrich(client, mr_list)

    return {
        "items": mr_list,
        "total": total,
        "total_pages": total_pages,
        "page": page,
    }
