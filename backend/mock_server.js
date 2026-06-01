const http = require("http");

const ME = { id: 1, name: "Dev User", username: "devuser", avatar_url: "" };

const PROJECTS = [
  { id: 101, path_with_namespace: "sogaz/lk-seller" },
  { id: 102, path_with_namespace: "sogaz/lk-products" },
  { id: 103, path_with_namespace: "sogaz/lk-packages" },
];

function mr(id, iid, pid, title, authorId = 2, approved = false, draft = false, pipeline = "success") {
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
    discussion_stats: { resolved: 2, total: 3 },
    pipeline: { status: pipeline, web_url: "#" },
  };
}

const MRS = [
  mr(1, 1, 101, "LKAG-2410 feat: logging module"),
  mr(2, 2, 102, "LKAG-2347: Добавление ручки doclean",  3, false, false, "manual"),
  mr(3, 3, 102, "LKAG-2162: Document Contract relay",   4, false, false, "manual"),
  mr(4, 4, 101, "LKAG-2307: Fixed v1 security vulns",   5),
  mr(5, 5, 101, "My own feature branch",                1, false, false, "running"),
  mr(6, 6, 103, "Refactor packages module",             1, false, true),
  mr(7, 7, 101, "Already reviewed this one",            2, true),
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

function send(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "*" });
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/api/health")   return send(res, { status: "ok" });
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

  if (path.match(/^\/api\/merge-requests\/\d+\/\d+\/approve$/) && req.method === "POST")
    return send(res, { ok: true });

  if (path === "/api/todos" && req.method === "GET")
    return send(res, TODOS);

  if (path === "/api/todos/mark_all_done" && req.method === "POST")
    return send(res, { ok: true });

  if (path.match(/^\/api\/todos\/\d+\/done$/) && req.method === "POST")
    return send(res, { ok: true });

  send(res, { error: "not found" }, 404);
});

server.listen(8000, () => console.log("Mock server running on :8000"));
