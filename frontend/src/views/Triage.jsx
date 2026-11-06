import { useState, useMemo, useEffect } from "react";
import { BUCKETS } from "../constants";
import { api } from "../api";
import { classifyMR } from "../utils/classifyMR";
import { timeAgo } from "../utils/timeAgo";
import { BucketIcon, IconSpin } from "../components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import Banner from "../components/Banner";
import BucketSection from "../components/BucketSection";
import RefreshButton from "../components/RefreshButton";

const BUCKET_IDS = ["needs", "approved", "mine", "mention"];

const approvalUrl = (mr, action) => `/api/merge-requests/${mr.project_id}/${mr.iid}/${action}`;

async function reapprove(mr) {
  await api.post(approvalUrl(mr, "unapprove"));
  try {
    await api.post(approvalUrl(mr, "approve"));
  } catch (e) {
    throw new Error(`your approval was withdrawn, but approving again failed: ${e.message}`);
  }
}

export default function Triage({ data, loading, error, currentUser, view, refresh, mentionedMRs, autoRefreshSecs, onAutoRefreshChange, searchQuery = "" }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [busy, setBusy]               = useState(null);
  const [bulkErrors, setBulkErrors]   = useState([]);
  const [doneMsg, setDoneMsg]         = useState(null);
  const [sortBy, setSortBy]           = useState("newest");

  useEffect(() => { setSelectedIds(new Set()); }, [view.bucket]);

  const toggleOne = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // MRs without diff stats (the REST paths do not carry them) sort last rather
  // than pretending to be empty ones.
  const changedLines = (mr) => mr.diff_stats
    ? (mr.diff_stats.additions ?? 0) + (mr.diff_stats.deletions ?? 0)
    : Number.POSITIVE_INFINITY;

  const sortFn = useMemo(() => ({
    newest:  (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
    oldest:  (a, b) => new Date(a.updated_at) - new Date(b.updated_at),
    title:   (a, b) => a.title.localeCompare(b.title),
    size:    (a, b) => changedLines(a) - changedLines(b),
  })[sortBy], [sortBy]);

  const all = data?.items ?? [];
  const classified = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const match = (mr) => !q || mr.title.toLowerCase().includes(q);
    // Being tagged is not a fifth kind of merge request, it is something that
    // happened to one. If it is already on this screen the row says so; the
    // bucket is left holding the mentions that would otherwise be invisible —
    // other people's merge requests, unselected projects, closed ones.
    const listed = new Set(all.map((mr) => mr.id));
    const tagged = new Set(mentionedMRs.map((mr) => mr.id));
    const out = {
      needs: [], approved: [], mine: [],
      mention: mentionedMRs.filter((mr) => match(mr) && !listed.has(mr.id)),
    };
    if (!currentUser) return out;
    for (const mr of all) {
      if (!match(mr)) continue;
      const b = classifyMR(mr, currentUser.id);
      if (b) out[b].push(tagged.has(mr.id) ? { ...mr, mentions_you: true } : mr);
    }
    BUCKET_IDS.forEach((k) => out[k].sort(sortFn));
    return out;
  }, [all, currentUser, mentionedMRs, sortFn, searchQuery]);

  const order = [view.bucket, ...BUCKET_IDS.filter((k) => k !== view.bucket)];

  const allVisible = BUCKET_IDS.flatMap((id) => classified[id]);
  const allSelected = allVisible.length > 0 && allVisible.every((mr) => selectedIds.has(mr.id));

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(allVisible.map((mr) => mr.id)));
  };

  const iApproved = (mr) => mr.approved_by_users?.some((u) => u.id === currentUser?.id);
  const selected = allVisible.filter((mr) => selectedIds.has(mr.id));
  const toApprove   = selected.filter((mr) => !iApproved(mr));
  const toReapprove = selected.filter((mr) => mr.activities_after_approval);
  const toUnapprove = selected.filter(iApproved);

  const runBulk = async (kind, mrs, action, doneVerb) => {
    if (busy || mrs.length === 0) return;
    setBusy(kind);
    setBulkErrors([]);
    const results = await Promise.allSettled(mrs.map(action));
    const failed = mrs.flatMap((mr, i) =>
      results[i].status === "rejected" ? [{ mr, message: results[i].reason.message }] : []
    );
    const succeeded = mrs.length - failed.length;
    setBusy(null);
    setBulkErrors(failed);
    // Failed MRs stay selected so the action can be retried.
    setSelectedIds(new Set(failed.map(({ mr }) => mr.id)));
    if (succeeded > 0) {
      setDoneMsg(`✓ ${doneVerb} ${succeeded} MR${succeeded > 1 ? "s" : ""}`);
      setTimeout(() => setDoneMsg(null), 2500);
    }
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

  const warnings = data?.warnings ?? [];
  const openCount = all.filter((m) => m.state === "opened").length;

  return (
    <main className="flex-1 overflow-auto">
      <div className="sticky top-0 z-20">
        <header className="px-5 py-3.5 border-b border-gray-200 flex items-center gap-3 bg-white shrink-0">
          <BucketIcon id={view.bucket} className="w-5 h-5 text-orange-600 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">{BUCKETS[view.bucket].label}</h2>
            <p className="text-xs text-gray-500">
              {`${openCount} open merge request${openCount !== 1 ? "s" : ""} grouped by what needs your attention`}
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
            <>
              <Button
                size="xs"
                onClick={() => runBulk("approve", toApprove, (mr) => api.post(approvalUrl(mr, "approve")), "Approved")}
                disabled={toApprove.length === 0 || busy !== null}
                variant="ghost"
              >
                {busy === "approve" ? <IconSpin /> : "✓"} Approve
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button variant="ghost" size="xs" disabled={toReapprove.length === 0 || busy !== null}
                      onClick={() => runBulk("reapprove", toReapprove, reapprove, "Re-approved")}
                      className="text-amber-700 hover:bg-amber-100 hover:text-amber-700">
                      {busy === "reapprove" ? <IconSpin /> : "↺"} Re-approve
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {toReapprove.length > 0
                    ? "Re-approve selected MRs that were updated after your approval"
                    : "Select MRs with new activity after your approval"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button variant="ghost" size="xs" disabled={toUnapprove.length === 0 || busy !== null}
                      onClick={() => runBulk("unapprove", toUnapprove, (mr) => api.post(approvalUrl(mr, "unapprove")), "Unapproved")}
                      className="text-red-600 hover:bg-red-50 hover:text-red-600">
                      {busy === "unapprove" ? <IconSpin /> : "✕"} Unapprove
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {toUnapprove.length > 0
                    ? "Withdraw your approval from selected MRs"
                    : "Select MRs you have already approved"}
                </TooltipContent>
              </Tooltip>
            </>
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
              <option value="size">Smallest first</option>
              <option value="title">Title A→Z</option>
            </select>
          </div>
        </div>
      </div>

      {bulkErrors.length > 0 && (
        <Banner onDismiss={() => setBulkErrors([])} className="mx-5 mt-4">
          {bulkErrors.map(({ mr, message }) => (
            <div key={mr.id}>
              <a href={mr.web_url} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">!{mr.iid}</a>{" "}
              {mr.title}: {message}
            </div>
          ))}
        </Banner>
      )}

      {error && <Banner onRetry={refresh} className="mx-5 mt-4">{error}</Banner>}

      {warnings.length > 0 && (
        <Banner tone="warning" onRetry={refresh} className="mx-5 mt-4">
          {warnings.map((w) => <div key={w}>{w}</div>)}
        </Banner>
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
                           selectedIds={selectedIds} onToggle={toggleOne}
                           dataLoaded={data !== null && currentUser !== null}
                           partial={warnings.length > 0}
                           searchActive={searchQuery.trim().length > 0} />
          </div>
        ))}
      </div>
    </main>
  );
}
