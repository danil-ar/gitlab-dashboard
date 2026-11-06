"""Release plans and tag builds: from a Jira version to the GitLab tags to deploy and roll back to."""
import asyncio
import re
from urllib.parse import quote

from fastapi import HTTPException

from . import release_plan
from .config import JIRA_DONE_STATUSES, JIRA_PROJECT, JIRA_RELEASE_STATUS, JIRA_URL, log
from .gitlab import GL, gather_settled, why
from .jira import Jira

_PLANNED_STATUSES = (JIRA_RELEASE_STATUS, *JIRA_DONE_STATUSES)
_JIRA_CONCURRENCY = 8  # parallel Jira calls while building one plan; GitLab has its own limit in GL

_RELEASE_SOURCE_BRANCH = "develop"
_RELEASE_TARGET_BRANCHES = ("master", "main")  # the first one that exists
_MERGE_CHECK_ATTEMPTS = 8  # GitLab works out mergeability in the background after an MR is created
_MERGE_CHECK_DELAY = 1  # seconds


def _status_of(fields: dict) -> dict:
    """Jira's status and its category: new, indeterminate or done, the same in every workflow."""
    status = fields.get("status") or {}
    return {"status": status.get("name"), "status_category": (status.get("statusCategory") or {}).get("key")}


async def _release_issue_statuses(jira: Jira, keys: list[str]) -> dict[str, dict]:
    """Status of each release's own issue (REL-2169). It only adds detail, so failing to read it mustn't cost the list."""
    if not keys:
        return {}
    try:
        page = await jira.get("/search", {
            # validateQuery=false: a release naming an issue that no longer exists mustn't fail all the others.
            "jql": f"key in ({','.join(keys)})", "fields": "status", "maxResults": len(keys), "validateQuery": "false",
        })
    except HTTPException as e:
        log.warning("could not read release issue statuses: %s", e.detail)
        return {}
    return {i["key"]: _status_of(i["fields"]) for i in page.get("issues", [])}


async def list_releases(jira: Jira) -> dict:
    versions = await jira.get(f"/project/{quote(JIRA_PROJECT)}/versions")
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
            "url":           f"{JIRA_URL}/projects/{JIRA_PROJECT}/versions/{v['id']}",
            "release_issue": issue[0] if issue else None,
            "release_issue_url": f"{JIRA_URL}/browse/{issue[0]}" if issue else None,
        })
    # Upcoming first with the nearest on top, then shipped with the latest on top.
    upcoming = sorted((r for r in releases if not r["released"]), key=lambda r: r["release_date"] or "9999")
    shipped = sorted((r for r in releases if r["released"]), key=lambda r: r["release_date"] or "", reverse=True)
    # Only upcoming ones: the shipped list only grows, and for those "released" says what matters.
    statuses = await _release_issue_statuses(jira, [r["release_issue"] for r in upcoming if r["release_issue"]])
    for r in releases:
        r["release_issue_status"] = statuses.get(r["release_issue"])
    return {"project": JIRA_PROJECT, "releases": upcoming + shipped}



async def _version_issues(jira: Jira, version_id: int) -> list[dict]:
    jql = f'project = "{JIRA_PROJECT}" AND fixVersion = {version_id} ORDER BY key'
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
        return {**change, "title": None, "state": "unknown", "sha": None, "error": why(mr)}
    sha = None
    if mr.get("state") == "merged":
        sha = mr.get("merge_commit_sha") or mr.get("squash_commit_sha") or mr.get("sha")
    return {**change, "title": mr.get("title"), "state": mr.get("state"), "sha": sha}


async def _json(gl: GL, path: str, params: dict | None = None):
    return (await gl.get(path, params)).json()


async def _all_pages(gl: GL, path: str, params: dict | None = None) -> list:
    items: list = []
    page = "1"
    while page:
        r = await gl.get(path, {**(params or {}), "per_page": 100, "page": page})
        items += r.json()
        page = r.headers.get("X-Next-Page")
    return items


async def _all_tag_names(gl: GL, enc_path: str) -> list[str]:
    """Every tag in the repo, read from GitLab: a page full of CI tags must not hide the latest release tag."""
    return [t["name"] for t in await _all_pages(gl, f"/projects/{enc_path}/repository/tags")]


async def _plan_for_repo(gl: GL, path: str, changes: list[dict], released: bool) -> dict:
    """Plan row for one repo. Closed MRs were never shipped, so they don't count as changes."""
    enc = quote(path, safe="")
    row = {"path": path, "name": path.rsplit("/", 1)[-1], "web_url": f"{gl.url}/{path}", "warnings": [], "unmerged": []}
    live = [c for c in changes if c["state"] != "closed"]

    tags_call, languages_call, *refs_calls = await gather_settled([
        _all_tag_names(gl, enc),
        _json(gl, f"/projects/{enc}/languages"),
        # An old commit sits in every later tag, so a repo with many tags needs all the pages to find its first one.
        *[_all_pages(gl, f"/projects/{enc}/repository/commits/{c['sha']}/refs", {"type": "tag"})
          for c in live if c["sha"]],
    ])
    row["group"] = release_plan.repo_group(row["name"], {} if isinstance(languages_call, Exception) else languages_call)
    row["changes"] = live
    row["issues"] = sorted({key for c in live for key in c["issues"]})
    if isinstance(tags_call, Exception):
        return {**row, "state": "error", "error": f"Could not read tags: {why(tags_call)}",
                "latest_tag": None, "deploy_tag": None, "rollback_tag": None}

    refs_by_sha = dict(zip([c["sha"] for c in live if c["sha"]], refs_calls))
    containing = []
    for c in live:
        issues = ", ".join(c["issues"])
        refs = refs_by_sha.get(c["sha"], [])
        if isinstance(refs, Exception):
            row["warnings"].append(f"{c['ref']}: could not check tags, treated as untagged ({why(refs)})")
            refs = []
        tags_of_change = [r["name"] for r in refs]
        containing.append(tags_of_change)
        c["tag"] = release_plan.first_tag(tags_of_change)
        if c["state"] in ("opened", "locked"):
            row["unmerged"].append({"ref": c["ref"], "url": c["url"], "issues": c["issues"]})
        elif c["state"] == "unknown":
            row["warnings"].append(f"{c['ref']}: could not load the MR, treated as untagged ({c['error']})")
        elif c["kind"] == "commit" and not c["tag"]:
            row["warnings"].append(f"{c['ref']} is a commit with no MR and no tag, check it's on the release branch ({issues})")

    plan = release_plan.plan_repo(tags_call, containing)
    # In a shipped release that's just history: of course newer tags have come since.
    if plan["state"] == "older_tag" and not released:
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



async def build_plan(jira: Jira, gl: GL, version_id: int, released: bool = False) -> dict:
    wanted = {status.casefold() for status in _PLANNED_STATUSES}
    issues = await _version_issues(jira, version_id)
    in_release = {i["key"] for i in issues if i["fields"]["status"]["name"].casefold() in wanted}
    warnings: list[str] = []

    jira_sem = asyncio.Semaphore(_JIRA_CONCURRENCY)

    async def jira_links(key: str):
        async with jira_sem:
            return await jira.get(f"/issue/{quote(key)}/remotelink")

    # 1. Jira issue → the GitLab MRs and commits it mentions
    links_by_issue: dict[str, list[dict]] = {}
    for issue, res in zip(issues, await gather_settled([jira_links(i["key"]) for i in issues])):
        if isinstance(res, Exception):
            warnings.append(f"{issue['key']}: could not read its GitLab links ({why(res)})")
            links_by_issue[issue["key"]] = []
            continue
        parsed = [release_plan.parse_gitlab_link((l.get("object") or {}).get("url") or "", gl.url) for l in res]
        links_by_issue[issue["key"]] = list({(p["path"], p.get("iid"), p.get("sha")): p for p in parsed if p}.values())

    # 2. MR details: state and the commit that landed on the target branch
    mr_keys = sorted({(l["path"], l["iid"]) for links in links_by_issue.values() for l in links if "iid" in l})
    mr_results = await gather_settled([_json(gl, f"/projects/{quote(p, safe='')}/merge_requests/{iid}") for p, iid in mr_keys])
    mrs = dict(zip(mr_keys, mr_results))

    # 3. Group by repo. An MR's branch commits may never reach a tag when it's squashed, so where an
    #    issue has an MR in a repo the MR alone says what ships. Commits count only for MR-less repos.
    #    Only issues in the release make up the plan; the others are listed so people can see what's missing.
    repos: dict[str, dict[str, dict]] = {}
    links_of: dict[str, list[dict]] = {i["key"]: [] for i in issues}
    for key, links in links_by_issue.items():
        repos_with_mr = {l["path"] for l in links if "iid" in l}
        for link in links:
            if "sha" in link and link["path"] in repos_with_mr:
                continue
            change = _change_from_link(gl, link, mrs)
            links_of[key].append({
                "ref": change["ref"], "url": change["url"], "state": change["state"],
                "path": link["path"], "repo": link["path"].rsplit("/", 1)[-1],
            })
            if key in in_release:
                repos.setdefault(link["path"], {}).setdefault(change["ref"], change)["issues"].append(key)

    # 4. Tags per repo
    live_repos = {p: list(c.values()) for p, c in repos.items() if any(x["state"] != "closed" for x in c.values())}
    rows = await gather_settled([_plan_for_repo(gl, p, c, released) for p, c in live_repos.items()])
    plan_rows = []
    for path, row in zip(live_repos, rows):
        if isinstance(row, Exception):
            warnings.append(f"{path}: could not build a plan ({why(row)})")
        else:
            plan_rows.append(row)
    plan_rows.sort(key=lambda r: (r["group"], r["name"]))

    return {
        "issues": [
            {
                "key":      i["key"],
                "url":      f"{JIRA_URL}/browse/{i['key']}",
                "summary":  i["fields"].get("summary"),
                "assignee": (i["fields"].get("assignee") or {}).get("displayName"),
                "type":     (i["fields"].get("issuetype") or {}).get("name"),
                **_status_of(i["fields"]),
                "in_release": i["key"] in in_release,
                "links":    links_of[i["key"]],
            }
            for i in issues
        ],
        "repos":    plan_rows,
        "warnings": warnings,
    }



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


async def _branch_head(gl: GL, enc: str, branch: str) -> str:
    r = await gl.get(f"/projects/{enc}/repository/branches/{quote(branch, safe='')}")
    return r.json()["commit"]["id"]


async def _commits_ahead(gl: GL, enc: str, target: str) -> list[dict]:
    range_ = f"{target}..{_RELEASE_SOURCE_BRANCH}"
    return await _all_pages(gl, f"/projects/{enc}/repository/commits", {"ref_name": range_})


async def _open_release_mr(gl: GL, enc: str, target: str) -> dict | None:
    r = await gl.get(f"/projects/{enc}/merge_requests", {
        "state": "opened", "source_branch": _RELEASE_SOURCE_BRANCH, "target_branch": target, "per_page": 1,
    })
    mrs = r.json()
    return mrs[0] if mrs else None


def _tag_path(enc: str, tag: str) -> str:
    return f"/projects/{enc}/repository/tags/{quote(tag, safe='')}"



async def repo_preview(jira: Jira, gl: GL, version_id: int, path: str, tag: str) -> dict:
    """What building this tag would do, and everything that would reach the target branch with it."""
    enc = quote(path, safe="")
    target = await _release_target_branch(gl, enc)
    head = await _branch_head(gl, enc, _RELEASE_SOURCE_BRANCH)
    target_head = await _branch_head(gl, enc, target)
    commits = await _commits_ahead(gl, enc, target)
    mr = await _open_release_mr(gl, enc, target)
    statuses = {i["key"]: i["fields"]["status"]["name"] for i in await _version_issues(jira, version_id)}
    return {
        "source": _RELEASE_SOURCE_BRANCH,
        "target": target,
        "source_sha": head,
        "target_sha": target_head,
        "ahead": len(commits),
        "open_mr": {"iid": mr["iid"], "url": mr["web_url"]} if mr else None,
        "tag_exists": await _exists(gl, _tag_path(enc, tag)),
        "commands": release_plan.manual_commands(_RELEASE_SOURCE_BRANCH, target, head, target_head, tag, bool(commits)),
        "commits": release_plan.describe_commits(commits, JIRA_PROJECT),
        **release_plan.summarize_commits(commits, statuses, _PLANNED_STATUSES, JIRA_PROJECT),
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



async def build_tag(gl: GL, path: str, tag: str, source_sha: str, target_sha: str, merged_sha: str | None = None) -> dict:
    """Merge develop into master and tag the result. Safe to repeat: each step is skipped once it's done.

    The tag goes on a commit, never on a branch name: the one the merge produced, or the target head the
    preview showed. If either branch moved since the preview nothing is written, because what would ship
    is no longer what was reviewed. `merged_sha` is the merge from an earlier attempt whose tag failed.
    That merge was reviewed, whatever has landed on the branch since.
    """
    enc = quote(path, safe="")
    repo_url = f"{gl.url}/{path}"
    done = {
        "status": "done",
        "tag": tag,
        "tag_url": f"{repo_url}/-/tags/{quote(tag, safe='')}",
        "pipelines_url": f"{repo_url}/-/pipelines?ref={quote(tag, safe='')}",
    }
    if await _exists(gl, _tag_path(enc, tag)):
        return done

    mr_url = None
    if merged_sha:
        ref = merged_sha
    else:
        target = await _release_target_branch(gl, enc)
        if await _branch_head(gl, enc, target) != target_sha:
            return {"status": "changed", "branch": target}
        ref = target_sha
        if await _commits_ahead(gl, enc, target):
            if await _branch_head(gl, enc, _RELEASE_SOURCE_BRANCH) != source_sha:
                return {"status": "changed", "branch": _RELEASE_SOURCE_BRANCH}
            merge = await _merge_release_mr(gl, enc, target, tag, source_sha)
            mr_url = merge["mr_url"]
            if "blocked" in merge:
                return {"status": "blocked", "reason": merge["blocked"], "mr_url": mr_url, "merged": False, "merged_sha": None}
            merged_sha = merge["merged_sha"]
            if not merged_sha:
                reason = "GitLab merged it but didn't say which commit, so the tag wasn't created. Check the branch and build again."
                return {"status": "blocked", "reason": reason, "mr_url": mr_url, "merged": True, "merged_sha": None}
            ref = merged_sha

    try:
        await gl.post(f"/projects/{enc}/repository/tags", {"tag_name": tag, "ref": ref})
    except HTTPException as e:
        return {
            "status": "blocked", "reason": f"Could not create the tag: {_write_refused(e)}", "mr_url": mr_url,
            "merged": merged_sha is not None, "merged_sha": merged_sha,
        }
    return {**done, "mr_url": mr_url}
