import { useState, useEffect, useCallback, useRef } from "react";

const STATE_OPTS = [
  { value: "opened", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const SCOPE_OPTS = [
  { value: "all", label: "All MRs" },
  { value: "created_by_me", label: "Created by me" },
  { value: "assigned_to_me", label: "Assigned to me" },
];

const STATE_BADGE = {
  opened: "bg-green-100 text-green-800",
  merged: "bg-purple-100 text-purple-800",
  closed: "bg-gray-100 text-gray-600",
};

const PIPELINE = {
  success:  { dot: "bg-green-500", label: "passed" },
  failed:   { dot: "bg-red-500",   label: "failed" },
  running:  { dot: "bg-blue-400 animate-pulse", label: "running" },
  pending:  { dot: "bg-yellow-400", label: "pending" },
  canceled: { dot: "bg-gray-400",  label: "canceled" },
  skipped:  { dot: "bg-gray-300",  label: "skipped" },
  created:  { dot: "bg-gray-300",  label: "created" },
};

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Avatar({ user }) {
  return user.avatar_url ? (
    <img src={user.avatar_url} alt={user.name} className="w-5 h-5 rounded-full" />
  ) : (
    <span className="w-5 h-5 rounded-full bg-gray-300 flex items-center justify-center text-xs font-medium text-gray-600">
      {user.name[0].toUpperCase()}
    </span>
  );
}

function PipelineStatus({ pipeline }) {
  if (!pipeline) return null;
  const p = PIPELINE[pipeline.status];
  if (!p) return null;
  return (
    <a
      href={pipeline.web_url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Pipeline: ${p.label}`}
      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
    >
      <span className={`w-2 h-2 rounded-full inline-block ${p.dot}`} />
      {p.label}
    </a>
  );
}

function ThreadsStatus({ stats }) {
  if (!stats || stats.total === 0) return null;
  const allResolved = stats.resolved === stats.total;
  return (
    <span
      title={`${stats.resolved} of ${stats.total} threads resolved`}
      className={`flex items-center gap-1 text-xs ${allResolved ? "text-green-600" : "text-gray-500"}`}
    >
      <span>{allResolved ? "✓" : "◔"}</span>
      {stats.resolved}/{stats.total} threads
    </span>
  );
}

function MRCard({ mr, currentUserId }) {
  const ref = mr.references?.full ?? `!${mr.iid}`;
  const isDraft = mr.draft || /^(Draft|WIP):/i.test(mr.title);
  const cleanTitle = mr.title.replace(/^(Draft|WIP):\s*/i, "");
  const iApproved = mr.approved_by_users?.some((u) => u.id === currentUserId);

  return (
    <div className={`bg-white rounded-lg border p-4 transition-colors ${iApproved ? "border-l-4 border-l-green-500 border-gray-200 hover:border-gray-300" : "border-gray-200 hover:border-gray-300"}`}>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-gray-400 font-mono">{ref}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATE_BADGE[mr.state] ?? "bg-gray-100 text-gray-600"}`}>
              {mr.state}
            </span>
            {isDraft && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-500 border border-gray-300">
                Draft
              </span>
            )}
            <PipelineStatus pipeline={mr.pipeline} />
            <ThreadsStatus stats={mr.discussion_stats} />
          </div>

          <a
            href={mr.web_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-blue-600 hover:underline"
          >
            {cleanTitle}
          </a>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <Avatar user={mr.author} />
              {mr.author.name}
            </span>
            <span>
              → <code className="bg-gray-100 px-1 rounded">{mr.target_branch}</code>
            </span>
            {mr.assignees?.length > 0 && (
              <span className="flex items-center gap-1">
                assigned:
                {mr.assignees.map((a) => (
                  <Avatar key={a.id} user={a} />
                ))}
              </span>
            )}
            <span className="ml-auto">updated {timeAgo(mr.updated_at)}</span>
          </div>

          {mr.approved_by_users?.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-gray-500">
              <span className="font-medium">✓ Approved by</span>
              {mr.approved_by_users.map((u) => (
                <span key={u.id} className={`flex items-center gap-1 ${u.id === currentUserId ? "font-semibold text-green-700" : ""}`}>
                  <Avatar user={u} />
                  {u.name}{u.id === currentUserId && " (You)"}
                </span>
              ))}
            </div>
          )}

          {mr.labels?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {mr.labels.map((l) => (
                <span key={l} className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
                  {l}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectSettings({ projects, onClose }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => {
    try {
      const saved = localStorage.getItem("gl_selected_projects");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const filtered = projects
    .filter((p) => p.path_with_namespace.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));

  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem("gl_selected_projects", JSON.stringify([...next]));
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((p) => next.delete(p.id));
      } else {
        filtered.forEach((p) => next.add(p.id));
      }
      localStorage.setItem("gl_selected_projects", JSON.stringify([...next]));
      return next;
    });
  };

  const clearAll = () => {
    setSelected(new Set());
    localStorage.removeItem("gl_selected_projects");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Project filter</h2>
          <div className="flex items-center gap-3">
            {selected.size > 0 && (
              <button onClick={clearAll} className="text-xs text-gray-400 hover:text-gray-600">
                Clear all ({selected.size})
              </button>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          </div>
        </div>

        <div className="px-5 py-3 border-b border-gray-100">
          <input
            autoFocus
            type="search"
            placeholder="Filter projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="px-5 py-2 border-b border-gray-100 flex items-center gap-2">
          <input
            type="checkbox"
            id="toggle-all"
            checked={allFilteredSelected}
            onChange={toggleAll}
            className="rounded"
          />
          <label htmlFor="toggle-all" className="text-xs text-gray-500 cursor-pointer select-none">
            {allFilteredSelected ? "Deselect all" : "Select all"} ({filtered.length})
          </label>
          {selected.size === 0 && (
            <span className="ml-auto text-xs text-gray-400">No selection = show all</span>
          )}
        </div>

        <div className="overflow-y-auto flex-1 px-2 py-2">
          {filtered.length === 0 ? (
            <p className="text-center py-8 text-sm text-gray-400">No projects found</p>
          ) : (
            filtered.map((p) => (
              <label
                key={p.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="rounded shrink-0"
                />
                <span className="text-sm text-gray-700 truncate">{p.path_with_namespace}</span>
              </label>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Select({ value, onChange, options, disabled }) {
  return (
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      className="text-sm border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function loadFilters() {
  try {
    const saved = localStorage.getItem("gl_filters");
    return saved
      ? { ...{ state: "opened", scope: "all", search: "", project_id: "" }, ...JSON.parse(saved) }
      : { state: "opened", scope: "all", search: "", project_id: "" };
  } catch {
    return { state: "opened", scope: "all", search: "", project_id: "" };
  }
}

export default function App() {
  const [filters, setFilters] = useState(loadFilters);
  const [needsMyApproval, setNeedsMyApproval] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => {
    try {
      const saved = localStorage.getItem("gl_selected_projects");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const searchRef = useRef(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list) => setProjects(list))
      .catch(() => {});
    fetch("/api/me")
      .then((r) => r.json())
      .then((u) => setCurrentUser(u))
      .catch(() => {});
  }, []);

  useEffect(() => {
    try { localStorage.setItem("gl_filters", JSON.stringify(filters)); } catch {}
  }, [filters]);

  const load = useCallback(async (f, p) => {
    setLoading(true);
    setError(null);
    try {
      const ids = (() => {
        try {
          const saved = localStorage.getItem("gl_selected_projects");
          return saved ? JSON.parse(saved) : [];
        } catch { return []; }
      })();
      const params = new URLSearchParams({
        state: f.state,
        scope: f.scope,
        page: p,
        per_page: 25,
        ...(f.search ? { search: f.search } : {}),
        ...(f.project_id
          ? { project_id: f.project_id }
          : ids.length > 0 ? { project_ids: ids.join(",") } : {}),
      });
      const r = await fetch(`/api/merge-requests?${params}`);
      if (!r.ok) throw new Error(`Error ${r.status}: ${await r.text()}`);
      setData(await r.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filters, page);
  }, [load, filters, page]);

  const setFilter = (key) => (e) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    setFilters((prev) => ({ ...prev, search: searchRef.current.value }));
  };

  const handleSettingsClose = () => {
    setShowSettings(false);
    try {
      const saved = localStorage.getItem("gl_selected_projects");
      setSelectedProjectIds(saved ? new Set(JSON.parse(saved)) : new Set());
    } catch {
      setSelectedProjectIds(new Set());
    }
  };

  const visibleProjects = (selectedProjectIds.size > 0
    ? projects.filter((p) => selectedProjectIds.has(p.id))
    : projects
  ).slice().sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));

  const projectOpts = [
    { value: "", label: "All projects" },
    ...visibleProjects.map((p) => ({ value: String(p.id), label: p.path_with_namespace })),
  ];

  const visibleItems = needsMyApproval && currentUser
    ? (data?.items ?? []).filter((mr) => !mr.approved_by_users?.some((u) => u.id === currentUser.id))
    : (data?.items ?? []);

  return (
    <div className="min-h-screen bg-gray-50">
      {showSettings && (
        <ProjectSettings projects={projects} onClose={handleSettingsClose} />
      )}

      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-4">
        <h1 className="text-base font-semibold text-gray-900 shrink-0">GitLab MRs</h1>
        <form onSubmit={handleSearch} className="flex-1 flex gap-2 max-w-md">
          <input
            ref={searchRef}
            type="search"
            placeholder="Search…"
            defaultValue={filters.search}
            className="flex-1 text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="text-sm px-3 py-2 rounded-md border border-gray-200 bg-white hover:bg-gray-50"
          >
            Search
          </button>
        </form>
        <button
          onClick={() => setShowSettings(true)}
          title="Configure projects"
          className={`ml-auto text-sm px-3 py-2 rounded-md border transition-colors ${
            selectedProjectIds.size > 0
              ? "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
              : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
          }`}
        >
          ⚙ Projects{selectedProjectIds.size > 0 && ` (${selectedProjectIds.size})`}
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex flex-wrap gap-3 mb-6">
          <Select value={filters.state} onChange={setFilter("state")} options={STATE_OPTS} />
          <Select
            value={filters.scope}
            onChange={setFilter("scope")}
            options={SCOPE_OPTS}
          />
          <select
            value={filters.project_id}
            onChange={setFilter("project_id")}
            className="text-sm border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-xs"
          >
            {projectOpts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setNeedsMyApproval((v) => !v)}
            className={`text-sm px-4 py-2 rounded-md border transition-colors ${
              needsMyApproval
                ? "bg-orange-500 border-orange-500 text-white hover:bg-orange-600"
                : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
            }`}
          >
            Needs my approval
          </button>
          <button
            onClick={() => load(filters, page)}
            className="ml-auto text-sm px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>
        )}

        {loading ? (
          <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
        ) : (
          <>
            <div className="space-y-3">
              {visibleItems.map((mr) => (
                <MRCard key={mr.id} mr={mr} currentUserId={currentUser?.id} />
              ))}
              {visibleItems.length === 0 && (
                <div className="text-center py-16 text-gray-400 text-sm">No merge requests found</div>
              )}
            </div>

            {data && data.total_pages > 1 && (
              <div className="mt-6 flex items-center justify-between text-sm text-gray-500">
                <span>{data.total} total</span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                    className="px-3 py-1.5 border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50 disabled:cursor-default"
                  >
                    ← Prev
                  </button>
                  <span>{page} / {data.total_pages}</span>
                  <button
                    disabled={page >= data.total_pages}
                    onClick={() => setPage((p) => p + 1)}
                    className="px-3 py-1.5 border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50 disabled:cursor-default"
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
