"""Merge request listing, per-MR detail batches and approval actions."""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import discussions as disc, service
from ..gitlab import GL
from ..session import get_gl

router = APIRouter(tags=["merge-requests"])


class MRRef(BaseModel):
    project_id: int
    iid: int
    # Lets the expensive post-approval lookups be cached until the MR actually
    # changes, instead of expiring on a timer.
    updated_at: str = ""


def _by_ref(refs, values) -> dict:
    return {
        f"{ref.project_id}_{ref.iid}": value
        for ref, value in zip(refs, values)
        if value is not None
    }


@router.post("/merge-requests/activities")
async def mr_activities_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    if not refs:
        return {}
    user = await service.current_user(gl)
    me_id = user.get("id")
    if not me_id:
        return {}

    # approvals are cached from the recent main enrich call
    approved_by_list = await asyncio.gather(
        *[service.approvals(gl, ref.project_id, ref.iid) for ref in refs]
    )
    approved_refs = [
        ref for ref, approved_by in zip(refs, approved_by_list)
        if any(u.get("id") == me_id for u in approved_by)
    ]
    if not approved_refs:
        return {}

    activities = await asyncio.gather(
        *[service.activities_after_approval(gl, ref.project_id, ref.iid, me_id, ref.updated_at)
          for ref in approved_refs]
    )
    return _by_ref(approved_refs, activities)


@router.post("/merge-requests/pipelines-batch")
async def mr_pipelines_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    if not refs:
        return {}
    pipelines = await asyncio.gather(
        *[service.latest_pipeline(gl, ref.project_id, ref.iid) for ref in refs]
    )
    return _by_ref(refs, pipelines)


@router.post("/merge-requests/discussion-stats-batch")
async def mr_discussion_stats_batch(refs: list[MRRef], gl: GL = Depends(get_gl)):
    if not refs:
        return {}
    threads = await asyncio.gather(
        *[service.fetch_discussions(gl, ref.project_id, ref.iid) for ref in refs]
    )
    return _by_ref(refs, [disc.compute_stats(t) if t is not None else None for t in threads])


@router.get("/projects/{project_id}/merge_requests/{iid}/discussion-stats")
async def mr_discussion_stats(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    threads = await service.fetch_discussions(gl, project_id, iid)
    if threads is None:
        raise HTTPException(status_code=502, detail="GitLab didn't return this merge request's threads")
    return disc.compute_stats(threads)


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
        service.invalidate_approvals(gl, project_id, iid)
    return {"ok": True}


@router.post("/merge-requests/{project_id}/{iid}/approve")
async def approve_mr(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    return await _approval_action(gl, project_id, iid, "approve")


@router.post("/merge-requests/{project_id}/{iid}/unapprove")
async def unapprove_mr(project_id: int, iid: int, gl: GL = Depends(get_gl)):
    return await _approval_action(gl, project_id, iid, "unapprove")


@router.get("/merge-requests")
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
    base_params: dict = {"state": state, "order_by": "updated_at", "sort": "desc"}
    warnings: list[str] = []
    if search:
        base_params["search"] = search

    ids = [int(x) for x in project_ids.split(",") if x.strip().isdigit()] if project_ids else []

    # One project is a list of one. Sending it down the same path as the rest
    # buys the whole GraphQL payload — approvers, pipeline, diff size, thread
    # counts — instead of a bare REST list the client then has to fill in with
    # three batch calls. Search is the exception: only REST can filter by text.
    if project_id and not search:
        ids = [project_id]

    def paginate(all_mrs: list[dict], known_total: int | None = None) -> tuple[list[dict], int, int]:
        total = len(all_mrs) if known_total is None else known_total
        total_pages = max(1, -(-total // per_page))
        start = (page - 1) * per_page
        return all_mrs[start: start + per_page], total, total_pages

    if triage:
        if ids:
            # Projects selected → fetch all MRs per project directly (shows everything, not just "mine")
            mr_list, _ = await service.fetch_mrs_for_projects(gl, ids, {**base_params, "scope": "all"}, warnings=warnings)
        else:
            # No project filter → targeted queries to avoid scope=all timeout on large instances
            mr_list = await service.fetch_targeted_mrs(gl, base_params, warnings)
        total, total_pages = len(mr_list), 1
    elif project_id and search:
        # Only REST can filter by text, so a search inside one project stays
        # here. Everything else about that project now goes the GraphQL way,
        # below, with `ids` holding it alone.
        r = await gl.get(f"/projects/{project_id}/merge_requests",
                         {**base_params, "scope": scope, "page": page, "per_page": per_page})
        mr_list     = r.json()
        total       = int(r.headers.get("X-Total") or 0)
        total_pages = int(r.headers.get("X-Total-Pages") or 1)
    elif ids:
        # A page of 25 needs at most the newest page×25 from each project — the
        # rest of a project's merged history is never displayed, so never read.
        all_mrs, server_total = await service.fetch_mrs_for_projects(
            gl, ids, {**base_params, "scope": scope}, want=page * per_page, warnings=warnings,
        )
        mr_list, total, total_pages = paginate(all_mrs, server_total)
    elif scope == "all":
        # scope=all on large instances (e.g. gitlab.com) times out — use targeted queries
        mr_list, total, total_pages = paginate(await service.fetch_targeted_mrs(gl, base_params, warnings))
    else:
        r = await gl.get("/merge_requests",
                         {**base_params, "scope": scope, "page": page, "per_page": per_page})
        mr_list     = r.json()
        total       = int(r.headers.get("X-Total") or 0)
        total_pages = int(r.headers.get("X-Total-Pages") or 1)

    return {
        "items":       await service.enrich(gl, mr_list, warnings=warnings),
        "total":       total,
        "total_pages": total_pages,
        "page":        page,
        "warnings":    warnings,
    }
