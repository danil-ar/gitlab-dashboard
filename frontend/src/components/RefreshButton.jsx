import { useState, useRef, useEffect } from "react";
import { IconRefresh } from "./icons";

const INTERVALS = [
  { value: 0,    label: "Off"  },
  { value: 60,   label: "1m"   },
  { value: 300,  label: "5m"   },
  { value: 900,  label: "15m"  },
  { value: 1800, label: "30m"  },
  { value: 3600, label: "1h"   },
];

export default function RefreshButton({ onRefresh, interval = 0, onIntervalChange, loading = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeLabel = INTERVALS.find((i) => i.value === interval)?.label ?? "Off";

  return (
    <div ref={ref} className="relative flex items-stretch">
      <button
        onClick={onRefresh}
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-r-0 border-gray-200 rounded-l-md bg-white hover:bg-gray-50 text-gray-700 transition-colors"
      >
        <IconRefresh className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        Refresh
        {interval > 0 && <span className="text-[11px] text-gray-400">· {activeLabel}</span>}
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center px-2 border border-gray-200 rounded-r-md text-gray-500 hover:bg-gray-50 transition-colors ${open ? "bg-gray-100" : "bg-white"}`}
      >
        <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-24 py-1">
          {INTERVALS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => { onIntervalChange(value); setOpen(false); }}
              className={`w-full px-3 py-1.5 text-sm text-left transition-colors ${
                interval === value
                  ? "bg-gray-100 text-gray-900 font-medium"
                  : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
