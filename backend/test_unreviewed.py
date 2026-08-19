"""Tests for deciding what has not been through review.

No GitLab and no network: both rules take plain dicts shaped like the branches
and commits APIs. Every branch or commit ruled out here is an HTTP call that
never happens afterwards.
"""
from datetime import datetime, timedelta, timezone

from app.service import arrived_without_a_merge, wants_merge_request


def iso(days_ago):
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def branch(name="feat", *, default=False, protected=False, merged=False, age=1):
    return {"name": name, "default": default, "protected": protected, "merged": merged,
            "commit": {"committed_date": iso(age)}}


# ─── which branches still want a merge request ────────────────────────────────

def test_a_fresh_unmerged_branch_wants_one():
    assert wants_merge_request(branch(), 14) is True


def test_the_default_branch_never_does():
    """Nobody opens a merge request from the branch everything merges into."""
    assert wants_merge_request(branch("develop", default=True), 14) is False


def test_a_protected_branch_never_does():
    """What reaches a protected branch unreviewed is the other half of this
    question, answered commit by commit rather than branch by branch."""
    assert wants_merge_request(branch("master", protected=True), 14) is False


def test_an_already_merged_branch_does_not():
    """Its work is in the trunk; there is nothing left to review."""
    assert wants_merge_request(branch(merged=True), 14) is False


def test_a_branch_nobody_has_touched_for_weeks_does_not():
    """Abandoned experiments would drown the list the feature exists to keep short."""
    assert wants_merge_request(branch(age=40), 14) is False
    assert wants_merge_request(branch(age=40), 90) is True


def test_a_branch_without_a_date_is_not_guessed_at():
    assert wants_merge_request({"name": "feat"}, 14) is False


# ─── which trunk commits might have skipped review ────────────────────────────

def test_a_merge_commit_came_from_a_merge_request():
    """Two parents on the first-parent line is the merge itself."""
    assert arrived_without_a_merge({"parent_ids": ["a", "b"]}) is False


def test_a_single_parent_commit_is_a_suspect():
    """Pushed straight to the branch — or squashed by a merge request. The
    commit cannot tell the two apart, which is why this is only a suspicion."""
    assert arrived_without_a_merge({"parent_ids": ["a"]}) is True


def test_the_repositorys_first_commit_is_not_a_suspect():
    """A root commit has no parent to have merged from — it is where the
    repository began, and there was never a review to skip."""
    assert arrived_without_a_merge({"parent_ids": []}) is False
    assert arrived_without_a_merge({}) is False


def test_an_octopus_merge_is_still_a_merge():
    assert arrived_without_a_merge({"parent_ids": ["a", "b", "c"]}) is False
