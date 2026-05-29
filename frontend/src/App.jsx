import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import TodoView, { fetchTodoCount } from "./TodoView";

/* ─────────────────────────────── constants ─────────────────────────────── */

const STATE_OPTS = [
  { value: "opened", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all",    label: "All" },
];

const SCOPE_OPTS = [
  { value: "all",             label: "All MRs" },
  { value: "created_by_me",   label: "Created by me" },
  { value: "assigned_to_me",  label: "Assigned to me" },
];

const STATE_BADGE = {
  opened: "bg-green-100 text-green-800",
  merged: "bg-purple-100 text-purple-800",
  closed: "bg-gray-100 text-gray-600",
};

const PIPELINE = {
  success:              { dot: "bg-green-500",              label: "passed"    },
  failed:               { dot: "bg-red-500",                label: "failed"    },
  running:              { dot: "bg-blue-400 animate-pulse", label: "running"   },
  pending:              { dot: "bg-yellow-400",             label: "pending"   },
  canceled:             { dot: "bg-gray-400",               label: "canceled"  },
  skipped:              { dot: "bg-gray-300",               label: "skipped"   },
  created:              { dot: "bg-gray-300",               label: "created"   },
  manual:               { dot: "bg-gray-400",               label: "manual"    },
  scheduled:            { dot: "bg-blue-300",               label: "scheduled" },
  waiting_for_resource: { dot: "bg-yellow-300",             label: "waiting"   },
  preparing:            { dot: "bg-yellow-300",             label: "preparing" },
};

const BUCKETS = {
  needs:    { id: "needs",    label: "Needs your review",         accentBar: "before:bg-orange-500", iconColor: "text-orange-600", pillBg: "bg-orange-500 text-white" },
  approved: { id: "approved", label: "You approved · still open", accentBar: "before:bg-green-500",  iconColor: "text-green-600",  pillBg: "bg-gray-200 text-gray-700" },
  mine:     { id: "mine",     label: "Your open MRs",             accentBar: "before:bg-blue-500",   iconColor: "text-blue-600",   pillBg: "bg-gray-200 text-gray-700" },
  mention:  { id: "mention",  label: "Mentioned you",             accentBar: "before:bg-purple-400", iconColor: "text-purple-500", pillBg: "bg-gray-200 text-gray-700" },
};

/* ─────────────────────────────── helpers ─────────────────────────────── */

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function classifyMR(mr, meId) {
  if (!meId || mr.state !== "opened") return null;
  const iAmAuthor = mr.author?.id === meId;
  const iApproved = mr.approved_by_users?.some((u) => u.id === meId);

  if (iAmAuthor) return "mine";
  if (iApproved) return "approved";
  return "needs";
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

/* ─────────────────────────────── atoms ─────────────────────────────── */

function Avatar({ user, size = "sm" }) {
  const [err, setErr] = useState(false);
  const dim = size === "md" ? "w-7 h-7 text-xs" : "w-5 h-5 text-[10px]";
  if (user?.avatar_url && !err) {
    return <img src={user.avatar_url} alt={user.name} className={`${dim} rounded-full object-cover`} onError={() => setErr(true)} />;
  }
  return (
    <span className={`${dim} rounded-full bg-gray-300 inline-flex items-center justify-center font-semibold text-gray-600 shrink-0`}>
      {user?.name?.[0]?.toUpperCase() ?? "?"}
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
      className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 whitespace-nowrap"
    >
      <span className={`w-2 h-2 rounded-full inline-block shrink-0 ${p.dot}`} />
      {p.label}
    </a>
  );
}

function ThreadsStatus({ stats }) {
  if (!stats) return <span className="text-[11px] text-gray-400">—</span>;
  if (stats.total === 0) return <span className="text-[11px] text-gray-400">—</span>;
  const allResolved = stats.resolved === stats.total;
  return (
    <span
      title={`${stats.resolved} of ${stats.total} threads resolved`}
      className={`flex items-center gap-1 text-xs whitespace-nowrap ${allResolved ? "text-green-600" : "text-orange-500"}`}
    >
      <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H9l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5v-6Z" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <span className="tabular-nums">{stats.resolved}/{stats.total}</span>
    </span>
  );
}

function Label({ children }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[11px] border border-gray-200/80 whitespace-nowrap">
      {children}
    </span>
  );
}

/* ─────────────────────────── icons ─────────────────────────────── */

function BucketIcon({ id, className }) {
  const path = {
    needs:    "M8 2.5 14 13H2L8 2.5Z M8 6.5v3.5 M8 11.5v.01",
    approved: "M5 7v6.5a.5.5 0 0 0 .5.5h6.4a1 1 0 0 0 1-.8l.9-4.7a.5.5 0 0 0-.5-.6H10V5a1.5 1.5 0 0 0-3 0L5 7Zm0 0H2.5v6.5H5",
    mine:     "M4.5 3v10M11.5 7v6M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11.5 7c-3 0-4-1.5-4-3",
    mention:  "M2.5 9.5V3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6m-11 0v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3m-11 0h3l1 2h3l1-2h3",
  }[id];
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d={path} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IconRefresh({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c2 0 3.7 1 4.7 2.5M13.5 2.5V5H11" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IconSearch({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3 3" strokeLinecap="round"/>
    </svg>
  );
}

function IconFilter({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4h12M4 8h8M6 12h4" strokeLinecap="round"/>
    </svg>
  );
}

function IconClock({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2 1" strokeLinecap="round"/>
    </svg>
  );
}

/* ─────────────────────────── MR row ─────────────────────────── */

function MRRow({ mr, currentUserId, bucket, selected, onToggle }) {
  const cleanTitle = mr.title.replace(/^(Draft|WIP):\s*/i, "");
  const isDraft    = mr.draft || /^(Draft|WIP):/i.test(mr.title);
  const proj       = mr.references?.full?.split("!")[0] ?? "";

  const accentClass = bucket?.accentBar
    ? `relative before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${bucket.accentBar}`
    : "";

  return (
    <div className={`group flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 hover:bg-gray-50/70 transition-colors ${accentClass}`}>
      <input type="checkbox" checked={!!selected} onChange={() => onToggle?.(mr.id)} className="rounded shrink-0 accent-blue-600" />

      {/* MR icon */}
      <svg viewBox="0 0 16 16" className={`w-4 h-4 shrink-0 ${isDraft ? "text-gray-400" : "text-green-600"}`} fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4.5 3v10M11.5 7v6M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11.5 7c-3 0-4-1.5-4-3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <a
            href={mr.web_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-gray-900 hover:text-blue-700 hover:underline truncate"
          >
            {cleanTitle}
          </a>
          {isDraft && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-300 shrink-0">Draft</span>
          )}
          {mr.has_conflicts && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200 shrink-0">conflicts</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500 min-w-0 flex-wrap">
          <span className="font-mono shrink-0 truncate max-w-[200px]">{proj}<span className="text-gray-400">!{mr.iid}</span></span>
          <span className="text-gray-300 shrink-0">·</span>
          <span className="shrink-0">by <span className="text-gray-700">{mr.author?.name}</span></span>
          <span className="text-gray-300 shrink-0">·</span>
          <span className="flex items-center gap-1 shrink-0">
            →&nbsp;<code className="bg-gray-100 px-1 rounded text-[10px]">{mr.target_branch}</code>
          </span>
          {mr.labels?.slice(0, 3).map((l) => <Label key={l}>{l}</Label>)}
        </div>
      </div>

      {/* Pipeline */}
      <div className="w-[72px] hidden md:flex shrink-0">
        <PipelineStatus pipeline={mr.pipeline} />
      </div>

      {/* Threads */}
      <div className="w-[48px] hidden md:flex shrink-0">
        <ThreadsStatus stats={mr.discussion_stats} />
      </div>

      {/* Approvals */}
      <div className="w-[96px] hidden md:flex items-center gap-1.5 shrink-0">
        {mr.approved_by_users?.length > 0 ? (
          <>
            <span className="flex -space-x-1.5">
              {mr.approved_by_users.slice(0, 2).map((u) => (
                <span key={u.id} className="ring-2 ring-white rounded-full">
                  <Avatar user={u} />
                </span>
              ))}
            </span>
            <span className="text-xs text-green-700 font-semibold tabular-nums">{mr.approved_by_users.length}</span>
          </>
        ) : (
          <span className="text-[11px] text-gray-400">no approvals</span>
        )}
      </div>

      {/* Assignees */}
      <div className="w-[44px] hidden lg:flex -space-x-1.5 shrink-0">
        {mr.assignees?.slice(0, 2).map((a) => (
          <span key={a.id} className="ring-2 ring-white rounded-full"><Avatar user={a} /></span>
        ))}
        {!mr.assignees?.length && <span className="text-[11px] text-gray-400">—</span>}
      </div>

      {/* Time */}
      <span className="w-[56px] text-right text-[11px] text-gray-400 tabular-nums shrink-0">
        {timeAgo(mr.updated_at)}
      </span>

      {/* Actions menu */}
      <button className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 shrink-0 transition-opacity" title="More actions">
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor">
          <circle cx="8" cy="3" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="13" r="1.2"/>
        </svg>
      </button>
    </div>
  );
}

/* ─────────────────────────── bucket section ─────────────────────────── */

function BucketSection({ bucket, mrs, hint, currentUserId, defaultOpen = true, selectedIds, onToggle }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <header className="flex items-center gap-2.5 px-4 py-2.5 bg-gray-50 border-y border-gray-200 sticky top-0 z-[1]">
        <button onClick={() => setOpen((v) => !v)} className="text-gray-400 hover:text-gray-600 text-xs w-4 shrink-0">
          {open ? "▾" : "▸"}
        </button>
        <BucketIcon id={bucket.id} className={`w-3.5 h-3.5 shrink-0 ${bucket.iconColor}`} />
        <span className="text-[13px] font-semibold text-gray-900">{bucket.label}</span>
        <span className={`text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full ${bucket.pillBg}`}>
          {mrs.length}
        </span>
        {hint && (
          <span className="text-[11px] text-gray-500 ml-1 flex items-center gap-1">
            {bucket.id === "needs" && mrs.length > 0 && (
              <IconClock className="w-3 h-3 text-orange-500 shrink-0" />
            )}
            {hint}
          </span>
        )}
      </header>
      {open && (
        <div>
          {mrs.length === 0 ? (
            <p className="text-center py-6 text-xs text-gray-400 bg-white border-b border-gray-100">All clear ✓</p>
          ) : (
            mrs.map((mr) => (
              <MRRow key={mr.id} mr={mr} currentUserId={currentUserId} bucket={bucket}
                     selected={selectedIds?.has(mr.id)} onToggle={onToggle} />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────── sidebar ─────────────────────────── */

function Sidebar({ counts, totalOpen, view, setView, navigateBrowse, filters, projects, selectedProjectIds, openProjectSettings, currentUser, projectCounts, todosCount }) {
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

  const visibleInSidebar = (selectedProjectIds.size > 0
    ? projects.filter((p) => selectedProjectIds.has(p.id))
    : projects
  ).slice().sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace)).slice(0, 30);

  return (
    <aside className="w-72 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col h-full overflow-hidden">
      {/* Triage */}
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

      {/* Browse */}
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

      {/* Projects */}
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
          {visibleInSidebar.map((p) => (
            <div key={p.id} className="px-3 py-1 flex items-center gap-1 text-[12px] text-gray-600 font-mono hover:bg-gray-100 rounded">
              <span className="truncate flex-1">{p.path_with_namespace}</span>
              {projectCounts[p.id] > 0 && (
                <span className="text-[11px] text-gray-400 tabular-nums shrink-0 ml-1">{projectCounts[p.id]}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Current user */}
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

/* ─────────────────────────── ProjectSettings ─────────────────────────── */

function ProjectSettings({ projects, onClose }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => {
    try {
      const saved = localStorage.getItem("gl_selected_projects");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  const filtered = projects
    .filter((p) => p.path_with_namespace.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));

  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    localStorage.setItem("gl_selected_projects", JSON.stringify([...next]));
    return next;
  });

  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allFilteredSelected) filtered.forEach((p) => next.delete(p.id));
    else                     filtered.forEach((p) => next.add(p.id));
    localStorage.setItem("gl_selected_projects", JSON.stringify([...next]));
    return next;
  });

  const clearAll = () => { setSelected(new Set()); localStorage.removeItem("gl_selected_projects"); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Project filter</h2>
          <div className="flex items-center gap-3">
            {selected.size > 0 && <button onClick={clearAll} className="text-xs text-gray-400 hover:text-gray-600">Clear all ({selected.size})</button>}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          </div>
        </div>
        <div className="px-5 py-3 border-b border-gray-100">
          <input autoFocus type="search" placeholder="Filter projects…" value={search} onChange={(e) => setSearch(e.target.value)}
                 className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="px-5 py-2 border-b border-gray-100 flex items-center gap-2">
          <input type="checkbox" id="toggle-all" checked={allFilteredSelected} onChange={toggleAll} className="rounded" />
          <label htmlFor="toggle-all" className="text-xs text-gray-500 cursor-pointer select-none">
            {allFilteredSelected ? "Deselect all" : "Select all"} ({filtered.length})
          </label>
          {selected.size === 0 && <span className="ml-auto text-xs text-gray-400">No selection = show all</span>}
        </div>
        <div className="overflow-y-auto flex-1 px-2 py-2">
          {filtered.length === 0 ? (
            <p className="text-center py-8 text-sm text-gray-400">No projects found</p>
          ) : filtered.map((p) => (
            <label key={p.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="rounded shrink-0" />
              <span className="text-sm text-gray-700 truncate">{p.path_with_namespace}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── browse mode ─────────────────────────── */

function Browse({ data, loading, error, filters, setFilter, projectOpts, needsMyApproval, setNeedsMyApproval, refresh, searchRef, handleSearch, page, setPage, currentUser }) {
  const visibleItems = needsMyApproval && currentUser
    ? (data?.items ?? []).filter((mr) => !mr.approved_by_users?.some((u) => u.id === currentUser.id))
    : (data?.items ?? []);

  return (
    <main className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex flex-wrap gap-3 mb-6">
          <form onSubmit={handleSearch} className="flex gap-2">
            <input ref={searchRef} type="search" placeholder="Search…" defaultValue={filters.search}
                   className="text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" className="text-sm px-3 py-2 rounded-md border border-gray-200 bg-white hover:bg-gray-50">Search</button>
          </form>
          <select value={filters.state} onChange={setFilter("state")} className="text-sm border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            {STATE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={filters.scope} onChange={setFilter("scope")} className="text-sm border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            {SCOPE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={filters.project_id} onChange={setFilter("project_id")} className="text-sm border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-xs">
            {projectOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={() => setNeedsMyApproval((v) => !v)}
                  className={`text-sm px-4 py-2 rounded-md border transition-colors ${
                    needsMyApproval ? "bg-orange-500 border-orange-500 text-white hover:bg-orange-600"
                                    : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                  }`}>
            Needs my approval
          </button>
          <button onClick={refresh} className="ml-auto text-sm px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700">Refresh</button>
        </div>

        {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}

        {loading ? (
          <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
        ) : (
          <>
            <div className="rounded-lg overflow-hidden border border-gray-200 bg-white">
              {visibleItems.map((mr, i, arr) => (
                <div key={mr.id} className={i === arr.length - 1 ? "[&>div]:border-b-0" : ""}>
                  <MRRow mr={mr} currentUserId={currentUser?.id} />
                </div>
              ))}
              {visibleItems.length === 0 && <div className="text-center py-16 text-gray-400 text-sm">No merge requests found</div>}
            </div>
            {data && data.total_pages > 1 && (
              <div className="mt-6 flex items-center justify-between text-sm text-gray-500">
                <span>{data.total} total</span>
                <div className="flex items-center gap-2">
                  <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50">← Prev</button>
                  <span>{page} / {data.total_pages}</span>
                  <button disabled={page >= data.total_pages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50">Next →</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/* ─────────────────────────── triage mode ─────────────────────────── */

function Triage({ data, loading, error, currentUser, view, refresh, mentionedMRs }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [approving, setApproving] = useState(false);

  const toggleOne = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const all = data?.items ?? [];
  const classified = useMemo(() => {
    const out = { needs: [], approved: [], mine: [], mention: mentionedMRs ?? [] };
    if (!currentUser) return out;
    for (const mr of all) {
      const b = classifyMR(mr, currentUser.id);
      if (b) out[b].push(mr);
    }
    ["needs", "approved", "mine", "mention"].forEach((k) =>
      out[k].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    );
    return out;
  }, [all, currentUser, mentionedMRs]);

  const order = view.bucket && view.bucket !== "all"
    ? [view.bucket, ...["needs", "approved", "mine", "mention"].filter((k) => k !== view.bucket)]
    : ["needs", "approved", "mine", "mention"];

  const allVisible = order.flatMap((id) => classified[id]);
  const allSelected = allVisible.length > 0 && allVisible.every((mr) => selectedIds.has(mr.id));

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allVisible.map((mr) => mr.id)));
    }
  };

  const handleApprove = async () => {
    if (selectedIds.size === 0 || approving) return;
    setApproving(true);
    const mrs = allVisible.filter((mr) => selectedIds.has(mr.id));
    await Promise.allSettled(
      mrs.map((mr) =>
        fetch(`/api/merge-requests/${mr.project_id}/${mr.iid}/approve`, { method: "POST" })
      )
    );
    setSelectedIds(new Set());
    setApproving(false);
    refresh();
  };

  const mineHint = (() => {
    if (!classified.mine.length) return null;
    const running = classified.mine.filter((m) => m.pipeline?.status === "running").length;
    const draft   = classified.mine.filter((m) => m.draft).length;
    const parts   = [];
    if (running > 0) parts.push(`${running} running`);
    if (draft > 0)   parts.push(`${draft} draft`);
    return parts.length > 0 ? parts.join(" · ") : null;
  })();

  const oldest = classified.needs.length > 0
    ? [...classified.needs].sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at))[0]
    : null;
  const hints = {
    needs:    oldest ? `oldest ${timeAgo(oldest.updated_at)}` : "all clear",
    approved: classified.approved.length > 0 ? "waiting on other reviewers" : null,
    mine:     mineHint,
    mention:  "tagged in discussion",
  };

  return (
    <main className="flex-1 overflow-auto">
      <header className="px-5 py-3.5 border-b border-gray-200 flex items-center gap-3 bg-white shrink-0">
        <BucketIcon
          id={view.bucket && view.bucket !== "all" ? view.bucket : "needs"}
          className="w-5 h-5 text-orange-600 shrink-0"
        />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">
            {view.bucket && BUCKETS[view.bucket] ? BUCKETS[view.bucket].label : "Triage queue"}
          </h2>
          <p className="text-xs text-gray-500">
            {all.filter((m) => m.state === "opened").length} open merge requests grouped by what needs your attention
          </p>
        </div>
        <button onClick={refresh} className="ml-auto text-sm px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50 flex items-center gap-1.5 shrink-0">
          <IconRefresh className="w-3.5 h-3.5" />
          Refresh
        </button>
      </header>

      <div className="px-5 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2.5 text-xs text-gray-500">
        <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded accent-blue-600" />
        <span className="text-gray-700 font-medium cursor-pointer select-none" onClick={toggleAll}>
          {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
        </span>
        <span className="w-px h-3.5 bg-gray-300 mx-0.5" />
        <button
          onClick={handleApprove}
          disabled={selectedIds.size === 0 || approving}
          className="px-2 py-0.5 rounded hover:bg-gray-200 text-gray-600 disabled:opacity-40 disabled:cursor-default flex items-center gap-1"
        >
          {approving ? (
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 2a6 6 0 1 0 6 6" strokeLinecap="round"/>
            </svg>
          ) : "✓"} Approve
        </button>
        <button className="px-2 py-0.5 rounded hover:bg-gray-200 text-gray-600 opacity-40 cursor-default">Mark read</button>
        <button className="px-2 py-0.5 rounded hover:bg-gray-200 text-gray-600 opacity-40 cursor-default">Snooze</button>
        <span className="ml-auto">Sort: <span className="text-gray-900 font-medium">Newest first</span></span>
      </div>

      {error && <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
      ) : (
        order.map((id) => (
          <BucketSection key={id} bucket={BUCKETS[id]} mrs={classified[id]} hint={hints[id]}
                         currentUserId={currentUser?.id} selectedIds={selectedIds} onToggle={toggleOne} />
        ))
      )}
    </main>
  );
}

/* ─────────────────────────────── App ─────────────────────────────── */

export default function App() {
  const [view, setView]                       = useState({ kind: "triage", bucket: "needs" });
  const [filters, setFilters]                 = useState(loadFilters);
  const [needsMyApproval, setNeedsMyApproval] = useState(false);
  const [page, setPage]                       = useState(1);
  const [data, setData]                       = useState(null);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState(null);
  const [projects, setProjects]               = useState([]);
  const [currentUser, setCurrentUser]         = useState(null);
  const [mentionedMRs, setMentionedMRs]       = useState([]);
  const [showSettings, setShowSettings]       = useState(false);
  const [todoCount, setTodoCount]             = useState(0);
  const [triageItems, setTriageItems]         = useState([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => {
    try {
      const saved = localStorage.getItem("gl_selected_projects");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const searchRef = useRef(null);

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then(setProjects).catch(() => {});
    fetch("/api/me").then((r) => r.json()).then(setCurrentUser).catch(() => {});
    fetch("/api/mentions").then((r) => r.json()).then(setMentionedMRs).catch(() => {});
    fetchTodoCount().then(setTodoCount);
    const id = setInterval(() => fetchTodoCount().then(setTodoCount), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try { localStorage.setItem("gl_filters", JSON.stringify(filters)); } catch {}
  }, [filters]);

  const load = useCallback(async (f, p, isTriage) => {
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
    load(filters, page, view.kind === "triage");
  }, [load, filters, page, view.kind]);

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
    try {
      const saved = localStorage.getItem("gl_selected_projects");
      setSelectedProjectIds(saved ? new Set(JSON.parse(saved)) : new Set());
    } catch { setSelectedProjectIds(new Set()); }
    load(filters, page, view.kind === "triage");
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
        {/* Top bar */}
        <header className="h-12 bg-white border-b border-gray-200 px-4 flex items-center gap-3 shrink-0">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-6 h-6 rounded-md bg-gradient-to-br from-orange-500 to-orange-600 grid place-items-center text-white text-xs font-bold select-none">⌘</span>
            <h1 className="text-sm font-semibold text-gray-900 whitespace-nowrap">GitLab MRs</h1>
          </div>

          {/* Center search */}
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

          {/* Right actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { if (view.kind !== "todo") load(filters, page, view.kind === "triage"); }}
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
          <Triage data={data} loading={loading} error={error} currentUser={currentUser} view={view}
            refresh={() => {
              load(filters, page, true);
              fetch("/api/mentions").then((r) => r.json()).then(setMentionedMRs).catch(() => {});
            }}
            mentionedMRs={mentionedMRs} />
        ) : (
          <Browse
            data={data} loading={loading} error={error}
            filters={filters} setFilter={setFilter} projectOpts={projectOpts}
            needsMyApproval={needsMyApproval} setNeedsMyApproval={setNeedsMyApproval}
            refresh={() => load(filters, page, view.kind === "triage")}
            searchRef={searchRef} handleSearch={handleSearch}
            page={page} setPage={setPage} currentUser={currentUser}
          />
        )}
      </div>
    </div>
  );
}
