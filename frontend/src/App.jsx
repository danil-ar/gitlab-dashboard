import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import TodoView, { fetchTodoCount } from "./TodoView";
import Sidebar from "./components/Sidebar";
import LoginScreen from "./components/LoginScreen";
import ProjectSettings from "./components/ProjectSettings";
import Triage from "./views/Triage";
import Browse from "./views/Browse";
import Releases from "./views/Releases";
import Avatar from "./components/Avatar";
import Banner from "./components/Banner";
import { Icon } from "./components/icons";
import { api, bindSession } from "./api";
import { classifyMR } from "./utils/classifyMR";
import { loadFilters, saveFilters, loadSelectedProjects, saveSelectedProjects } from "./utils/storage";

// ─── root (manages session via cookie) ───────────────────────────────────────

export default function Root() {
  const [ready, setReady]               = useState(false);
  const [profiles, setProfiles]         = useState([]);
  const [activeProfile, setActiveProfile] = useState(null);
  const [jiraUrl, setJiraUrl]           = useState(null);
  const [notice, setNotice]             = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get("/api/auth/profiles");
      const list = data.profiles ?? [];
      const active = list.find((p) => p.id === data.activeId) ?? null;
      // Only the account whose token died goes away; the user's other accounts stay signed in.
      bindSession(active, async (expired) => {
        setNotice(`The token for "${expired.label}" no longer works, so that account was removed. Add it again with a new token.`);
        await api.delete(`/api/auth/profiles/${expired.id}`).catch(() => {});
        await refresh();
      });
      setProfiles(list);
      setActiveProfile(active);
      setJiraUrl(data.jiraUrl ?? null);
    } catch {
      bindSession(null);
      setProfiles([]);
      setActiveProfile(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-sm text-gray-400">
        Loading…
      </div>
    );
  }

  return (
    <>
      {notice && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4">
          <Banner tone="warning" onDismiss={() => setNotice(null)} className="shadow-lg">{notice}</Banner>
        </div>
      )}
      {activeProfile ? (
        <App
          key={activeProfile.id}
          activeProfile={activeProfile}
          profiles={profiles}
          jiraUrl={jiraUrl}
          onRefresh={refresh}
        />
      ) : (
        <LoginScreen onLogin={refresh} />
      )}
    </>
  );
}

// ─── main app ────────────────────────────────────────────────────────────────

const BASICS_LABELS = { projects: "your projects", profile: "your GitLab profile", mentions: "your mentions" };

function App({ activeProfile, profiles, jiraUrl, onRefresh }) {
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
  const [searchInput, setSearchInput]               = useState(filters.search);
  const [basicsErrors, setBasicsErrors]             = useState({});
  const loadIdRef = useRef(0);

  const isMRView = view.kind === "triage" || view.kind === "browse";

  // clear stale data and search when switching view kinds
  const prevViewKindRef = useRef(view.kind);
  useEffect(() => {
    if (prevViewKindRef.current === view.kind) return;
    prevViewKindRef.current = view.kind;
    setData(null);
    setSearchInput("");
  }, [view.kind]);

  // debounce browse search
  useEffect(() => {
    if (view.kind !== "browse") return;
    const t = setTimeout(() => {
      setPage(1);
      setFilters((prev) => ({ ...prev, search: searchInput }));
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput, view.kind]);

  // Resolves to the data, or to null after recording the failure for the banner.
  const trackBasics = useCallback((key, request) => request
    .then((value) => {
      setBasicsErrors(({ [key]: _cleared, ...rest }) => rest);
      return value;
    })
    .catch((e) => {
      if (e.status !== 401) setBasicsErrors((prev) => ({ ...prev, [key]: e.message }));
      return null;
    }), []);

  const refreshMentions = useCallback(() => {
    trackBasics("mentions", api.get("/api/mentions")).then((d) => { if (d) setMentionedMRs(d); });
  }, [trackBasics]);

  const loadBasics = useCallback(() => {
    trackBasics("projects", api.get("/api/projects")).then((d) => {
      if (!d) return;
      setProjects(d);
      if (loadSelectedProjects().size === 0) {
        api.get("/api/config").then((cfg) => {
          if (!cfg.default_group) return;
          const ns = cfg.default_group.toLowerCase();
          const ids = new Set(d.filter((p) => p.path_with_namespace.toLowerCase().startsWith(ns + "/")).map((p) => p.id));
          if (ids.size > 0) { saveSelectedProjects(ids); setSelectedProjectIds(ids); }
        }).catch(() => {});
      }
    });
    trackBasics("profile", api.get("/api/me")).then((d) => { if (d) setCurrentUser(d); });
    refreshMentions();
  }, [trackBasics, refreshMentions]);

  useEffect(() => {
    const updateTodoCount = () => fetchTodoCount().then(setTodoCount).catch(() => {});
    loadBasics();
    updateTodoCount();
    const id = setInterval(updateTodoCount, 60_000);
    return () => clearInterval(id);
  }, [loadBasics]);

  useEffect(() => { saveFilters(filters); }, [filters]);

  const load = useCallback(async (f, p, isTriage, projectIds) => {
    const myLoadId = ++loadIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const ids = [...projectIds];
      const params = new URLSearchParams({
        state:    isTriage ? "opened" : f.state,
        ...(isTriage ? { triage: "1" } : { scope: f.scope }),
        page:     isTriage ? 1        : p,
        per_page: isTriage ? 100      : 25,
        ...((!isTriage && f.search) ? { search: f.search } : {}),
        ...((!isTriage && f.project_id)
          ? { project_id: f.project_id }
          : ids.length > 0 ? { project_ids: ids.join(",") } : {}),
      });
      const json = await api.get(`/api/merge-requests?${params}`);
      if (loadIdRef.current !== myLoadId) return;
      setData(json);
      if (isTriage) setTriageItems(json.items ?? []);

      const refs = (json.items ?? []).map((mr) => ({ project_id: mr.project_id, iid: mr.iid }));
      if (refs.length > 0) {
        const applyPatch = (patch) => {
          if (loadIdRef.current !== myLoadId) return;
          setData((prev) => prev ? { ...prev, items: prev.items.map(patch) } : prev);
          if (isTriage) setTriageItems((prev) => prev.map(patch));
        };

        // A failed call fills the column with null: rows show nothing rather than loading forever.
        const fillColumn = (url, field) => {
          api.post(url, refs).catch(() => ({})).then((batch) =>
            applyPatch((mr) => ({ ...mr, [field]: batch[`${mr.project_id}_${mr.iid}`] ?? null }))
          );
        };

        fillColumn("/api/merge-requests/activities", "activities_after_approval");
        fillColumn("/api/merge-requests/discussion-stats-batch", "discussion_stats");
        fillColumn("/api/merge-requests/pipelines-batch", "pipeline");
      }
    } catch (e) {
      if (loadIdRef.current !== myLoadId || e.status === 401) return;
      setError(e.message);
    } finally {
      if (loadIdRef.current === myLoadId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isMRView) return;
    load(filters, page, view.kind === "triage", selectedProjectIds);
  }, [load, filters, page, isMRView, view.kind, selectedProjectIds]);

  useEffect(() => {
    if (autoRefreshSecs === 0 || !isMRView) return;
    const isTriage = view.kind === "triage";
    const id = setInterval(() => {
      load(filters, page, isTriage, selectedProjectIds);
      if (isTriage) refreshMentions();
    }, autoRefreshSecs * 1000);
    return () => clearInterval(id);
  }, [autoRefreshSecs, isMRView, view.kind, load, refreshMentions, filters, page, selectedProjectIds]);

  const setFilter = (key) => (e) => {
    setData(null);
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const navigateBrowse = (state) => {
    setData(null);
    setFilters((prev) => ({ ...prev, state }));
    setView({ kind: "browse" });
    setPage(1);
  };

  const handleSettingsClose = () => {
    setShowSettings(false);
    setSelectedProjectIds(loadSelectedProjects());
  };

  const handleProjectClick = (projectId) => {
    setData(null);
    setFilters((prev) => ({ ...prev, project_id: String(projectId), state: "opened" }));
    setView({ kind: "browse" });
    setPage(1);
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
      if (b) c[b] += 1;
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
  const basicsFailures = Object.entries(basicsErrors);

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
        activeProfile={activeProfile}
        profiles={profiles}
        jiraUrl={jiraUrl}
        onRefresh={onRefresh}
        onProjectClick={handleProjectClick}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-12 bg-white border-b border-gray-200 px-4 flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-6 h-6 rounded-md bg-gradient-to-br from-orange-500 to-orange-600 grid place-items-center text-white text-xs font-bold select-none">⌘</span>
            <h1 className="text-sm font-semibold text-gray-900 whitespace-nowrap">GitLab MRs</h1>
          </div>

          <div className="flex-1 flex justify-center px-4 max-w-2xl mx-auto w-full">
            {isMRView && (
              <div className="relative w-full">
                <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder={view.kind === "browse" ? "Search by title…" : "Filter merge requests…"}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className={`w-full text-sm bg-gray-50 border border-gray-200 rounded-md pl-8 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors ${searchInput ? "pr-7" : "pr-3"}`}
                />
                {searchInput && (
                  <button
                    onClick={() => {
                      setSearchInput("");
                      setPage(1);
                      setFilters((prev) => ({ ...prev, search: "" }));
                    }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <Icon name="close" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowSettings(true)}
              className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-xs font-medium transition-colors ${
                selectedProjectIds.size > 0
                  ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              <Icon name="filter" />
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

        {basicsFailures.length > 0 && (
          <Banner onRetry={loadBasics} className="m-3 mb-0 shrink-0">
            {basicsFailures.map(([key, message]) => (
              <div key={key}>Could not load {BASICS_LABELS[key]}: {message}</div>
            ))}
          </Banner>
        )}

        {view.kind === "todo" ? (
          <TodoView />
        ) : view.kind === "releases" ? (
          <Releases
            jiraUrl={jiraUrl} connected={activeProfile.jiraConnected} onConnected={onRefresh}
            projects={projects} selectedProjectIds={selectedProjectIds}
          />
        ) : view.kind === "triage" ? (
          <Triage
            data={data} loading={loading} error={error}
            currentUser={currentUser} view={view}
            refresh={() => {
              load(filters, page, true, selectedProjectIds);
              refreshMentions();
            }}
            mentionedMRs={mentionedMRs}
            autoRefreshSecs={autoRefreshSecs}
            onAutoRefreshChange={setAutoRefreshSecs}
            searchQuery={searchInput}
          />
        ) : (
          <Browse
            data={data} loading={loading} error={error}
            filters={filters} setFilter={setFilter} projectOpts={projectOpts}
            needsMyApproval={needsMyApproval} setNeedsMyApproval={setNeedsMyApproval}
            refresh={() => load(filters, page, false, selectedProjectIds)}
            page={page} setPage={setPage} currentUser={currentUser}
            autoRefreshSecs={autoRefreshSecs}
            onAutoRefreshChange={setAutoRefreshSecs}
          />
        )}
      </div>
    </div>
  );
}
