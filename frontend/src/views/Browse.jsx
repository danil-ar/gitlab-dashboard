import MRRow, { MRColumns } from "../components/MRRow";
import PageHeader from "../components/PageHeader";
import RefreshButton from "../components/RefreshButton";
import Banner from "../components/Banner";
import { Icon } from "../components/icons";
import { SCOPE_OPTS } from "../constants";

const TITLES = { opened: "Open merge requests", merged: "Merged merge requests", closed: "Closed merge requests" };

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
      <Icon name="chevronDown" className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
    </div>
  );
}

export default function Browse({ data, loading, error, filters, setFilter, projectName, clearProject, needsMyApproval, setNeedsMyApproval, refresh, page, setPage, currentUser, autoRefreshSecs, onAutoRefreshChange }) {
  // Approving only means something while a merge request is open.
  const approvalFilter = needsMyApproval && filters.state === "opened" && currentUser;
  const visibleItems = approvalFilter
    ? (data?.items ?? []).filter((mr) => !mr.approved_by_users?.some((u) => u.id === currentUser.id))
    : (data?.items ?? []);
  const warnings = data?.warnings ?? [];

  return (
    <main className="flex-1 overflow-auto">
      <PageHeader
        className="sticky top-0 z-20"
        title={TITLES[filters.state] ?? "All merge requests"}
        subtitle={data ? `${data.total} found` : "Loading…"}
      >
        {projectName && (
          <span className="inline-flex items-center gap-1 text-sm pl-3 pr-1.5 py-1 rounded-md border border-blue-200 bg-blue-50 text-blue-700 font-mono max-w-xs">
            <span className="truncate" title={projectName}>{projectName}</span>
            <button onClick={clearProject} title="Show all projects" aria-label="Show all projects" className="p-0.5 rounded hover:bg-blue-100">
              <Icon name="close" className="w-3 h-3" />
            </button>
          </span>
        )}
        <Sel value={filters.scope} onChange={setFilter("scope")} options={SCOPE_OPTS} />
        {filters.state === "opened" && (
          <button
            onClick={() => setNeedsMyApproval((v) => !v)}
            className={`text-sm px-3 py-1.5 rounded-md border transition-colors whitespace-nowrap ${
              needsMyApproval
                ? "bg-orange-700 border-orange-700 text-white hover:bg-orange-800"
                : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
            }`}
          >
            Needs my approval
          </button>
        )}
        <RefreshButton onRefresh={refresh} loading={loading} interval={autoRefreshSecs} onIntervalChange={onAutoRefreshChange} />
      </PageHeader>

      {error && <Banner onRetry={refresh} className="mx-5 mt-4">{error}</Banner>}

      {warnings.length > 0 && (
        <Banner tone="warning" onRetry={refresh} className="mx-5 mt-4">
          {warnings.map((w) => <div key={w}>{w}</div>)}
        </Banner>
      )}

      {visibleItems.length > 0 && (
        <div className="bg-white">
          <div className="flex justify-end px-4 py-1 border-b border-gray-100"><MRColumns /></div>
          {visibleItems.map((mr) => <MRRow key={mr.id} mr={mr} />)}
        </div>
      )}
      {visibleItems.length === 0 && data !== null && !loading && (
        <div className="text-center py-16 text-gray-500 text-sm">No merge requests found</div>
      )}

      {data && data.total_pages > 1 && (
        <div className="px-5 py-4 flex items-center justify-between text-sm text-gray-500">
          <span>{data.total} total</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50">Previous</button>
            <span>{page} / {data.total_pages}</span>
            <button disabled={page >= data.total_pages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50">Next</button>
          </div>
        </div>
      )}
    </main>
  );
}
