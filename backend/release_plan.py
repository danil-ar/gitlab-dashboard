"""Release plan rules with no I/O: which repo a link points to and which tags to deploy or roll back to."""
import re
from urllib.parse import urlsplit

_TAG_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
_CHANGE_RE = re.compile(
    r"^(?P<path>.+?)/(?:-/)?(?:merge_requests/(?P<iid>\d+)|commit/(?P<sha>[0-9a-f]{7,40}))(?:/.*)?$"
)
_FRONTEND_NAME_RE = re.compile(r"(^|[-_.])(frontend|front|ui|web)([-_.]|$)", re.IGNORECASE)
_FRONTEND_LANGUAGES = {"TypeScript", "TSX", "JavaScript", "JSX", "Vue", "Svelte", "HTML", "CSS", "SCSS", "Sass", "Less"}


def parse_tag(tag: str) -> tuple[int, int, int] | None:
    match = _TAG_RE.match(tag)
    return tuple(int(part) for part in match.groups()) if match else None


def next_tag(tag: str) -> str:
    """Minor bump with the patch reset, keeping the v prefix: v1.3.0 becomes v1.4.0."""
    major, minor, _ = parse_tag(tag)
    prefix = "v" if tag.startswith("v") else ""
    return f"{prefix}{major}.{minor + 1}.0"


def first_tag(tags) -> str | None:
    """The lowest version among tags, i.e. the one that first shipped a commit contained in all of them."""
    return min((t for t in tags if parse_tag(t)), key=parse_tag, default=None)


def parse_gitlab_link(url: str, gitlab_url: str) -> dict | None:
    """Turn a Jira remote link into {path, iid} or {path, sha}, or None if it isn't a change on this GitLab."""
    link, base = urlsplit(url), urlsplit(gitlab_url)
    if link.netloc.lower() != base.netloc.lower():
        return None
    prefix = base.path.rstrip("/") + "/"
    if not link.path.startswith(prefix):
        return None
    match = _CHANGE_RE.match(link.path[len(prefix):])
    if not match:
        return None
    if match["iid"]:
        return {"path": match["path"], "iid": int(match["iid"])}
    return {"path": match["path"], "sha": match["sha"]}


def repo_group(name: str, languages: dict[str, float]) -> str:
    """Plan section for a repo: its name if that says frontend, otherwise its main language.

    A Node backend with a neutral name will land in frontend.
    """
    if _FRONTEND_NAME_RE.search(name):
        return "frontend"
    if not languages:
        return "other"
    return "frontend" if max(languages, key=languages.get) in _FRONTEND_LANGUAGES else "backend"


def plan_repo(tags: list[str], changes: list) -> dict:
    """Pick the tags for one repo. Each item in `changes` is the collection of tags containing that change.

    new_tag:   something isn't tagged yet, so deploy the next version after the latest tag.
    tagged:    everything is tagged and the newest such tag is the latest one, so deploy that tag.
    older_tag: everything is tagged but newer tags exist. The tag may belong to this release or may
               have shipped long ago (an old MR linked to the issue), which only a person can tell.
    no_tags:   GitLab has no version to continue from, so no tag is suggested.

    Rollback is the nearest tag below that carries none of this release's changes. Walking down from
    the top and stopping at the first such tag keeps an old MR from dragging the rollback back months.
    """
    first_tags = {first_tag(tags_of_change) for tags_of_change in changes}
    introduced = first_tags - {None}
    versions = sorted({t for t in tags if parse_tag(t)} | introduced, key=parse_tag, reverse=True)
    if not versions:
        return {"state": "no_tags", "latest_tag": None, "deploy_tag": None, "rollback_tag": None}
    latest = versions[0]

    if None in first_tags or not introduced:
        deploy, state, start = next_tag(latest), "new_tag", 0
    else:
        deploy = max(introduced, key=parse_tag)
        state = "tagged" if deploy == latest else "older_tag"
        start = versions.index(deploy)

    rollback = next((t for t in versions[start:] if t not in introduced), None)
    return {"state": state, "latest_tag": latest, "deploy_tag": deploy, "rollback_tag": rollback}
