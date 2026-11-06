import { useState } from "react";
import { BucketIcon, Icon } from "./icons";
import MRRow, { MRColumns } from "./MRRow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function emptyText(searchActive, partial) {
  if (searchActive) return "No results";
  return partial ? "Nothing here, but some data failed to load" : "All clear ✓";
}

export default function BucketSection({ bucket, mrs, hint, selectedIds, onToggle, dataLoaded = true, partial = false, searchActive = false }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <header
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2.5 px-4 py-2.5 ${bucket.headerBg} border-b border-gray-200 cursor-pointer hover:brightness-95 transition-all select-none`}
      >
        <span className="text-gray-500 text-xs w-4 shrink-0">{open ? "▾" : "▸"}</span>
        <BucketIcon id={bucket.id} className={`w-3.5 h-3.5 shrink-0 ${bucket.iconColor}`} />
        <span className="text-[13px] font-semibold text-gray-900">{bucket.label}</span>
        {bucket.description && (
          <Tooltip>
            <TooltipTrigger asChild onClick={(e) => e.stopPropagation()}>
              <span className="text-gray-500 hover:text-gray-600 transition-colors">
                <Icon name="info" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{bucket.description}</TooltipContent>
          </Tooltip>
        )}
        <span className={`text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full shrink-0 ${
          mrs.length > 0 ? bucket.pillBg : "bg-gray-200 text-gray-700"
        }`}>
          {mrs.length}
        </span>
        {hint && (
          <span className="text-[11px] text-gray-500 ml-1 flex items-center gap-1 min-w-0 truncate">
            {bucket.id === "needs" && mrs.length > 0 && (
              <Icon name="clock" className="w-3 h-3 text-orange-500 shrink-0" />
            )}
            {hint}
          </span>
        )}
        {open && mrs.length > 0 && <MRColumns className="ml-auto" />}
      </header>
      {open && (
        <div>
          {mrs.length === 0 ? (
            dataLoaded && (
              <p className="text-center py-6 text-xs text-gray-500 bg-white border-b border-gray-100">
                {emptyText(searchActive, partial)}
              </p>
            )
          ) : (
            mrs.map((mr) => (
              <MRRow key={mr.id} mr={mr} bucket={bucket}
                     selected={selectedIds?.has(mr.id)} onToggle={onToggle} />
            ))
          )}
        </div>
      )}
    </section>
  );
}
