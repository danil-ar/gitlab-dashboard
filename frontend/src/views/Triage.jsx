import { useState, useMemo, useEffect } from "react";
import { BUCKETS } from "../constants";
import { classifyMR } from "../utils/classifyMR";
import { timeAgo } from "../utils/timeAgo";
import { BucketIcon, IconSpin } from "../components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import BucketSection from "../components/BucketSection";
import RefreshButton from "../components/RefreshButton";

/** POST that fails loudly, carrying GitLab's reason instead of a bare status. */
async function post(url) {
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    const detail = await r.json().then((d) => d?.detail).catch(() => null);
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return r;
}

const mrRef = (mr) => mr.references?.full ?? `!${mr.iid}`;

export default function Triage({ data, loading, error, currentUser, view, refresh, mentionedMRs, autoRefreshSecs, onAutoRefreshChange, searchQuery = "" }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [approving, setApproving]     = useState(false);
  const [reapproving, setReapproving] = useState(false);
  const [unapproving, setUnapproving] = useState(false);
  const [doneMsg, setDoneMsg]         = useState(null);
  const [actionError, setActionError] = useState(null);
  const [sortBy, setSortBy]           = useState("newest");

  useEffect(() => { setSelectedIds(new Set()); }, [view.bucket]);

  const toggleOne = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const sortFn = useMemo(() => ({
    newest: (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
    oldest: (a, b) => new Date(a.updated_at) - new Date(b.updated_at),
    title:  (a, b) => a.title.localeCompare(b.title),
  })[sortBy], [sortBy]);

  const all = data?.items ?? [];
  const classified = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const match = (mr) => !q || mr.title.toLowerCase().includes(q);
    const out = { needs: [], approved: [], mine: [], mention: (mentionedMRs ?? []).filter(match) };
    if (!currentUser) return out;
    for (const mr of all) {
      if (!match(mr)) continue;
      const b = classifyMR(mr, currentUser.id);
      if (b) out[b].push(mr);
    }
    ["needs", "approved", "mine", "mention"].forEach((k) => out[k].sort(sortFn));
    return out;
  }, [all, currentUser, mentionedMRs, sortFn, searchQuery]);

  const order = view.bucket && view.bucket !== "all"
    ? [view.bucket, ...["needs", "approved", "mine", "mention"].filter((k) => k !== view.bucket)]
    : ["needs", "approved", "mine", "mention"];

  const allVisible = order.flatMap((id) => classified[id]);
  const allSelected = allVisible.length > 0 && allVisible.every((mr) => selectedIds.has(mr.id));

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(allVisible.map((mr) => mr.id)));
  };

  /** Runs a bulk action and reports what actually happened per MR. Anything that
   *  failed stays selected, so a retry is one click away. */
  const runBulk = async ({ done, verb }, mrs, action) => {
    setActionError(null);
    const results = await Promise.allSettled(mrs.map(action));
    const failures = results
      .map((r, i) => (r.status === "rejected" ? { mr: mrs[i], reason: r.reason?.message ?? "unknown error" } : null))
      .filter(Boolean);

    setSelectedIds(new Set(failures.map((f) => f.mr.id)));

    if (failures.length === 0) {
      setDoneMsg(`✓ ${done} ${mrs.length} MR${mrs.length > 1 ? "s" : ""}`);
      setTimeout(() => setDoneMsg(null), 2500);
    } else {
      const shown = failures.slice(0, 2).map((f) => `${mrRef(f.mr)} — ${f.reason}`).join("; ");
      const more  = failures.length > 2 ? ` (+${failures.length - 2} more)` : "";
      setActionError(`Could not ${verb} ${failures.length} of ${mrs.length}: ${shown}${more}`);
    }
    refresh();
  };

  const handleApprove = async () => {
    if (selectedIds.size === 0 || approving) return;
    const mrs = allVisible.filter((mr) => selectedIds.has(mr.id));
    setApproving(true);
    await runBulk({ done: "Approved", verb: "approve" }, mrs, (mr) =>
      post(`/api/merge-requests/${mr.project_id}/${mr.iid}/approve`)
    );
    setApproving(false);
  };

  const handleReapprove = async () => {
    if (reapproving) return;
    const mrs = allVisible.filter((mr) => selectedIds.has(mr.id) && mr.activities_after_approval);
    if (!mrs.length) return;
    setReapproving(true);
    await runBulk({ done: "Re-approved", verb: "re-approve" }, mrs, async (mr) => {
      await post(`/api/merge-requests/${mr.project_id}/${mr.iid}/unapprove`);
      try {
        await post(`/api/merge-requests/${mr.project_id}/${mr.iid}/approve`);
      } catch (e) {
        // Never let this fail quietly: the approval is already gone at this point.
        throw new Error(`approval withdrawn but could not be re-applied (${e.message}) — approve it manually`);
      }
    });
    setReapproving(false);
  };

  const canReapprove = !reapproving && allVisible.some(
    (mr) => selectedIds.has(mr.id) && mr.activities_after_approval
  );

  const handleUnapprove = async () => {
    if (unapproving) return;
    const mrs = allVisible.filter(
      (mr) => selectedIds.has(mr.id) && mr.approved_by_users?.some((u) => u.id === currentUser?.id)
    );
    if (!mrs.length) return;
    setUnapproving(true);
    await runBulk({ done: "Unapproved", verb: "unapprove" }, mrs, (mr) =>
      post(`/api/merge-requests/${mr.project_id}/${mr.iid}/unapprove`)
    );
    setUnapproving(false);
  };

  const canUnapprove = !unapproving && allVisible.some(
    (mr) => selectedIds.has(mr.id) && mr.approved_by_users?.some((u) => u.id === currentUser?.id)
  );

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

  const approvedWithNewCommits = classified.approved.filter((m) => m.activities_after_approval).length;

  const hints = {
    needs:    oldest ? `oldest ${timeAgo(oldest.updated_at)}` : null,
    approved: classified.approved.length > 0
      ? (approvedWithNewCommits > 0
          ? `${approvedWithNewCommits} updated after your approval`
          : "waiting on other reviewers")
      : null,
    mine:     mineHint,
    mention:  classified.mention.length > 0 ? "tagged in discussion" : null,
  };

  return (
    <main className="flex-1 overflow-auto">
      <div className="sticky top-0 z-20">
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
              {(() => { const n = all.filter((m) => m.state === "opened").length; return `${n} open merge request${n !== 1 ? "s" : ""} grouped by what needs your attention`; })()}
            </p>
          </div>
          <div className="ml-auto shrink-0">
            <RefreshButton onRefresh={refresh} loading={loading} interval={autoRefreshSecs} onIntervalChange={onAutoRefreshChange} />
          </div>
        </header>

        <div className="px-5 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="w-4 h-4 rounded accent-blue-600 cursor-pointer shrink-0"
          />
          <span className="text-gray-700 font-medium cursor-pointer select-none" onClick={toggleAll}>
            {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
          </span>
          <span className="w-px h-3.5 bg-gray-300 mx-0.5" />
          {doneMsg ? (
            <span className="text-green-600 font-medium text-xs animate-in fade-in duration-200">{doneMsg}</span>
          ) : (
            <TooltipProvider>
              <Button
                size="xs"
                onClick={handleApprove}
                disabled={selectedIds.size === 0 || approving}
                variant="ghost"
              >
                {approving ? <IconSpin /> : "✓"} Approve
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button variant="ghost" size="xs" onClick={handleReapprove} disabled={!canReapprove}
                      className="text-amber-700 hover:bg-amber-100 hover:text-amber-700">
                      {reapproving ? <IconSpin /> : "↺"} Re-approve
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {canReapprove
                    ? "Re-approve selected MRs that were updated after your approval"
                    : "Select MRs with new activity after your approval"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button variant="ghost" size="xs" onClick={handleUnapprove} disabled={!canUnapprove}
                      className="text-red-600 hover:bg-red-50 hover:text-red-600">
                      {unapproving ? <IconSpin /> : "✕"} Unapprove
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {canUnapprove
                    ? "Withdraw your approval from selected MRs"
                    : "Select MRs you have already approved"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <div className="ml-auto flex items-center gap-1.5 text-gray-400">
            <span>Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-gray-700 font-medium bg-transparent border-none outline-none cursor-pointer text-xs"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Title A→Z</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700 flex items-center gap-3">
          <span className="flex-1">{error}</span>
          <button onClick={refresh} className="shrink-0 text-red-600 hover:text-red-800 font-medium underline underline-offset-2">Retry</button>
        </div>
      )}

      {actionError && (
        <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700 flex items-start gap-3">
          <span className="flex-1">{actionError}</span>
          <button onClick={() => setActionError(null)} className="shrink-0 text-red-400 hover:text-red-700" title="Dismiss">
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      )}

      {/* Two columns on 2xl. Deliberately CSS multi-column rather than a 2-col
          grid: a grid ties both cells of a row to the taller one, which is what
          left the big blank gaps under the shorter bucket. The divider is a
          column-rule, not a background showing through the gap — a background
          would paint the tail of the shorter column grey. */}
      <div className="bg-white 2xl:columns-2 2xl:gap-px 2xl:[column-rule:1px_solid_#e5e7eb]">
        {order.map((id) => (
          <div key={id} className="break-inside-avoid">
            <BucketSection bucket={BUCKETS[id]} mrs={classified[id]} hint={hints[id]}
                           currentUserId={currentUser?.id} selectedIds={selectedIds} onToggle={toggleOne}
                           dataLoaded={data !== null} searchActive={searchQuery.trim().length > 0} />
          </div>
        ))}
      </div>
    </main>
  );
}
