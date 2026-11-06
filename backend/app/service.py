"""Domain reads: everything the routes need from GitLab, cached and enriched."""
import asyncio
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import HTTPException

from . import cache, discussions as disc, graphql
from .cache import MISS
from .config import (
    GRAPHQL_MR_LIMIT, GRAPHQL_PROJECT_BATCH, MAX_DISCUSSION_PAGES, MAX_MR_PAGES, MAX_NOTE_PAGES,
    MAX_PROJECT_PAGES, MAX_TODO_PAGES, USE_GRAPHQL, log,
)
from .gitlab import GL, gather_settled, why


async def current_user(gl: GL) -> dict:
    key = gl.key("user")
    cached = cache.users.get(key)
    if cached is not MISS:
        return cached
    user = (await gl.get("/user")).json()
    cache.users.set(key, user)
    return user


async def fetch_discussions(gl: GL, project_id: int, iid: int) -> list[dict] | None:
    """Every thread of an MR, or None when GitLab couldn't say: a failed call must not pass for "no threads"."""
    key = gl.key("discussions", project_id, iid)
    cached = cache.discussions.get(key)
    if cached is not MISS:
        return cached
    try:
        result = await gl.get_all(
            f"/projects/{project_id}/merge_requests/{iid}/discussions", {"per_page": 100},
            MAX_DISCUSSION_PAGES, strict=True,
        )
    except HTTPException as e:
        if e.status_code == 401:  # the token is dead, which is not an "unknown"
            raise
        return None
    except ValueError:  # not JSON, e.g. a proxy's error page sent with 200
        return None
    cache.discussions.set(key, result)
    return result


async def approvals_or_none(gl: GL, project_id: int, iid: int) -> list[dict] | None:
    """Who approved this MR, or None when GitLab couldn't say: a failed call must not pass for "no approvals"."""
    key = gl.key("approvals", project_id, iid)
    cached = cache.approvals.get(key)
    if cached is not MISS:
        return cached
    try:
        r = await gl.get(f"/projects/{project_id}/merge_requests/{iid}/approvals")
    except HTTPException as e:
        if e.status_code == 401:  # the token is dead: no list can be right, so this isn't an "unknown"
            raise
        return None
    result = [entry["user"] for entry in r.json().get("approved_by", [])]
    cache.approvals.set(key, result)
    return result


async def approvals(gl: GL, project_id: int, iid: int) -> list[dict]:
    return await approvals_or_none(gl, project_id, iid) or []


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
                message = (c.get("message") or "").strip()
                new_commits.append({
                    "id":       c.get("id", ""),
                    "short_id": c.get("short_id", ""),
                    "title":    c.get("title", ""),
                    # A thread preview answers who, when and what; a commit that
                    # landed on an approved MR deserves the same three, and the
                    # date is already in hand — it is what the filter above reads.
                    "author":   c.get("author_name") or "",
                    "created_at": c.get("committed_date"),
                    "web_url":  c.get("web_url"),
                    # Everything past the subject line, where people explain why.
                    "body":     message.split("\n", 1)[1].strip() if "\n" in message else "",
                })
    new_threads, new_replies, previews = disc.compute_new_threads(threads or [], approval_dt)
    result = {
        "commits":             new_commits,
        "new_threads":         new_threads,
        "new_replies":         new_replies,
        "new_thread_previews": previews,
    } if new_commits or new_threads or new_replies else None
    # This cache only ends when the MR changes, so a read that failed must not be remembered as "no activity".
    if commits_r is not None and threads is not None:
        cache.activities.set(key, result)
    return result


# ─── merge request queries ────────────────────────────────────────────────────

async def fetch_project_mrs(gl: GL, project_id: int, params: dict, max_pages: int = MAX_MR_PAGES) -> list[dict]:
    return await gl.get_all(f"/projects/{project_id}/merge_requests", params, max_pages, strict=True)


async def fetch_global_mrs(gl: GL, params: dict) -> list[dict]:
    return await gl.get_all("/merge_requests", params, MAX_MR_PAGES, strict=True)


async def fetch_projects(gl: GL) -> list[dict]:
    return await gl.get_all("/projects", {
        "membership": True,
        "simple": True,
        "per_page": 100,
        "order_by": "last_activity_at",
        "sort": "desc",
    }, MAX_PROJECT_PAGES, strict=True)


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


async def _settled_batches(queries: list, what: str, warnings: list[str] | None) -> list[list[dict]]:
    """Run MR queries, reporting partial failures. If every query failed there is nothing to show, so raise."""
    results = await gather_settled(queries)
    failed = [res for res in results if isinstance(res, Exception)]
    if failed and len(failed) == len(results):
        raise failed[0]
    if failed and warnings is not None:
        warnings.append(f"Could not load {len(failed)} of {len(results)} {what}: {why(failed[0])}")
    return [res for res in results if not isinstance(res, Exception)]


async def fetch_mrs_for_projects(gl: GL, project_ids: list[int], params: dict, want: int | None = None,
                                 warnings: list[str] | None = None) -> tuple[list[dict], int | None]:
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

    The GraphQL query has no text search and no "mine", so a list narrowed by
    either goes straight to REST: answering anyway would show the whole list as
    if it were the filtered one.
    """
    graphql_can_answer = not params.get("search") and params.get("scope", "all") == "all"
    if USE_GRAPHQL and graphql_can_answer:
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
    batches = await _settled_batches(
        [fetch_project_mrs(gl, pid, {**params, "per_page": 100}, max_pages) for pid in project_ids],
        "selected projects", warnings,
    )
    return dedupe(batches), None


async def fetch_targeted_mrs(gl: GL, params: dict, warnings: list[str] | None = None) -> list[dict]:
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
    return dedupe(await _settled_batches(queries, "MR queries", warnings))


async def enrich(gl: GL, mr_list: list[dict], with_details: bool = False,
                 warnings: list[str] | None = None) -> list[dict]:
    """Attach approvers to every MR, None where they are unknown; `with_details`
    also attaches pipeline and discussion stats for lists the client cannot
    patch in afterwards."""
    if not mr_list:
        return []

    t0 = time.monotonic()
    # GraphQL already delivered approvers; only REST-sourced MRs need the calls.
    pending = [mr for mr in mr_list if "approved_by_users" not in mr]
    approved_by_list = await asyncio.gather(
        *[approvals_or_none(gl, mr["project_id"], mr["iid"]) for mr in pending]
    )
    for mr, approved_by in zip(pending, approved_by_list):
        mr["approved_by_users"] = approved_by
    unknown = approved_by_list.count(None)
    if unknown and warnings is not None:
        warnings.append(f"Approvals unavailable for {unknown} MRs, so they may sit in the wrong bucket")

    # The client follows this response with the activities batch, and that
    # batch's first question is "did I approve this one?". Seed the cache it
    # reads, or it spends one GitLab call per MR re-learning what this list
    # already carried — 25 of the 53 calls the Merged tab used to make.
    for mr in mr_list:
        if mr["approved_by_users"] is not None:
            cache.approvals.set(gl.key("approvals", mr["project_id"], mr["iid"]),
                                mr["approved_by_users"])

    if with_details:
        pipelines, threads = await asyncio.gather(
            asyncio.gather(*[latest_pipeline(gl, mr["project_id"], mr["iid"]) for mr in mr_list]),
            asyncio.gather(*[fetch_discussions(gl, mr["project_id"], mr["iid"]) for mr in mr_list]),
        )
        for mr, pipeline, mr_threads in zip(mr_list, pipelines, threads):
            mr["pipeline"] = pipeline
            mr["discussion_stats"] = disc.compute_stats(mr_threads) if mr_threads is not None else None

    log.debug("enriched %s MRs in %.2fs (details=%s)", len(mr_list), time.monotonic() - t0, with_details)
    return mr_list


# ─── work that never went through review ──────────────────────────────────────

def _recent(iso: str | None, days: int) -> bool:
    dt = disc.parse_dt(iso)
    return dt is not None and (datetime.now(timezone.utc) - dt).days < days



def wants_merge_request(branch: dict, days: int) -> bool:
    """Whether this branch is work that still needs review.

    The trunk is not: nobody opens a merge request *from* the branch everything
    merges into, and what lands there unreviewed is the other half of this
    question. Neither is a branch already merged, nor one nothing has touched in
    weeks — that is somebody's abandoned experiment, not a review queue.
    """
    return (
        not branch.get("default")
        and not branch.get("protected")
        and not branch.get("merged")
        and _recent((branch.get("commit") or {}).get("committed_date"), days)
    )


def arrived_without_a_merge(commit: dict) -> bool:
    """Whether this trunk commit could have reached the branch without a merge.

    Read along `first_parent`, a commit with two parents is the merge itself, so
    a merge request did its job. One parent means the change was written onto
    the branch — either pushed straight there, or squashed by a merge request,
    and the shape of the commit cannot tell those apart. So this is a suspicion,
    not a verdict; GitLab settles it.
    """
    parents = commit.get("parent_ids") or []
    # A root commit has no parent to merge from: it is where the repository
    # began, and nobody was ever going to review it.
    return len(parents) == 1


async def project_branches(gl: GL, project_ids: list[int]) -> dict[int, list[dict]]:
    """Every branch of every selected project, one call each.

    This one listing answers all of it: which branch is the trunk, which are
    protected, which are already merged, and when each was last touched — so
    nothing below has to ask again.
    """
    listings = await asyncio.gather(*[
        gl.get_all(f"/projects/{pid}/repository/branches", {"per_page": 100}, 2)
        for pid in project_ids
    ])
    return dict(zip(project_ids, listings))


async def branches_without_mr(gl: GL, projects: dict[int, dict],
                              branches: dict[int, list[dict]], days: int) -> list[dict]:
    """Branches nobody opened a merge request for — work in progress that no
    reviewer can see yet.

    The trunk is excluded on purpose: nobody opens a merge request *from* the
    branch everything merges into. What lands there without review is a
    different question, answered by commits_without_mr.
    """
    candidates = [
        (pid, b) for pid, listing in branches.items() for b in listing
        if wants_merge_request(b, days)
    ]

    existing = await asyncio.gather(*[
        gl.try_get(f"/projects/{pid}/merge_requests",
                   {"source_branch": b["name"], "state": "all", "per_page": 1})
        for pid, b in candidates
    ])

    out = []
    for (pid, b), r in zip(candidates, existing):
        if r is not None and r.json():
            continue
        project, commit = projects.get(pid) or {}, b.get("commit") or {}
        web = project.get("web_url")
        out.append({
            "project_id":   pid,
            "project_path": project.get("path_with_namespace") or "",
            "project_url":  web,
            "branch":       b["name"],
            "branch_url":   f"{web}/-/tree/{quote(b['name'], safe='')}" if web else None,
            "commit_title": commit.get("title") or "",
            "author":       commit.get("author_name") or "",
            "pushed_at":    commit.get("committed_date"),
            "create_mr_url": (
                f"{project['web_url']}/-/merge_requests/new"
                f"?merge_request%5Bsource_branch%5D={quote(b['name'], safe='')}"
                if project.get("web_url") else None
            ),
        })
    out.sort(key=lambda b: b.get("pushed_at") or "", reverse=True)
    return out


async def commits_without_mr(gl: GL, projects: dict[int, dict],
                             branches: dict[int, list[dict]], days: int) -> list[dict]:
    """Commits that reached a protected or default branch without a merge request.

    `first_parent` is what makes this affordable and correct: it walks the trunk
    itself rather than every commit of every branch ever merged into it. On that
    line a merge commit means an MR did its job, and anything with a single
    parent is a change that arrived some other way.
    """
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    trunks = [
        (pid, b["name"]) for pid, listing in branches.items() for b in listing
        if (b.get("default") or b.get("protected"))
        # The listing already says when this branch was last committed to. If
        # that was before the window, its history inside the window is empty and
        # reading it would be a round trip to be told nothing happened.
        and _recent((b.get("commit") or {}).get("committed_date"), days)
    ]
    histories = await asyncio.gather(*[
        gl.try_get(f"/projects/{pid}/repository/commits",
                   {"ref_name": name, "first_parent": "true", "since": since, "per_page": 100})
        for pid, name in trunks
    ])

    # A protected branch and the default branch share history, so the same
    # commit turns up on both. It is one commit that skipped review, not two:
    # collect the branches it sits on instead of repeating it per branch.
    suspects: dict[tuple[int, str], dict] = {}
    for (pid, name), r in zip(trunks, histories):
        for c in (r.json() if r is not None else []):
            if not arrived_without_a_merge(c):
                continue
            found = suspects.setdefault((pid, c["id"]), {"commit": c, "branches": []})
            found["branches"].append(name)
    log.debug("commits_without_mr: %s suspects on %s trunks", len(suspects), len(trunks))

    # A squash or fast-forward merge also leaves one parent, so the shape of the
    # commit cannot settle it — only GitLab knows whether an MR carried it.
    carried = await asyncio.gather(*[
        gl.try_get(f"/projects/{pid}/repository/commits/{sha}/merge_requests")
        for pid, sha in suspects
    ])

    out = []
    for ((pid, _), found), r in zip(suspects.items(), carried):
        if r is None or r.json():
            continue
        c, project = found["commit"], projects.get(pid) or {}
        out.append({
            "project_id":   pid,
            "project_path": project.get("path_with_namespace") or "",
            "project_url":  project.get("web_url"),
            "branches":     found["branches"],
            "short_id":     c.get("short_id") or "",
            "title":        c.get("title") or "",
            "author":       c.get("author_name") or "",
            "created_at":   c.get("committed_date"),
            "web_url":      c.get("web_url"),
        })
    out.sort(key=lambda c: c.get("created_at") or "", reverse=True)
    return out


async def unreviewed(gl: GL, project_ids: list[int], days: int, refresh: bool = False) -> dict:
    """Both halves of "what has not been through review", from one branch listing."""
    key = gl.key("unreviewed", days, tuple(sorted(project_ids)))
    cached = cache.unreviewed.get(key)
    if cached is not MISS and not refresh:
        return cached

    projects = {p["id"]: p for p in await fetch_projects(gl)}
    ids = project_ids or list(projects)
    branches = await project_branches(gl, ids)

    branch_rows, commit_rows = await asyncio.gather(
        branches_without_mr(gl, projects, branches, days),
        commits_without_mr(gl, projects, branches, days),
    )
    result = {"branches": branch_rows, "commits": commit_rows}
    cache.unreviewed.set(key, result)
    log.info("unreviewed: %s branches, %s commits across %s projects",
             len(branch_rows), len(commit_rows), len(ids))
    return result


# GitLab splits being tagged in two: `mentioned` when your handle appears
# somewhere in the body, `directly_addressed` when the comment opens with it.
# Asking only for the first misses every "@name, take a look" ever written.
MENTION_ACTIONS = ("mentioned", "directly_addressed")


async def mentioned_merge_requests(gl: GL) -> list[dict]:
    """Merge requests where somebody tagged you and you have not looked yet."""
    todos = await gl.get_all("/todos", {"state": "pending", "per_page": 100}, MAX_TODO_PAGES, strict=True)
    seen: set = set()
    out: list[dict] = []
    for todo in todos:
        if todo.get("target_type") != "MergeRequest":
            continue
        if todo.get("action_name") not in MENTION_ACTIONS:
            continue
        target = todo.get("target") or {}
        mid = target.get("id")
        if mid and mid not in seen:
            seen.add(mid)
            out.append(target)
    return out
