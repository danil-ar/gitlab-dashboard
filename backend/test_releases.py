"""The release plan, end to end: real routes against a fake Jira and a fake GitLab."""
import httpx
import pytest
from fastapi.testclient import TestClient

import main

BACKEND, WEB, OLD, GONE, CLOSED, WIP, MANY, SHIPPED = (
    "grp/lk-backend", "grp/lk-web", "grp/lk-old", "grp/lk-gone", "grp/lk-closed", "grp/lk-wip", "grp/lk-many", "grp/lk-shipped",
)
IN_RELEASE = {"name": "ВКЛЮЧЕНО В РЕЛИЗ"}  # Jira's case, not the one configured


def link(path, tail):
    return {"object": {"url": f"https://gitlab.test/{path}/-/{tail}"}, "relationship": "mentioned on"}


LINKS = {
    "LKAG-1": [link(BACKEND, "merge_requests/1"), link(BACKEND, "commit/aaaaaaaa11")],  # squashed MR + its branch commit
    "LKAG-2": [link(BACKEND, "merge_requests/2"), {"object": {"url": "https://wiki.test/page"}}],
    "LKAG-3": [link(WEB, "merge_requests/3")],
    "LKAG-4": [link(OLD, "merge_requests/4")],
    "LKAG-5": [link(CLOSED, "merge_requests/5")],
    "LKAG-6": [link(GONE, "merge_requests/6")],
    "LKAG-7": [link(WEB, "commit/bbbbbbbb22")],
    "LKAG-8": [],
    "LKAG-9": [link(MANY, "merge_requests/9")],
    "LKAG-10": [link(SHIPPED, "merge_requests/10")],
    "LKAG-90": [link(WIP, "merge_requests/7")],
}
DONE = {"name": "Выполнено", "statusCategory": {"key": "done"}}
OTHER_ISSUES = {
    "LKAG-10": DONE,
    "LKAG-90": {"name": "Тестирование", "statusCategory": {"key": "indeterminate"}},
    "LKAG-91": {"name": "Отозвано", "statusCategory": {"key": "done"}},
    "LKAG-92": {"name": "Тестирование"},
}
MRS = {
    (WIP, 7): {"state": "opened", "title": "wip"},
    (BACKEND, 1): {"state": "merged", "merge_commit_sha": "m1", "title": "one"},
    (BACKEND, 2): {"state": "opened", "title": "two"},
    (WEB, 3): {"state": "merged", "squash_commit_sha": "s3", "merge_commit_sha": None, "title": "three"},
    (OLD, 4): {"state": "merged", "merge_commit_sha": "m4", "title": "old"},
    (CLOSED, 5): {"state": "closed", "title": "nope"},
    (MANY, 9): {"state": "merged", "merge_commit_sha": "m9", "title": "shipped long ago"},
    (SHIPPED, 10): {"state": "merged", "merge_commit_sha": "m10", "title": "done"},
}
MANY_TAGS = [f"v3.{i}.0" for i in range(131)]
TAGS = {
    # CI tags fill the first pages; the release tags only show up on the last one
    BACKEND: [f"build-{i}" for i in range(230)] + ["v4.33.0", "v4.32.0"],
    WEB: ["v2.1.0", "v2.0.0"],
    OLD: ["v1.9.0", "v1.8.0", "v1.1.0", "v1.0.0"],
    CLOSED: ["v1.0.0"],
    MANY: MANY_TAGS,
    SHIPPED: ["v5.1.0", "v5.0.0"],
}
REFS = {
    "m1": [],
    "s3": ["v2.1.0"],
    "m4": ["v1.1.0", "v1.8.0", "v1.9.0"],
    "bbbbbbbb22": ["v2.1.0"],
    "m10": ["v5.1.0"],
    "m9": list(reversed(MANY_TAGS)),  # newest first, so its real first tag is only on the second page
}
LANGUAGES = {SHIPPED: {"Python": 99}, BACKEND: {"Python": 99}, WEB: {"TypeScript": 80, "Python": 20}, OLD: {"Python": 99}, MANY: {"Python": 99}}
VERSIONS = [
    {"id": "1", "name": "Релиз 23.11", "released": False, "releaseDate": "2026-11-23", "description": "REL-3"},
    {"id": "2", "name": "Релиз 09.11", "released": False, "releaseDate": "2026-11-09", "description": "REL-2169"},
    {"id": "3", "name": "Релиз 01.10", "released": True, "releaseDate": "2026-10-01"},
    {"id": "4", "name": "Релиз 01.11", "released": True, "releaseDate": "2026-11-01", "description": "REL-9"},
    {"id": "5", "name": "archived", "released": True, "archived": True, "releaseDate": "2020-01-01"},
]


def paged(req, items):
    page = int(req.url.params.get("page", "1"))
    more = page * 100 < len(items)
    return httpx.Response(200, headers={"X-Next-Page": str(page + 1) if more else ""}, json=items[(page - 1) * 100:page * 100])


class FakeServices:
    def __init__(self):
        self.seen = []
        self.jira_rejects_token = False
        self.release_issues_fail = False

    def jira(self, req, raw):
        if self.jira_rejects_token or req.headers.get("authorization") != "Bearer jira-pat":
            return httpx.Response(401, text="<html>login</html>")
        if raw.endswith("/myself"):
            return httpx.Response(200, json={"name": "me"})
        if raw.endswith("/project/LKAG/versions"):
            return httpx.Response(200, json=VERSIONS)
        if raw.endswith("/search") and "key in" in req.url.params["jql"]:
            assert req.url.params["validateQuery"] == "false"
            assert "REL-2169" in req.url.params["jql"] and "REL-9" not in req.url.params["jql"]
            if self.release_issues_fail:
                return httpx.Response(500, json={"errorMessages": ["boom"]})
            status = {"name": "В работе", "statusCategory": {"key": "indeterminate"}}
            return httpx.Response(200, json={"total": 1, "issues": [{"key": "REL-2169", "fields": {"status": status}}]})
        if raw.endswith("/search"):
            assert "fixVersion = 2" in req.url.params["jql"]
            issues = [
                {"key": key, "fields": {"summary": key, "status": OTHER_ISSUES.get(key, IN_RELEASE), "assignee": {"displayName": "A"}, "issuetype": {"name": "Task"}}}
                for key in [*(k for k in LINKS if k not in OTHER_ISSUES), *OTHER_ISSUES]
            ]
            start = int(req.url.params["startAt"])
            return httpx.Response(200, json={"total": len(issues), "issues": issues[start:start + 4]})  # forces paging
        if "/remotelink" in raw:
            return httpx.Response(200, json=LINKS.get(raw.split("/")[-2], []))
        return httpx.Response(500, text=f"unexpected {raw}")

    def gitlab(self, req, raw):
        assert req.headers.get("private-token") == "gl-token"
        path = raw.removeprefix("/api/v4")
        if path == "/user":
            return httpx.Response(200, json={"id": 1, "name": "me", "username": "me"})
        parts = path.split("/")
        repo = parts[2].replace("%2F", "/")
        if repo == GONE:
            return httpx.Response(404, json={"message": "404 Project Not Found"})
        tail = "/".join(parts[3:])
        if tail.startswith("merge_requests/"):
            return httpx.Response(200, json=MRS[(repo, int(parts[4]))])
        if tail == "repository/tags":
            return paged(req, [{"name": t} for t in TAGS[repo]])
        if tail == "languages":
            return httpx.Response(200, json=LANGUAGES.get(repo, {}))
        if tail.endswith("/refs"):
            return paged(req, [{"type": "tag", "name": t} for t in REFS[parts[5]]])
        return httpx.Response(500, text=f"unexpected {raw}")

    def __call__(self, req):
        raw = req.url.raw_path.decode().split("?")[0]
        self.seen.append((req.url.host, raw, req.headers.get("authorization"), req.headers.get("private-token")))
        return self.jira(req, raw) if req.url.host == "jira.test" else self.gitlab(req, raw)


@pytest.fixture
def services(use_handler):
    fake = FakeServices()
    use_handler(fake)
    return fake


@pytest.fixture
def signed_in(services):
    client = TestClient(main.app, raise_server_exceptions=False)
    assert client.post("/api/auth/login", json={"gitlab_url": "https://gitlab.test", "token": "gl-token"}).status_code == 200
    return client


@pytest.fixture
def connected(signed_in):
    assert signed_in.post("/api/jira/connect", json={"token": "jira-pat"}).status_code == 200
    return signed_in


@pytest.fixture
def plan(connected):
    response = connected.get("/api/jira/releases/2/plan")
    assert response.status_code == 200
    return response.json()


@pytest.fixture
def repos(plan):
    return {row["name"]: row for row in plan["repos"]}


def issue_in(plan, key):
    return next(i for i in plan["issues"] if i["key"] == key)


# ─── connecting ───────────────────────────────────────────────────────────────

def test_profiles_say_jira_is_available_but_never_show_the_token(connected):
    profiles = connected.get("/api/auth/profiles").json()
    assert profiles["jiraUrl"] == "https://jira.test"
    assert profiles["profiles"][0]["jiraConnected"] is True
    assert "jiraToken" not in profiles["profiles"][0]


def test_before_connecting_it_is_403_not_a_dead_session(signed_in):
    assert signed_in.get("/api/jira/releases").status_code == 403


def test_a_rejected_jira_token_leaves_the_gitlab_session_alone(signed_in):
    assert signed_in.post("/api/jira/connect", json={"token": "bad"}).status_code == 403
    assert signed_in.get("/api/me").status_code == 200


def test_a_jira_token_that_expires_later_isnt_a_gitlab_sign_out(connected, services):
    services.jira_rejects_token = True
    assert connected.get("/api/jira/releases/2/plan").status_code == 403


# ─── the release list ─────────────────────────────────────────────────────────

def test_upcoming_come_first_nearest_on_top_then_shipped_latest_on_top(connected):
    releases = connected.get("/api/jira/releases").json()["releases"]
    assert [r["id"] for r in releases] == ["2", "1", "4", "3"]
    assert (releases[0]["release_issue"], releases[3]["release_issue"]) == ("REL-2169", None)


def test_release_issue_status_is_read_for_upcoming_releases(connected):
    releases = connected.get("/api/jira/releases").json()["releases"]
    assert [r["release_issue_status"] for r in releases] == [
        {"status": "В работе", "status_category": "indeterminate"}, None, None, None,
    ]


def test_failing_to_read_those_statuses_doesnt_cost_the_list(connected, services):
    services.release_issues_fail = True
    response = connected.get("/api/jira/releases")
    assert response.status_code == 200
    assert len(response.json()["releases"]) == 4
    assert response.json()["releases"][0]["release_issue_status"] is None


# ─── issues ───────────────────────────────────────────────────────────────────

def test_every_issue_of_the_version_is_listed_across_jira_pages(plan):
    assert len(plan["issues"]) == 13
    assert sum(i["in_release"] for i in plan["issues"]) == 10


def test_an_issue_outside_the_release_shows_its_status_and_links(plan):
    issue = issue_in(plan, "LKAG-90")
    assert (issue["status"], issue["status_category"], issue["in_release"]) == ("Тестирование", "indeterminate", False)
    assert [(l["repo"], l["ref"], l["state"]) for l in issue["links"]] == [("lk-wip", "!7", "opened")]


def test_an_issue_outside_the_release_doesnt_touch_the_plan(plan, repos):
    assert "lk-wip" not in repos
    assert not any("!7" in warning for row in plan["repos"] for warning in row["warnings"])


def test_an_issue_finished_after_the_release_still_belongs_to_it(plan, repos):
    """Issues move on to "Выполнено" once a release ships, which left every shipped release looking empty."""
    assert issue_in(plan, "LKAG-10")["in_release"] is True
    row = repos["lk-shipped"]
    assert (row["state"], row["deploy_tag"], row["rollback_tag"]) == ("tagged", "v5.1.0", "v5.0.0")


def test_withdrawn_work_is_finished_too_but_not_part_of_the_release(plan):
    issue = issue_in(plan, "LKAG-91")
    assert (issue["status_category"], issue["in_release"]) == ("done", False)


def test_an_old_tag_is_a_question_only_while_the_release_is_upcoming(connected, repos):
    assert any("newer tags exist" in warning for warning in repos["lk-old"]["warnings"])
    shipped = connected.get("/api/jira/releases/2/plan", params={"released": "true"}).json()
    row = next(r for r in shipped["repos"] if r["name"] == "lk-old")
    assert row["state"] == "older_tag"
    assert row["warnings"] == []


def test_status_matching_ignores_case(plan):
    assert issue_in(plan, "LKAG-1")["in_release"] is True


def test_an_issue_with_no_links_is_kept(plan):
    assert issue_in(plan, "LKAG-8")["links"] == []


def test_a_closed_mr_shows_on_its_issue_with_the_full_repo_path(plan):
    only_link = issue_in(plan, "LKAG-5")["links"][0]
    assert (only_link["state"], only_link["path"]) == ("closed", CLOSED)


# ─── tags ─────────────────────────────────────────────────────────────────────

def test_latest_tag_is_found_past_pages_of_ci_tags(repos, services):
    assert repos["lk-backend"]["latest_tag"] == "v4.33.0"
    assert sum(seen[1].endswith("lk-backend/repository/tags") for seen in services.seen) == 3


def test_untagged_changes_need_a_new_tag(repos):
    row = repos["lk-backend"]
    assert (row["state"], row["rollback_tag"], row["deploy_tag"], row["group"]) == ("new_tag", "v4.33.0", "v4.34.0", "backend")


def test_a_branch_commit_of_a_squashed_mr_doesnt_count_separately(repos):
    assert [change["ref"] for change in repos["lk-backend"]["changes"]] == ["!1", "!2"]


def test_an_unmerged_mr_is_reported_with_its_link_and_issues(repos):
    assert repos["lk-backend"]["unmerged"] == [{
        "ref": "!2", "url": f"https://gitlab.test/{BACKEND}/-/merge_requests/2", "issues": ["LKAG-2"],
    }]


def test_a_merged_mr_isnt_reported_as_unmerged(repos):
    assert repos["lk-web"]["unmerged"] == []


def test_squashed_and_commit_only_changes_are_found_in_their_tag(repos):
    row = repos["lk-web"]
    assert (row["state"], row["rollback_tag"], row["deploy_tag"], row["group"]) == ("tagged", "v2.0.0", "v2.1.0", "frontend")


def test_changes_shipped_long_ago_are_flagged(repos):
    row = repos["lk-old"]
    assert (row["state"], row["deploy_tag"], row["rollback_tag"]) == ("older_tag", "v1.1.0", "v1.0.0")


def test_the_first_tag_of_a_commit_in_many_tags_is_found_on_a_later_page(repos):
    """An old commit sits in every later tag. Reading only the first hundred
    gave v3.31.0 and a rollback to v3.30.0, which also contains the change."""
    row = repos["lk-many"]
    assert (row["state"], row["deploy_tag"], row["rollback_tag"]) == ("older_tag", "v3.0.0", None)


def test_a_repo_with_only_closed_mrs_isnt_planned(repos):
    assert "lk-closed" not in repos


def test_a_repo_that_cant_be_read_is_reported_on_its_own_row(repos):
    row = repos["lk-gone"]
    assert (row["state"], row["deploy_tag"]) == ("error", None)
    assert "Not found" in row["error"]


# ─── tokens ───────────────────────────────────────────────────────────────────

def test_each_token_only_goes_to_its_own_service(plan, services):
    assert not any(host == "jira.test" and gitlab_token for host, _, _, gitlab_token in services.seen)
    assert not any(host == "gitlab.test" and jira_token for host, _, jira_token, _ in services.seen)
