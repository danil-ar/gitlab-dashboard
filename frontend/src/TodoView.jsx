import { useState, useEffect, useCallback, useMemo } from "react";
import Avatar from "./components/Avatar";
import Banner from "./components/Banner";
import RefreshButton from "./components/RefreshButton";
import { Icon } from "./components/icons";
import { api } from "./api";
import { timeAgo } from "./utils/timeAgo";
import { renderMd } from "./utils/renderMd";

/* ─────────────────────────── action metadata ─────────────────────────── */

const ACTIONS = {
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

/* ─────────────────────────── helpers ─────────────────────────── */

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

/* ─────────────────────────── atoms ─────────────────────────── */

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
        <Icon name={action.svg} />
      </span>

      <div className="flex-1 min-w-0">
        {/* project · iid + time/done */}
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon name={targetIconName(todo.target_type)} className={`w-3 h-3 shrink-0 ${targetIconColor(todo.target_type)}`} />
          <span className="font-mono text-[11px] text-gray-500 truncate">
            {path}<span className="text-gray-400">{refSymbol(todo.target_type)}</span>{iid}
          </span>
          <span className="ml-auto text-[11px] text-gray-400 shrink-0 group-hover:hidden">{timeAgo(todo.created_at)}</span>
          <button
            onClick={() => onMarkDone(todo.id)}
            disabled={busy}
            className="ml-auto hidden group-hover:flex items-center gap-1 text-[11px] text-gray-500 hover:text-green-700 disabled:opacity-40 shrink-0"
            title="Mark as done"
          >
            <Icon name="check" className="w-3 h-3 text-green-600" /> Done
          </button>
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
              <Icon name={action.svg} className="w-3 h-3" /> GitLab
            </span>
          )}
          <span>{action.label}</span>
          <span className="text-gray-300">·</span>
          <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10px]">{shortType(todo.target_type)}</span>
        </div>

        {/* body excerpt */}
        {todo.body && (
          <div className="mt-2 pl-2.5 border-l-2 border-gray-200 bg-gray-50/50 rounded-r px-2 py-1 text-xs text-gray-600 leading-relaxed">
            {renderMd(todo.body)}
          </div>
        )}
      </div>

    </div>
  );
}

/* ─────────────────────────── group header ─────────────────────────── */

function GroupHeader({ label, count, hint }) {
  return (
    <div className="flex items-center gap-2 pb-2">
      <Icon name="clock" className="w-3 h-3 text-gray-400" />
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
  const [actionFilter, setAct]      = useState("");
  const [busyId, setBusyId]         = useState(null);
  const [confirmAll, setConfirmAll]  = useState(false);
  const [autoRefreshSecs, setAutoRefreshSecs] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTodos(await api.get("/api/todos?state=pending&per_page=100"));
    } catch (e) {
      if (e.status !== 401) setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (autoRefreshSecs === 0) return;
    const id = setInterval(load, autoRefreshSecs * 1000);
    return () => clearInterval(id);
  }, [autoRefreshSecs, load]);

  const markDone = async (id) => {
    setBusyId(id);
    try {
      await api.post(`/api/todos/${id}/done`);
      setTodos((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const markAllDone = async () => {
    setConfirmAll(false);
    setLoading(true);
    setAct("");
    try {
      await api.post("/api/todos/mark_all_done");
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
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Icon name="inbox" className="w-4 h-4 text-blue-600 shrink-0" />
          <span className="text-sm font-semibold text-gray-900">To-Do</span>
          <span className="text-sm text-gray-400 tabular-nums">{displayTodos.length}</span>
          <div className="flex flex-wrap items-center gap-2 flex-1">
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
          <div className="flex items-center gap-2 ml-auto shrink-0">
            {confirmAll ? (
              <>
                <span className="text-xs text-gray-600">Mark all as done?</span>
                <button onClick={markAllDone}
                        className="text-xs px-2.5 py-1.5 rounded-md bg-green-600 hover:bg-green-700 text-white font-medium transition-colors">
                  Yes
                </button>
                <button onClick={() => setConfirmAll(false)}
                        className="text-xs px-2.5 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmAll(true)}
                      className="text-sm px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50 flex items-center gap-1.5">
                <Icon name="check" className="w-3 h-3 text-green-600" /> Mark all done
              </button>
            )}
            <RefreshButton onRefresh={load} loading={loading} interval={autoRefreshSecs} onIntervalChange={setAutoRefreshSecs} />
          </div>
        </div>

        {error && <Banner onRetry={load}>{error}</Banner>}

        {displayTodos.length === 0 && !loading ? (
          <div className="text-center py-20">
            <Icon name="check" className="w-8 h-8 text-green-500 mx-auto mb-2" />
            <p className="text-sm text-gray-700 font-semibold">All caught up</p>
            <p className="text-xs text-gray-400 mt-1">Nothing waiting on you.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {groups.older.length > 0 && (
              <div>
                <GroupHeader label="Older than 1 day" count={groups.older.length}
                             hint={oldestTime && `oldest ${timeAgo(oldestTime)}`} />
                <div className="rounded-lg overflow-hidden border border-gray-200">
                  {groups.older.map((t) => <TodoRow key={t.id} todo={t} onMarkDone={markDone} busy={busyId === t.id} />)}
                </div>
              </div>
            )}
            {groups.today.length > 0 && (
              <div>
                <GroupHeader label="Today" count={groups.today.length} />
                <div className="rounded-lg overflow-hidden border border-gray-200">
                  {groups.today.map((t) => <TodoRow key={t.id} todo={t} onMarkDone={markDone} busy={busyId === t.id} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

/* ─────────────────────────── sidebar count helper ─────────────────────────── */

export async function fetchTodoCount() {
  const list = await api.get("/api/todos?state=pending&per_page=100");
  return list.length;
}
