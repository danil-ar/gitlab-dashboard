"""Pure functions over GitLab discussion payloads.

No network and no state — everything here takes plain dicts shaped like the
GitLab API responses, which is what makes it directly testable.
"""
import re
from datetime import datetime

_MD_HEADING = re.compile(r"^#{1,6}\s+", re.MULTILINE)
_MD_RULE    = re.compile(r"^[-*_]{3,}\s*$", re.MULTILINE)
_MD_BULLET  = re.compile(r"^[\*\-\+]\s+", re.MULTILINE)
_MD_NUMBER  = re.compile(r"^\d+\.\s+", re.MULTILINE)


def parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def is_after(iso: str | None, since: datetime | None) -> bool:
    if since is None or not iso:
        return False
    dt = parse_dt(iso)
    return dt is not None and dt > since


def strip_markdown(text: str) -> str:
    for pattern in (_MD_HEADING, _MD_RULE, _MD_BULLET, _MD_NUMBER):
        text = pattern.sub("", text)
    return text.strip()


def truncate(text: str, max_len: int = 120) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len].rsplit(" ", 1)[0] + "…"


def _clean(body: str | None, max_len: int) -> str:
    return truncate(strip_markdown((body or "").replace("\n", " ")), max_len)


def build_note_preview(notes: list[dict], since: datetime | None = None) -> dict:
    """Preview of one discussion thread.

    With `since`, the reply list is narrowed to what arrived after that moment —
    that is what makes 'new replies on a thread you already read' visible.
    """
    first        = notes[0]
    position     = first.get("position") or {}
    user_replies = [n for n in notes[1:] if not n.get("system")]
    new_replies  = [n for n in user_replies if is_after(n.get("created_at"), since)] if since else []
    shown = new_replies if since else user_replies
    return {
        "note_id":     first.get("id"),
        "author":      first.get("author", {}).get("name", ""),
        "body":        _clean(first.get("body"), 500),
        "created_at":  first.get("created_at"),
        "replies":     len(user_replies),
        "new_replies": len(new_replies),
        "reply_notes": [
            {
                "note_id":    n.get("id"),
                "author":     n.get("author", {}).get("name", ""),
                "body":       _clean(n.get("body"), 300),
                "created_at": n.get("created_at"),
            }
            for n in shown[-5:]
        ],
        "file_path":  position.get("new_path") or position.get("old_path"),
        "line":       position.get("new_line") or position.get("old_line"),
    }


def sort_previews(previews: list[dict]) -> None:
    previews.sort(key=lambda p: p.get("created_at") or "", reverse=True)


def compute_stats(discussions: list[dict]) -> dict:
    total = resolved_count = 0
    unresolved_previews: list[dict] = []
    resolved_previews:   list[dict] = []
    for d in discussions:
        notes      = d.get("notes", [])
        resolvable = [n for n in notes if n.get("resolvable")]
        if not resolvable:
            continue
        total += 1
        preview = build_note_preview(notes)
        if all(n.get("resolved") for n in resolvable):
            resolved_count += 1
            resolved_previews.append(preview)
        else:
            unresolved_previews.append(preview)
    sort_previews(unresolved_previews)
    sort_previews(resolved_previews)
    return {
        "resolved":            resolved_count,
        "total":               total,
        "unresolved_previews": unresolved_previews,
        "resolved_previews":   resolved_previews,
    }


def compute_new_threads(discussions: list[dict], since: datetime) -> tuple[int, int, list[dict]]:
    """Discussion activity after `since`.

    Counts both brand-new threads and replies landing on threads that already
    existed — a reply on an old thread is exactly the kind of "answer my review
    comment" event that must not be missed.
    """
    new_threads = 0
    new_replies = 0
    previews: list[dict] = []
    for d in discussions:
        notes = d.get("notes", [])
        if not notes or notes[0].get("system"):
            continue
        if is_after(notes[0].get("created_at"), since):
            new_threads += 1
            previews.append(build_note_preview(notes))
            continue
        preview = build_note_preview(notes, since=since)
        if preview["new_replies"] > 0:
            new_replies += preview["new_replies"]
            previews.append(preview)
    sort_previews(previews)
    return new_threads, new_replies, previews
