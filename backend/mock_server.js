const http = require("http");

const ME = { id: 1, name: "Dev User", username: "devuser", avatar_url: "" };

const PROJECTS = [
  { id: 101, path_with_namespace: "sogaz/lk-seller" },
  { id: 102, path_with_namespace: "sogaz/lk-products" },
  { id: 103, path_with_namespace: "sogaz/lk-packages" },
  { id: 104, path_with_namespace: "demo/lk-backend" },
  { id: 105, path_with_namespace: "demo/lk-config" },
  { id: 106, path_with_namespace: "demo/lk-legacy" },
  { id: 107, path_with_namespace: "demo/lk-products" },
  { id: 108, path_with_namespace: "demo/lk-web" },
];

function mr(id, iid, pid, title, authorId = 2, approved = false, draft = false, pipeline = "success", updatedAfterApproval = false) {
  return {
    id, iid, project_id: pid,
    title: (draft ? "Draft: " : "") + title,
    state: "opened", draft,
    web_url: `http://localhost:8085/mock/mr/${id}`,
    references: { full: `sogaz/lk-seller!${iid}` },
    target_branch: "main",
    author: { id: authorId, name: authorId === 1 ? "Dev User" : "Colleague", avatar_url: "" },
    assignees: [], labels: ["backend"], has_conflicts: false,
    updated_at: "2025-03-15T10:00:00Z",
    approved_by_users: approved ? [ME] : [],
    discussion_stats: { resolved: 2, total: 3, unresolved_previews: [{ author: "Богданов Ярослав", body: "Можно вынести эту логику в отдельный сервис?" }] },
    pipeline: { status: pipeline, web_url: "#" },
    activities_after_approval: updatedAfterApproval,
  };
}

const MRS = [
  mr(1, 1, 101, "LKAG-2410 feat: logging module"),
  mr(2, 2, 102, "LKAG-2347: Добавление ручки doclean",  3, false, false, "manual"),
  mr(3, 3, 102, "LKAG-2162: Document Contract relay",   4, false, false, "manual"),
  mr(4, 4, 101, "LKAG-2307: Fixed v1 security vulns",   5),
  mr(5, 5, 101, "My own feature branch",                1, false, false, "running"),
  mr(6, 6, 103, "Refactor packages module",             1, false, true),
  mr(7, 7, 101, "Already reviewed this one",            2, true,  false, "success", false),
  mr(8, 8, 102, "Auth refactor: token rotation",        3, true,  false, "running", {
    commits: [
      { id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", short_id: "a1b2c3d4", title: "fix: handle token expiry edge case" },
      { id: "b2c3d4e5f6a7b2c3d4e5f6a7b2c3d4e5f6a7b2c3", short_id: "b2c3d4e5", title: "fix: refresh token rotation" },
    ],
    new_threads: 1,
    new_thread_previews: [{ author: "Богданов Ярослав", body: "Не хватает обработки ошибки при истечении токена" }],
  }),
];

const TODOS = [
  { id: 1, action_name: "review_requested", state: "pending", created_at: "2025-03-15T09:00:00Z",
    author: { id: 2, name: "Colleague", avatar_url: "" }, target_type: "MergeRequest",
    target: { id: 1, iid: 1, title: "LKAG-2410 feat: logging module", web_url: "#" },
    project: { path_with_namespace: "sogaz/lk-seller" }, body: "Please review the logging approach" },
  { id: 2, action_name: "mentioned", state: "pending", created_at: "2025-03-14T15:00:00Z",
    author: { id: 3, name: "Other", avatar_url: "" }, target_type: "MergeRequest",
    target: { id: 2, iid: 2, title: "LKAG-2347 ручка doclean", web_url: "#" },
    project: { path_with_namespace: "sogaz/lk-products" }, body: "@devuser what do you think?" },
  { id: 3, action_name: "build_failed", state: "pending", created_at: "2025-03-15T11:00:00Z",
    author: null, target_type: "MergeRequest",
    target: { id: 5, iid: 5, title: "My own feature branch", web_url: "#" },
    project: { path_with_namespace: "sogaz/lk-seller" }, body: null },
];

function batchOf(field) {
  return Object.fromEntries(MRS.filter((m) => m[field]).map((m) => [`${m.project_id}_${m.iid}`, m[field]]));
}

function send(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

const MOCK_PROFILE = { id: "mock", label: ME.name, gitlabUrl: "http://localhost:8000" };

const JIRA_URL = "http://localhost:8085/mock-jira";
const GITLAB = "http://localhost:8085/mock-gitlab";
let jiraConnected = false;

function release(id, name, date, released, issue) {
  return {
    id, name, released, release_date: date,
    url: `${JIRA_URL}/projects/DEMO/versions/${id}`,
    release_issue: issue,
    release_issue_url: `${JIRA_URL}/browse/${issue}`,
  };
}

const RELEASES = [
  release("3", "Release 09.11.2026", "2026-11-09", false, "REL-3"),
  release("4", "Release 23.11.2026", "2026-11-23", false, "REL-4"),
  release("2", "Release 29.10.2026", "2026-10-30", true, "REL-2"),
];

function repo(name, group, state, latest_tag, rollback_tag, deploy_tag, issues, warnings = []) {
  return {
    path: `demo/${name}`, name, web_url: `${GITLAB}/demo/${name}`, group, state,
    latest_tag, rollback_tag, deploy_tag, issues, warnings, changes: [], error: null,
  };
}

function issue(key, summary, assignee, links) {
  return { key, summary, assignee, type: "Task", url: `${JIRA_URL}/browse/${key}`, links };
}

function change(repoName, iid, state) {
  return { ref: `!${iid}`, state, repo: repoName, path: `demo/${repoName}`, url: `${GITLAB}/demo/${repoName}/-/merge_requests/${iid}` };
}

const RELEASE_PLAN = {
  issues: [
    issue("DEMO-101", "Switch the client card to the new contracts source", "Dev User", [change("lk-backend", 41, "merged")]),
    issue("DEMO-102", "Sales points: skip the deal card on create", "Colleague", [change("lk-web", 87, "merged"), change("lk-backend", 42, "opened")]),
    issue("DEMO-103", "Fix config rendering", "Colleague", [change("lk-products", 12, "merged"), change("lk-products", 11, "closed")]),
    issue("DEMO-104", "Remove the unused consumer", "Dev User", [change("lk-legacy", 5, "merged")]),
    issue("DEMO-105", "Update the release checklist", "Colleague", []),
  ],
  total_issues: 9,
  other_statuses: [{ name: "Testing", count: 2 }, { name: "Withdrawn", count: 2 }],
  repos: [
    repo("lk-backend", "backend", "new_tag", "v4.32.0", "v4.32.0", "v4.33.0", ["DEMO-101", "DEMO-102"], ["!42 is not merged yet (DEMO-102)"]),
    repo("lk-config", "backend", "no_tags", null, null, null, ["DEMO-104"], ["GitLab has no vX.Y.Z tags here, so there is no version to continue from. Left out of the plan: tick it and enter a tag if this repo is deployed by tag."]),
    repo("lk-legacy", "backend", "older_tag", "v1.5.0", "v1.1.0", "v1.2.0", ["DEMO-104"], ["Everything is already in v1.2.0 and newer tags exist. Left out of the plan: include it if that tag belongs to this release."]),
    repo("lk-products", "backend", "tagged", "v1.19.0", "v1.18.0", "v1.19.0", ["DEMO-103"]),
    repo("lk-web", "frontend", "new_tag", "v2.7.0", "v2.7.0", "v2.8.0", ["DEMO-102"]),
  ],
  warnings: [],
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE", "Access-Control-Allow-Headers": "*" });
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/api/health")   return send(res, { status: "ok" });
  if (path === "/api/config")   return send(res, { gitlab_url: null });

  // auth — mock always has one pre-configured profile, no real validation
  if (path === "/api/auth/profiles")
    return send(res, { profiles: [{ ...MOCK_PROFILE, jiraConnected }], activeId: MOCK_PROFILE.id, jiraUrl: JIRA_URL });
  if (path === "/api/auth/login" && req.method === "POST")
    return send(res, { profile: MOCK_PROFILE, user: ME });
  if (path === "/api/auth/switch" && req.method === "POST")
    return send(res, { ok: true });
  if (path === "/api/auth/logout" && req.method === "POST")
    return send(res, { ok: true });
  if (path.match(/^\/api\/auth\/profiles\//) && req.method === "DELETE")
    return send(res, { ok: true, activeId: MOCK_PROFILE.id });

  if (path === "/api/me")       return send(res, ME);
  if (path === "/api/projects") return send(res, PROJECTS);
  if (path === "/api/mentions") return send(res, [MRS[0]]);

  if (path === "/api/merge-requests" && req.method === "GET") {
    const state = url.searchParams.get("state") || "opened";
    const search = (url.searchParams.get("search") || "").toLowerCase();
    let items = state === "all" ? MRS : MRS.filter(m => m.state === state);
    if (search) items = items.filter(m => m.title.toLowerCase().includes(search));
    return send(res, { items, total: items.length, total_pages: 1, page: 1 });
  }

  if (path === "/api/merge-requests/activities" && req.method === "POST")
    return send(res, batchOf("activities_after_approval"));
  if (path === "/api/merge-requests/discussion-stats-batch" && req.method === "POST")
    return send(res, batchOf("discussion_stats"));
  if (path === "/api/merge-requests/pipelines-batch" && req.method === "POST")
    return send(res, batchOf("pipeline"));

  if (path.match(/^\/api\/merge-requests\/\d+\/\d+\/approve$/) && req.method === "POST")
    return send(res, { ok: true });

  if (path.match(/^\/api\/merge-requests\/\d+\/\d+\/unapprove$/) && req.method === "POST")
    return send(res, { ok: true });

  if (path === "/api/todos" && req.method === "GET")
    return send(res, TODOS);

  if (path === "/api/todos/mark_all_done" && req.method === "POST")
    return send(res, { ok: true });

  if (path.match(/^\/api\/todos\/\d+\/done$/) && req.method === "POST")
    return send(res, { ok: true });

  if (path === "/api/jira/connect" && req.method === "POST") {
    jiraConnected = true;
    return send(res, { ok: true });
  }
  if (path === "/api/jira/releases")
    return send(res, { project: "DEMO", status: "Included in release", releases: RELEASES });
  if (path.match(/^\/api\/jira\/releases\/\d+\/plan$/))
    return send(res, RELEASE_PLAN);

  send(res, { error: "not found" }, 404);
});

server.listen(8000, () => console.log("Mock server running on :8000"));
