"""Unit tests for the pure discussion/cache logic in main.py.

No GitLab and no network: every helper here takes plain dicts shaped like the
GitLab API responses.
"""
from datetime import datetime, timedelta, timezone

import main


APPROVED_AT = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def note(nid, body="comment", *, at=APPROVED_AT, system=False, resolvable=False,
         resolved=False, author="Dana", author_id=1):
    return {
        "id": nid,
        "body": body,
        "system": system,
        "resolvable": resolvable,
        "resolved": resolved,
        "created_at": iso(at),
        "author": {"id": author_id, "name": author},
    }


def thread(*notes):
    return {"notes": list(notes)}


# ─── discussion stats ─────────────────────────────────────────────────────────

def test_counts_only_resolvable_threads():
    stats = main._compute_discussion_stats([
        thread(note(1, resolvable=True, resolved=True)),
        thread(note(2, resolvable=True)),
        thread(note(3)),  # plain comment, not a review thread
    ])
    assert (stats["resolved"], stats["total"]) == (1, 2)
    assert len(stats["unresolved_previews"]) == 1
    assert len(stats["resolved_previews"]) == 1


def test_thread_is_resolved_only_when_every_note_is():
    stats = main._compute_discussion_stats([
        thread(
            note(1, resolvable=True, resolved=True),
            note(2, resolvable=True, resolved=False),
        ),
    ])
    assert (stats["resolved"], stats["total"]) == (0, 1)


def test_previews_are_newest_first():
    old, new = APPROVED_AT - timedelta(days=2), APPROVED_AT
    stats = main._compute_discussion_stats([
        thread(note(1, "older", at=old, resolvable=True)),
        thread(note(2, "newer", at=new, resolvable=True)),
    ])
    assert [p["body"] for p in stats["unresolved_previews"]] == ["newer", "older"]


# ─── activity after approval ──────────────────────────────────────────────────

def test_thread_opened_after_approval_counts_as_new():
    after = APPROVED_AT + timedelta(hours=1)
    threads, replies, previews = main._compute_new_threads(
        [thread(note(1, "fresh take", at=after))], APPROVED_AT,
    )
    assert (threads, replies) == (1, 0)
    assert previews[0]["body"] == "fresh take"


def test_reply_on_a_pre_existing_thread_counts_as_new():
    """The case the old implementation missed: someone answers a review comment
    that was written before the approval."""
    before = APPROVED_AT - timedelta(days=1)
    after  = APPROVED_AT + timedelta(hours=2)
    threads, replies, previews = main._compute_new_threads(
        [thread(note(1, "please fix", at=before), note(2, "fixed it", at=after))],
        APPROVED_AT,
    )
    assert (threads, replies) == (0, 1)
    assert previews[0]["new_replies"] == 1
    assert [r["body"] for r in previews[0]["reply_notes"]] == ["fixed it"]


def test_untouched_old_thread_is_not_reported():
    before = APPROVED_AT - timedelta(days=1)
    threads, replies, previews = main._compute_new_threads(
        [thread(note(1, "old", at=before), note(2, "also old", at=before))],
        APPROVED_AT,
    )
    assert (threads, replies, previews) == (0, 0, [])


def test_system_notes_never_open_a_thread():
    after = APPROVED_AT + timedelta(hours=1)
    threads, replies, _ = main._compute_new_threads(
        [thread(note(1, "changed title", at=after, system=True))], APPROVED_AT,
    )
    assert (threads, replies) == (0, 0)


def test_system_replies_are_not_counted_as_replies():
    before = APPROVED_AT - timedelta(days=1)
    after  = APPROVED_AT + timedelta(hours=1)
    threads, replies, _ = main._compute_new_threads(
        [thread(note(1, "review", at=before), note(2, "marked ready", at=after, system=True))],
        APPROVED_AT,
    )
    assert (threads, replies) == (0, 0)


def test_only_the_five_newest_replies_are_shipped():
    before = APPROVED_AT - timedelta(days=1)
    notes = [note(0, "review", at=before)]
    notes += [note(i, f"reply {i}", at=APPROVED_AT + timedelta(minutes=i)) for i in range(1, 9)]
    _, replies, previews = main._compute_new_threads([thread(*notes)], APPROVED_AT)
    assert replies == 8
    assert [r["body"] for r in previews[0]["reply_notes"]] == [f"reply {i}" for i in range(4, 9)]


# ─── text handling ────────────────────────────────────────────────────────────

def test_markdown_is_stripped_from_previews():
    body = "## Heading\n- bullet\n1. numbered\n---\nplain"
    assert main._strip_markdown(body) == "Heading\nbullet\nnumbered\n\nplain"


def test_truncation_keeps_whole_words():
    assert main._truncate("alpha beta gamma", 12) == "alpha beta…"
    assert main._truncate("short", 12) == "short"


def test_malformed_timestamps_do_not_crash():
    assert main._parse_dt("not-a-date") is None
    assert main._parse_dt("") is None
    assert main._is_after("not-a-date", APPROVED_AT) is False
    assert main._is_after(None, APPROVED_AT) is False


# ─── cache ────────────────────────────────────────────────────────────────────

def test_none_is_a_real_cached_value():
    """An MR with no pipeline must not be re-fetched on every refresh."""
    cache = main.TTLCache(ttl=60)
    cache.set(("pipeline",), None)
    assert cache.get(("pipeline",)) is None
    assert cache.get(("absent",)) is main._MISS


def test_cache_evicts_least_recently_used():
    cache = main.TTLCache(ttl=60, maxsize=2)
    cache.set(("a",), 1)
    cache.set(("b",), 2)
    cache.get(("a",))       # refresh "a", making "b" the coldest entry
    cache.set(("c",), 3)
    assert cache.get(("b",)) is main._MISS
    assert cache.get(("a",)) == 1
    assert len(cache) == 2


def test_expired_entries_are_dropped():
    cache = main.TTLCache(ttl=0)
    cache.set(("a",), 1)
    assert cache.get(("a",)) is main._MISS


def test_cache_keys_are_namespaced_per_token():
    """Two people on one backend must never read each other's cached data."""
    a = main.GL("https://gitlab.example.com", "token-a")
    b = main.GL("https://gitlab.example.com", "token-b")
    assert a.key("approvals", 1, 2) != b.key("approvals", 1, 2)
