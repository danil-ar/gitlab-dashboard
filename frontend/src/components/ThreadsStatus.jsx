import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { timeAgo } from "../utils/timeAgo";
import { renderMd } from "../utils/renderMd";

export function ThreadPreview({ p, url, dim = false, separator = false }) {
  const [expanded, setExpanded] = useState(false);
  const fileName = p.file_path ? p.file_path.split("/").pop() : null;
  const hasReplies = p.replies > 0 && p.reply_notes?.length > 0;

  return (
    <div className={`${separator ? "mb-1 pb-2 border-b border-white/8" : ""}`}>
      <a
        href={url && p.note_id ? `${url}#note_${p.note_id}` : url}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:bg-white/8 rounded-md px-1 py-1 transition-colors border border-transparent hover:border-white/8"
      >
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <div className="min-w-0 flex-1">
            <span className={`font-semibold text-[12px] ${dim ? "text-gray-300" : "text-gray-100"}`}>
              {p.author}
            </span>
            {p.created_at && (
              <span className="text-[10px] text-gray-500 ml-1.5">{timeAgo(p.created_at)}</span>
            )}
          </div>
          {hasReplies && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded(x => !x); }}
              className="text-[11px] text-gray-500 hover:text-gray-300 shrink-0 transition-colors flex items-center gap-0.5"
            >
              {p.replies} {p.replies === 1 ? "reply" : "replies"}
              <span className="text-[9px]">{expanded ? " ▲" : " ▼"}</span>
            </button>
          )}
          {p.replies > 0 && !hasReplies && (
            <span className="text-[11px] text-gray-500 shrink-0">
              {p.replies} {p.replies === 1 ? "reply" : "replies"}
            </span>
          )}
        </div>
        {fileName && (
          <div className="mb-1">
            <code className="text-[11px] text-gray-400 bg-white/10 px-1 py-0.5 rounded">
              {fileName}{p.line ? `:${p.line}` : ""}
            </code>
          </div>
        )}
        <div className={`text-[12px] leading-[1.4] ${dim ? "text-gray-400" : "text-gray-300"}`}
             style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}>
          {renderMd(p.body)}
        </div>
      </a>

      {expanded && (
        <div className="ml-2 mt-1 pl-2 border-l-2 border-white/10 space-y-1.5">
          {p.reply_notes.map((r) => (
            <a
              key={r.note_id}
              href={url && r.note_id ? `${url}#note_${r.note_id}` : url}
              target="_blank"
              rel="noopener noreferrer"
              className="block hover:bg-white/8 rounded px-1 py-0.5 transition-colors"
            >
              <div className="flex items-center gap-1.5">
                <span className={`text-[11px] font-semibold ${dim ? "text-gray-400" : "text-gray-300"}`}>
                  {r.author}
                </span>
                {r.created_at && (
                  <span className="text-[10px] text-gray-600">{timeAgo(r.created_at)}</span>
                )}
              </div>
              <div className={`text-[11px] leading-[1.35] ${dim ? "text-gray-500" : "text-gray-400"}`}
                   style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}>
                {renderMd(r.body)}
              </div>
            </a>
          ))}
          {p.replies > 5 && (
            <div className="text-[10px] text-gray-600 px-1">+{p.replies - 5} more replies</div>
          )}
        </div>
      )}
    </div>
  );
}

function TooltipContent({ stats, mrUrl }) {
  const unresolved = stats.unresolved_previews ?? [];
  const resolved   = stats.resolved_previews   ?? [];

  return (
    <div className="bg-gray-800 border border-white/10 rounded-lg shadow-2xl overflow-hidden">
      <div
        className="max-h-[560px] overflow-y-auto p-2
          [&::-webkit-scrollbar]:w-1
          [&::-webkit-scrollbar-track]:bg-transparent
          [&::-webkit-scrollbar-thumb]:bg-white/15
          [&::-webkit-scrollbar-thumb]:rounded-full
          [&::-webkit-scrollbar-thumb:hover]:bg-white/30"
      >
        {unresolved.length > 0 && (
          <>
            <div className="sticky top-0 z-10 bg-gray-800 -mx-2 px-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-orange-400 py-1.5 mb-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
              Unresolved · {unresolved.length}
            </div>
            {unresolved.map((p, i) => (
              <ThreadPreview key={i} p={p} url={mrUrl} separator={i < unresolved.length - 1} />
            ))}
          </>
        )}
        {resolved.length > 0 && (
          <>
            <div className={`sticky top-0 z-10 bg-gray-800 -mx-2 px-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-green-500 py-1.5 mb-0.5 ${unresolved.length > 0 ? "mt-3 border-t border-white/8" : ""}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              Resolved · {resolved.length}
            </div>
            {resolved.map((p, i) => (
              <ThreadPreview key={i} p={p} url={mrUrl} dim separator={i < resolved.length - 1} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default function ThreadsStatus({ stats, mrUrl }) {
  const triggerRef = useRef(null);
  const closeTimer = useRef(null);
  const [open, setOpen]     = useState(false);
  const [style, setStyle]   = useState({});

  const show = () => {
    clearTimeout(closeTimer.current);
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const above = rect.top >= 430;
      setStyle({
        position: "fixed",
        width:    "480px",
        right:    `${window.innerWidth - rect.right}px`,
        ...(above
          ? { bottom: `${window.innerHeight - rect.top + 8}px` }
          : { top:    `${rect.bottom + 8}px` }),
        zIndex: 9999,
      });
    }
    setOpen(true);
  };

  const hide = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  if (!stats || stats.total === 0) return <span className="text-[11px] text-gray-400">—</span>;

  const allResolved = stats.resolved === stats.total;
  const unresolved  = stats.unresolved_previews ?? [];
  const resolved    = stats.resolved_previews   ?? [];
  if (unresolved.length === 0 && resolved.length === 0) {
    return (
      <span className={`flex items-center gap-1 text-xs whitespace-nowrap ${allResolved ? "text-green-600" : "text-orange-500"}`}>
        <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H9l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5v-6Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="tabular-nums">{stats.resolved}/{stats.total}</span>
      </span>
    );
  }

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`flex items-center gap-1 text-xs whitespace-nowrap cursor-default ${allResolved ? "text-green-600" : "text-orange-500"}`}
      >
        <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H9l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5v-6Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="tabular-nums">{stats.resolved}/{stats.total}</span>
      </span>

      {open && createPortal(
        <div style={style} onMouseEnter={() => clearTimeout(closeTimer.current)} onMouseLeave={hide}>
          <TooltipContent stats={stats} mrUrl={mrUrl} />
        </div>,
        document.body
      )}
    </>
  );
}
