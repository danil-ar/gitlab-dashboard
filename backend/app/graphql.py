"""GraphQL reads.

One query per batch of projects returns what REST needs four calls per MR to
assemble: the MR list plus approvers, reviewers, pipeline, diff size and merge
status. Everything is mapped back into the REST-shaped dicts the rest of the
app already speaks, so this is a swap-in — nothing downstream has to know.
"""
import asyncio
import re

from fastapi import HTTPException

from .config import GRAPHQL_PIPELINE_DEPTH as PIPELINE_DEPTH, MAX_MR_PAGES as MAX_PAGES, log
from .gitlab import GL

# Verified against GitLab 18.4.3. Every field here must exist: GraphQL fails the
# whole query on one unknown field, which is why the caller falls back to REST.
_MR_FIELDS = """
fragment MRFields on MergeRequest {
  id
  iid
  title
  state
  draft
  conflicts
  webUrl
  createdAt
  updatedAt
  sourceBranch
  targetBranch
  reference(full: true)
  detailedMergeStatus
  author { id name username avatarUrl }
  assignees { nodes { id name username avatarUrl } }
  reviewers { nodes { id name username avatarUrl } }
  approvedBy { nodes { id name username avatarUrl } }
  labels { nodes { title } }
  pipelines(first: $pipelines) { nodes { id status source path createdAt } }
  diffStatsSummary { additions deletions fileCount }
  resolvableDiscussionsCount
  resolvedDiscussionsCount
}
"""

MR_QUERY = _MR_FIELDS + """
query DashboardMRs($ids: [ID!], $state: MergeRequestState!, $first: Int!, $pipelines: Int!) {
  projects(ids: $ids) {
    nodes {
      id
      fullPath
      mergeRequests(state: $state, sort: UPDATED_DESC, first: $first) {
        count
        pageInfo { hasNextPage endCursor }
        nodes { ...MRFields }
      }
    }
  }
}
"""

# Same shape, one project, resumed from a cursor: without this a project with
# more open MRs than `first` would silently lose the rest.
MORE_QUERY = _MR_FIELDS + """
query MoreMRs($ids: [ID!], $state: MergeRequestState!, $first: Int!, $after: String!, $pipelines: Int!) {
  projects(ids: $ids) {
    nodes {
      id
      fullPath
      mergeRequests(state: $state, sort: UPDATED_DESC, first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ...MRFields }
      }
    }
  }
}
"""

_GID = re.compile(r"/(\d+)$")


def gid_int(gid: str | int | None) -> int | None:
    """"gid://gitlab/User/314" → 314. GraphQL speaks global ids; the frontend
    compares plain numeric ids, so they have to be unwrapped."""
    if isinstance(gid, int):
        return gid
    if not gid:
        return None
    m = _GID.search(str(gid))
    return int(m.group(1)) if m else None


def _absolute(url: str | None, base: str) -> str | None:
    """Avatar paths come back relative ("/uploads/-/system/..."); REST gives
    absolute URLs and the frontend puts them straight into <img src>."""
    if not url:
        return None
    return url if url.startswith(("http://", "https://")) else f"{base}{url}"


def map_user(node: dict | None, base: str) -> dict | None:
    if not node:
        return None
    return {
        "id":         gid_int(node.get("id")),
        "name":       node.get("name") or "",
        "username":   node.get("username") or "",
        "avatar_url": _absolute(node.get("avatarUrl"), base),
    }


def _map_users(container: dict | None, base: str) -> list[dict]:
    nodes = (container or {}).get("nodes") or []
    return [u for u in (map_user(n, base) for n in nodes) if u]


def pick_pipeline(nodes: list[dict] | None) -> dict | None:
    """The pipeline worth showing on a review dashboard: the newest branch build.

    Not `headPipeline` — on an MR that has both, the head pipeline is the
    detached `merge_request_event` one, often a manual gate sitting at MANUAL,
    while the branch pipeline beside it is what actually went red. Showing the
    former hides broken builds.

    The list is sorted here rather than trusted: GraphQL connections make no
    ordering promise, and picking the oldest build instead of the newest is the
    difference between "this MR is broken" and "this MR was broken in January".
    """
    if not nodes:
        return None
    newest_first = sorted(
        nodes,
        key=lambda p: (p.get("createdAt") or "", gid_int(p.get("id")) or 0),
        reverse=True,
    )
    return next(
        (p for p in newest_first if p.get("source") != "merge_request_event"),
        newest_first[0],
    )


def map_merge_request(node: dict, project_id: int | None, base: str) -> dict:
    """GraphQL MR node → the REST-shaped dict the frontend already consumes."""
    pipeline = pick_pipeline((node.get("pipelines") or {}).get("nodes"))
    diff     = node.get("diffStatsSummary") or {}
    out = {
        "id":            gid_int(node.get("id")),
        "iid":           int(node["iid"]),          # GraphQL returns this as a string
        "project_id":    project_id,
        "title":         node.get("title") or "",
        "state":         (node.get("state") or "").lower(),
        "draft":         bool(node.get("draft")),
        "has_conflicts": bool(node.get("conflicts")),
        "web_url":       node.get("webUrl"),
        "created_at":    node.get("createdAt"),
        "updated_at":    node.get("updatedAt"),
        "source_branch": node.get("sourceBranch"),
        "target_branch": node.get("targetBranch"),
        "references":    {"full": node.get("reference")},
        "author":        map_user(node.get("author"), base),
        "assignees":     _map_users(node.get("assignees"), base),
        "reviewers":     _map_users(node.get("reviewers"), base),
        "labels":        [l["title"] for l in ((node.get("labels") or {}).get("nodes") or [])],
        # Already resolved here, so the client never has to ask for them again.
        "approved_by_users": _map_users(node.get("approvedBy"), base),
        "pipeline": {
            "id":      gid_int(pipeline.get("id")),
            # REST reports "success"; GraphQL shouts "SUCCESS" and the UI keys off
            # the lowercase form.
            "status":  (pipeline.get("status") or "").lower(),
            "web_url": _absolute(pipeline.get("path"), base),
        } if pipeline else None,
        # New signals REST did not hand us cheaply:
        "detailed_merge_status": node.get("detailedMergeStatus"),
        "diff_stats": {
            "additions": diff.get("additions"),
            "deletions": diff.get("deletions"),
            "files":     diff.get("fileCount"),
        } if diff else None,
    }
    if "resolvableDiscussionsCount" in node:
        # Counted server-side, so the row's "11/12" costs nothing. The thread
        # text behind it is a separate, per-MR question — see ThreadsStatus.
        out["discussion_stats"] = {
            "resolved": node.get("resolvedDiscussionsCount") or 0,
            "total":    node.get("resolvableDiscussionsCount") or 0,
        }
    return out


def map_response(payload: dict, base: str) -> list[dict]:
    projects = ((payload.get("data") or {}).get("projects") or {}).get("nodes") or []
    out: list[dict] = []
    for project in projects:
        project_id = gid_int(project.get("id"))
        for node in ((project.get("mergeRequests") or {}).get("nodes") or []):
            out.append(map_merge_request(node, project_id, base))
    return out


class GraphQLUnavailable(Exception):
    """The query did not work here — caller should fall back to REST."""


class TooComplex(GraphQLUnavailable):
    """The instance's complexity budget rejected this query size."""


def total_count(payload: dict) -> int:
    """How many MRs match in total, not how many were shipped.

    GitLab counts server-side, so a paginated view can show a true total without
    anyone downloading every row to count them.
    """
    return sum(
        ((p.get("mergeRequests") or {}).get("count") or 0)
        for p in ((payload.get("data") or {}).get("projects") or {}).get("nodes") or []
    )


def truncated_projects(payload: dict) -> list[tuple[int, str]]:
    """(project_id, cursor) for projects whose MR list did not fit in one page."""
    out = []
    for project in ((payload.get("data") or {}).get("projects") or {}).get("nodes") or []:
        page = ((project.get("mergeRequests") or {}).get("pageInfo") or {})
        if page.get("hasNextPage") and page.get("endCursor"):
            pid = gid_int(project.get("id"))
            if pid is not None:
                out.append((pid, page["endCursor"]))
    return out


async def _query(gl: GL, variables: dict, document: str = MR_QUERY) -> dict:
    r = await gl._send(
        "POST", f"{gl.url}/api/graphql",
        json={"query": document, "variables": variables},
    )
    if r.status_code != 200:
        raise GraphQLUnavailable(f"HTTP {r.status_code}")
    payload = r.json()
    if payload.get("errors"):
        # Unknown field, complexity ceiling, permissions — all land here.
        message = "; ".join(e.get("message", "?") for e in payload["errors"])[:300]
        # "Query has complexity of 276, which exceeds max complexity of 250" is
        # not a broken query, just too big a bite — worth retrying smaller.
        if "complexity" in message.lower():
            raise TooComplex(message)
        raise GraphQLUnavailable(message)
    return payload


def _profiles(batch: int, first: int) -> list[tuple[int, int]]:
    """Query sizes to try, largest first.

    Instances cap query complexity (GitLab's default is 250) and the ceiling is
    not discoverable up front — it depends on the fields asked for. Rather than
    make the operator tune constants, walk down until one fits.
    """
    candidates = [
        (batch, first),
        (max(1, batch // 2), first),
        (1, first),
        (1, max(10, first // 2)),
        (1, 10),
    ]
    seen: set = set()
    return [c for c in candidates if not (c in seen or seen.add(c))]


async def _drain(gl: GL, project_id: int, cursor: str, state: str,
                 first: int, pipelines: int, want: int | None = None) -> list[dict]:
    """Keep pulling one project's remaining MR pages from where the batch stopped.

    Without `want` the read is open-ended, so MAX_PAGES is the only brake. With
    it the caller has named a finite target — deep page 13 of a paginated list —
    and stopping at MAX_PAGES would quietly hand back the wrong rows, so the
    budget follows the target instead.
    """
    out: list[dict] = []
    pages = 0
    budget = MAX_PAGES if want is None else -(-want // first)
    while cursor and pages < budget and (want is None or len(out) + first < want):
        payload = await _query(gl, {
            "ids":       [f"gid://gitlab/Project/{project_id}"],
            "state":     state,
            "first":     first,
            "after":     cursor,
            "pipelines": pipelines,
        }, document=MORE_QUERY)
        out.extend(map_response(payload, gl.url))
        pages += 1
        remaining = truncated_projects(payload)
        cursor = remaining[0][1] if remaining else ""
    if cursor and want is None:
        log.warning("project %s still has more MRs after %s extra pages", project_id, pages)
    return out


async def _fetch_with_size(gl: GL, project_ids: list[int], state: str,
                           first: int, batch: int, pipelines: int,
                           want: int | None) -> tuple[list[dict], int]:
    """`want` is how many MRs per project the caller can possibly need.

    A paginated view showing the newest 25 across projects needs only the newest
    25 from each — reading a project's whole merged history to display a page of
    it is what turned the Merged tab into a 21-second request.
    """
    page_size = first if want is None else min(first, want)
    chunks = [project_ids[i:i + batch] for i in range(0, len(project_ids), batch)]
    payloads = await asyncio.gather(*[
        _query(gl, {
            "ids":       [f"gid://gitlab/Project/{pid}" for pid in chunk],
            "state":     state,
            "first":     page_size,
            "pipelines": pipelines,
        })
        for chunk in chunks
    ])
    out: list[dict] = []
    total = 0
    overflow: list[tuple[int, str]] = []
    for payload in payloads:
        out.extend(map_response(payload, gl.url))
        total += total_count(payload)
        overflow.extend(truncated_projects(payload))

    if want is not None and page_size >= want:
        overflow = []  # already have everything this view can display

    if overflow:
        # A busy project must not lose MRs just because it did not fit one page.
        log.info("graphql: %s project(s) exceeded first=%s, fetching the rest", len(overflow), page_size)
        for extra in await asyncio.gather(
            *[_drain(gl, pid, cursor, state, page_size, pipelines, want) for pid, cursor in overflow]
        ):
            out.extend(extra)

    log.debug("graphql: %s of %s MRs from %s projects in %s queries (batch=%s first=%s)",
              len(out), total, len(project_ids), len(chunks), batch, page_size)
    return out, total


async def fetch_mrs(gl: GL, project_ids: list[int], state: str, first: int, batch: int,
                    pipelines: int = PIPELINE_DEPTH, want: int | None = None,
                    remember=None, recall=None) -> tuple[list[dict], int]:
    """MRs for many projects, plus how many matched in total.

    Shrinks the query until the instance's complexity budget accepts it, and
    remembers the size that worked so the search happens once, not per request —
    but only for reads that actually exercised that size.
    `want` caps how many MRs per project are actually read — see _fetch_with_size.
    Raises GraphQLUnavailable only if even the smallest query is refused.
    """
    if not project_ids:
        return [], 0

    known = recall() if recall else None
    profiles = _profiles(*known) if known else _profiles(batch, first)

    last: Exception | None = None
    for size in profiles:
        try:
            result = await _fetch_with_size(gl, project_ids, state, size[1], size[0], pipelines, want)
        except TooComplex as e:
            last = e
            log.info("graphql too complex at batch=%s first=%s (%s), trying smaller", size[0], size[1], e)
            continue
        # A `want`-capped request may have been accepted only because it asked
        # for fewer MRs than `size` names; remembering it would claim the
        # instance tolerates a query that was never sent.
        proven = want is None or want >= size[1]
        if remember and proven and size != known:
            remember(size)
            log.info("graphql settled on batch=%s first=%s", size[0], size[1])
        return result
    raise last or GraphQLUnavailable("no workable query size")


def _raw_pipelines(payload: dict, iid: int) -> list[dict] | None:
    """The pipeline list exactly as the batch query returned it, for one MR."""
    for project in ((payload.get("data") or {}).get("projects") or {}).get("nodes") or []:
        for node in ((project.get("mergeRequests") or {}).get("nodes") or []):
            if int(node["iid"]) == iid:
                return [
                    {"id": gid_int(p.get("id")), "status": p.get("status"),
                     "source": p.get("source")}
                    for p in ((node.get("pipelines") or {}).get("nodes") or [])
                ]
    return None


async def probe(gl: GL, project_id: int, iid: int | None = None) -> dict:
    """Run the real query against one project and report what happened.

    With `iid`, also dumps that MR's pipeline list in the order the batch query
    delivered it plus which one the rule picked — the order is not guaranteed by
    GraphQL, and it decides whether a red build is visible or hidden.
    """
    payload = None
    reason = "no workable query size"
    # Walk down the same way the real fetch does, so the check reports what the
    # dashboard would actually manage rather than failing on a size it never uses.
    for first_n in (50, 20, 10, 5):
        try:
            payload = await _query(gl, {
                "ids": [f"gid://gitlab/Project/{project_id}"], "state": "opened",
                "first": first_n, "pipelines": PIPELINE_DEPTH,
            })
            break
        except TooComplex as e:
            reason = str(e)
            continue
        except GraphQLUnavailable as e:
            return {"ok": False, "reason": str(e)}
        except HTTPException as e:
            return {"ok": False, "reason": f"{e.status_code}: {e.detail}"}
    if payload is None:
        return {"ok": False, "reason": reason}

    mrs = map_response(payload, gl.url)
    result: dict = {"ok": True, "merge_requests": len(mrs)}

    if iid is not None:
        picked = next((m for m in mrs if m["iid"] == iid), None)
        result["inspect"] = {
            "iid": iid,
            "pipelines_as_returned": _raw_pipelines(payload, iid),
            "picked": (picked or {}).get("pipeline"),
        }
        return result

    sample = mrs[0] if mrs else None
    result["sample"] = {
        "iid":                   sample["iid"],
        "project_id":            sample["project_id"],
        "approved_by":           [u["username"] for u in sample["approved_by_users"]],
        "reviewers":             [u["username"] for u in sample["reviewers"]],
        "pipeline":              (sample["pipeline"] or {}).get("status"),
        "detailed_merge_status": sample["detailed_merge_status"],
        "diff_stats":            sample["diff_stats"],
    } if sample else None
    return result
