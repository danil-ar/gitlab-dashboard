import Avatar from "./Avatar";
import PipelineStatus from "./PipelineStatus";
import ThreadsStatus from "./ThreadsStatus";
import Label from "./Label";
import { timeAgo } from "../utils/timeAgo";

export default function MRRow({ mr, currentUserId, bucket, selected, onToggle }) {
  const cleanTitle = mr.title.replace(/^(Draft|WIP):\s*/i, "");
  const isDraft    = mr.draft || /^(Draft|WIP):/i.test(mr.title);
  const proj       = mr.references?.full?.split("!")[0] ?? "";

  const accentClass = bucket?.accentBar
    ? `relative before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${bucket.accentBar}`
    : "";

  return (
    <div className={`flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 hover:bg-gray-50/70 transition-colors ${accentClass}`}>
      <input type="checkbox" checked={!!selected} onChange={() => onToggle?.(mr.id)} className="rounded shrink-0 accent-blue-600" />

      <svg viewBox="0 0 16 16" className={`w-4 h-4 shrink-0 ${isDraft ? "text-gray-400" : "text-green-600"}`} fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4.5 3v10M11.5 7v6M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11.5 7c-3 0-4-1.5-4-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <a href={mr.web_url} target="_blank" rel="noopener noreferrer"
             className="text-sm font-semibold text-gray-900 hover:text-blue-700 hover:underline truncate">
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

      <div className="w-[72px] hidden md:flex shrink-0">
        <PipelineStatus pipeline={mr.pipeline} />
      </div>

      <div className="w-[48px] hidden md:flex shrink-0">
        <ThreadsStatus stats={mr.discussion_stats} />
      </div>

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

      <div className="w-[44px] hidden lg:flex -space-x-1.5 shrink-0">
        {mr.assignees?.slice(0, 2).map((a) => (
          <span key={a.id} className="ring-2 ring-white rounded-full"><Avatar user={a} /></span>
        ))}
        {!mr.assignees?.length && <span className="text-[11px] text-gray-400">—</span>}
      </div>

      <span className="w-[56px] text-right text-[11px] text-gray-400 tabular-nums shrink-0">
        {timeAgo(mr.updated_at)}
      </span>
    </div>
  );
}
