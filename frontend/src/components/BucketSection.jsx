import { useState } from "react";
import { BucketIcon, IconClock } from "./icons";
import MRRow from "./MRRow";

export default function BucketSection({ bucket, mrs, hint, currentUserId, defaultOpen = true, selectedIds, onToggle }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <header className="flex items-center gap-2.5 px-4 py-2.5 bg-gray-50 border-y border-gray-200 sticky top-0 z-[1]">
        <button onClick={() => setOpen((v) => !v)} className="text-gray-400 hover:text-gray-600 text-xs w-4 shrink-0">
          {open ? "▾" : "▸"}
        </button>
        <BucketIcon id={bucket.id} className={`w-3.5 h-3.5 shrink-0 ${bucket.iconColor}`} />
        <span className="text-[13px] font-semibold text-gray-900">{bucket.label}</span>
        <span className={`text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full ${bucket.pillBg}`}>
          {mrs.length}
        </span>
        {hint && (
          <span className="text-[11px] text-gray-500 ml-1 flex items-center gap-1">
            {bucket.id === "needs" && mrs.length > 0 && (
              <IconClock className="w-3 h-3 text-orange-500 shrink-0" />
            )}
            {hint}
          </span>
        )}
      </header>
      {open && (
        <div>
          {mrs.length === 0 ? (
            <p className="text-center py-6 text-xs text-gray-400 bg-white border-b border-gray-100">All clear ✓</p>
          ) : (
            mrs.map((mr) => (
              <MRRow key={mr.id} mr={mr} currentUserId={currentUserId} bucket={bucket}
                     selected={selectedIds?.has(mr.id)} onToggle={onToggle} />
            ))
          )}
        </div>
      )}
    </section>
  );
}
