import asyncio
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
    allow_methods=["GET"],
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


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/me")
async def me():
    async with httpx.AsyncClient(timeout=10) as client:
        r = await _get(client, "/user")
    return r.json()


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


@app.get("/api/merge-requests")
async def merge_requests(
    state: str = Query("opened", pattern="^(opened|merged|closed|all)$"),
    scope: str = Query("all", pattern="^(all|created_by_me|assigned_to_me)$"),
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=100),
    search: str = Query(""),
    project_id: int | None = Query(None),
):
    params: dict = {
        "state": state,
        "page": page,
        "per_page": per_page,
        "order_by": "updated_at",
        "sort": "desc",
    }
    if search:
        params["search"] = search

    path = f"/projects/{project_id}/merge_requests" if project_id else "/merge_requests"
    if not project_id:
        params["scope"] = scope

    async with httpx.AsyncClient(timeout=15) as client:
        r = await _get(client, path, params)
        mr_list: list[dict] = r.json()

        approved_by_list = await asyncio.gather(*[
            _approvals(client, mr["project_id"], mr["iid"]) for mr in mr_list
        ])

    for mr, approved_by in zip(mr_list, approved_by_list):
        mr["approved_by_users"] = approved_by

    return {
        "items": mr_list,
        "total": int(r.headers.get("X-Total", 0)),
        "total_pages": int(r.headers.get("X-Total-Pages", 1)),
        "page": page,
    }
