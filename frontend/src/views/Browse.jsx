import MRRow from "../components/MRRow";
import RefreshButton from "../components/RefreshButton";
import { STATE_OPTS, SCOPE_OPTS } from "../constants";

export default function Browse({ data, loading, error, filters, setFilter, projectOpts, needsMyApproval, setNeedsMyApproval, refresh, searchRef, handleSearch, page, setPage, currentUser, autoRefreshSecs, onAutoRefreshChange }) {
  const visibleItems = needsMyApproval && currentUser
    ? (data?.items ?? []).filter((mr) => !mr.approved_by_users?.some((u) => u.id === currentUser.id))
    : (data?.items ?? []);

  return (
    <main className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex flex-wrap gap-3 mb-6">
          <form onSubmit={handleSearch} className="flex gap-2">
            <input ref={searchRef} type="search" placeholder="Search…" defaultValue={filters.search}
                   className="text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" className="text-sm px-3 py-2 rounded-md border border-gray-200 bg-white hover:bg-gray-50">Search</button>
          </form>
          <select value={filters.state} onChange={setFilter("state")} className="text-sm border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            {STATE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={filters.scope} onChange={setFilter("scope")} className="text-sm border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            {SCOPE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={filters.project_id} onChange={setFilter("project_id")} className="text-sm border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-xs">
            {projectOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={() => setNeedsMyApproval((v) => !v)}
                  className={`text-sm px-4 py-2 rounded-md border transition-colors ${
                    needsMyApproval ? "bg-orange-500 border-orange-500 text-white hover:bg-orange-600"
                                    : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                  }`}>
            Needs my approval
          </button>
          <div className="ml-auto">
            <RefreshButton onRefresh={refresh} loading={loading} interval={autoRefreshSecs} onIntervalChange={onAutoRefreshChange} />
          </div>
        </div>

        {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}

        {loading ? (
          <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
        ) : (
          <>
            <div className="rounded-lg overflow-hidden border border-gray-200 bg-white">
              {visibleItems.map((mr, i, arr) => (
                <div key={mr.id} className={i === arr.length - 1 ? "[&>div]:border-b-0" : ""}>
                  <MRRow mr={mr} currentUserId={currentUser?.id} />
                </div>
              ))}
              {visibleItems.length === 0 && <div className="text-center py-16 text-gray-400 text-sm">No merge requests found</div>}
            </div>
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
          </>
        )}
      </div>
    </main>
  );
}
