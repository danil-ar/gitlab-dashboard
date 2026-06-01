import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import TodoView, { fetchTodoCount } from "./TodoView";
import Sidebar from "./components/Sidebar";
import ProjectSettings from "./components/ProjectSettings";
import Triage from "./views/Triage";
import Browse from "./views/Browse";
import Avatar from "./components/Avatar";
import { IconRefresh, IconSearch, IconFilter } from "./components/icons";
import { classifyMR } from "./utils/classifyMR";
import { loadFilters, saveFilters, loadSelectedProjects } from "./utils/storage";

export default function App() {
  const [view, setView]                             = useState({ kind: "triage", bucket: "needs" });
  const [filters, setFilters]                       = useState(loadFilters);
  const [needsMyApproval, setNeedsMyApproval]       = useState(false);
  const [page, setPage]                             = useState(1);
  const [data, setData]                             = useState(null);
  const [loading, setLoading]                       = useState(false);
  const [error, setError]                           = useState(null);
  const [projects, setProjects]                     = useState([]);
  const [currentUser, setCurrentUser]               = useState(null);
  const [mentionedMRs, setMentionedMRs]             = useState([]);
  const [showSettings, setShowSettings]             = useState(false);
  const [todoCount, setTodoCount]                   = useState(0);
  const [triageItems, setTriageItems]               = useState([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState(loadSelectedProjects);
  const [autoRefreshSecs, setAutoRefreshSecs]       = useState(0);
  const searchRef = useRef(null);

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then(setProjects).catch((e) => console.error("[init] projects", e));
    fetch("/api/me").then((r) => r.json()).then(setCurrentUser).catch((e) => console.error("[init] me", e));
    fetch("/api/mentions").then((r) => r.json()).then(setMentionedMRs).catch((e) => console.error("[init] mentions", e));
    fetchTodoCount().then(setTodoCount);
    const id = setInterval(() => fetchTodoCount().then(setTodoCount), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { saveFilters(filters); }, [filters]);

  const load = useCallback(async (f, p, isTriage, projectIds) => {
    setLoading(true);
    setError(null);
    try {
      const ids = [...projectIds];
      const params = new URLSearchParams({
        state:    isTriage ? "opened" : f.state,
        scope:    isTriage ? "all"    : f.scope,
        page:     isTriage ? 1        : p,
        per_page: isTriage ? 100      : 25,
        ...((!isTriage && f.search) ? { search: f.search } : {}),
        ...((!isTriage && f.project_id)
          ? { project_id: f.project_id }
          : ids.length > 0 ? { project_ids: ids.join(",") } : {}),
      });
      const r = await fetch(`/api/merge-requests?${params}`);
      if (!r.ok) throw new Error(`Error ${r.status}: ${await r.text()}`);
      const json = await r.json();
      setData(json);
      if (isTriage) setTriageItems(json.items ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view.kind === "todo") return;
    load(filters, page, view.kind === "triage", selectedProjectIds);
  }, [load, filters, page, view.kind, selectedProjectIds]);

  useEffect(() => {
    if (autoRefreshSecs === 0 || view.kind === "todo") return;
    const isTriage = view.kind === "triage";
    const id = setInterval(() => {
      load(filters, page, isTriage, selectedProjectIds);
      if (isTriage) {
        fetch("/api/mentions").then((r) => r.json()).then(setMentionedMRs).catch((e) => console.error("[auto-refresh] mentions", e));
      }
    }, autoRefreshSecs * 1000);
    return () => clearInterval(id);
  }, [autoRefreshSecs, view.kind, load, filters, page, selectedProjectIds]);

  const setFilter = (key) => (e) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    setFilters((prev) => ({ ...prev, search: searchRef.current.value }));
  };

  const navigateBrowse = (state) => {
    setFilters((prev) => ({ ...prev, state }));
    setView({ kind: "browse" });
    setPage(1);
  };

  const handleSettingsClose = () => {
    setShowSettings(false);
    setSelectedProjectIds(loadSelectedProjects());
  };

  const visibleProjects = (selectedProjectIds.size > 0
    ? projects.filter((p) => selectedProjectIds.has(p.id))
    : projects
  ).slice().sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));

  const projectOpts = [
    { value: "",  label: "All projects" },
    ...visibleProjects.map((p) => ({ value: String(p.id), label: p.path_with_namespace })),
  ];

  const counts = useMemo(() => {
    const c = { needs: 0, approved: 0, mine: 0, mention: mentionedMRs.length };
    if (!currentUser) return c;
    for (const mr of triageItems) {
      const b = classifyMR(mr, currentUser.id);
      if (b && b !== "mention" && c[b] != null) c[b] += 1;
    }
    return c;
  }, [triageItems, currentUser, mentionedMRs]);

  const projectCounts = useMemo(() => {
    const c = {};
    for (const mr of triageItems) {
      if (mr.state === "opened") c[mr.project_id] = (c[mr.project_id] || 0) + 1;
    }
    return c;
  }, [triageItems]);

  const totalOpen = triageItems.filter((m) => m.state === "opened").length;

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {showSettings && <ProjectSettings projects={projects} onClose={handleSettingsClose} />}

      <Sidebar
        counts={counts}
        totalOpen={totalOpen}
        view={view}
        setView={setView}
        navigateBrowse={navigateBrowse}
        filters={filters}
        projects={projects}
        selectedProjectIds={selectedProjectIds}
        openProjectSettings={() => setShowSettings(true)}
        currentUser={currentUser}
        projectCounts={projectCounts}
        todosCount={todoCount}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-12 bg-white border-b border-gray-200 px-4 flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-6 h-6 rounded-md bg-gradient-to-br from-orange-500 to-orange-600 grid place-items-center text-white text-xs font-bold select-none">⌘</span>
            <h1 className="text-sm font-semibold text-gray-900 whitespace-nowrap">GitLab MRs</h1>
          </div>

          <div className="flex-1 flex justify-center px-4 max-w-2xl mx-auto w-full">
            <div className="relative w-full">
              <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
              <input
                type="search"
                placeholder="Search merge requests…"
                defaultValue={filters.search}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  setPage(1);
                  setFilters((prev) => ({ ...prev, search: e.currentTarget.value }));
                  if (view.kind !== "browse") navigateBrowse(filters.state);
                }}
                className="w-full text-sm bg-gray-50 border border-gray-200 rounded-md pl-8 pr-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { if (view.kind !== "todo") load(filters, page, view.kind === "triage", selectedProjectIds); }}
              title="Refresh"
              className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-500 transition-colors"
            >
              <IconRefresh className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => setShowSettings(true)}
              className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-xs font-medium transition-colors ${
                selectedProjectIds.size > 0
                  ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              <IconFilter className="w-3.5 h-3.5" />
              Projects
              {selectedProjectIds.size > 0 && (
                <span className="bg-blue-600 text-white rounded-full px-1.5 text-[10px] font-bold leading-5">
                  {selectedProjectIds.size}
                </span>
              )}
            </button>

            {currentUser && (
              <button title={`${currentUser.name} (@${currentUser.username})`} className="shrink-0 rounded-full ring-2 ring-gray-200 hover:ring-gray-300 transition-all">
                <Avatar user={currentUser} size="md" />
              </button>
            )}
          </div>
        </header>

        {view.kind === "todo" ? (
          <TodoView />
        ) : view.kind === "triage" ? (
          <Triage
            data={data} loading={loading} error={error}
            currentUser={currentUser} view={view}
            refresh={() => {
              load(filters, page, true, selectedProjectIds);
              fetch("/api/mentions").then((r) => r.json()).then(setMentionedMRs).catch((e) => console.error("[refresh] mentions", e));
            }}
            mentionedMRs={mentionedMRs}
            autoRefreshSecs={autoRefreshSecs}
            onAutoRefreshChange={setAutoRefreshSecs}
          />
        ) : (
          <Browse
            data={data} loading={loading} error={error}
            filters={filters} setFilter={setFilter} projectOpts={projectOpts}
            needsMyApproval={needsMyApproval} setNeedsMyApproval={setNeedsMyApproval}
            refresh={() => load(filters, page, false, selectedProjectIds)}
            searchRef={searchRef} handleSearch={handleSearch}
            page={page} setPage={setPage} currentUser={currentUser}
            autoRefreshSecs={autoRefreshSecs}
            onAutoRefreshChange={setAutoRefreshSecs}
          />
        )}
      </div>
    </div>
  );
}
