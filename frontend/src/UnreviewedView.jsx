import { useState, useEffect, useCallback } from "react";
import { api } from "./api";
import Banner from "./components/Banner";
import RefreshButton from "./components/RefreshButton";
import { timeAgo } from "./utils/timeAgo";

/** Work that has not been through review, in the two shapes it comes in.
 *
 * A branch nobody opened a merge request for is unfinished business you can
 * still act on — hence the button. A commit already sitting on a protected or
 * default branch cannot be un-merged; there the only useful thing is to know
 * about it.
 */
const query = (ids) => new URLSearchParams(ids?.length ? { project_ids: ids.join(",") } : {});

export async function fetchUnreviewedCount(projectIds) {
  const d = await api.get(`/api/unreviewed?${query(projectIds)}`);
  return (d.branches?.length ?? 0) + (d.commits?.length ?? 0);
}

function byProject(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.project_path || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function Section({ title, hint, rows, accent, renderRow, keyOf }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${accent}`} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{title}</span>
        <span className="text-[11px] text-gray-400 tabular-nums">{rows.length}</span>
        <span className="text-[11px] text-gray-400 truncate">· {hint}</span>
      </div>
      <div className="space-y-3">
        {byProject(rows).map(([project, group]) => (
          <div key={project} className="rounded-lg overflow-hidden border border-gray-200">
            {/* the project is said once here instead of on every row below */}
            <div className="flex items-center gap-2 px-4 py-1.5 bg-gray-50 border-b border-gray-200">
              {group[0].project_url ? (
                <a href={group[0].project_url} target="_blank" rel="noopener noreferrer"
                   className="font-mono text-[11px] text-gray-600 hover:text-blue-700 hover:underline truncate">
                  {project}
                </a>
              ) : (
                <span className="font-mono text-[11px] text-gray-600 truncate">{project}</span>
              )}
              <span className="text-[11px] text-gray-400 tabular-nums">{group.length}</span>
            </div>
            {group.map((row) => <div key={keyOf(row)}>{renderRow(row)}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}

const rowClass =
  "flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors";

function BranchRow({ b }) {
  return (
    <div className={rowClass}>
      <div className="flex-1 min-w-0">
        {b.branch_url ? (
          <a href={b.branch_url} target="_blank" rel="noopener noreferrer"
             className="text-sm font-semibold text-gray-900 hover:text-blue-700 hover:underline truncate inline-block max-w-full font-mono">
            {b.branch}
          </a>
        ) : (
          <code className="text-sm font-semibold text-gray-900 truncate">{b.branch}</code>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500 min-w-0 flex-nowrap overflow-hidden">
          {b.author && <span className="shrink-0">by {b.author}</span>}
          {b.commit_title && <><span className="text-gray-300 shrink-0">·</span><span className="truncate">{b.commit_title}</span></>}
        </div>
      </div>
      <span className="text-[11px] text-gray-400 tabular-nums shrink-0">{timeAgo(b.pushed_at)}</span>
      {b.create_mr_url && (
        <a href={b.create_mr_url} target="_blank" rel="noopener noreferrer"
           className="shrink-0 text-xs px-2.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors">
          Create merge request
        </a>
      )}
    </div>
  );
}

function CommitRow({ c }) {
  return (
    <a href={c.web_url} target="_blank" rel="noopener noreferrer"
       className={`${rowClass} relative before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-amber-400`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <code className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded font-mono shrink-0">{c.short_id}</code>
          <span className="text-sm text-gray-800 truncate">{c.title}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500 min-w-0 flex-nowrap overflow-hidden">
          {c.branches?.map((name) => (
            <code key={name} className="bg-gray-100 px-1 rounded text-[10px] shrink-0">{name}</code>
          ))}
          {c.author && <><span className="text-gray-300 shrink-0">·</span><span className="shrink-0 truncate">by {c.author}</span></>}
        </div>
      </div>
      <span className="text-[11px] text-gray-400 tabular-nums shrink-0">{timeAgo(c.created_at)}</span>
    </a>
  );
}

export default function UnreviewedView({ selectedProjectIds, onCount }) {
  const [data, setData]       = useState({ branches: [], commits: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const ids = [...(selectedProjectIds ?? [])].join(",");

  // Opening the view is happy with the cached answer; pressing Refresh is a
  // person saying they want it looked up again.
  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(ids ? { project_ids: ids } : {});
      if (force) params.set("refresh", "1");
      const json = await api.get(`/api/unreviewed?${params}`);
      setData({ branches: json.branches ?? [], commits: json.commits ?? [] });
      onCount?.((json.branches?.length ?? 0) + (json.commits?.length ?? 0));
    } catch (e) {
      if (e.status !== 401) setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [ids, onCount]);

  useEffect(() => { load(); }, [load]);

  const total = data.branches.length + data.commits.length;

  return (
    <main className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">No merge request</p>
            <p className="text-xs text-gray-500 mt-0.5">Work from the last two weeks that no review has seen</p>
          </div>
          <div className="ml-auto shrink-0">
            <RefreshButton onRefresh={() => load(true)} loading={loading} />
          </div>
        </div>

        {error && <Banner onRetry={() => load(true)}>{error}</Banner>}

        {error && total === 0 ? null : total === 0 && !loading ? (
          <div className="text-center py-20">
            <p className="text-sm text-gray-700 font-semibold">Everything went through review</p>
            <p className="text-xs text-gray-400 mt-1">No stray branches, nothing pushed straight to a protected branch.</p>
          </div>
        ) : (
          <>
            <Section title="Commits without a merge request" accent="bg-amber-500"
                     rows={data.commits} hint="already on a protected or default branch"
                     keyOf={(c) => `${c.project_id}_${c.short_id}`}
                     renderRow={(c) => <CommitRow c={c} />} />
            <Section title="Branches without a merge request" accent="bg-blue-500"
                     rows={data.branches} hint="nobody can review them yet"
                     keyOf={(b) => `${b.project_id}_${b.branch}`}
                     renderRow={(b) => <BranchRow b={b} />} />
          </>
        )}
      </div>
    </main>
  );
}
