import { timeAgo } from "../utils/timeAgo";

/** A commit that landed after your approval.
 *
 * Deliberately the same card as ThreadPreview in ThreadsStatus.jsx: both answer
 * who, where, when and what, and they sit in the same popover — a commit shown
 * as a bare sha and subject next to a full discussion card reads as an
 * afterthought. The amber sha is what keeps the two kinds apart at a glance.
 */
export default function CommitPreview({ c }) {
  return (
    <a
      href={c.web_url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg border border-gray-200 bg-white px-3 pt-2.5 pb-2.5 hover:bg-gray-50 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[12px] font-semibold text-gray-700 truncate flex-1">{c.author}</span>
        <code className="text-[11px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded font-mono shrink-0">
          {c.short_id}
        </code>
        {c.created_at && (
          <span className="text-[11px] text-gray-500 shrink-0">{timeAgo(c.created_at)}</span>
        )}
      </div>
      <div className="text-[13px] leading-snug text-gray-600" style={{ wordBreak: "break-word" }}>
        {c.title}
      </div>
      {c.body && (
        <div className="mt-1 text-[12px] leading-snug text-gray-500 whitespace-pre-line line-clamp-3">
          {c.body}
        </div>
      )}
    </a>
  );
}
