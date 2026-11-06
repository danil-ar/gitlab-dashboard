"""Release rules with no I/O: which tags to use, what a link points at, what a merge would carry."""
import pytest

from app import release_plan as rp

TAGS = ["v4.33.0", "v4.32.0", "v4.31.0", "v4.10.0", "v4.9.0", "not-semver"]


def tags_for(tags, changes):
    plan = rp.plan_repo(tags, changes)
    return plan["state"], plan["deploy_tag"], plan["rollback_tag"]


# ─── which tags ───────────────────────────────────────────────────────────────

def test_latest_is_the_highest_version_not_the_newest_by_date():
    assert rp.plan_repo(["v4.32.1", "v4.33.0", "v4.32.0"], [[]])["latest_tag"] == "v4.33.0"


def test_a_hotfix_after_a_higher_tag_continues_from_the_highest():
    assert rp.plan_repo(["v4.32.1", "v4.33.0"], [[]])["deploy_tag"] == "v4.34.0"


def test_nothing_tagged_rolls_back_to_the_latest_and_deploys_the_next():
    assert tags_for(TAGS, [[]]) == ("new_tag", "v4.34.0", "v4.33.0")


def test_already_tagged_deploys_that_tag():
    assert tags_for(TAGS, [["v4.33.0"]]) == ("tagged", "v4.33.0", "v4.32.0")


def test_a_release_across_two_tags_rolls_back_below_both():
    assert tags_for(TAGS, [["v4.33.0"], ["v4.32.0", "v4.33.0"]]) == ("tagged", "v4.33.0", "v4.31.0")


def test_partly_tagged_needs_a_new_tag_and_rolls_back_below_ours():
    assert tags_for(TAGS, [["v4.33.0"], []]) == ("new_tag", "v4.34.0", "v4.32.0")


def test_an_ancient_mr_alone_is_flagged_rather_than_planned_as_latest():
    assert tags_for(TAGS, [["v4.10.0", "v4.31.0", "v4.32.0", "v4.33.0"]]) == ("older_tag", "v4.10.0", "v4.9.0")


def test_an_ancient_mr_doesnt_drag_the_rollback_back_months():
    assert tags_for(TAGS, [["v4.10.0", "v4.33.0"], []]) == ("new_tag", "v4.34.0", "v4.33.0")


@pytest.mark.parametrize("tags", [[], ["build-1", "nightly"]])
def test_no_version_tags_means_no_invented_version(tags):
    assert rp.plan_repo(tags, [[]]) == {"state": "no_tags", "latest_tag": None, "deploy_tag": None, "rollback_tag": None}


def test_the_only_tag_has_nothing_below_it_to_roll_back_to():
    assert tags_for(["v1.0.0"], [["v1.0.0"]]) == ("tagged", "v1.0.0", None)


def test_release_candidates_dont_count_as_versions():
    assert tags_for(["v1.3.0-rc1", "v1.2.0"], [["v1.3.0-rc1"]]) == ("new_tag", "v1.3.0", "v1.2.0")


@pytest.mark.parametrize("tag, following", [("v1.3.0", "v1.4.0"), ("v1.3.7", "v1.4.0"), ("1.9.3", "1.10.0")])
def test_next_tag_bumps_the_minor_and_keeps_the_prefix(tag, following):
    assert rp.next_tag(tag) == following


# ─── what a Jira link points at ───────────────────────────────────────────────

GITLAB = "https://gitlab.test"


@pytest.mark.parametrize("url, parsed", [
    (f"{GITLAB}/a/b/lk/-/merge_requests/12", {"path": "a/b/lk", "iid": 12}),
    (f"{GITLAB}/a/lk/-/merge_requests/12#note_5", {"path": "a/lk", "iid": 12}),
    (f"{GITLAB}/a/lk/-/merge_requests/12/diffs", {"path": "a/lk", "iid": 12}),
    (f"{GITLAB}/a/lk/merge_requests/12", {"path": "a/lk", "iid": 12}),
    (f"{GITLAB}/a/lk/-/commit/abcdef1234", {"path": "a/lk", "sha": "abcdef1234"}),
])
def test_links_to_changes_are_understood(url, parsed):
    assert rp.parse_gitlab_link(url, GITLAB) == parsed


@pytest.mark.parametrize("url", [
    "https://gitlab.test.evil.io/a/lk/-/merge_requests/1",
    f"{GITLAB}/a/lk/-/issues/1",
    "https://wiki.test/x",
])
def test_other_links_are_not_changes(url):
    assert rp.parse_gitlab_link(url, GITLAB) is None


def test_gitlab_under_a_subpath():
    assert rp.parse_gitlab_link("https://h/gl/a/lk/-/merge_requests/1", "https://h/gl") == {"path": "a/lk", "iid": 1}
    assert rp.parse_gitlab_link("https://h/x/a/lk/-/merge_requests/1", "https://h/gl") is None


# ─── plan sections ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name, languages, group", [
    ("svc", {"Python": 90, "HTML": 10}, "backend"),
    ("svc", {"TypeScript": 70, "Python": 30}, "frontend"),
    ("svc", {"TSX": 70, "Python": 30}, "frontend"),
    ("svc", {}, "other"),
    ("lk-frontend", {"Shell": 100}, "frontend"),
    ("lk-frontend-mirroring", {}, "frontend"),
    ("consent-ui", {}, "frontend"),
    ("lk_web", {"Go": 100}, "frontend"),
    ("lk-backend", {"Python": 99}, "backend"),
    ("lk-webhooks", {"Python": 99}, "backend"),
    ("lkag-test-config", {"YAML": 100}, "backend"),
])
def test_repo_group(name, languages, group):
    assert rp.repo_group(name, languages) == group


# ─── what a merge would carry ─────────────────────────────────────────────────

def commit(title, message=None, parents=("p",)):
    return {"title": title, "message": message or title, "parent_ids": list(parents)}


def test_commits_are_sorted_by_whether_their_issue_is_ready():
    statuses = {"LKAG-1": "ВКЛЮЧЕНО В РЕЛИЗ", "LKAG-2": "Тестирование", "LKAG-3": "Включено в релиз", "LKAG-4": "Выполнено"}
    summary = rp.summarize_commits([
        commit("LKAG-1: ready"),
        commit("LKAG-4: done"),
        commit("LKAG-2 testing"),
        commit("Merge branch 'LKAG-3' into 'develop'", "Merge\n\nSee !1", parents=("a", "b")),
        commit("LKAG-99 elsewhere"),
        commit("no key"),
        commit("Merge branch 'x'", parents=("a", "b")),
        commit("RESECT-5 other tracker"),
    ], statuses, ("Включено в релиз", "Выполнено"), "LKAG")
    assert summary == {
        "ready": ["LKAG-1", "LKAG-3", "LKAG-4"],
        "not_ready": [{"key": "LKAG-2", "status": "Тестирование"}],
        "foreign": ["LKAG-99"],
        "no_key": 2,  # a merge commit with no key says nothing about its content, so it isn't counted
    }


def test_merge_block_reasons():
    assert rp.merge_block_reason("not_approved") == "The merge request needs approval"
    assert "something_new" in rp.merge_block_reason("something_new")
