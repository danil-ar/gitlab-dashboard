export default function ThreadsStatus({ stats }) {
  if (!stats || stats.total === 0) return <span className="text-[11px] text-gray-400">—</span>;
  const allResolved = stats.resolved === stats.total;
  return (
    <span
      title={`${stats.resolved} of ${stats.total} threads resolved`}
      className={`flex items-center gap-1 text-xs whitespace-nowrap ${allResolved ? "text-green-600" : "text-orange-500"}`}
    >
      <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H9l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5v-6Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="tabular-nums">{stats.resolved}/{stats.total}</span>
    </span>
  );
}
