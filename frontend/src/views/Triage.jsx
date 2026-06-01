import { useState, useMemo } from "react";
import { BUCKETS } from "../constants";
import { classifyMR } from "../utils/classifyMR";
import { timeAgo } from "../utils/timeAgo";
import { BucketIcon } from "../components/icons";
import BucketSection from "../components/BucketSection";
import RefreshButton from "../components/RefreshButton";

export default function Triage({ data, loading, error, currentUser, view, refresh, mentionedMRs, autoRefreshSecs, onAutoRefreshChange }) {
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
    setSelectedIds(allSelected ? new Set() : new Set(allVisible.map((mr) => mr.id)));
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
        <div className="ml-auto shrink-0">
          <RefreshButton onRefresh={refresh} loading={loading} interval={autoRefreshSecs} onIntervalChange={onAutoRefreshChange} />
        </div>
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
