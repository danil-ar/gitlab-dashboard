import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import Banner from "./Banner";
import CopyBlock from "./CopyBlock";
import { IconSpin } from "./icons";

const LINK = "font-medium underline underline-offset-2";

function IssueList({ title, tone, issues, jiraUrl }) {
  const colors = tone === "danger" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800";
  return (
    <div className={`border rounded-md p-2.5 text-xs ${colors}`}>
      <div className="font-semibold mb-1">{title}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {issues.map(({ key, status }) => (
          <span key={key}>
            <a href={`${jiraUrl}/browse/${key}`} target="_blank" rel="noopener noreferrer" className={`font-mono ${LINK}`}>{key}</a>
            {status && ` (${status})`}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function BuildTagDialog({ row, versionId, jiraUrl, onClose }) {
  const [preview, setPreview]     = useState(null);
  const [error, setError]         = useState(null);
  const [checked, setChecked]     = useState(false);
  const [running, setRunning]     = useState(false);
  const [result, setResult]       = useState(null);
  const [changed, setChanged]     = useState(false);

  const tag = row.deploy_tag;

  const loadPreview = useCallback(async () => {
    setPreview(null);
    setError(null);
    setChecked(false);
    const query = new URLSearchParams({ path: row.path, tag });
    try {
      setPreview(await api.get(`/api/jira/releases/${versionId}/repo-preview?${query}`));
    } catch (e) {
      setError(e.message);
    }
  }, [row.path, tag, versionId]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  const build = async () => {
    setRunning(true);
    setError(null);
    setChanged(false);
    try {
      const res = await api.post("/api/releases/build-tag", { path: row.path, tag, source_sha: preview.source_sha });
      if (res.status === "changed") {
        setChanged(true);
        setResult(null);
        await loadPreview();
      } else {
        setResult(res);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const done = result?.status === "done";
  const blocked = result?.status === "blocked";
  const close = () => onClose(done);

  const flagged = preview && (preview.not_ready.length > 0 || preview.foreign.length > 0);
  const canRun = preview && !preview.tag_exists && !running && !done && (!flagged || checked);
  const runLabel = blocked ? "Try again" : preview?.ahead > 0 ? "Merge and create tag" : "Create tag";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!running) close(); }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <h2 className="px-5 py-4 border-b border-gray-200 text-sm font-semibold text-gray-900">
          Build <span className="font-mono">{tag}</span> in {row.name}
        </h2>

        <div className="px-5 py-4 space-y-3 overflow-y-auto text-sm text-gray-700">
          {!preview && !error && (
            <div className="flex items-center gap-2 text-gray-400 py-4 justify-center">
              <IconSpin className="w-4 h-4" /> Checking what would go out…
            </div>
          )}
          {error && <Banner onRetry={preview ? undefined : loadPreview}>{error}</Banner>}
          {changed && <Banner tone="warning">{preview?.source ?? "The branch"} changed after the preview, so nothing was merged. Check the new list below.</Banner>}

          {preview?.tag_exists && !done && (
            <Banner tone="warning">Tag {tag} already exists in GitLab. Nothing to build.</Banner>
          )}

          {preview && !preview.tag_exists && !done && (
            <>
              {preview.ahead > 0 ? (
                <ol className="list-decimal list-inside space-y-0.5">
                  <li>
                    Merge <code>{preview.source}</code> into <code>{preview.target}</code>: {preview.ahead} commit{preview.ahead !== 1 ? "s" : ""}
                    {preview.open_mr
                      ? <>, through open <a href={preview.open_mr.url} target="_blank" rel="noopener noreferrer" className={LINK}>!{preview.open_mr.iid}</a></>
                      : ", through a new merge request"}
                  </li>
                  <li>Create tag <code>{tag}</code> on <code>{preview.target}</code></li>
                </ol>
              ) : (
                <p>
                  <code>{preview.source}</code> has nothing new for <code>{preview.target}</code>, so only tag <code>{tag}</code> will be created on <code>{preview.target}</code>.
                </p>
              )}

              {preview.not_ready.length > 0 && (
                <IssueList tone="danger" title="In this release, but not ready. They would still go out:" issues={preview.not_ready} jiraUrl={jiraUrl} />
              )}
              {preview.foreign.length > 0 && (
                <IssueList tone="warning" title="Not in this release. They would still go out:" issues={preview.foreign.map((key) => ({ key }))} jiraUrl={jiraUrl} />
              )}
              {preview.no_key > 0 && (
                <p className="text-xs text-gray-500">{preview.no_key} commit{preview.no_key !== 1 ? "s" : ""} without an issue key will go out too.</p>
              )}
              {preview.ready.length > 0 && (
                <p className="text-xs text-gray-500">Ready in this release: {preview.ready.join(", ")}</p>
              )}
              {row.warnings.length > 0 && (
                <div className="text-xs text-amber-700 space-y-0.5">
                  {row.warnings.map((w) => <div key={w}>{w}</div>)}
                </div>
              )}

              {flagged && (
                <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 w-4 h-4 accent-blue-600" />
                  I've checked these issues and they can go to {preview.target}
                </label>
              )}

              <p className="text-xs text-gray-500">This happens in GitLab right away and may start a build. It can't be undone from here.</p>

              <div className="pt-2 border-t border-gray-100 space-y-1.5">
                <CopyBlock title={`Or by hand, in a clone of ${row.name}`} text={preview.commands.join("\n")} />
                <p className="text-xs text-gray-500">
                  The button doesn't run git: it does the same through the GitLab API
                  {preview.ahead > 0 && (
                    <>
                      {" "}with a merge request. Pushing by hand skips that request and its approvals, and
                      GitLab refuses the push if <code>{preview.target}</code> is protected
                    </>
                  )}.
                </p>
              </div>
            </>
          )}

          {blocked && (
            <Banner tone="warning">
              {result.merged && <div>Merged into {preview?.target}, but the tag wasn't created.</div>}
              <div>{result.reason}</div>
              {result.mr_url && <a href={result.mr_url} target="_blank" rel="noopener noreferrer" className={LINK}>Open the merge request</a>}
            </Banner>
          )}

          {done && (
            <div className="border border-green-200 bg-green-50 text-green-800 rounded-md p-3 space-y-1">
              <div className="font-medium">✓ Tag {result.tag} created</div>
              <div className="flex gap-3 text-xs">
                <a href={result.tag_url} target="_blank" rel="noopener noreferrer" className={LINK}>Tag</a>
                <a href={result.pipelines_url} target="_blank" rel="noopener noreferrer" className={LINK}>Pipelines</a>
                {result.mr_url && <a href={result.mr_url} target="_blank" rel="noopener noreferrer" className={LINK}>Merge request</a>}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={close} disabled={running} className="text-sm px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50 text-gray-700 disabled:opacity-50">
            {done ? "Close" : "Cancel"}
          </button>
          {!done && preview && !preview.tag_exists && (
            <button onClick={build} disabled={!canRun} className="text-sm px-3 py-1.5 rounded-md bg-orange-500 hover:bg-orange-600 text-white font-medium disabled:opacity-50 flex items-center gap-1.5">
              {running && <IconSpin />} {runLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
