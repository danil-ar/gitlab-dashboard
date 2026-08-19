"""A fake GitLab, enough of one to exercise the dashboard end to end.

Unit tests cover the rules; this covers the plumbing between them — that a
request really does turn into the right calls, in the right number, and that
what comes back is classified the way the rules intend.

The fixtures are not invented. They reproduce what the real instance returns,
including the awkward parts that shaped the code:

* GraphQL answers with global ids, `iid` as a string, SCREAMING pipeline
  statuses and relative avatar paths — the reasons a mapper exists at all;
* a MANUAL `merge_request_event` pipeline sitting on top of a FAILED branch
  build, which is how a green row used to hide a broken one;
* a complexity ceiling that rejects a query too large, scored the way the real
  instance scored ours: one project x 100 MRs x 5 pipelines came back as 276
  against a ceiling of 250;
* `/projects` paginated, so a backend reading only the first page loses a
  project;
* a protected `master` beside a default `develop` sharing history, so the same
  commit shows up on both.

Run it standalone to poke at the dashboard by hand:

    python fake_gitlab.py            # serves on 127.0.0.1:9911

/_stats returns the call counter, /_break_graphql and /_fix_graphql toggle the
GraphQL failure that sends the backend down its REST fallback.
"""
import json
import re
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ME = {"id": 7, "name": "Dana", "username": "dana", "avatar_url": "http://127.0.0.1:9911/uploads/a.png"}
OTHER = {"id": 9, "name": "Sam", "username": "sam"}

APPROVED_AT = "2026-08-01T12:00:00Z"
BEFORE      = "2026-07-30T09:00:00Z"
AFTER       = "2026-08-02T09:00:00Z"

PROJECTS = [
    {"id": 1, "path_with_namespace": "team/backend",  "default_branch": "develop", "web_url": "http://gl/team/backend"},
    {"id": 2, "path_with_namespace": "team/frontend", "default_branch": "develop", "web_url": "http://gl/team/frontend"},
    {"id": 3, "path_with_namespace": "team/infra",    "default_branch": "main",    "web_url": "http://gl/team/infra"},
]

def mr(pid, iid, title, state="opened"):
    return {
        "id": pid * 10000 + iid, "iid": iid, "project_id": pid, "title": title, "state": state,
        "updated_at": "2026-08-10T10:00:00Z", "web_url": f"http://gl/{pid}/-/merge_requests/{iid}",
        "author": OTHER, "source_branch": "feat", "target_branch": "main",
        "references": {"full": f"team/p{pid}!{iid}"},
    }

MRS = {1: [mr(1, 1, "Approved by me"), mr(1, 2, "Fresh one")] + [mr(1, i, f"Old MR {i}") for i in range(3, 121)],
       2: [mr(2, 1, "Other project")], 3: []}

def note(nid, body, at, *, system=False, author=OTHER, resolvable=True, resolved=False):
    return {"id": nid, "body": body, "created_at": at, "system": system,
            "author": author, "resolvable": resolvable, "resolved": resolved}

DISCUSSIONS = {
    (1, 1): [
        # opened before the approval, answered after it — the case that used to be invisible
        {"notes": [note(1, "please rename this", BEFORE), note(2, "renamed", AFTER)]},
        # brand-new thread after the approval
        {"notes": [note(3, "one more thing", AFTER)]},
        # untouched since before the approval
        {"notes": [note(4, "old chatter", BEFORE, resolved=True)]},
    ],
    (1, 2): [], (2, 1): [],
}

NOW_ISH = "2026-08-18T10:00:00Z"
LONG_AGO = "2025-01-05T10:00:00Z"

def branch(name, title, at=NOW_ISH, default=False, protected=False, merged=False):
    return {"name": name, "default": default, "protected": protected, "merged": merged,
            "commit": {"title": title, "author_name": "Sam Reviewer", "committed_date": at}}

# mirrors the real setup: develop is the default, master a protected release branch
BRANCHES = {
    1: [
        branch("develop", "Merge branch 'feat'", default=True),
        branch("master", "release 1.4", protected=True),
        branch("LKAG-3210", "Require deal on activity creation"),   # no MR → shown
        branch("feat", "Approved by me"),                           # MR 1!1 exists → hidden
        branch("landed", "hand-merged", merged=True),               # already in trunk → hidden
        branch("ancient", "forgotten", at=LONG_AGO),                # too old → hidden
    ],
    2: [branch("main", "init", at=LONG_AGO, default=True)],   # quiet for months
    3: [],
}

def commit(cid, title, parents, at=NOW_ISH):
    return {"id": cid, "short_id": cid, "title": title, "parent_ids": parents,
            "author_name": "Sam Reviewer", "committed_date": at,
            "web_url": f"http://gl/-/commit/{cid}"}

TRUNK_COMMITS = {
    (1, "develop"): [
        commit("mrg111", "Merge branch 'feat' into develop", ["p1", "p2"]),  # merge → came from an MR
        commit("sqh222", "LKAG-3129: DMS proxy", ["p3"]),                    # one parent, but an MR carried it
        commit("dir333", "hotfix: typo in config", ["p4"]),                  # one parent, no MR → shown
        commit("root000", "Initial commit", []),                             # root commit → skipped
    ],
    (1, "master"): [
        commit("rel444", "refactor: logging", ["p5"]),   # straight into protected → shown
        commit("dir333", "hotfix: typo in config", ["p4"]),  # same commit as on develop → one row
        commit("root000", "Initial commit", []),             # where the repo began → not a suspect
    ],
    (2, "main"): [],
}

# only the squashed one was carried by a merge request
COMMIT_MRS = {"sqh222": [{"iid": 100}]}

hits = Counter()
BROKEN = {"graphql": False}
MAX_COMPLEXITY = 250  # same ceiling the real instance reported


def gql_user(uid, name):
    return {"id": f"gid://gitlab/User/{uid}", "name": name,
            "username": name.lower(), "avatarUrl": f"/uploads/{uid}.png"}


def graphql_payload(variables=None):
    """Same MRs as the REST side, in GraphQL shape with all its quirks —
    honouring the requested project ids, `first` and the `after` cursor."""
    variables = variables or {}
    first = variables.get("first") or 100
    start = int(variables.get("after") or 0)
    wanted = {int(i.rsplit("/", 1)[1]) for i in (variables.get("ids") or [])}

    nodes = []
    for pid, all_mrs in MRS.items():
        if wanted and pid not in wanted:
            continue
        mrs = all_mrs[start:start + first]
        nodes.append({
            "id": f"gid://gitlab/Project/{pid}",
            "fullPath": f"team/p{pid}",
            "mergeRequests": {
                "count": len(all_mrs),
                "pageInfo": {
                    "hasNextPage": start + first < len(all_mrs),
                    "endCursor": str(start + first),
                },
                "nodes": [
                {
                    "id": f"gid://gitlab/MergeRequest/{m['id']}",
                    "iid": str(m["iid"]),               # string, like the real thing
                    "title": m["title"],
                    "state": "opened",
                    "draft": False,
                    "conflicts": False,
                    "webUrl": m["web_url"],
                    "createdAt": m["updated_at"],
                    "updatedAt": m["updated_at"],
                    "sourceBranch": m["source_branch"],
                    "targetBranch": m["target_branch"],
                    "reference": m["references"]["full"],
                    "detailedMergeStatus": "MERGEABLE",
                    "author": gql_user(9, "Sam"),
                    "assignees": {"nodes": []},
                    "reviewers": {"nodes": []},
                    "approvedBy": {"nodes": [gql_user(7, "Dana")] if (pid, m["iid"]) == (1, 1) else []},
                    "labels": {"nodes": [
                        {"title": "needs-refactoring", "color": "#ad4363", "textColor": "#ffffff"},
                        {"title": "ai-approved", "color": "#428bca", "textColor": "#ffffff"},
                    ] if m["iid"] == 1 else []},
                    # mirrors lk-portfolio!7: a MANUAL gate on the MR event
                    # sitting on top of a FAILED branch build
                    "pipelines": {"nodes": [
                        {"id": "gid://gitlab/Ci::Pipeline/673004", "status": "MANUAL",
                         "source": "merge_request_event", "path": "/p/pipelines/673004"},
                        {"id": "gid://gitlab/Ci::Pipeline/673002", "status": "FAILED",
                         "source": "push", "path": "/p/pipelines/673002"},
                    ]},
                    "diffStatsSummary": {"additions": 10, "deletions": 2, "fileCount": 3},
                    # counted server-side, like the real instance does
                    "resolvableDiscussionsCount": len(DISCUSSIONS.get((pid, m["iid"]), [])),
                    "resolvedDiscussionsCount": sum(
                        1 for d in DISCUSSIONS.get((pid, m["iid"]), [])
                        if all(n["resolved"] for n in d["notes"] if n["resolvable"])
                    ),
                }
                    for m in mrs
                ],
            },
        })
    return {"data": {"projects": {"nodes": nodes}}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # the backend pools connections and fans out concurrently

    def log_message(self, *a):
        pass

    def _send(self, payload, code=200, headers=None):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        hits[path] += 1

        if path == "/api/graphql":
            if BROKEN["graphql"]:
                return self._send({"errors": [{"message": "Field 'nope' doesn't exist on type 'MergeRequest'"}]})
            variables = (json.loads(raw or b"{}").get("variables") or {})
            # Calibrated against the real instance: 1 project × 100 MRs × 5
            # pipelines scored 276 against a ceiling of 250.
            score = round(len(variables.get("ids") or [1]) * variables.get("first", 1) * 2.76)
            tag = "after" if variables.get("after") else "first"
            hits[f"/api/graphql[{len(variables.get('ids') or [])}x{variables.get('first')}:{tag}]"] += 1
            if score > MAX_COMPLEXITY:
                return self._send({"errors": [{"message":
                    f"Query has complexity of {score}, which exceeds max complexity of {MAX_COMPLEXITY}"}]})
            return self._send(graphql_payload(variables))
        self._send({"ok": True})

    def do_GET(self):
        path, _, query = self.path.partition("?")
        hits[re.sub(r"/\d+", "/N", path)] += 1

        if path == "/_stats":
            return self._send(dict(hits))
        if path == "/_break_graphql":
            BROKEN["graphql"] = True
            return self._send({"broken": True})
        if path == "/_fix_graphql":
            BROKEN["graphql"] = False
            return self._send({"broken": False})
        if path.startswith("/uploads/"):
            return self._send({"png": True})
        if path == "/api/v4/user":
            return self._send(ME)

        m = re.match(r"/api/v4/projects/(\d+)/repository/branches$", path)
        if m:
            return self._send(BRANCHES.get(int(m.group(1)), []), headers={"X-Total-Pages": "1"})

        m = re.match(r"/api/v4/projects/(\d+)/repository/commits$", path)
        if m:
            params = dict(x.split("=", 1) for x in query.split("&") if "=" in x)
            return self._send(TRUNK_COMMITS.get((int(m.group(1)), params.get("ref_name", "")), []))

        m = re.match(r"/api/v4/projects/(\d+)/repository/commits/(\w+)/merge_requests$", path)
        if m:
            return self._send(COMMIT_MRS.get(m.group(2), []))

        if path == "/api/v4/projects":
            page = int(dict(p.split("=") for p in query.split("&") if "=" in p).get("page", 1))
            # two pages, so a backend that only reads page 1 loses a project
            chunk = PROJECTS[:2] if page == 1 else PROJECTS[2:]
            return self._send(chunk, headers={"X-Total-Pages": "2", "X-Total": "3"})

        m = re.match(r"/api/v4/projects/(\d+)/merge_requests$", path)
        if m:
            params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
            mrs = MRS.get(int(m.group(1)), [])
            if "source_branch" in params:
                mrs = [x for x in mrs if x["source_branch"] == params["source_branch"]]
            return self._send(mrs, headers={"X-Total-Pages": "1"})

        m = re.match(r"/api/v4/projects/(\d+)/merge_requests/(\d+)/(\w+)$", path)
        if m:
            pid, iid, kind = int(m.group(1)), int(m.group(2)), m.group(3)
            if kind == "approvals":
                approvers = [{"user": ME}] if (pid, iid) == (1, 1) else []
                return self._send({"approved_by": approvers})
            if kind == "discussions":
                return self._send(DISCUSSIONS.get((pid, iid), []))
            if kind == "pipelines":
                return self._send([{"id": 5, "status": "success", "source": "push", "web_url": "http://gl/p"}])
            if kind == "notes":
                notes = [note(90, "approved this merge request", APPROVED_AT, system=True, author=ME)]
                return self._send(notes if (pid, iid) == (1, 1) else [], headers={"X-Total-Pages": "1"})
            if kind == "commits":
                return self._send([
                    {"id": "abc123", "short_id": "abc123", "title": "late fix",
                     "message": "late fix\n\nthe rename broke the import, this puts it back",
                     "author_name": "Sam Reviewer", "committed_date": AFTER,
                     "web_url": "http://gl/p/-/commit/abc123"},
                    {"id": "old999", "short_id": "old999", "title": "earlier",
                     "message": "earlier", "author_name": "Sam Reviewer",
                     "committed_date": BEFORE, "web_url": "http://gl/p/-/commit/old999"},
                ])

        if path == "/api/v4/merge_requests":
            return self._send([], headers={"X-Total-Pages": "1"})
        if path == "/api/v4/todos":
            return self._send([{"id": 1, "action_name": "mentioned", "target_type": "MergeRequest",
                                "created_at": AFTER, "author": OTHER, "target": MRS[1][0]}])
        return self._send({"message": "404 Not Found"}, 404)


def serve(port: int = 9911) -> ThreadingHTTPServer:
    """Start on `port` (0 picks a free one) and return the server, unstarted
    threads and all — the caller decides whether to block or run it aside."""
    hits.clear()
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    server = serve()
    print(f"fake GitLab on http://127.0.0.1:{server.server_address[1]}")
    server.serve_forever()
