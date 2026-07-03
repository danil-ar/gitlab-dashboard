import { useState } from "react";
import { BucketIcon, IconClock } from "./icons";
import MRRow from "./MRRow";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export default function BucketSection({ bucket, mrs, hint, currentUserId, defaultOpen = true, selectedIds, onToggle, dataLoaded = true, searchActive = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <header
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2.5 px-4 py-2.5 ${bucket.headerBg} border-b border-gray-200 cursor-pointer hover:brightness-95 transition-all select-none`}
      >
        <span className="text-gray-400 text-xs w-4 shrink-0">{open ? "▾" : "▸"}</span>
        <BucketIcon id={bucket.id} className={`w-3.5 h-3.5 shrink-0 ${bucket.iconColor}`} />
        <span className="text-[13px] font-semibold text-gray-900">{bucket.label}</span>
        {bucket.description && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild onClick={(e) => e.stopPropagation()}>
                <span className="text-gray-400 hover:text-gray-600 transition-colors">
                  <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="8" cy="8" r="5.5"/>
                    <path d="M8 7v4M8 5.5v.5" strokeLinecap="round"/>
                  </svg>
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">{bucket.description}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <span className={`text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full shrink-0 ${
          mrs.length > 0 ? bucket.pillBg : "bg-gray-200 text-gray-500"
        }`}>
          {mrs.length}
        </span>
        {hint && (
          <span className="text-[11px] text-gray-500 ml-1 flex items-center gap-1 shrink-0">
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
            dataLoaded && (
              <p className="text-center py-6 text-xs text-gray-400 bg-white border-b border-gray-100">
                {searchActive ? "No results" : "All clear ✓"}
              </p>
            )
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
