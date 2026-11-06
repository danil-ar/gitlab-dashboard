import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import Banner from "../components/Banner";
import BuildTagDialog from "../components/BuildTagDialog";
import CopyBlock from "../components/CopyBlock";
import { Icon, IconSpin } from "../components/icons";
import PageHeader from "../components/PageHeader";

const STATE_BADGES = {
  new_tag:   { label: "needs tag",  className: "bg-blue-50 text-blue-700",   title: "Some changes aren't in a tag yet. The deploy tag still has to be created." },
  shipped:   { label: "shipped",    className: "bg-green-50 text-green-700", title: "All changes went out in the deploy tag." },
  tagged:    { label: "tag exists", className: "bg-green-50 text-green-700", title: "All changes are in the latest tag, so that tag is what gets deployed." },
  older_tag: { label: "older tag",  className: "bg-amber-50 text-amber-800", title: "All changes are in a tag, but newer tags exist. Check whether this repo belongs in the plan." },
  no_tags:   { label: "no tags",    className: "bg-gray-100 text-gray-600",  title: "GitLab has no vX.Y.Z tags here, so no tag is suggested." },
  error:     { label: "error",      className: "bg-red-50 text-red-700",     title: "The plan for this repo could not be built." },
};

const LEFT_OUT_BY_DEFAULT = new Set(["older_tag", "no_tags", "error"]);
const BUILDABLE_STATES = new Set(["new_tag", "no_tags"]);
const TAGGED_STATES = new Set(["tagged", "older_tag"]);
const VERSION_TAG = /^v?\d+\.\d+\.\d+$/;

const CHANGE_STATE_COLORS = {
  merged:  "text-green-700",
  opened:  "text-amber-700",
  locked:  "text-amber-700",
  closed:  "text-gray-500 line-through",
  unknown: "text-red-600",
};

const JIRA_STATUS_COLORS = {
  new:           "bg-gray-100 text-gray-600",
  indeterminate: "bg-blue-50 text-blue-700",
  done:          "bg-green-50 text-green-700",
};
const IN_RELEASE_COLOR = "bg-green-50 text-green-700";
// Work under way first: it's the most likely to still make the release. Closed ones (withdrawn) last.
const OTHER_STATUS_ORDER = { indeterminate: 0, new: 1, done: 2 };

const SECTION_TITLE = "text-xs font-semibold uppercase tracking-wider text-gray-500";
const INPUT = "text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500";
const TAG_EDITED = "border-amber-400 bg-amber-50";
const TAG_INPUT = "font-mono text-xs w-20 border rounded px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400";

function formatDate(iso) {
  return iso ? iso.split("-").reverse().join(".") : "no date";
}

function daysUntil(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const now = new Date();
  return Math.round((new Date(year, month - 1, day) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
}

function releaseTiming(release) {
  if (release.released) return { label: "Released", className: "bg-green-50 text-green-700" };
  if (!release.release_date) return { label: "Not released", className: "bg-gray-100 text-gray-600" };
  const days = daysUntil(release.release_date);
  if (days < 0) return { label: `${-days}d overdue`, className: "bg-red-50 text-red-700" };
  if (days === 0) return { label: "Today", className: "bg-amber-50 text-amber-800" };
  if (days === 1) return { label: "Tomorrow", className: "bg-amber-50 text-amber-800" };
  return { label: `In ${days} days`, className: "bg-gray-100 text-gray-600" };
}

// Most release names already carry the date, and there's no point saying it twice.
function dateIfNotInName(release) {
  const date = formatDate(release.release_date);
  return release.name?.includes(date) ? null : date;
}

function planText(rows, tagField) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.include || !row[tagField]) continue;
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(`${row.web_url}/-/tags/${encodeURIComponent(row[tagField])}`);
  }
  return [...groups].map(([group, urls]) => [group, ...urls].join("\n")).join("\n\n");
}

// ─── connect ─────────────────────────────────────────────────────────────────

function JiraConnect({ jiraUrl, reason, onConnect }) {
  const [token, setToken]     = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/api/jira/connect", { token: token.trim() });
      await onConnect();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const shownError = error ?? reason;

  return (
    <main className="flex-1 overflow-auto flex items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 w-full max-w-md space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Connect Jira</h2>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
            Releases come from Jira, so this needs your own token. Create one under{" "}
            <a
              href={`${jiraUrl}/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`}
              target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Profile → Personal Access Tokens
            </a>.
          </p>
        </div>
        <input
          type="password" required autoFocus value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Jira Personal Access Token"
          className={`${INPUT} w-full font-mono`}
        />
        {shownError && <Banner>{shownError}</Banner>}
        <button type="submit" disabled={loading}
          className="w-full py-2.5 bg-orange-700 hover:bg-orange-800 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
          {loading ? "Connecting…" : "Connect"}
        </button>
      </form>
    </main>
  );
}

// ─── plan ────────────────────────────────────────────────────────────────────

function StatusBadge({ className, title, children }) {
  return (
    <span title={title} className={`text-[11px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${className}`}>
      {children}
    </span>
  );
}

function RepoRow({ row, released, onEdit, onReset, onBuild }) {
  const inputClass = (field) => `${TAG_INPUT} ${(row[field] ?? "") !== (row.suggested[field] ?? "") ? TAG_EDITED : "border-gray-200"}`;
  const edited = (row.rollback_tag ?? "") !== (row.suggested.rollback_tag ?? "") || (row.deploy_tag ?? "") !== (row.suggested.deploy_tag ?? "");
  const badge = STATE_BADGES[released && TAGGED_STATES.has(row.state) ? "shipped" : row.state];
  const disabled = row.state === "error";
  const canBuild = !released && row.include && BUILDABLE_STATES.has(row.state) && VERSION_TAG.test(row.deploy_tag ?? "");
  return (
    <>
      <tr className={`border-t border-gray-100 ${row.include ? "" : "bg-gray-50"}`}>
        <td className="pl-3 py-2.5 w-8">
          <input
            type="checkbox"
            aria-label={`Include ${row.name} in the plans`}
            checked={row.include}
            disabled={disabled}
            onChange={(e) => onEdit(row.path, { include: e.target.checked })}
            className="block w-4 h-4 rounded accent-blue-600 cursor-pointer disabled:cursor-default"
          />
        </td>
        <td className="px-3 py-2.5 min-w-0">
          <a href={row.web_url} target="_blank" rel="noopener noreferrer"
             className={`text-sm font-medium hover:text-blue-700 hover:underline whitespace-nowrap ${row.include ? "text-gray-900" : "text-gray-600"}`}>
            {row.name}
          </a>
          <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500 [&>span]:whitespace-nowrap">
            <span>{row.group}</span>
            <span>{row.issues.length} issue{row.issues.length !== 1 ? "s" : ""}</span>
            {!disabled && (
              <span>
                {"latest "}
                <a href={`${row.web_url}/-/tags`} target="_blank" rel="noopener noreferrer"
                   title="The highest vX.Y.Z tag in GitLab"
                   className="font-mono text-gray-500 hover:text-blue-700 hover:underline">
                  {row.latest_tag ?? "none"}
                </a>
              </span>
            )}
          </div>
        </td>
        <td className="px-2 py-2.5 whitespace-nowrap">
          <input
            aria-label={`Rollback tag for ${row.name}`}
            value={row.rollback_tag ?? ""}
            disabled={disabled}
            onChange={(e) => onEdit(row.path, { rollback_tag: e.target.value })}
            className={inputClass("rollback_tag")}
          />
          <span className="mx-1.5 text-gray-300" aria-hidden="true">→</span>
          <input
            aria-label={`Deploy tag for ${row.name}`}
            value={row.deploy_tag ?? ""}
            disabled={disabled}
            onChange={(e) => onEdit(row.path, { deploy_tag: e.target.value })}
            className={inputClass("deploy_tag")}
          />
          {edited && (
            <button onClick={() => onReset(row.path)} title="Back to the tags worked out from GitLab" className="ml-1.5 text-[11px] text-blue-600 hover:underline">
              reset
            </button>
          )}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <StatusBadge className={badge.className} title={badge.title}>{badge.label}</StatusBadge>
            {canBuild && (
              <button
                onClick={() => onBuild(row)}
                className="text-xs px-2 py-1 rounded border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 whitespace-nowrap"
              >
                Build tag
              </button>
            )}
          </div>
        </td>
      </tr>
      {(row.error || row.warnings.length > 0 || row.unmerged.length > 0) && (
        <tr className={row.include ? "" : "bg-gray-50"}>
          <td />
          <td colSpan={3} className="px-3 pb-2.5 text-[11px] text-amber-700 space-y-0.5">
            {row.error && <div className="text-red-600">{row.error}</div>}
            {row.unmerged.map(({ ref, url, issues }) => (
              <div key={ref}>
                <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono underline underline-offset-2">{ref}</a>
                {" is not merged yet"}{issues.length > 0 && ` (${issues.join(", ")})`}
              </div>
            ))}
            {row.warnings.map((w) => <div key={w}>{w}</div>)}
          </td>
        </tr>
      )}
    </>
  );
}

function IssueRow({ issue }) {
  const statusColor = issue.in_release
    ? IN_RELEASE_COLOR
    : issue.status_category === "indeterminate" ? JIRA_STATUS_COLORS.indeterminate : JIRA_STATUS_COLORS.new;
  return (
    <div className="flex items-baseline gap-3 px-3 py-2 border-t border-gray-100 first:border-t-0">
      <a href={issue.url} target="_blank" rel="noopener noreferrer"
         className="font-mono text-xs text-blue-700 hover:underline shrink-0">
        {issue.key}
      </a>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-gray-800 truncate" title={issue.summary}>{issue.summary}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
          {issue.assignee && <span className="text-gray-500">{issue.assignee}</span>}
          {issue.links.length === 0 && (
            <span className={issue.in_release ? "text-amber-700" : "text-gray-500"}>no GitLab links</span>
          )}
          {issue.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"
               title={link.state}
               className={`font-mono hover:underline ${CHANGE_STATE_COLORS[link.state] ?? "text-gray-500"}`}>
              {link.repo}{link.ref.startsWith("!") ? link.ref : `@${link.ref}`}
            </a>
          ))}
        </div>
      </div>
      <StatusBadge className={`shrink-0 ${statusColor}`}>{issue.status}</StatusBadge>
    </div>
  );
}

function IssueGroup({ title, note, issues }) {
  if (issues.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-xs">
        <h4 className="font-medium text-gray-700">{title} · {issues.length}</h4>
        {note && <span className="text-gray-500">{note}</span>}
      </div>
      <div className="border border-gray-200 rounded-lg bg-white">
        {issues.map((issue) => <IssueRow key={issue.key} issue={issue} />)}
      </div>
    </div>
  );
}

function statusCounts(issues) {
  const counts = new Map();
  for (const issue of issues) counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} ${count}`).join(" · ");
}

function ReleaseDetail({ release, filterPaths, jiraUrl, onTokenRejected }) {
  const [plan, setPlan]       = useState(null);
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits]     = useState({});
  const [attempt, setAttempt] = useState(0);
  const [building, setBuilding] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get(`/api/jira/releases/${release.id}/plan${release.released ? "?released=true" : ""}`, { signal: controller.signal })
      .then((p) => {
        setPlan(p);
        setLoading(false);
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        if (e.status === 403) onTokenRejected(e.message);
        setError(e.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [release.id, release.released, attempt, onTokenRejected]);

  const onEdit = (path, patch) => setEdits((prev) => ({ ...prev, [path]: { ...prev[path], ...patch } }));
  const onReset = (path) => setEdits(({ [path]: _dropped, ...rest }) => rest);

  const inFilter = (path) => !filterPaths || filterPaths.has(path.toLowerCase());

  const repos = plan?.repos ?? [];
  const hiddenRepos = repos.filter((repo) => !inFilter(repo.path));
  const rows = repos.filter((repo) => inFilter(repo.path)).map((repo) => ({
    ...repo,
    // Newer tags since this one are only a question for a release that hasn't shipped.
    include: !LEFT_OUT_BY_DEFAULT.has(repo.state) || (release.released && repo.state === "older_tag"),
    suggested: { rollback_tag: repo.rollback_tag, deploy_tag: repo.deploy_tag },
    ...edits[repo.path],
  }));

  // Issues with no GitLab links stay: nothing says they don't belong to the selected repos.
  const allIssues = plan?.issues ?? [];
  const issues = allIssues
    .filter((issue) => issue.links.length === 0 || issue.links.some((link) => inFilter(link.path)))
    .map((issue) => ({ ...issue, links: issue.links.filter((link) => inFilter(link.path)) }));
  const hiddenIssueCount = allIssues.length - issues.length;
  const inRelease = issues.filter((issue) => issue.in_release);
  const otherIssues = issues
    .filter((issue) => !issue.in_release)
    .sort((a, b) => (OTHER_STATUS_ORDER[a.status_category] ?? 1) - (OTHER_STATUS_ORDER[b.status_category] ?? 1)
      || (a.status ?? "").localeCompare(b.status ?? ""));
  const stillOpen = otherIssues.filter((issue) => issue.status_category !== "done").length;

  const planned = rows.filter((row) => row.include);
  const needTag = planned.filter((row) => row.state === "new_tag").length;
  const toCheck = rows.reduce((n, row) => n + row.warnings.length + row.unmerged.length + (row.error ? 1 : 0), 0)
    + inRelease.filter((issue) => issue.links.length === 0).length;
  const timing = releaseTiming(release);
  const date = dateIfNotInName(release);
  const issueStatus = release.release_issue_status;

  const reload = () => setAttempt((n) => n + 1);

  // Once a tag is built the plan knows it, so a tag typed for that repo has nothing left to say.
  const closeBuild = (built) => {
    if (built) {
      onReset(building.path);
      reload();
    }
    setBuilding(null);
  };

  return (
    <>
      {building && (
        <BuildTagDialog row={building} versionId={release.id} jiraUrl={jiraUrl} onClose={closeBuild} />
      )}

      <PageHeader
        className="sticky top-0 z-20"
        title={<a href={release.url} target="_blank" rel="noopener noreferrer" className="hover:text-blue-700 hover:underline">{release.name}</a>}
        subtitle={
          <>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <StatusBadge className={timing.className}>{timing.label}</StatusBadge>
            {date && <span>{date}</span>}
            {release.release_issue && (
              <a href={release.release_issue_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{release.release_issue}</a>
            )}
            {issueStatus?.status && (
              <StatusBadge className={JIRA_STATUS_COLORS[issueStatus.status_category] ?? JIRA_STATUS_COLORS.new}>{issueStatus.status}</StatusBadge>
            )}
          </div>
          {plan && rows.length > 0 && (
            <p className="mt-2 text-xs text-gray-600">
              {rows.length} repositor{rows.length !== 1 ? "ies" : "y"}
              {needTag > 0 && <> · <span className="font-medium text-blue-700">{needTag} need{needTag === 1 ? "s" : ""} a tag</span></>}
              {inRelease.length + stillOpen > 0 && <> · {inRelease.length} of {inRelease.length + stillOpen} issues ready</>}
              {toCheck > 0 && <> · <span className="font-medium text-amber-700">{toCheck} to check</span></>}
            </p>
          )}
          </>
        }
      >
        <button
          onClick={reload}
          disabled={loading}
          title="Read the plan from Jira and GitLab again. Tags you typed stay."
          className="ml-auto shrink-0 flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-200 rounded-md bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50"
        >
          {loading ? <IconSpin className="w-3.5 h-3.5" /> : <Icon name="refresh" />}
          Refresh
        </button>
      </PageHeader>

    <div className="p-6 space-y-5 max-w-5xl">
      {error && <Banner onRetry={reload}>{error}</Banner>}

      {loading && !plan && (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
          <IconSpin className="w-4 h-4" /> Collecting issues, merge requests and tags…
        </div>
      )}

      {plan && (
        <>
          {plan.warnings.length > 0 && (
            <Banner tone="warning">{plan.warnings.map((w) => <div key={w}>{w}</div>)}</Banner>
          )}

          <section>
            <h3 className={`${SECTION_TITLE} mb-2`}>Repositories</h3>
            {rows.length === 0 ? (
              <p className="text-sm text-gray-500 border border-gray-200 rounded-lg bg-white py-8 text-center">
                {hiddenRepos.length > 0
                  ? "All repositories in this release are outside your project filter."
                  : "No GitLab changes found on the issues in this release."}
              </p>
            ) : (
              <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[11px] text-gray-500">
                      <th />
                      <th className="px-3 py-2 font-medium">Repository</th>
                      <th className="px-2 py-2 font-medium">Rollback → Deploy</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => <RepoRow key={row.path} row={row} released={release.released} onEdit={onEdit} onReset={onReset} onBuild={setBuilding} />)}
                  </tbody>
                </table>
              </div>
            )}
            {hiddenRepos.length > 0 && (
              <p className="mt-2 text-xs text-gray-500">
                Outside your project filter, so not in the plans: {hiddenRepos.map((repo) => repo.name).join(", ")}
              </p>
            )}
          </section>

          {rows.length > 0 && (
            <section className="grid md:grid-cols-2 gap-4">
              <CopyBlock title="Deploy plan" text={planText(rows, "deploy_tag")} />
              <CopyBlock title="Rollback plan" text={planText(rows, "rollback_tag")} />
            </section>
          )}

          <section className="space-y-3">
            <h3 className={SECTION_TITLE}>Issues</h3>
            {hiddenIssueCount > 0 && (
              <p className="text-xs text-gray-500">
                {hiddenIssueCount} more touch only repositories outside your project filter.
              </p>
            )}
            <IssueGroup title="In the release" issues={inRelease} />
            <IssueGroup title="Other statuses" note={statusCounts(otherIssues)} issues={otherIssues} />
            {issues.length === 0 && (
              <p className="text-sm text-gray-500 border border-gray-200 rounded-lg bg-white py-8 text-center">No issues to show</p>
            )}
          </section>
        </>
      )}
    </div>
    </>
  );
}

// ─── view ────────────────────────────────────────────────────────────────────

export default function Releases({ jiraUrl, connected, onConnected, projects, selectedProjectIds }) {
  const [list, setList]               = useState(null);
  const [error, setError]             = useState(null);
  const [tokenProblem, setTokenProblem] = useState(null);
  const [showShipped, setShowShipped] = useState(false);
  const [selectedId, setSelectedId]   = useState(null);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get("/api/jira/releases");
      setList(data);
      setTokenProblem(null);
      const first = data.releases.find((r) => !r.released) ?? data.releases[0];
      setSelectedId((current) => current ?? first?.id ?? null);
      if (first?.released) setShowShipped(true);
    } catch (e) {
      if (e.status === 403) setTokenProblem(e.message);
      else setError(e.message);
    }
  }, []);

  useEffect(() => { if (connected) loadList(); }, [connected, loadList]);

  // null means no filter: an empty selection shows everything, like the rest of the app,
  // and without the project list the selected ids can't be matched to repos at all.
  const filterPaths = useMemo(() => {
    if (selectedProjectIds.size === 0 || projects.length === 0) return null;
    return new Set(projects.filter((p) => selectedProjectIds.has(p.id)).map((p) => p.path_with_namespace.toLowerCase()));
  }, [projects, selectedProjectIds]);

  if (!connected || tokenProblem) {
    return (
      <JiraConnect
        jiraUrl={jiraUrl}
        reason={tokenProblem}
        onConnect={async () => {
          await onConnected();
          // A first connect flips `connected`, and the effect above loads the list.
          if (connected) await loadList();
        }}
      />
    );
  }

  const releases = list?.releases ?? [];
  const shown = releases.filter((r) => r.released === showShipped);
  const selected = releases.find((r) => r.id === selectedId);

  const tabClass = (active) => `flex-1 text-xs font-medium py-1 rounded transition-colors ${
    active ? "bg-white shadow-sm text-gray-900" : "text-gray-600 hover:text-gray-800"
  }`;

  return (
    <main className="flex-1 flex min-h-0">
      <div className="w-64 shrink-0 border-r border-gray-200 bg-white flex flex-col min-h-0">
        <div className="p-3 border-b border-gray-200">
          <div className="flex gap-1 p-0.5 bg-gray-100 rounded-md">
            <button onClick={() => setShowShipped(false)} className={tabClass(!showShipped)}>Upcoming</button>
            <button onClick={() => setShowShipped(true)} className={tabClass(showShipped)}>Released</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {shown.map((r) => {
            const timing = releaseTiming(r);
            const date = dateIfNotInName(r);
            return (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`w-full text-left px-3 py-2 border-b border-gray-100 transition-colors ${
                  r.id === selectedId ? "bg-blue-50" : "hover:bg-gray-50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 text-sm text-gray-900 truncate" title={r.name}>{r.name}</span>
                  {!r.released && <StatusBadge className={`shrink-0 ${timing.className}`}>{timing.label}</StatusBadge>}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-600 min-w-0">
                  {date && <span className="font-mono shrink-0">{date}</span>}
                  {r.release_issue && <span className="font-mono shrink-0">{r.release_issue}</span>}
                  {r.release_issue_status?.status && <span className="truncate">· {r.release_issue_status.status}</span>}
                </div>
              </button>
            );
          })}
          {list && shown.length === 0 && (
            <p className="text-center py-8 text-xs text-gray-500">No releases here</p>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        {error && <Banner onRetry={loadList} className="m-6">{error}</Banner>}
        {!list && !error && (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-16 justify-center">
            <IconSpin className="w-4 h-4" /> Loading releases…
          </div>
        )}
        {selected && (
          <ReleaseDetail key={selected.id} release={selected} filterPaths={filterPaths} jiraUrl={jiraUrl} onTokenRejected={setTokenProblem} />
        )}
      </div>
    </main>
  );
}
