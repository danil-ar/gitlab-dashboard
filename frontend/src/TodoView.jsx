import { useState, useEffect, useCallback, useMemo } from "react";

/* ─────────────────────────── action metadata ─────────────────────────── */

export const ACTIONS = {
  assigned:           { label: "assigned you",             iconBg: "bg-blue-50",    iconText: "text-blue-600",   svg: "mr"   },
  review_requested:   { label: "requested your review",    iconBg: "bg-orange-50",  iconText: "text-orange-600", svg: "thumb"},
  mentioned:          { label: "mentioned you",            iconBg: "bg-purple-100", iconText: "text-purple-500", svg: "at"   },
  directly_addressed: { label: "directly addressed you",   iconBg: "bg-purple-100", iconText: "text-purple-500", svg: "at"   },
  approval_required:  { label: "needs your approval",      iconBg: "bg-orange-50",  iconText: "text-orange-600", svg: "check"},
  build_failed:       { label: "build failed on",          iconBg: "bg-red-50",     iconText: "text-red-600",    svg: "alert"},
  unmergeable:        { label: "conflicts — cannot merge", iconBg: "bg-red-50",     iconText: "text-red-600",    svg: "alert"},
  marked:             { label: "you marked",               iconBg: "bg-yellow-100", iconText: "text-yellow-700", svg: "star" },
};

const FALLBACK_ACTION = { label: "todo", iconBg: "bg-gray-100", iconText: "text-gray-600", svg: "inbox" };

/* ─────────────────────────── icon paths ─────────────────────────── */

const SVG = {
  mr:    "M4.5 3v10M11.5 7v6M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11.5 7c-3 0-4-1.5-4-3",
  thumb: "M5 7v6.5a.5.5 0 0 0 .5.5h6.4a1 1 0 0 0 1-.8l.9-4.7a.5.5 0 0 0-.5-.6H10V5a1.5 1.5 0 0 0-3 0L5 7Zm0 0H2.5v6.5H5",
  at:    "M8 13.5A5.5 5.5 0 1 1 13.5 8M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm3-3v.5a1.5 1.5 0 0 0 3 0V8",
  check: "M3 8.5 6.5 12 13 4.5",
  alert: "M8 2.5 14 13H2L8 2.5Z M8 6.5v3.5 M8 11.5v.01",
  star:  "m8 2 1.7 3.6 3.8.5-2.8 2.7.7 3.9L8 10.8l-3.4 1.9.7-3.9L2.5 6.1l3.8-.5L8 2Z",
  inbox: "M2.5 9.5V3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6m-11 0v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3m-11 0h3l1 2h3l1-2h3",
  issue: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M8 5v3.5 M8 11v.01",
  epic:  "M2.5 3.5a1 1 0 0 1 1-1h3a2 2 0 0 1 1.5.7A2 2 0 0 1 9.5 2.5h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3a2 2 0 0 0-1.5.7 2 2 0 0 0-1.5-.7h-3a1 1 0 0 1-1-1v-8Z M8 4v8.5",
  clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Zm0-9v3.5l2.5 1.5",
  refresh: "M13.5 8A5.5 5.5 0 1 1 8 2.5c2 0 3.7 1 4.7 2.5M13.5 2.5V5H11",
};

function Glyph({ name, className = "w-3.5 h-3.5" }) {
  const d = SVG[name];
  if (!d) return null;
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d={d} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function targetIconName(type) {
  if (type === "MergeRequest") return "mr";
  if (type === "Issue") return "issue";
  if (type === "Epic") return "epic";
  return "inbox";
}

function targetIconColor(type) {
  if (type === "MergeRequest") return "text-green-600";
  if (type === "Issue") return "text-orange-600";
  return "text-gray-500";
}

function refSymbol(type) {
  return type === "MergeRequest" ? "!" : "#";
}

function shortType(type) {
  if (type === "MergeRequest") return "MR";
  if (type === "Issue") return "Issue";
  if (type === "Epic") return "Epic";
  return type ?? "—";
}

function renderBodyExcerpt(body) {
  if (!body) return null;
  return body.split(/(`[^`]+`|@\w[\w.-]*|#\d+)/).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`"))
      return <code key={i} className="font-mono bg-gray-200 px-1 rounded text-[11px]">{part.slice(1, -1)}</code>;
    if (part.startsWith("@")) return <span key={i} className="text-blue-700 font-medium">{part}</span>;
    if (part.startsWith("#")) return <span key={i} className="text-blue-700 font-mono">{part}</span>;
    return part;
  });
}

/* ─────────────────────────── atoms ─────────────────────────── */

function Avatar({ user }) {
  const [err, setErr] = useState(false);
  if (user?.avatar_url && !err) {
    return <img src={user.avatar_url} alt={user?.name ?? ""} className="w-5 h-5 rounded-full object-cover shrink-0" onError={() => setErr(true)} />;
  }
  return (
    <span className="w-5 h-5 rounded-full bg-gray-300 inline-flex items-center justify-center font-medium text-[10px] text-gray-600 shrink-0">
      {user?.name?.[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function FilterPill({ active, onClick, children, count, urgent }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
        active
          ? "bg-gray-900 border-gray-900 text-white"
          : urgent
          ? "bg-red-50 border-red-200 text-red-700 hover:bg-red-100"
          : "bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100"
      }`}
    >
      {children}
      {count != null && (
        <span className={`tabular-nums ${active ? "opacity-70" : "opacity-60"}`}>{count}</span>
      )}
    </button>
  );
}

/* ─────────────────────────── todo row ─────────────────────────── */

function TodoRow({ todo, onMarkDone, busy }) {
  const action  = ACTIONS[todo.action_name] ?? FALLBACK_ACTION;
  const target  = todo.target ?? {};
  const project = todo.project ?? {};
  const title   = target.title ?? "(no title)";
  const iid     = target.iid ?? target.id;
  const path    = project.path_with_namespace ?? "";

  return (
    <div className="group flex items-start gap-3 px-4 py-3 bg-white border-b border-gray-100 hover:bg-gray-50">
      <span className={`w-7 h-7 rounded-full inline-flex items-center justify-center shrink-0 mt-0.5 ${action.iconBg} ${action.iconText}`}>
        <Glyph name={action.svg} />
      </span>

      <div className="flex-1 min-w-0">
        {/* project · iid + time */}
        <div className="flex items-center gap-1.5 min-w-0">
          <Glyph name={targetIconName(todo.target_type)} className={`w-3 h-3 shrink-0 ${targetIconColor(todo.target_type)}`} />
          <span className="font-mono text-[11px] text-gray-500 truncate">
            {path}<span className="text-gray-400">{refSymbol(todo.target_type)}</span>{iid}
          </span>
          <span className="ml-auto text-[11px] text-gray-400 shrink-0">{timeAgo(todo.created_at)}</span>
        </div>

        {/* title */}
        {target.web_url ? (
          <a href={target.web_url} target="_blank" rel="noopener noreferrer"
             className="block mt-1 font-semibold text-[13.5px] text-gray-900 hover:text-blue-700 hover:underline truncate">
            {title}
          </a>
        ) : (
          <div className="mt-1 font-semibold text-[13.5px] text-gray-900 truncate">{title}</div>
        )}

        {/* actor + action + type chip */}
        <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-500 min-w-0">
          {todo.author ? (
            <>
              <Avatar user={todo.author} />
              <span className="text-gray-700 font-medium truncate">{todo.author.name}</span>
            </>
          ) : (
            <span className={`inline-flex items-center gap-1 font-medium ${action.iconText}`}>
              <Glyph name={action.svg} className="w-3 h-3" /> GitLab
            </span>
          )}
          <span>{action.label}</span>
          <span className="text-gray-300">·</span>
          <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10px]">{shortType(todo.target_type)}</span>
        </div>

        {/* body excerpt */}
        {todo.body && (
          <div className="mt-2 pl-2.5 border-l-2 border-gray-200 bg-gray-50/50 rounded-r px-2 py-1 text-xs text-gray-600 leading-relaxed">
            {renderBodyExcerpt(todo.body)}
          </div>
        )}
      </div>

      <button
        onClick={() => onMarkDone(todo.id)}
        disabled={busy}
        className="shrink-0 px-2 py-1 rounded text-[11px] text-gray-500 hover:bg-gray-200 hover:text-green-700 disabled:opacity-40 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
        title="Mark as done"
      >
        <Glyph name="check" className="w-3 h-3 text-green-600" /> Done
      </button>
    </div>
  );
}

/* ─────────────────────────── group header ─────────────────────────── */

function GroupHeader({ label, count, hint }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-y border-gray-200 sticky top-0 z-[1]">
      <Glyph name="clock" className="w-3 h-3 text-gray-400" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-700">{count}</span>
      {hint && <span className="ml-auto text-[11px] text-gray-400">{hint}</span>}
    </div>
  );
}

/* ─────────────────────────── main component ─────────────────────────── */

export default function TodoView() {
  const [todos, setTodos]      = useState([]);
  const [loading, setLoading]  = useState(false);
  const [error, setError]      = useState(null);
  const state = "pending";
  const [actionFilter, setAct] = useState("");
  const [busyId, setBusyId]    = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ state, per_page: 100 });
      const r = await fetch(`/api/todos?${params}`);
      if (!r.ok) throw new Error(`Error ${r.status}: ${await r.text()}`);
      setTodos(await r.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [state]);

  useEffect(() => { load(); }, [load]);

  const markDone = async (id) => {
    setBusyId(id);
    try {
      const r = await fetch(`/api/todos/${id}/done`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      setTodos((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const markAllDone = async () => {
    if (!window.confirm("Отметить ВСЕ pending todos как выполненные?")) return;
    setLoading(true);
    setAct("");
    try {
      const r = await fetch("/api/todos/mark_all_done", { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  const counts = useMemo(() => {
    const c = { byAction: {} };
    for (const t of todos) {
      c.byAction[t.action_name] = (c.byAction[t.action_name] || 0) + 1;
    }
    return c;
  }, [todos]);

  const displayTodos = useMemo(
    () => actionFilter ? todos.filter((t) => t.action_name === actionFilter) : todos,
    [todos, actionFilter],
  );

  const groups = useMemo(() => {
    const now = Date.now();
    const older = [], today = [];
    for (const t of displayTodos) {
      const age = now - new Date(t.created_at).getTime();
      (age > 86400 * 1000 ? older : today).push(t);
    }
    older.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    today.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return { older, today };
  }, [displayTodos]);

  const oldestTime = groups.older[0]?.created_at;

  return (
    <main className="flex-1 overflow-auto">
      <header className="px-5 py-4 border-b border-gray-200 bg-white shrink-0">
        <div className="flex items-start gap-3">
          <Glyph name="inbox" className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3">
              <h2 className="text-sm font-semibold text-gray-900">To-Do</h2>
              <span className="text-sm text-gray-400 tabular-nums">{displayTodos.length}</span>
            </div>
            <p className="text-xs text-gray-500">MRs, issues, mentions, build failures, approvals</p>
          </div>
          <button onClick={markAllDone}
                  className="text-sm px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50 flex items-center gap-1.5 shrink-0">
            <Glyph name="check" className="w-3 h-3 text-green-600" /> Mark all done
          </button>
          <button onClick={load}
                  className="text-sm px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50 flex items-center gap-1.5 shrink-0">
            <Glyph name="refresh" className="w-3 h-3" /> Refresh
          </button>
        </div>

        {/* Action filters (only show present action types) */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {Object.entries(ACTIONS).map(([key, meta]) => {
            const n = counts.byAction[key] ?? 0;
            if (n === 0) return null;
            const urgent = key === "build_failed" || key === "unmergeable";
            return (
              <FilterPill key={key} active={actionFilter === key}
                          onClick={() => setAct(actionFilter === key ? "" : key)}
                          count={n} urgent={urgent}>
                {meta.label.replace(" you","").replace(/^[a-z]/,(c) => c.toUpperCase())}
              </FilterPill>
            );
          })}
        </div>
      </header>

      {error && <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
      ) : displayTodos.length === 0 ? (
        <div className="text-center py-20">
          <Glyph name="check" className="w-8 h-8 text-green-500 mx-auto mb-2" />
          <p className="text-sm text-gray-700 font-semibold">All caught up</p>
          <p className="text-xs text-gray-400 mt-1">Nothing waiting on you.</p>
        </div>
      ) : (
        <>
          {groups.older.length > 0 && (
            <>
              <GroupHeader label="Older than 1 day" count={groups.older.length}
                           hint={oldestTime && `oldest ${timeAgo(oldestTime)}`} />
              {groups.older.map((t) => <TodoRow key={t.id} todo={t} onMarkDone={markDone} busy={busyId === t.id} />)}
            </>
          )}
          {groups.today.length > 0 && (
            <>
              <GroupHeader label="Today" count={groups.today.length} />
              {groups.today.map((t) => <TodoRow key={t.id} todo={t} onMarkDone={markDone} busy={busyId === t.id} />)}
            </>
          )}
        </>
      )}
    </main>
  );
}

/* ─────────────────────────── sidebar count helper ─────────────────────────── */

export async function fetchTodoCount() {
  try {
    const r = await fetch("/api/todos?state=pending&per_page=100");
    if (!r.ok) return 0;
    const list = await r.json();
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}
