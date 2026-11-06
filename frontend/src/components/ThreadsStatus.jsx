import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon, IconSpin } from "./icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { timeAgo } from "../utils/timeAgo";
import { renderMd } from "../utils/renderMd";

export function ThreadPreview({ p, url, dim = false }) {
  const [expanded, setExpanded] = useState(false);
  const fileName = p.file_path ? p.file_path.split("/").pop() : null;
  const hasReplies = p.replies > 0 && p.reply_notes?.length > 0;

  // When the preview was built relative to a moment in time (post-approval
  // activity), reply_notes holds only what arrived since — so count and label
  // have to describe that subset, not the whole thread.
  const newCount = p.new_replies ?? 0;
  const relevant = newCount > 0 ? newCount : p.replies;
  const hidden   = relevant - (p.reply_notes?.length ?? 0);
  const repliesLabel = newCount > 0
    ? `${newCount} new ${newCount === 1 ? "reply" : "replies"}`
    : `${p.replies} ${p.replies === 1 ? "reply" : "replies"}`;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <a
        href={url && p.note_id ? `${url}#note_${p.note_id}` : url}
        target="_blank"
        rel="noopener noreferrer"
        className="block px-3 pt-2.5 pb-2.5 hover:bg-gray-50 rounded-t-lg transition-colors"
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span className={`text-[12px] font-semibold truncate flex-1 ${dim ? "text-gray-500" : "text-gray-700"}`}>
            {p.author}
          </span>
          {fileName && (
            <code className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded font-mono shrink-0">
              {fileName}{p.line ? `:${p.line}` : ""}
            </code>
          )}
          {p.created_at && (
            <span className="text-[11px] text-gray-400 shrink-0">{timeAgo(p.created_at)}</span>
          )}
        </div>
        <div
          className={`text-[13px] leading-snug ${dim ? "text-gray-500" : "text-gray-600"}`}
          style={{ wordBreak: "break-word" }}
        >
          {renderMd(p.body)}
        </div>
      </a>

      {p.replies > 0 && (
        <div className="border-t border-gray-100">
          {hasReplies ? (
            <button
              onClick={() => setExpanded(x => !x)}
              className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] hover:bg-gray-50 transition-colors rounded-b-lg ${
                newCount > 0 ? "text-amber-700 font-medium hover:text-amber-800" : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {repliesLabel}
              <span className="text-[9px] ml-auto">{expanded ? "▲" : "▼"}</span>
            </button>
          ) : (
            <div className="px-3 py-1.5 text-[11px] text-gray-400">{repliesLabel}</div>
          )}
          {expanded && (
            <div className="px-3 pb-2.5 pt-2 space-y-2 border-t border-gray-100">
              {p.reply_notes.map((r) => (
                <a
                  key={r.note_id}
                  href={url && r.note_id ? `${url}#note_${r.note_id}` : url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block hover:bg-gray-50 rounded px-1 py-0.5 transition-colors"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[11px] font-semibold text-gray-600">{r.author}</span>
                    {r.created_at && <span className="text-[10px] text-gray-400">{timeAgo(r.created_at)}</span>}
                  </div>
                  <div className="text-[12px] text-gray-500" style={{ wordBreak: "break-word" }}>
                    {renderMd(r.body)}
                  </div>
                </a>
              ))}
              {hidden > 0 && (
                <div className="text-[11px] text-gray-400">+{hidden} more</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadList({ stats, mrUrl }) {
  const unresolved = stats.unresolved_previews ?? [];
  const resolved   = stats.resolved_previews   ?? [];
  // Resolved threads are the archive: worth reaching for, not worth scrolling
  // past to reach the two that still want an answer. Unless they are all there
  // is, in which case hiding them would leave an empty popover.
  const [showResolved, setShowResolved] = useState(unresolved.length === 0);

  return (
    <>
      {unresolved.length > 0 && (
        <div className="p-2.5">
          <div className="flex items-center gap-1.5 px-0.5 pb-2 text-[10px] font-semibold uppercase tracking-wider text-orange-500">
            <span className="w-1.5 h-1.5 rounded-full bg-orange-500 shrink-0" />
            Unresolved · {unresolved.length}
          </div>
          <div className="space-y-1.5">
            {unresolved.map((p, i) => <ThreadPreview key={i} p={p} url={mrUrl} />)}
          </div>
        </div>
      )}
      {resolved.length > 0 && (
        <div className={`p-2.5 ${unresolved.length > 0 ? "border-t border-gray-100" : ""}`}>
          <button
            onClick={() => setShowResolved((v) => !v)}
            className="w-full flex items-center gap-1.5 px-0.5 pb-2 text-[10px] font-semibold uppercase tracking-wider text-green-600 hover:text-green-700 transition-colors"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
            Resolved · {resolved.length}
            <span className="text-[9px] ml-auto">{showResolved ? "▲" : "▼"}</span>
          </button>
          {showResolved && (
            <div className="space-y-1.5">
              {resolved.map((p, i) => <ThreadPreview key={i} p={p} url={mrUrl} dim />)}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function ThreadsStatus({ stats: propStats, projectId, iid, mrUrl }) {
  const fetchedRef  = useRef(false);
  const abortRef    = useRef(null);
  const [fetchedStats, setFetchedStats] = useState(null);
  const [loading, setLoading]           = useState(false);
  const [loadError, setLoadError]       = useState(null);

  // The list carries the counters; the thread text arrives only for a row
  // somebody opens, so the fetched object is the richer of the two.
  const stats      = fetchedStats ?? propStats;
  const hasThreads = !!stats && "unresolved_previews" in stats;

  useEffect(() => {
    fetchedRef.current = false;
    setFetchedStats(null);
    setLoading(false);
    setLoadError(null);
    return () => abortRef.current?.abort();
  }, [projectId, iid]);

  const handleOpen = (open) => {
    if (!open || hasThreads || fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    setLoadError(null);
    abortRef.current = new AbortController();
    api.get(`/api/projects/${projectId}/merge_requests/${iid}/discussion-stats`, { signal: abortRef.current.signal })
      .then((s) => { setFetchedStats(s); setLoading(false); })
      .catch((e) => {
        if (e.name === "AbortError") return;
        fetchedRef.current = false; // opening it again retries
        setLoadError(e.message);
        setLoading(false);
      });
  };

  if (propStats === undefined && fetchedStats === null) {
    return <div className="w-8 h-3 bg-gray-200 rounded animate-pulse" />;
  }

  if (!stats || stats.total === 0) {
    return <span className="text-[11px] text-gray-400">—</span>;
  }

  return (
    <Popover onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button className={`flex items-center gap-1 text-xs whitespace-nowrap cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors hover:bg-gray-100 hover:ring-1 hover:ring-gray-200 data-[state=open]:bg-gray-100 data-[state=open]:ring-1 data-[state=open]:ring-gray-200 ${
          stats.resolved === stats.total ? "text-green-600" : "text-orange-500"
        }`}>
          {loading ? <IconSpin className="w-3 h-3 shrink-0" /> : <Icon name="chat" className="w-3 h-3 shrink-0" />}
          <span className="tabular-nums animate-in fade-in duration-300">{stats.resolved}/{stats.total}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="left"
        collisionPadding={{ top: 100, bottom: 20, left: 20, right: 20 }}
        className="w-[420px] max-h-[520px] overflow-y-auto p-0 rounded-xl border-gray-200 bg-white shadow-xl
          [&::-webkit-scrollbar]:w-1.5
          [&::-webkit-scrollbar-track]:bg-transparent
          [&::-webkit-scrollbar-thumb]:bg-gray-200
          [&::-webkit-scrollbar-thumb]:rounded-full"
      >
        {loading && (
          <div className="px-4 py-3 flex items-center gap-2 text-gray-400 text-xs">
            <IconSpin className="w-3 h-3 shrink-0" /> Loading threads…
          </div>
        )}
        {!loading && loadError && <div className="px-4 py-3 text-xs text-red-700">Could not load threads: {loadError}</div>}
        {!loading && !loadError && <ThreadList stats={stats} mrUrl={mrUrl} />}
      </PopoverContent>
    </Popover>
  );
}
