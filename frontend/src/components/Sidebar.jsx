import { useState, useEffect } from "react";
import Avatar from "./Avatar";
import { BucketIcon } from "./icons";

export default function Sidebar({
  counts, totalOpen, view, setView, navigateBrowse, filters, projects,
  selectedProjectIds, openProjectSettings, currentUser, projectCounts, todosCount,
  activeProfile, profiles, onRefresh,
}) {
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showAddAccount, setShowAddAccount]   = useState(false);

  const handleSwitch = async (profileId) => {
    setShowProfileMenu(false);
    await fetch("/api/auth/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId }),
    });
    await onRefresh();
  };

  const handleLogout = async () => {
    setShowProfileMenu(false);
    await fetch("/api/auth/logout", { method: "POST" });
    await onRefresh();
  };

  const handleRemove = async (profileId) => {
    await fetch(`/api/auth/profiles/${profileId}`, { method: "DELETE" });
    await onRefresh();
  };

  const triageItem = (id, label, count, accent, urgent) => (
    <button
      key={id}
      onClick={() => setView({ kind: "triage", bucket: id })}
      className={`group w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
        view.kind === "triage" && view.bucket === id
          ? "bg-white shadow-sm ring-1 ring-gray-200 text-gray-900 font-semibold"
          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
      }`}
    >
      <BucketIcon id={id} className={`w-3.5 h-3.5 shrink-0 ${accent ?? "text-gray-400"}`} />
      <span className="flex-1 text-left">{label}</span>
      <span className={`text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full ${
        urgent ? "bg-orange-500 text-white" : "bg-gray-200 text-gray-600 group-hover:bg-gray-300"
      }`}>
        {count}
      </span>
    </button>
  );

  const browseStates = [
    {
      state: "opened", label: "All open", count: totalOpen,
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5.5"/></svg>,
    },
    {
      state: "merged", label: "Merged",
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0 text-purple-500" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4.5 3v10M11.5 7v6M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11.5 7c-3 0-4-1.5-4-3" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    },
    {
      state: "closed", label: "Closed",
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 5.5l5 5m0-5l-5 5" strokeLinecap="round"/></svg>,
    },
  ];

  const visibleProjects = (selectedProjectIds.size > 0
    ? projects.filter((p) => selectedProjectIds.has(p.id))
    : projects
  ).slice().sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace)).slice(0, 30);

  if (showAddAccount) {
    return (
      <aside className="w-72 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
          <button onClick={() => setShowAddAccount(false)}
            className="text-gray-400 hover:text-gray-600 p-1 rounded" title="Back">
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <span className="text-sm font-medium text-gray-700">Add account</span>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <AddAccountPanel
            onDone={async () => { setShowAddAccount(false); await onRefresh(); }}
            onCancel={() => setShowAddAccount(false)}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-72 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col h-full overflow-hidden">
      <div className="p-3 space-y-0.5">
        <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Triage</p>
        {triageItem("needs",    "Needs your review",   counts.needs,    "text-orange-600", counts.needs > 0)}
        {triageItem("approved", "You approved · open", counts.approved, "text-green-600")}
        {triageItem("mine",     "Your open MRs",       counts.mine,     "text-blue-600")}
        {triageItem("mention",  "Mentioned you",       counts.mention,  "text-purple-500")}
        <button
          onClick={() => setView({ kind: "todo" })}
          className={`group w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
            view.kind === "todo"
              ? "bg-white shadow-sm ring-1 ring-gray-200 text-gray-900 font-semibold"
              : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
          }`}
        >
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0 text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="12" height="12" rx="1.5"/>
            <path d="M5 8l2 2 4-4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="flex-1 text-left">To-Do List</span>
          {todosCount > 0 && (
            <span className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600 group-hover:bg-gray-300">
              {todosCount}
            </span>
          )}
        </button>
      </div>

      <div className="border-t border-gray-200 p-3 space-y-0.5">
        <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Browse</p>
        {browseStates.map(({ state, label, count, icon }) => (
          <button key={state} onClick={() => navigateBrowse(state)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
              view.kind === "browse" && filters.state === state
                ? "bg-white shadow-sm ring-1 ring-gray-200 text-gray-900 font-semibold"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            {icon}
            <span className="flex-1 text-left">{label}</span>
            {count != null && (
              <span className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600">{count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="border-t border-gray-200 p-3 flex-1 min-h-0 flex flex-col">
        <div className="px-3 py-1.5 flex items-center gap-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 flex-1">
            Projects{selectedProjectIds.size > 0 && ` · ${selectedProjectIds.size}`}
          </p>
          <button onClick={openProjectSettings} title="Configure projects"
            className="text-gray-400 hover:text-gray-600 w-4 h-4 flex items-center justify-center rounded">
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6.5 2h3l.5 1.5 1.2-.5 2 2-.5 1.2L14 7v2l-1.3.8.5 1.2-2 2-1.2-.5L9.5 14h-3l-.5-1.5-1.2.5-2-2 .5-1.2L2 9V7l1.3-.8-.5-1.2 2-2 1.2.5L6.5 2Z" strokeLinejoin="round"/>
              <circle cx="8" cy="8" r="2"/>
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 -mx-1 px-1 space-y-0.5">
          {visibleProjects.map((p) => (
            <div key={p.id} className="px-3 py-1 flex items-center gap-1 text-[12px] text-gray-600 font-mono hover:bg-gray-100 rounded">
              <span className="truncate flex-1">{p.path_with_namespace}</span>
              {projectCounts[p.id] > 0 && (
                <span className="text-[11px] text-gray-400 tabular-nums shrink-0 ml-1">{projectCounts[p.id]}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Profile area */}
      <div className="border-t border-gray-200 relative">
        <button
          onClick={() => setShowProfileMenu((s) => !s)}
          className="w-full px-3 py-2.5 flex items-center gap-2.5 hover:bg-gray-100 transition-colors"
        >
          {currentUser ? <Avatar user={currentUser} size="md" /> : <span className="w-7 h-7 rounded-full bg-gray-200 shrink-0" />}
          <div className="min-w-0 flex-1 leading-tight text-left">
            <div className="text-[12px] font-semibold truncate text-gray-900">
              {activeProfile?.label ?? currentUser?.name ?? "—"}
            </div>
            <div className="text-[11px] text-gray-500 font-mono truncate">
              {currentUser ? `@${currentUser.username}` : activeProfile?.gitlabUrl ?? ""}
            </div>
          </div>
          <svg viewBox="0 0 16 16" className={`w-3.5 h-3.5 shrink-0 text-gray-400 transition-transform ${showProfileMenu ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {showProfileMenu && (
          <div className="absolute bottom-full left-0 right-0 bg-white border border-gray-200 rounded-t-lg shadow-lg overflow-hidden z-10">
            {profiles.length > 1 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Switch account</p>
                {profiles.map((p) => (
                  <div key={p.id} className="flex items-center group">
                    <button
                      onClick={() => handleSwitch(p.id)}
                      className={`flex-1 flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                        p.id === activeProfile?.id
                          ? "bg-blue-50 text-blue-700 font-medium"
                          : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <span className="w-5 h-5 rounded-full bg-gray-200 text-[10px] font-semibold flex items-center justify-center shrink-0 text-gray-600">
                        {(p.label?.[0] ?? "?").toUpperCase()}
                      </span>
                      <span className="flex-1 text-left truncate">{p.label}</span>
                      {p.id === activeProfile?.id && (
                        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-blue-600 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </button>
                    {p.id !== activeProfile?.id && (
                      <button
                        onClick={() => handleRemove(p.id)}
                        className="px-2 py-2 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                        title="Remove account"
                      >
                        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round"/>
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
                <div className="border-t border-gray-100" />
              </>
            )}
            <button
              onClick={() => { setShowProfileMenu(false); setShowAddAccount(true); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v5M5.5 8h5" strokeLinecap="round"/>
              </svg>
              Add account
            </button>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M10.5 11l3-3-3-3M13.5 8H6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── add account panel ────────────────────────────────────────────────────────

function AddAccountPanel({ onDone, onCancel }) {
  const [url, setUrl]             = useState("https://");
  const [token, setToken]         = useState("");
  const [label, setLabel]         = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => { if (d.gitlab_url) setUrl(d.gitlab_url); })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gitlab_url: url.trim().replace(/\/$/, ""),
          token: token.trim(),
          label: label.trim(),
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || `Error ${r.status}`);
      }
      await onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">GitLab URL</label>
        <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://gitlab.example.com"
          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Token</label>
        <div className="relative">
          <input type={showToken ? "text" : "password"} required value={token}
            onChange={(e) => setToken(e.target.value)} placeholder="glpat-…"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pr-12 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
          <button type="button" onClick={() => setShowToken((s) => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600">
            {showToken ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Label <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder="Work account"
          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 break-all">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={onCancel}
          className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={loading}
          className="flex-1 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
          {loading ? "…" : "Connect"}
        </button>
      </div>
    </form>
  );
}
