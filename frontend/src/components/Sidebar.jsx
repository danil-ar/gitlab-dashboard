import Avatar from "./Avatar";
import { BucketIcon } from "./icons";

export default function Sidebar({ counts, totalOpen, view, setView, navigateBrowse, filters, projects, selectedProjectIds, openProjectSettings, currentUser, projectCounts, todosCount }) {
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
          <button
            key={state}
            onClick={() => navigateBrowse(state)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
              view.kind === "browse" && filters.state === state
                ? "bg-white shadow-sm ring-1 ring-gray-200 text-gray-900 font-semibold"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            {icon}
            <span className="flex-1 text-left">{label}</span>
            {count != null && (
              <span className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600">
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="border-t border-gray-200 p-3 flex-1 min-h-0 flex flex-col">
        <div className="px-3 py-1.5 flex items-center gap-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 flex-1">
            Projects{selectedProjectIds.size > 0 && ` · ${selectedProjectIds.size}`}
          </p>
          <button onClick={openProjectSettings} title="Configure projects" className="text-gray-400 hover:text-gray-600 w-4 h-4 flex items-center justify-center rounded">
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" strokeLinecap="round"/>
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

      {currentUser && (
        <div className="border-t border-gray-200 px-3 py-2.5 flex items-center gap-2.5">
          <Avatar user={currentUser} size="md" />
          <div className="min-w-0 leading-tight">
            <div className="text-[12px] font-semibold truncate text-gray-900">{currentUser.name}</div>
            <div className="text-[11px] text-gray-500 font-mono truncate">@{currentUser.username}</div>
          </div>
        </div>
      )}
    </aside>
  );
}
