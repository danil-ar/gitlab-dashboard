import MRRow from "../components/MRRow";
import RefreshButton from "../components/RefreshButton";
import { STATE_OPTS, SCOPE_OPTS } from "../constants";

function Sel({ value, onChange, options, className = "" }) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={onChange}
        className="appearance-none w-full text-sm border border-gray-200 rounded-md pl-3 pr-7 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer text-gray-700"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <svg viewBox="0 0 16 16" className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

export default function Browse({ data, loading, error, filters, setFilter, projectOpts, needsMyApproval, setNeedsMyApproval, refresh, page, setPage, currentUser, autoRefreshSecs, onAutoRefreshChange, searchQuery }) {
  const visibleItems = needsMyApproval && currentUser
    ? (data?.items ?? []).filter((mr) => !mr.approved_by_users?.some((u) => u.id === currentUser.id))
    : (data?.items ?? []);

  return (
    <main className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <Sel value={filters.state}      onChange={setFilter("state")}      options={STATE_OPTS} />
          <Sel value={filters.scope}      onChange={setFilter("scope")}      options={SCOPE_OPTS} />
          <Sel value={filters.project_id} onChange={setFilter("project_id")} options={projectOpts} className="max-w-xs" />
          <button
            onClick={() => setNeedsMyApproval((v) => !v)}
            className={`text-sm px-3 py-1.5 rounded-md border transition-colors whitespace-nowrap ${
              needsMyApproval
                ? "bg-orange-500 border-orange-500 text-white hover:bg-orange-600"
                : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
            }`}
          >
            Needs my approval
          </button>
          <div className="ml-auto">
            <RefreshButton onRefresh={refresh} loading={loading} interval={autoRefreshSecs} onIntervalChange={onAutoRefreshChange} />
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700 flex items-center gap-3">
            <span className="flex-1">{error}</span>
            <button onClick={refresh} className="shrink-0 text-red-600 hover:text-red-800 font-medium underline underline-offset-2">Retry</button>
          </div>
        )}

        {(visibleItems.length > 0 || (data !== null && !loading)) && (
          <div className="rounded-lg overflow-hidden border border-gray-200 bg-white">
            {visibleItems.map((mr, i, arr) => (
              <div key={mr.id} className={i === arr.length - 1 ? "[&>div]:border-b-0" : ""}>
                <MRRow mr={mr} currentUserId={currentUser?.id} />
              </div>
            ))}
            {visibleItems.length === 0 && (
              <div className="text-center py-16 text-gray-400 text-sm">No merge requests found</div>
            )}
          </div>
        )}

        {data && data.total_pages > 1 && (
          <div className="mt-6 flex items-center justify-between text-sm text-gray-500">
            <span>{data.total} total</span>
            <div className="flex items-center gap-2">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50">← Prev</button>
              <span>{page} / {data.total_pages}</span>
              <button disabled={page >= data.total_pages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50">Next →</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
