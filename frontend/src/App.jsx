import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import UnreviewedView, { fetchUnreviewedCount } from "./UnreviewedView";
import TodoView, { fetchTodoCount } from "./TodoView";
import Sidebar from "./components/Sidebar";
import LoginScreen from "./components/LoginScreen";
import ProjectSettings from "./components/ProjectSettings";
import Triage from "./views/Triage";
import Browse from "./views/Browse";
import Avatar from "./components/Avatar";
import { IconSearch, IconFilter } from "./components/icons";
import { classifyMR } from "./utils/classifyMR";
import { loadFilters, saveFilters, loadSelectedProjects, saveSelectedProjects } from "./utils/storage";

// ─── root (manages session via cookie) ───────────────────────────────────────

export default function Root() {
  const [ready, setReady]               = useState(false);
  const [profiles, setProfiles]         = useState([]);
  const [activeProfile, setActiveProfile] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/profiles");
      const data = await r.json();
      const list = data.profiles ?? [];
      const active = list.find((p) => p.id === data.activeId) ?? null;
      setProfiles(list);
      setActiveProfile(active);
    } catch {
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

  if (!activeProfile) {
    return <LoginScreen onLogin={refresh} />;
  }

  return (
    <App
      key={activeProfile.id}
      activeProfile={activeProfile}
      profiles={profiles}
      onRefresh={refresh}
    />
  );
}

// ─── main app ────────────────────────────────────────────────────────────────

function App({ activeProfile, profiles, onRefresh }) {
  const profileId = activeProfile.id;
  const [view, setView]                             = useState({ kind: "triage", bucket: "needs" });
  const [filters, setFilters]                       = useState(() => loadFilters(profileId));
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
  const [unreviewedCount, setUnreviewedCount]       = useState(0);
  const [triageItems, setTriageItems]               = useState([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => loadSelectedProjects(profileId));
  const [autoRefreshSecs, setAutoRefreshSecs]       = useState(0);
  const [searchInput, setSearchInput]               = useState(filters.search);
  const loadIdRef = useRef(0);

  // `lastQueryRef` describes what `data` currently holds, which is how the
  // loader knows that a re-render asking for the same query needs no fetch. The
  // two must therefore be emptied together: clearing the list while still
  // claiming its query is loaded is what left the triage groups reading zero
  // after a trip to another view.
  const lastQueryRef = useRef("");
  const clearData = useCallback(() => {
    setData(null);
    lastQueryRef.current = "";
  }, []);

  // clear stale data and search when switching view kinds
  const prevViewKindRef = useRef(view.kind);
  useEffect(() => {
    if (prevViewKindRef.current === view.kind) return;
    prevViewKindRef.current = view.kind;
    clearData();
    setSearchInput("");
    // the committed query has to go too, otherwise the emptied box still
    // filters the list you come back to
    setFilters((prev) => (prev.search ? { ...prev, search: "" } : prev));
  }, [view.kind]);

  // debounce browse search
  useEffect(() => {
    if (view.kind !== "browse") return;
    const t = setTimeout(() => {
      // Entering a browse view runs this too, with the same empty box. Handing
      // back `prev` untouched keeps that from looking like a new query.
      setFilters((prev) =>
        (prev.search ?? "") === searchInput ? prev : { ...prev, search: searchInput }
      );
      setPage((p) => (p === 1 ? p : 1));
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput, view.kind]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    onRefresh();
  }, [onRefresh]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => { if (r.status === 401) { signOut(); return null; } return r.json(); })
      .then((d) => {
        if (!d) return;
        setProjects(d);
        if (loadSelectedProjects(profileId).size === 0) {
          fetch("/api/config").then((r) => r.json()).then((cfg) => {
            if (!cfg.default_group) return;
            const ns = cfg.default_group.toLowerCase();
            const ids = new Set(d.filter((p) => p.path_with_namespace.toLowerCase().startsWith(ns + "/")).map((p) => p.id));
            if (ids.size > 0) { saveSelectedProjects(profileId, ids); setSelectedProjectIds(ids); }
          }).catch(() => {});
        }
      })
      .catch(console.error);
    fetch("/api/me").then((r) => { if (r.status === 401) { signOut(); return null; } return r.json(); }).then((d) => d && setCurrentUser(d)).catch(console.error);
    fetch("/api/mentions").then((r) => { if (r.status === 401) return null; return r.json(); }).then((d) => d && setMentionedMRs(d)).catch(console.error);
    fetchTodoCount().then(setTodoCount);
    // same project filter the view will use, or the badge would count branches
    // the list then refuses to show
    fetchUnreviewedCount([...loadSelectedProjects(profileId)]).then(setUnreviewedCount).catch(() => {});
    const id = setInterval(() => fetchTodoCount().then(setTodoCount), 60_000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { saveFilters(profileId, filters); }, [profileId, filters]);

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
      const r = await fetch(`/api/merge-requests?${params}`);
      if (r.status === 401) { signOut(); return; }
      if (!r.ok) throw new Error(`Error ${r.status}: ${await r.text()}`);
      const json = await r.json();
      if (loadIdRef.current !== myLoadId) return;
      setData(json);
      if (isTriage) setTriageItems(json.items ?? []);

      // updated_at lets the server cache the expensive post-approval lookups
      // until the MR actually changes, instead of re-scanning on every refresh
      const refs = (json.items ?? []).map((mr) => ({
        project_id: mr.project_id,
        iid:        mr.iid,
        updated_at: mr.updated_at ?? "",
      }));
      if (refs.length > 0) {
        const body = JSON.stringify(refs);
        const headers = { "Content-Type": "application/json" };

        const applyPatch = (patch) => {
          if (loadIdRef.current !== myLoadId) return;
          setData((prev) => prev ? { ...prev, items: prev.items.map(patch) } : prev);
          if (isTriage) setTriageItems((prev) => prev.map(patch));
        };

        const bgFetch = (url, onData) => {
          fetch(url, { method: "POST", headers, body })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (data) onData(data); })
            .catch(() => {});
        };

        bgFetch("/api/merge-requests/activities", (activities) =>
          applyPatch((mr) => ({
            ...mr,
            activities_after_approval: activities[`${mr.project_id}_${mr.iid}`] ?? null,
          }))
        );

        // Counters ride along with the GraphQL list; the thread text behind them
        // is fetched by ThreadsStatus for the one row somebody actually opens,
        // instead of downloading every thread of every MR to render "11/12".
        const statsIncluded = (json.items ?? []).some((mr) => "discussion_stats" in mr);
        if (!statsIncluded) {
          bgFetch("/api/merge-requests/discussion-stats-batch", (statsBatch) =>
            applyPatch((mr) => ({
              ...mr,
              discussion_stats: statsBatch[`${mr.project_id}_${mr.iid}`] ?? null,
            }))
          );
        }

        // The GraphQL path already ships pipelines with the list; asking again
        // would spend the round trip the switch was meant to save.
        const pipelinesIncluded = (json.items ?? []).some((mr) => "pipeline" in mr);
        if (!pipelinesIncluded) {
          bgFetch("/api/merge-requests/pipelines-batch", (pipelinesBatch) =>
            applyPatch((mr) => ({
              ...mr,
              pipeline: pipelinesBatch[`${mr.project_id}_${mr.iid}`] ?? null,
            }))
          );
        }
      }
    } catch (e) {
      if (loadIdRef.current !== myLoadId) return;
      setError(e.message === "Failed to fetch" ? "Could not reach the server. Check your connection." : e.message);
    } finally {
      if (loadIdRef.current === myLoadId) setLoading(false);
    }
  }, []);

  // What the loader watches are objects, and React compares those by identity —
  // so a re-render that rebuilds `filters` with identical contents used to cost
  // a second full fetch of the same page. Compare the query instead.
  useEffect(() => {
    if (view.kind === "todo" || view.kind === "branches") return;
    const query = JSON.stringify([view.kind, page, filters, [...selectedProjectIds].sort()]);
    if (query === lastQueryRef.current) return;
    lastQueryRef.current = query;
    load(filters, page, view.kind === "triage", selectedProjectIds);
  }, [load, filters, page, view.kind, selectedProjectIds]);

  useEffect(() => {
    if (autoRefreshSecs === 0 || view.kind === "todo" || view.kind === "branches") return;
    const isTriage = view.kind === "triage";
    const id = setInterval(() => {
      load(filters, page, isTriage, selectedProjectIds);
      if (isTriage) {
        fetch("/api/mentions").then((r) => r.json()).then(setMentionedMRs).catch(console.error);
      }
    }, autoRefreshSecs * 1000);
    return () => clearInterval(id);
  }, [autoRefreshSecs, view.kind, load, filters, page, selectedProjectIds]);

  const setFilter = (key) => (e) => {
    clearData();
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  // The loader skips a query it has already run, so blanking the list on a
  // navigation that changes nothing would leave it blank. Re-selecting the tab
  // or project you are already looking at is that case.
  const goBrowse = (patch) => {
    const unchanged = view.kind === "browse"
      && Object.entries(patch).every(([key, value]) => filters[key] === value);
    if (!unchanged) {
      clearData();
      setFilters((prev) => ({ ...prev, ...patch }));
    }
    setView({ kind: "browse" });
    setPage(1);
  };

  const navigateBrowse = (state) => goBrowse({ state });

  const handleSettingsClose = () => {
    setShowSettings(false);
    setSelectedProjectIds(loadSelectedProjects(profileId));
  };

  const handleProjectClick = (projectId) =>
    goBrowse({ project_id: String(projectId), state: "opened" });

  const visibleProjects = (selectedProjectIds.size > 0
    ? projects.filter((p) => selectedProjectIds.has(p.id))
    : projects
  ).slice().sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));

  const projectOpts = [
    { value: "",  label: "All projects" },
    ...visibleProjects.map((p) => ({ value: String(p.id), label: p.path_with_namespace })),
  ];

  const counts = useMemo(() => {
    // a mention on a merge request already in a bucket is shown on its row, so
    // counting it here as well would count the same thing twice
    const listed = new Set(triageItems.map((mr) => mr.id));
    const c = {
      needs: 0, approved: 0, mine: 0,
      mention: mentionedMRs.filter((mr) => !listed.has(mr.id)).length,
    };
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

  // "All open" navigates to Browse, which applies scope and the single-project
  // filter — the triage tally only describes that list when neither is narrowing
  // it, so drop the number rather than show one that disagrees with the page.
  const totalOpen = filters.scope === "all" && !filters.project_id
    ? triageItems.filter((m) => m.state === "opened").length
    : null;

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {showSettings && <ProjectSettings projects={projects} profileId={profileId} onClose={handleSettingsClose} />}

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
        unreviewedCount={unreviewedCount}
        activeProfile={activeProfile}
        profiles={profiles}
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
            <div className="relative w-full">
              <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
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
                  <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round"/>
                  </svg>
                </button>
              )}
            </div>
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
          <TodoView onUnauthorized={signOut} onCountChange={setTodoCount} />
        ) : view.kind === "branches" ? (
          <UnreviewedView selectedProjectIds={selectedProjectIds} onCount={setUnreviewedCount} />
        ) : view.kind === "triage" ? (
          <Triage
            data={data} loading={loading} error={error}
            currentUser={currentUser} view={view}
            refresh={() => {
              load(filters, page, true, selectedProjectIds);
              fetch("/api/mentions").then((r) => r.json()).then(setMentionedMRs).catch(console.error);
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
            searchQuery={filters.search}
            page={page} setPage={setPage} currentUser={currentUser}
            autoRefreshSecs={autoRefreshSecs}
            onAutoRefreshChange={setAutoRefreshSecs}
          />
        )}
      </div>
    </div>
  );
}
