/** The announcement people paste into chat when a merge request is ready.
 *
 * The shape is the team's own, learned from the channel:
 *
 *     https://jira.example.com/browse/LKAG-3210
 *     Require deal or sales point on activity creation
 *     https://gitlab.example.com/group/project/-/merge_requests/355/diffs
 *     @all
 *
 * Three of the four lines are already known here. The second is the odd one
 * out: in the channel it is the issue summary, which lives in the tracker and
 * not in GitLab, so this fills in the merge request title and leaves the one
 * line worth rewording sitting at the top of the clipboard.
 */
let jiraUrl = null;

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => { jiraUrl = cfg.jira_url || null; })
  .catch(() => {});

const ISSUE_KEY = /[A-Z][A-Z0-9]*-\d+/;

/** The tracker key, taken from the branch first: that is where it is exact. */
export function issueKey(mr) {
  const found = mr.source_branch?.match(ISSUE_KEY) ?? mr.title?.match(ISSUE_KEY);
  return found ? found[0] : null;
}

/** Where the tracker shows this branch's issue, when both are knowable.
 *
 *  Read at render time, and `jiraUrl` arrives asynchronously — which is safe
 *  only because /api/config is a local call made at module load while any row
 *  is waiting on a round trip to GitLab first.
 */
export function issueUrl(mr) {
  const key = issueKey(mr);
  return key && jiraUrl ? `${jiraUrl}/browse/${key}` : null;
}

export function reviewMessage(mr) {
  const key = issueKey(mr);
  // "LKAG-3210: Require deal…" — the key is about to be its own line above
  const summary = mr.title.replace(new RegExp(`^\\s*${key}\\s*[:\\-–]?\\s*`), "").trim();

  return [
    key && (jiraUrl ? `${jiraUrl}/browse/${key}` : key),
    summary,
    mr.web_url && `${mr.web_url}/diffs`,
    "@all",
  ].filter(Boolean).join("\n");
}

/** Clipboard access needs a secure context, which an office dashboard reached
 *  by hostname over plain http is not — hence the old-fashioned fallback. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  }
}
