"""Domain reads: everything the routes need from GitLab, cached and enriched."""
import asyncio
import time

from . import cache, discussions as disc, graphql
from .cache import MISS
from .config import (
    GRAPHQL_MR_LIMIT, GRAPHQL_PROJECT_BATCH, MAX_MR_PAGES, MAX_NOTE_PAGES,
    MAX_PROJECT_PAGES, USE_GRAPHQL, log,
)
from .gitlab import GL


async def current_user(gl: GL) -> dict:
    key = gl.key("user")
    cached = cache.users.get(key)
    if cached is not MISS:
        return cached
    user = (await gl.get("/user")).json()
    cache.users.set(key, user)
    return user


async def fetch_discussions(gl: GL, project_id: int, iid: int) -> list[dict]:
    key = gl.key("discussions", project_id, iid)
    cached = cache.discussions.get(key)
    if cached is not MISS:
        return cached
    r = await gl.try_get(f"/projects/{project_id}/merge_requests/{iid}/discussions", {"per_page": 100})
    if r is None:
        return []
    result = r.json()
    if not isinstance(result, list):
        return []
    cache.discussions.set(key, result)
    return result


async def approvals(gl: GL, project_id: int, iid: int) -> list[dict]:
    key = gl.key("approvals", project_id, iid)
    cached = cache.approvals.get(key)
    if cached is not MISS:
        return cached
    r = await gl.try_get(f"/projects/{project_id}/merge_requests/{iid}/approvals")
    if r is None:
        return []
    result = [entry["user"] for entry in r.json().get("approved_by", [])]
    cache.approvals.set(key, result)
    return result


def invalidate_approvals(gl: GL, project_id: int, iid: int) -> None:
    """Own approval just changed — drop the cached approver list so the refresh
    that follows shows the new state instead of a minute-old one."""
    cache.approvals.delete(gl.key("approvals", project_id, iid))


async def latest_pipeline(gl: GL, project_id: int, iid: int) -> dict | None:
    key = gl.key("pipeline", project_id, iid)
    cached = cache.pipelines.get(key)
    if cached is not MISS:
        return cached
    r = await gl.try_get(f"/projects/{project_id}/merge_requests/{iid}/pipelines", {"per_page": 50})
    if r is None:
        return None
    pipelines = r.json()
    result = next((p for p in pipelines if p.get("source") != "merge_request_event"), None)
    if result is None and pipelines:
        result = pipelines[0]
    cache.pipelines.set(key, result)
    return result


async def find_approval_note(gl: GL, project_id: int, iid: int, user_id: int, updated_at: str) -> str | None:
    """Timestamp of the newest 'approved this merge request' system note.

    The scan pages through an MR's whole note history, so both hits and misses
    are cached — a miss is the expensive case and used to be repeated on every
    single refresh.
    """
    key = gl.key("approval_at", project_id, iid, user_id, updated_at)
    cached = cache.approval_at.get(key)
    if cached is not MISS:
        return cached

    t0 = time.monotonic()
    found: str | None = None
    page = 1
    while page <= MAX_NOTE_PAGES:
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

    log.debug("approval note %s!%s pages=%s %.2fs → %s",
              project_id, iid, page, time.monotonic() - t0, "found" if found else "none")
    cache.approval_at.set(key, found)
    return found


async def activities_after_approval(gl: GL, project_id: int, iid: int, user_id: int, updated_at: str) -> dict | None:
    key = gl.key("activities", project_id, iid, user_id, updated_at)
    cached = cache.activities.get(key)
    if cached is not MISS:
        return cached

    last_approval_at = await find_approval_note(gl, project_id, iid, user_id, updated_at)
    if last_approval_at is None:
        return None
    approval_dt = disc.parse_dt(last_approval_at)
    if approval_dt is None:
        return None

    commits_r, threads = await asyncio.gather(
        gl.try_get(f"/projects/{project_id}/merge_requests/{iid}/commits", {"per_page": 20}),
        fetch_discussions(gl, project_id, iid),
    )
    new_commits = []
    if commits_r is not None:
        for c in commits_r.json():
            if disc.is_after(c.get("committed_date"), approval_dt):
                new_commits.append({
                    "id":       c.get("id", ""),
                    "short_id": c.get("short_id", ""),
                    "title":    c.get("title", ""),
                })
    new_threads, new_replies, previews = disc.compute_new_threads(threads, approval_dt)
    if not new_commits and not new_threads and not new_replies:
        cache.activities.set(key, None)
        return None
    result = {
        "commits":             new_commits,
        "new_threads":         new_threads,
        "new_replies":         new_replies,
        "new_thread_previews": previews,
    }
    cache.activities.set(key, result)
    return result


# ─── merge request queries ────────────────────────────────────────────────────

async def fetch_project_mrs(gl: GL, project_id: int, params: dict, max_pages: int = MAX_MR_PAGES) -> list[dict]:
    return await gl.get_all(f"/projects/{project_id}/merge_requests", params, max_pages)


async def fetch_global_mrs(gl: GL, params: dict) -> list[dict]:
    return await gl.get_all("/merge_requests", params, MAX_MR_PAGES)


async def fetch_projects(gl: GL) -> list[dict]:
    return await gl.get_all("/projects", {
        "membership": True,
        "simple": True,
        "per_page": 100,
        "order_by": "last_activity_at",
        "sort": "desc",
    }, MAX_PROJECT_PAGES)


def dedupe(batches: list[list[dict]]) -> list[dict]:
    seen: set = set()
    result: list[dict] = []
    for batch in batches:
        for mr in batch:
            if mr["id"] not in seen:
                seen.add(mr["id"])
                result.append(mr)
    result.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
    return result


async def fetch_mrs_for_projects(gl: GL, project_ids: list[int], params: dict,
                                 want: int | None = None) -> tuple[list[dict], int | None]:
    """MRs across several projects, and how many matched in total.

    Prefers one GraphQL query per batch of projects — that arrives with
    approvers, pipeline, diff size and merge status attached, which REST needs
    three extra calls per MR to gather. Any GraphQL failure falls back to REST
    and is remembered, so an instance that rejects the query is not re-probed on
    every request.

    `want` is how many MRs the caller can display. Triage passes None because it
    groups everything open; a paginated list passes page×per_page, which is all
    it could possibly show. GraphQL returns the true match count alongside, so a
    capped read still reports an honest total; REST returns None and leaves the
    caller to count the rows it got.
    """
    if USE_GRAPHQL:
        broken_key = gl.key("graphql_broken")
        budget_key = gl.key("graphql_budget")
        if cache.graphql_broken.get(broken_key) is MISS:
            try:
                remembered = cache.graphql_budget.get(budget_key)
                mrs, total = await graphql.fetch_mrs(
                    gl, project_ids,
                    state=params.get("state", "opened"),
                    first=GRAPHQL_MR_LIMIT,
                    batch=GRAPHQL_PROJECT_BATCH,
                    want=want,
                    recall=(lambda: remembered) if remembered is not MISS else None,
                    remember=lambda size: cache.graphql_budget.set(budget_key, size),
                )
                # Same dedupe+sort as the REST path, so both produce one list in
                # one order regardless of how the batches came back.
                return dedupe([mrs]), total
            except graphql.GraphQLUnavailable as e:
                log.warning("graphql unavailable, falling back to REST: %s", e)
                cache.graphql_broken.set(broken_key, str(e))

    # REST has no cheap count, so its total is however many rows it read — which
    # makes `want` a floor here, never a cap: reading less than before would
    # shrink the page count this view offers.
    max_pages = MAX_MR_PAGES if want is None else max(MAX_MR_PAGES, -(-want // 100))
    batches = await asyncio.gather(
        *[fetch_project_mrs(gl, pid, {**params, "per_page": 100}, max_pages) for pid in project_ids]
    )
    return dedupe(list(batches)), None


async def fetch_targeted_mrs(gl: GL, params: dict) -> list[dict]:
    """scope=all times out on big instances, so ask three targeted questions."""
    user = await current_user(gl)
    user_id = user.get("id")
    p = {**params, "per_page": 100}
    queries = [
        fetch_global_mrs(gl, {**p, "scope": "created_by_me"}),
        fetch_global_mrs(gl, {**p, "scope": "assigned_to_me"}),
    ]
    if user_id:
        queries.append(fetch_global_mrs(gl, {**p, "scope": "all", "reviewer_id": user_id}))
    return dedupe(await asyncio.gather(*queries))


async def enrich(gl: GL, mr_list: list[dict], with_details: bool = False) -> list[dict]:
    """Attach approvers to every MR; `with_details` also attaches pipeline and
    discussion stats for lists the client cannot patch in afterwards."""
    if not mr_list:
        return []

    t0 = time.monotonic()
    # GraphQL already delivered approvers; only REST-sourced MRs need the calls.
    pending = [mr for mr in mr_list if "approved_by_users" not in mr]
    approved_by_list = await asyncio.gather(
        *[approvals(gl, mr["project_id"], mr["iid"]) for mr in pending]
    )
    for mr, approved_by in zip(pending, approved_by_list):
        mr["approved_by_users"] = approved_by

    # The client follows this response with the activities batch, and that
    # batch's first question is "did I approve this one?". Seed the cache it
    # reads, or it spends one GitLab call per MR re-learning what this list
    # already carried — 25 of the 53 calls the Merged tab used to make.
    for mr in mr_list:
        cache.approvals.set(gl.key("approvals", mr["project_id"], mr["iid"]),
                            mr["approved_by_users"])

    if with_details:
        pipelines, threads = await asyncio.gather(
            asyncio.gather(*[latest_pipeline(gl, mr["project_id"], mr["iid"]) for mr in mr_list]),
            asyncio.gather(*[fetch_discussions(gl, mr["project_id"], mr["iid"]) for mr in mr_list]),
        )
        for mr, pipeline, mr_threads in zip(mr_list, pipelines, threads):
            mr["pipeline"] = pipeline
            mr["discussion_stats"] = disc.compute_stats(mr_threads)

    log.debug("enriched %s MRs in %.2fs (details=%s)", len(mr_list), time.monotonic() - t0, with_details)
    return mr_list
