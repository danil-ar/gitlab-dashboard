import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import Banner from "../components/Banner";
import { Icon, IconSpin } from "../components/icons";

const STATE_BADGES = {
  new_tag:   { label: "new tag",    className: "bg-blue-50 text-blue-700",   title: "Some changes aren't in a tag yet. The deploy tag still has to be created." },
  tagged:    { label: "tag exists", className: "bg-green-50 text-green-700", title: "All changes are in the latest tag, so that tag is what gets deployed." },
  older_tag: { label: "older tag",  className: "bg-amber-50 text-amber-700", title: "All changes are in a tag, but newer tags exist. Check whether this repo belongs in the plan." },
  no_tags:   { label: "no tags",    className: "bg-gray-100 text-gray-600",  title: "GitLab has no vX.Y.Z tags here, so no tag is suggested." },
  error:     { label: "error",      className: "bg-red-50 text-red-700",     title: "The plan for this repo could not be built." },
};

const LEFT_OUT_BY_DEFAULT = new Set(["older_tag", "no_tags", "error"]);

const CHANGE_STATE_COLORS = {
  merged:  "text-green-700",
  opened:  "text-amber-700",
  locked:  "text-amber-700",
  closed:  "text-gray-400 line-through",
  unknown: "text-red-600",
};

const INPUT = "text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500";
const TAG_INPUT = "font-mono text-xs w-24 border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400";

function formatDate(iso) {
  return iso ? iso.split("-").reverse().join(".") : "no date";
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
          className="w-full py-2.5 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
          {loading ? "Connecting…" : "Connect"}
        </button>
      </form>
    </main>
  );
}

// ─── plan ────────────────────────────────────────────────────────────────────

function PlanBlock({ title, text }) {
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef(null);

  const copy = async () => {
    // navigator.clipboard exists only on HTTPS and localhost; the dashboard may run on plain HTTP.
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    } else {
      textareaRef.current.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-xs font-semibold text-gray-700">{title}</h3>
        <button
          onClick={copy}
          disabled={!text}
          className="text-xs px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <textarea
        ref={textareaRef}
        readOnly
        value={text}
        rows={Math.max(3, text.split("\n").length)}
        placeholder="Nothing to do"
        className="w-full font-mono text-[11px] leading-relaxed border border-gray-200 rounded-md p-2 bg-gray-50 text-gray-700 resize-none whitespace-pre overflow-x-auto focus:outline-none"
      />
    </div>
  );
}

function RepoRow({ row, onEdit }) {
  const badge = STATE_BADGES[row.state];
  const disabled = row.state === "error";
  return (
    <>
      <tr className="border-t border-gray-100 align-top">
        <td className="pl-3 py-2.5 w-8">
          <input
            type="checkbox"
            checked={row.include}
            disabled={disabled}
            onChange={(e) => onEdit(row.path, { include: e.target.checked })}
            className="w-4 h-4 rounded accent-blue-600 cursor-pointer disabled:cursor-default"
          />
        </td>
        <td className="px-3 py-2.5 min-w-0">
          <a href={row.web_url} target="_blank" rel="noopener noreferrer"
             className="text-sm font-medium text-gray-900 hover:text-blue-700 hover:underline">
            {row.name}
          </a>
          <div className="text-[11px] text-gray-400">
            {row.group} · {row.issues.length} issue{row.issues.length !== 1 ? "s" : ""}
            {!disabled && (
              <>
                {" · latest in GitLab: "}
                <a href={`${row.web_url}/-/tags`} target="_blank" rel="noopener noreferrer"
                   className="font-mono text-gray-500 hover:text-blue-700 hover:underline">
                  {row.latest_tag ?? "no tags"}
                </a>
              </>
            )}
          </div>
        </td>
        <td className="px-2 py-2.5">
          <input
            aria-label={`Rollback tag for ${row.name}`}
            value={row.rollback_tag ?? ""}
            disabled={disabled}
            onChange={(e) => onEdit(row.path, { rollback_tag: e.target.value })}
            className={TAG_INPUT}
          />
        </td>
        <td className="px-2 py-2.5">
          <input
            aria-label={`Deploy tag for ${row.name}`}
            value={row.deploy_tag ?? ""}
            disabled={disabled}
            onChange={(e) => onEdit(row.path, { deploy_tag: e.target.value })}
            className={TAG_INPUT}
          />
        </td>
        <td className="px-3 py-2.5">
          <span title={badge.title} className={`text-[11px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${badge.className}`}>
            {badge.label}
          </span>
        </td>
      </tr>
      {(row.error || row.warnings.length > 0) && (
        <tr>
          <td />
          <td colSpan={4} className="px-3 pb-2.5 text-[11px] text-amber-700 space-y-0.5">
            {row.error && <div className="text-red-600">{row.error}</div>}
            {row.warnings.map((w) => <div key={w}>{w}</div>)}
          </td>
        </tr>
      )}
    </>
  );
}

function IssueRow({ issue }) {
  return (
    <div className="flex items-baseline gap-3 px-3 py-2 border-t border-gray-100 first:border-t-0">
      <a href={issue.url} target="_blank" rel="noopener noreferrer"
         className="font-mono text-xs text-blue-700 hover:underline shrink-0">
        {issue.key}
      </a>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-gray-800 truncate">{issue.summary}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
          {issue.assignee && <span className="text-gray-400">{issue.assignee}</span>}
          {issue.links.length === 0 && <span className="text-amber-700">no GitLab links</span>}
          {issue.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"
               title={link.state}
               className={`font-mono hover:underline ${CHANGE_STATE_COLORS[link.state] ?? "text-gray-500"}`}>
              {link.repo}{link.ref.startsWith("!") ? link.ref : `@${link.ref}`}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReleaseDetail({ release, status, filterPaths, onTokenRejected }) {
  const [plan, setPlan]       = useState(null);
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits]     = useState({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get(`/api/jira/releases/${release.id}/plan`, { signal: controller.signal })
      .then((p) => { setPlan(p); setEdits({}); setLoading(false); })
      .catch((e) => {
        if (e.name === "AbortError") return;
        if (e.status === 403) onTokenRejected(e.message);
        setError(e.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [release.id, attempt, onTokenRejected]);

  const onEdit = (path, patch) => setEdits((prev) => ({ ...prev, [path]: { ...prev[path], ...patch } }));

  const inFilter = (path) => !filterPaths || filterPaths.has(path.toLowerCase());

  const repos = plan?.repos ?? [];
  const hiddenRepos = repos.filter((repo) => !inFilter(repo.path));
  const rows = repos.filter((repo) => inFilter(repo.path)).map((repo) => ({
    ...repo,
    include: !LEFT_OUT_BY_DEFAULT.has(repo.state),
    ...edits[repo.path],
  }));

  // Issues with no GitLab links stay: nothing says they don't belong to the selected repos.
  const allIssues = plan?.issues ?? [];
  const issues = allIssues
    .filter((issue) => issue.links.length === 0 || issue.links.some((link) => inFilter(link.path)))
    .map((issue) => ({ ...issue, links: issue.links.filter((link) => inFilter(link.path)) }));
  const hiddenIssueCount = allIssues.length - issues.length;

  const rebuild = () => setAttempt((n) => n + 1);

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">
            <a href={release.url} target="_blank" rel="noopener noreferrer" className="hover:text-blue-700 hover:underline">{release.name}</a>
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {formatDate(release.release_date)} · {release.released ? "released" : "not released"}
            {release.release_issue && (
              <> · <a href={release.release_issue_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{release.release_issue}</a></>
            )}
          </p>
        </div>
        <button
          onClick={rebuild}
          disabled={loading}
          className="ml-auto shrink-0 flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-200 rounded-md bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50"
        >
          {loading ? <IconSpin className="w-3.5 h-3.5" /> : <Icon name="refresh" />}
          Rebuild
        </button>
      </div>

      {error && <Banner onRetry={rebuild}>{error}</Banner>}

      {loading && !plan && (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-10 justify-center">
          <IconSpin className="w-4 h-4" /> Collecting issues, merge requests and tags…
        </div>
      )}

      {plan && (
        <>
          {plan.warnings.length > 0 && (
            <Banner tone="warning">{plan.warnings.map((w) => <div key={w}>{w}</div>)}</Banner>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Repositories</h3>
            {rows.length === 0 ? (
              <p className="text-sm text-gray-400 border border-gray-200 rounded-lg bg-white py-8 text-center">
                {hiddenRepos.length > 0
                  ? "All repositories in this release are outside your project filter."
                  : "No GitLab changes found on the issues in this release."}
              </p>
            ) : (
              <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[11px] text-gray-400">
                      <th />
                      <th className="px-3 py-2 font-medium">Repository</th>
                      <th className="px-2 py-2 font-medium">Rollback to</th>
                      <th className="px-2 py-2 font-medium">Deploy</th>
                      <th className="px-3 py-2 font-medium">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => <RepoRow key={row.path} row={row} onEdit={onEdit} />)}
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
              <PlanBlock title="Deploy plan" text={planText(rows, "deploy_tag")} />
              <PlanBlock title="Rollback plan" text={planText(rows, "rollback_tag")} />
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
              Issues in "{status}" · {issues.length} of {plan.total_issues}
            </h3>
            {plan.other_statuses.length > 0 && (
              <p className="mb-2 text-xs text-gray-500">
                Not counted: {plan.other_statuses.map((s) => `${s.name} ${s.count}`).join(" · ")}
              </p>
            )}
            {hiddenIssueCount > 0 && (
              <p className="mb-2 text-xs text-gray-500">
                {hiddenIssueCount} more touch only repositories outside your project filter.
              </p>
            )}
            {issues.length > 0 && (
              <div className="border border-gray-200 rounded-lg bg-white">
                {issues.map((issue) => <IssueRow key={issue.key} issue={issue} />)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
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
    active ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-700"
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
          {shown.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={`w-full text-left px-3 py-2 border-b border-gray-100 transition-colors ${
                r.id === selectedId ? "bg-blue-50" : "hover:bg-gray-50"
              }`}
            >
              <div className="text-sm text-gray-900 truncate">{r.name}</div>
              <div className="text-[11px] text-gray-400 font-mono">
                {formatDate(r.release_date)}{r.release_issue ? ` · ${r.release_issue}` : ""}
              </div>
            </button>
          ))}
          {list && shown.length === 0 && (
            <p className="text-center py-8 text-xs text-gray-400">No releases here</p>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        {error && <Banner onRetry={loadList} className="m-6">{error}</Banner>}
        {!list && !error && (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-16 justify-center">
            <IconSpin className="w-4 h-4" /> Loading releases…
          </div>
        )}
        {selected && (
          <ReleaseDetail key={selected.id} release={selected} status={list.status} filterPaths={filterPaths} onTokenRejected={setTokenProblem} />
        )}
      </div>
    </main>
  );
}
