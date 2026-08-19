import { useState } from "react";

import Avatar from "./Avatar";
import CommitPreview from "./CommitPreview";
import PipelineStatus from "./PipelineStatus";
import ThreadsStatus, { ThreadPreview } from "./ThreadsStatus";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { timeAgo } from "../utils/timeAgo";
import { MERGE_STATUS, STALE_DAYS } from "../constants";
import { copyText, reviewMessage } from "../utils/reviewMessage";

/** Changed lines, as a reviewer reads them: how big a bite is this. */
function DiffSize({ stats }) {
  if (!stats || (stats.additions == null && stats.deletions == null)) return null;
  const files = stats.files;
  return (
    <span
      className="shrink-0 tabular-nums font-mono"
      title={files != null ? `${files} file${files === 1 ? "" : "s"} changed` : undefined}
    >
      <span className="text-green-600">+{stats.additions ?? 0}</span>
      <span className="text-red-500 ml-1">−{stats.deletions ?? 0}</span>
    </span>
  );
}

/** Copies the "ready for review" announcement for this MR, in the shape the
 *  team already writes by hand. */
function CopyMessage({ mr }) {
  const [copied, setCopied] = useState(false);

  const onClick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (await copyText(reviewMessage(mr))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      onClick={onClick}
      title="Copy the review announcement for chat"
      className={`shrink-0 p-1 rounded transition-opacity ${
        copied ? "opacity-100 text-green-600" : "opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-700"
      }`}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

export default function MRRow({ mr, currentUserId, bucket, selected, onToggle }) {
  const isStale = (iso) =>
    iso && (Date.now() - new Date(iso).getTime()) / 86_400_000 >= STALE_DAYS;

  const cleanTitle = mr.title.replace(/^(Draft|WIP):\s*/i, "");
  const isDraft    = mr.draft || /^(Draft|WIP):/i.test(mr.title);
  const proj       = mr.references?.full?.split("!")[0] ?? "";

  const activities = mr.activities_after_approval;
  const accentBar = activities ? "before:bg-amber-400" : bucket?.accentBar;
  const accentClass = accentBar
    ? `relative before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-1 ${accentBar}`
    : "";

  return (
    <div className={`group flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 hover:bg-gray-50 transition-colors ${accentClass}`}>
      {onToggle && (
        <input type="checkbox" checked={!!selected} onChange={() => onToggle(mr.id)} className="w-4 h-4 rounded shrink-0 accent-blue-600 cursor-pointer" />
      )}

      <svg viewBox="0 0 16 16" className={`w-4 h-4 shrink-0 ${isDraft ? "text-gray-400" : "text-green-600"}`} fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4.5 3v10M11.5 7v6M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11.5 7c-3 0-4-1.5-4-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <a href={mr.web_url} target="_blank" rel="noopener noreferrer"
             className="text-sm font-semibold text-gray-900 group-hover:text-blue-700 hover:underline truncate transition-colors">
            {cleanTitle}
          </a>
          {activities && (() => {
            const previews = activities.new_thread_previews ?? [];
            const parts = [
              activities.commits?.length > 0 && `+${activities.commits.length} commit${activities.commits.length > 1 ? "s" : ""}`,
              activities.new_threads > 0 && `+${activities.new_threads} thread${activities.new_threads > 1 ? "s" : ""}`,
              activities.new_replies > 0 && `+${activities.new_replies} ${activities.new_replies > 1 ? "replies" : "reply"}`,
            ].filter(Boolean);
            return (
              <Popover>
                <PopoverTrigger asChild>
                  <span className="shrink-0 inline-flex items-center animate-in fade-in slide-in-from-bottom-1 duration-300 cursor-pointer">
                    <Badge className="bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100">
                      {parts.join(" · ")}
                    </Badge>
                  </span>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  collisionPadding={{ top: 100, bottom: 20, left: 20, right: 20 }}
                  className="w-[400px] max-h-[420px] overflow-y-auto p-0 rounded-xl border-gray-200 bg-white shadow-xl [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full"
                >
                  <div className="p-2.5 space-y-3">
                    {activities.commits?.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 mb-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                          New commits · {activities.commits.length}
                        </div>
                        <div className="space-y-1.5">
                          {activities.commits.map((c) => <CommitPreview key={c.id} c={c} />)}
                        </div>
                      </div>
                    )}
                    {previews.length > 0 && (
                      <div className={activities.commits?.length > 0 ? "border-t border-gray-100 pt-2.5" : ""}>
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-orange-500 mb-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 shrink-0" />
                          New discussion · {previews.length}
                        </div>
                        <div className="space-y-1.5">
                          {previews.map((p) => (
                            <ThreadPreview key={p.note_id} p={p} url={mr.web_url} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            );
          })()}
          {isDraft && <Badge variant="secondary" className="shrink-0">Draft</Badge>}
          {mr.has_conflicts && <Badge variant="destructive" className="shrink-0">conflicts</Badge>}
          {!isDraft && !mr.has_conflicts && MERGE_STATUS[mr.detailed_merge_status] && (
            <Badge
              className={`shrink-0 ${MERGE_STATUS[mr.detailed_merge_status].cls}`}
              title={MERGE_STATUS[mr.detailed_merge_status].hint}
            >
              {MERGE_STATUS[mr.detailed_merge_status].label}
            </Badge>
          )}
          {mr.labels?.slice(0, 3).map((l) => {
            // REST hands labels down as plain strings, GraphQL as objects with
            // the colour the team chose in GitLab. The filled colour is also
            // what keeps them apart from the state chips beside them: those are
            // facts the dashboard computed, these are notes people wrote.
            const title = typeof l === "string" ? l : l.title;
            const style = typeof l === "string" || !l.color ? undefined
              : { backgroundColor: l.color, color: l.text_color, borderColor: l.color };
            return (
              <Badge key={title} variant="outline" style={style}
                     className="shrink-0 max-w-[140px] truncate text-[10px] text-gray-500 h-4 px-1.5 py-0">
                {title}
              </Badge>
            );
          })}
          {mr.labels?.length > 3 && (
            <span className="text-[10px] text-gray-400 shrink-0" title={mr.labels.slice(3).map((l) => (typeof l === "string" ? l : l.title)).join(", ")}>
              +{mr.labels.length - 3}
            </span>
          )}
          <CopyMessage mr={mr} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500 min-w-0 flex-nowrap overflow-hidden">
          <span className="font-mono shrink-0 truncate max-w-[200px]">{proj}<span className="text-gray-400">!{mr.iid}</span></span>
          <span className="text-gray-300 shrink-0">·</span>
          <span className="shrink-0">by <span className="text-gray-700">{mr.author?.name}</span></span>
          <span className="text-gray-300 shrink-0">·</span>
          <span className="flex items-center gap-1 shrink-0">
            <code className="bg-gray-100 px-1 rounded text-[10px] max-w-[100px] truncate">{mr.source_branch}</code>
            <span className="text-gray-400">→</span>
            <code className="bg-gray-100 px-1 rounded text-[10px]">{mr.target_branch}</code>
          </span>
        </div>
      </div>

      {/* Its own column, not part of the meta line: sizes are only worth showing
          if you can compare them down the list at a glance. */}
      <div className="w-[88px] hidden lg:flex justify-end shrink-0 text-[11px]">
        <DiffSize stats={mr.diff_stats} />
      </div>

      <div className="w-[72px] hidden md:flex shrink-0">
        <PipelineStatus pipeline={mr.pipeline} />
      </div>

      <div className="w-[48px] hidden md:flex shrink-0">
        <ThreadsStatus stats={mr.discussion_stats} projectId={mr.project_id} iid={mr.iid} mrUrl={mr.web_url} />
      </div>

      <div className="w-[96px] hidden md:flex items-center gap-1.5 shrink-0">
        {mr.approved_by_users?.length > 0 ? (
          <>
            <span className="flex -space-x-1.5">
              {mr.approved_by_users.slice(0, 2).map((u) => (
                <span key={u.id} className="ring-2 ring-white rounded-full">
                  <Avatar user={u} showTooltip />
                </span>
              ))}
            </span>
            <span className="text-xs text-green-700 font-semibold tabular-nums">{mr.approved_by_users.length}</span>
          </>
        ) : (
          <span className="text-[11px] text-gray-400" title="No approvals yet">—</span>
        )}
      </div>

      <div className="w-[44px] hidden lg:flex -space-x-1.5 shrink-0">
        {mr.assignees?.slice(0, 2).map((a) => (
          <span key={a.id} className="ring-2 ring-white rounded-full"><Avatar user={a} showTooltip /></span>
        ))}
        {!mr.assignees?.length && <span className="text-[11px] text-gray-400">—</span>}
      </div>

      <span className={`w-[56px] text-right text-[11px] tabular-nums shrink-0 ${
        isStale(mr.updated_at) ? "text-gray-600 font-medium" : "text-gray-400"
      }`}>
        {timeAgo(mr.updated_at)}
      </span>
    </div>
  );
}
