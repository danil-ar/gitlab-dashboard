import { useState } from "react";
import Avatar from "./Avatar";
import { BucketIcon, Icon } from "./icons";
import { Separator } from "@/components/ui/separator";
import AboutModal from "./AboutModal";
import AccountForm from "./AccountForm";
import { api } from "../api";

const navClass = (active) => `group w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
  active
    ? "bg-white shadow-sm text-gray-900 font-semibold"
    : "text-gray-600 hover:bg-gray-200/60 hover:text-gray-900"
}`;

const SECTION_TITLE = "px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400";

const BROWSE_ICON = "w-3.5 h-3.5 shrink-0";

export default function Sidebar({
  counts, totalOpen, view, setView, navigateBrowse, filters, projects,
  selectedProjectIds, openProjectSettings, currentUser, projectCounts, todosCount, unreviewedCount,
  activeProfile, profiles, jiraUrl, onRefresh, onProjectClick,
}) {
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showAddAccount, setShowAddAccount]   = useState(false);
  const [showAbout, setShowAbout]             = useState(false);

  const runThenRefresh = async (request) => {
    await request.catch(console.error);
    await onRefresh();
  };

  const handleSwitch = (profileId) => {
    setShowProfileMenu(false);
    runThenRefresh(api.post("/api/auth/switch", { profile_id: profileId }));
  };

  const handleLogout = () => {
    setShowProfileMenu(false);
    runThenRefresh(api.post("/api/auth/logout"));
  };

  const handleRemove = (profileId) => runThenRefresh(api.delete(`/api/auth/profiles/${profileId}`));

  const triageItem = (id, label, count, accent, urgent) => (
    <button
      key={id}
      onClick={() => setView({ kind: "triage", bucket: id })}
      className={navClass(view.kind === "triage" && view.bucket === id)}
    >
      <BucketIcon id={id} className={`w-3.5 h-3.5 shrink-0 ${accent ?? "text-gray-400"}`} />
      <span className="flex-1 text-left">{label}</span>
      <span className={`text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full ${
        urgent ? "bg-orange-500 text-white" : "bg-gray-200 text-gray-500 group-hover:bg-gray-300"
      }`}>
        {count}
      </span>
    </button>
  );

  const browseStates = [
    { state: "opened", label: "All open", count: totalOpen, icon: <Icon name="circle" className={`${BROWSE_ICON} text-gray-400`} /> },
    { state: "merged", label: "Merged", icon: <Icon name="mr" className={`${BROWSE_ICON} text-purple-500`} /> },
    { state: "closed", label: "Closed", icon: <Icon name="circleX" className={`${BROWSE_ICON} text-gray-400`} /> },
  ];

  const visibleProjects = (selectedProjectIds.size > 0
    ? projects.filter((p) => selectedProjectIds.has(p.id))
    : projects
  ).slice().sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace)).slice(0, 30);

  if (showAddAccount) {
    return (
      <aside className="w-72 shrink-0 bg-gray-100 flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
          <button onClick={() => setShowAddAccount(false)}
            className="text-gray-400 hover:text-gray-700 p-1 rounded" title="Back">
            <Icon name="chevronLeft" className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium text-gray-700">Add account</span>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <AccountForm
            onSuccess={async () => { setShowAddAccount(false); await onRefresh(); }}
            onCancel={() => setShowAddAccount(false)}
          />
        </div>
      </aside>
    );
  }

  return (
    <>
    {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    <aside className="w-72 shrink-0 bg-gray-100 flex flex-col h-full overflow-hidden">
      <div className="p-3 space-y-0.5">
        <p className={SECTION_TITLE}>Triage</p>
        {triageItem("needs",    "Needs your review",   counts.needs,    "text-orange-600", counts.needs > 0)}
        {triageItem("approved", "You approved",        counts.approved, "text-green-600")}
        {triageItem("mine",     "Your open MRs",       counts.mine,     "text-blue-600")}
        {triageItem("mention",  "Mentioned you",       counts.mention,  "text-purple-500")}
        <button
          onClick={() => setView({ kind: "branches" })}
          title="Branches you pushed that no merge request was opened for"
          className={navClass(view.kind === "branches")}
        >
          <Icon name="branch" className="w-3.5 h-3.5 shrink-0 text-gray-400" />
          <span className="flex-1 text-left truncate">No merge request</span>
          {unreviewedCount > 0 && (
            <span className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 shrink-0">
              {unreviewedCount}
            </span>
          )}
        </button>
        <button onClick={() => setView({ kind: "todo" })} className={navClass(view.kind === "todo")}>
          <Icon name="todo" className="w-3.5 h-3.5 shrink-0 text-blue-400" />
          <span className="flex-1 text-left">To-Do List</span>
          {todosCount > 0 && (
            <span className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500 group-hover:bg-gray-300">
              {todosCount}
            </span>
          )}
        </button>
      </div>

      <Separator className="bg-gray-200" />
      <div className="p-3 space-y-0.5">
        <p className={SECTION_TITLE}>Browse</p>
        {browseStates.map(({ state, label, count, icon }) => (
          <button key={state} onClick={() => navigateBrowse(state)}
            className={navClass(view.kind === "browse" && filters.state === state)}
          >
            {icon}
            <span className="flex-1 text-left">{label}</span>
            {count != null && (
              <span className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500">{count}</span>
            )}
          </button>
        ))}
        {jiraUrl && (
          <button onClick={() => setView({ kind: "releases" })} className={navClass(view.kind === "releases")}>
            <Icon name="tag" className={`${BROWSE_ICON} text-teal-600`} />
            <span className="flex-1 text-left">Releases</span>
          </button>
        )}
      </div>

      <Separator className="bg-gray-200" />
      <div className="p-3 flex-1 min-h-0 flex flex-col">
        <div className="px-3 py-1.5 flex items-center gap-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 flex-1">
            Projects{selectedProjectIds.size > 0 && ` · ${selectedProjectIds.size}`}
          </p>
          <button onClick={openProjectSettings} title="Configure projects"
            className="text-gray-400 hover:text-gray-700 w-4 h-4 flex items-center justify-center rounded">
            <Icon name="gear" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 -mx-1 px-1 space-y-0.5">
          {visibleProjects.map((p) => (
            <button
              key={p.id}
              onClick={() => onProjectClick?.(p.id)}
              className="w-full px-3 py-1 flex items-center gap-1 text-[12px] text-gray-500 font-mono hover:bg-gray-200/60 hover:text-gray-700 rounded transition-colors text-left"
            >
              <span className="truncate flex-1">{p.path_with_namespace}</span>
              {projectCounts[p.id] > 0 && (
                <span className="text-[11px] text-gray-400 tabular-nums shrink-0 ml-1">{projectCounts[p.id]}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <Separator className="bg-gray-200" />
      <div className="relative">
        <button
          onClick={() => setShowProfileMenu((s) => !s)}
          className="w-full px-3 py-2.5 flex items-center gap-2.5 hover:bg-gray-200/60 transition-colors"
        >
          {currentUser ? <Avatar user={currentUser} size="md" /> : <span className="w-7 h-7 rounded-full bg-gray-200 shrink-0" />}
          <div className="min-w-0 flex-1 leading-tight text-left">
            <div className="text-[12px] font-semibold truncate text-gray-800">
              {activeProfile?.label ?? currentUser?.name ?? "—"}
            </div>
            <div className="text-[11px] text-gray-500 font-mono truncate">
              {currentUser ? `@${currentUser.username}` : activeProfile?.gitlabUrl ?? ""}
            </div>
          </div>
          <Icon name="chevronDown" className={`w-3.5 h-3.5 shrink-0 text-gray-400 transition-transform ${showProfileMenu ? "rotate-180" : ""}`} />
        </button>

        {showProfileMenu && (
          <div className="absolute bottom-full left-0 right-0 bg-white border border-gray-200 rounded-t-lg shadow-xl overflow-hidden z-10">
            {profiles.length > 1 && (
              <>
                <p className={SECTION_TITLE}>Switch account</p>
                {profiles.map((p) => (
                  <div key={p.id} className="flex items-center group">
                    <button
                      onClick={() => handleSwitch(p.id)}
                      className={`flex-1 flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                        p.id === activeProfile?.id
                          ? "bg-blue-50 text-blue-700 font-medium"
                          : "text-gray-700 hover:bg-gray-100"
                      }`}
                    >
                      <span className="w-5 h-5 rounded-full bg-gray-200 text-[10px] font-semibold flex items-center justify-center shrink-0 text-gray-500">
                        {(p.label?.[0] ?? "?").toUpperCase()}
                      </span>
                      <span className="flex-1 text-left truncate">{p.label}</span>
                      {p.id === activeProfile?.id && (
                        <Icon name="check" className="w-3.5 h-3.5 text-blue-500 shrink-0" strokeWidth={2} />
                      )}
                    </button>
                    {p.id !== activeProfile?.id && (
                      <button
                        onClick={() => handleRemove(p.id)}
                        className="px-2 py-2 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                        title="Remove account"
                      >
                        <Icon name="close" />
                      </button>
                    )}
                  </div>
                ))}
                <div className="border-t border-gray-100" />
              </>
            )}
            <button
              onClick={() => { setShowProfileMenu(false); setShowAddAccount(true); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <Icon name="circlePlus" className="w-3.5 h-3.5 text-gray-400" />
              Add account
            </button>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
            >
              <Icon name="signOut" />
              Sign out
            </button>
            <button
              onClick={() => { setShowProfileMenu(false); setShowAbout(true); }}
              className="w-full flex items-center justify-between px-3 py-2 border-t border-gray-100 hover:bg-gray-50 transition-colors"
            >
              <span className="text-[10px] text-gray-400 font-mono">GitLab MRs</span>
              <span className="text-[10px] text-gray-400 font-mono">v{__APP_VERSION__}</span>
            </button>
          </div>
        )}
      </div>
    </aside>
    </>
  );
}
