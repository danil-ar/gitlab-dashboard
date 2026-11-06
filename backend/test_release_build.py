"""Building a tag on the real routes against a stateful fake GitLab. What matters most is what is NOT written."""
import httpx
import pytest
from fastapi.testclient import TestClient

import main
from app import releases

PATH, ENCODED = "grp/sub/lk-backend", "grp%2Fsub%2Flk-backend"
REPO_URL = f"https://g.test/{PATH}"
ALL_COMMANDS = [
    "git fetch origin --tags", "git checkout master", "git pull --ff-only origin master",
    'git merge --no-ff d1 -m "Release v1.1.0: develop into master"', "git push origin master",
    "git tag v1.1.0", "git push origin v1.1.0",
]


def commit(title, message=None, parents=("p",)):
    return {"id": "c", "title": title, "message": message or title, "parent_ids": list(parents)}


def refusal(status, message="x"):
    return httpx.Response(status, json={"message": message})


class FakeRepo:
    """A repo with master and develop, recording every write."""

    def __init__(self):
        self.branches = {"master": "m0", "develop": "d1"}
        self.ahead = [commit("LKAG-1: a")]
        self.tags = ["v1.0.0"]
        self.mrs = []
        self.merge_statuses = []  # consumed one per read; "mergeable" once empty
        self.merge_error = None
        self.tag_error = None
        self.merge_hides_commit = False
        self.create_mr_error = None
        self.token_dead = False
        self.writes = []

    def write_kinds(self):
        return [(method, path.rsplit("/", 1)[-1]) for method, path, _ in self.writes]

    def reads(self, tail, query):
        if tail.startswith("/repository/branches/"):
            name = tail.rsplit("/", 1)[-1]
            return httpx.Response(200, json={"name": name, "commit": {"id": self.branches[name]}}) if name in self.branches else refusal(404)
        if tail == "/repository/commits":
            assert query["ref_name"].endswith("..develop")
            return httpx.Response(200, json=self.ahead if query.get("page", "1") == "1" else [])
        if tail.startswith("/repository/tags/"):
            return httpx.Response(200, json={}) if tail.rsplit("/", 1)[-1] in self.tags else refusal(404)
        if tail == "/merge_requests":
            return httpx.Response(200, json=[mr for mr in self.mrs if mr["state"] == "opened"][:1])
        if tail.startswith("/merge_requests/"):
            status = self.merge_statuses.pop(0) if self.merge_statuses else "mergeable"
            return httpx.Response(200, json={**self.mrs[0], "detailed_merge_status": status})
        return refusal(500, f"unexpected read {tail}")

    def __call__(self, req):
        raw = req.url.raw_path.decode().split("?")[0]
        query = req.url.params
        if req.url.host == "jira.test":
            if raw.endswith("/myself"):
                return httpx.Response(200, json={"name": "me"})
            statuses = {"LKAG-1": "ВКЛЮЧЕНО В РЕЛИЗ", "LKAG-2": "Тестирование", "LKAG-3": "Включено в релиз", "LKAG-4": "Выполнено"}
            return httpx.Response(200, json={"total": 3, "issues": [{"key": k, "fields": {"status": {"name": v}}} for k, v in statuses.items()]})

        path = raw.removeprefix("/api/v4")
        if self.token_dead:
            return refusal(401)
        if path == "/user":
            return httpx.Response(200, json={"id": 1, "name": "n", "username": "u"})
        assert path.startswith(f"/projects/{ENCODED}"), path
        tail = path.removeprefix(f"/projects/{ENCODED}")
        if req.method == "GET":
            return self.reads(tail, query)

        self.writes.append((req.method, tail, dict(query)))
        if req.method == "POST" and tail == "/merge_requests":
            if self.create_mr_error:
                return refusal(self.create_mr_error, "nope")
            mr = {"iid": 77, "state": "opened", "web_url": f"{REPO_URL}/-/merge_requests/77"}
            self.mrs.append(mr)
            return httpx.Response(201, json=mr)
        if req.method == "PUT" and tail.endswith("/merge"):
            if self.merge_error:
                return refusal(self.merge_error, "merge refused")
            self.mrs[0]["state"] = "merged"
            self.ahead = []
            self.branches["main" if "main" in self.branches else "master"] = "m1"
            if self.merge_hides_commit:
                return httpx.Response(200, json={"state": "merged"})
            return httpx.Response(200, json={"merge_commit_sha": "m1", "sha": "d1", "state": "merged"})
        if req.method == "POST" and tail == "/repository/tags":
            if self.tag_error:
                return refusal(self.tag_error, "protected tag")
            self.tags.append(query["tag_name"])
            return httpx.Response(201, json={})
        return refusal(500, f"unexpected write {tail}")


@pytest.fixture
def repo(use_handler, monkeypatch):
    monkeypatch.setattr(releases, "_MERGE_CHECK_DELAY", 0)
    fake = FakeRepo()
    use_handler(fake)
    return fake


@pytest.fixture
def client(repo):
    c = TestClient(main.app, raise_server_exceptions=False)
    assert c.post("/api/auth/login", json={"gitlab_url": "https://g.test", "token": "t"}).status_code == 200
    assert c.post("/api/jira/connect", json={"token": "j"}).status_code == 200
    return c


def build(client, tag="v1.1.0", sha="d1", target="m0", merged=None):
    return client.post("/api/releases/build-tag", json={"path": PATH, "tag": tag, "source_sha": sha, "target_sha": target, "merged_sha": merged})


def preview(client, tag="v1.1.0"):
    return client.get("/api/jira/releases/7/repo-preview", params={"path": PATH, "tag": tag})


# ─── the normal case ──────────────────────────────────────────────────────────

def test_it_creates_an_mr_merges_it_then_tags(client, repo):
    result = build(client).json()
    assert (result["status"], result["tag"]) == ("done", "v1.1.0")
    assert repo.write_kinds() == [("POST", "merge_requests"), ("PUT", "merge"), ("POST", "tags")]
    assert result["tag_url"] == f"{REPO_URL}/-/tags/v1.1.0"
    assert result["pipelines_url"] == f"{REPO_URL}/-/pipelines?ref=v1.1.0"
    assert result["mr_url"] == f"{REPO_URL}/-/merge_requests/77"


def test_develop_and_its_commits_survive_the_merge(client, repo):
    build(client)
    created, merged, _ = (query for _, _, query in repo.writes)
    assert (created["source_branch"], created["target_branch"]) == ("develop", "master")
    assert (created["remove_source_branch"], created["squash"]) == ("false", "false")
    assert (merged["should_remove_source_branch"], merged["squash"]) == ("false", "false")


def test_the_merge_is_pinned_to_the_previewed_commit(client, repo):
    build(client)
    assert repo.writes[1][2]["sha"] == "d1"


def test_the_tag_goes_on_the_merge_commit_not_a_moving_branch(client, repo):
    build(client)
    tag = repo.writes[2][2]
    assert (tag["tag_name"], tag["ref"]) == ("v1.1.0", "m1")


def test_repeating_it_writes_nothing_more(client, repo):
    build(client)
    written = len(repo.writes)
    assert build(client).json()["status"] == "done"
    assert len(repo.writes) == written


# ─── when it must not write ───────────────────────────────────────────────────

def test_develop_moved_after_the_preview_writes_nothing(client, repo):
    result = build(client, sha="OLD").json()
    assert (result["status"], result["branch"]) == ("changed", "develop")
    assert repo.writes == []


def test_master_moved_after_the_preview_writes_nothing(client, repo):
    """A merge from there would carry somebody else's commits into the tag, unseen."""
    result = build(client, target="OLD").json()
    assert (result["status"], result["branch"]) == ("changed", "master")
    assert repo.writes == []


def test_with_nothing_ahead_master_moving_still_writes_nothing(client, repo):
    repo.ahead = []
    assert build(client, target="OLD").json()["status"] == "changed"
    assert repo.writes == []


@pytest.mark.parametrize("tag", ["latest", "v1;rm -rf"])
def test_a_tag_that_isnt_a_version_is_refused(client, repo, tag):
    assert build(client, tag=tag).status_code == 400
    assert preview(client, tag=tag).status_code == 400
    assert repo.writes == []


def test_an_existing_tag_writes_nothing(client, repo):
    assert build(client, tag="v1.0.0").json()["status"] == "done"
    assert repo.writes == []


def test_an_unapproved_mr_blocks_everything(client, repo):
    repo.mrs = [{"iid": 5, "state": "opened", "web_url": "u"}]
    repo.merge_statuses = ["not_approved"]
    result = build(client).json()
    assert (result["status"], result["reason"], result["mr_url"], result["merged"]) == ("blocked", "The merge request needs approval", "u", False)
    assert repo.writes == []


@pytest.mark.parametrize("status", [405, 406, 409])
def test_a_refused_merge_leaves_no_tag(client, repo, status):
    repo.merge_error = status
    result = build(client).json()
    assert result["status"] == "blocked"
    assert "merge refused" in result["reason"]
    assert ("POST", "tags") not in repo.write_kinds()


def test_a_merge_refused_with_401_isnt_a_sign_out(client, repo):
    repo.merge_error = 401
    response = build(client)
    assert response.status_code == 200
    assert response.json()["status"] == "blocked"
    assert "permission" in response.json()["reason"]


def test_failing_to_create_the_mr_is_reported(client, repo):
    repo.create_mr_error = 403
    result = build(client).json()
    assert (result["status"], result["mr_url"]) == ("blocked", None)
    assert "Could not create" in result["reason"]


def test_a_repo_with_no_target_branch_writes_nothing(client, repo):
    repo.branches = {"develop": "d1"}
    assert build(client).status_code == 404
    assert repo.writes == []


def test_a_dead_token_on_a_read_is_a_real_401(client, repo):
    repo.token_dead = True
    assert build(client).status_code == 401


# ─── carrying on ──────────────────────────────────────────────────────────────

def test_an_open_release_mr_is_reused(client, repo):
    repo.mrs = [{"iid": 5, "state": "opened", "web_url": "u"}]
    build(client)
    assert repo.write_kinds() == [("PUT", "merge"), ("POST", "tags")]


def test_it_waits_while_gitlab_checks_a_new_mr(client, repo):
    repo.merge_statuses = ["checking", "preparing", "mergeable"]
    assert build(client).json()["status"] == "done"


def test_it_gives_up_waiting_without_merging(client, repo):
    repo.merge_statuses = ["checking"] * 20
    assert build(client).json()["status"] == "blocked"
    assert not any(method == "PUT" for method, _, _ in repo.writes)


def test_a_refused_tag_says_the_merge_already_happened(client, repo):
    repo.tag_error = 403
    result = build(client).json()
    assert (result["status"], result["merged"], result["merged_sha"]) == ("blocked", True, "m1")
    assert "protected tag" in result["reason"]


def test_a_retry_tags_that_merge_even_if_master_has_moved_on(client, repo):
    """It used to tag "master", and so whatever had landed there in between."""
    repo.tag_error = 403
    merged = build(client).json()["merged_sha"]
    repo.tag_error = None
    repo.branches["master"] = "somebody-elses-commit"
    written = len(repo.writes)
    assert build(client, merged=merged).json()["status"] == "done"
    assert [method for method, _, _ in repo.writes[written:]] == ["POST"], "no second merge"
    assert repo.writes[-1][2]["ref"] == "m1"


def test_a_retry_tags_that_merge_even_if_develop_has_moved_on(client, repo):
    repo.tag_error = 403
    merged = build(client).json()["merged_sha"]
    repo.tag_error = None
    repo.branches["develop"] = "d2"
    repo.ahead = [commit("LKAG-1: later")]
    assert build(client, merged=merged).json()["status"] == "done"
    assert repo.writes[-1][2]["ref"] == "m1"
    assert [kind for kind in repo.write_kinds() if kind == ("PUT", "merge")] == [("PUT", "merge")]


def test_reopening_after_a_refused_tag_asks_again_when_master_moved(client, repo):
    """A new preview has no merge to remember, so it goes by what that preview showed."""
    repo.tag_error = 403
    build(client)
    repo.tag_error = None
    assert build(client, target="m0").json()["status"] == "changed"
    assert preview(client).json()["target_sha"] == "m1"
    assert build(client, target="m1").json()["status"] == "done"
    assert repo.writes[-1][2]["ref"] == "m1"


def test_a_merge_that_doesnt_name_its_commit_leaves_no_tag(client, repo):
    repo.merge_hides_commit = True
    result = build(client).json()
    assert (result["status"], result["merged"], result["merged_sha"]) == ("blocked", True, None)
    assert ("POST", "tags") not in repo.write_kinds()


def test_nothing_ahead_tags_the_commit_the_preview_showed(client, repo):
    repo.ahead = []
    assert build(client).json()["status"] == "done"
    assert repo.write_kinds() == [("POST", "tags")]
    assert repo.writes[0][2]["ref"] == "m0"


def test_it_falls_back_to_main_when_there_is_no_master(client, repo):
    repo.branches = {"main": "m0", "develop": "d1"}
    build(client)
    assert repo.writes[0][2]["target_branch"] == "main"


# ─── the preview ──────────────────────────────────────────────────────────────

def test_the_preview_writes_nothing_and_says_what_would_happen(client, repo):
    body = preview(client).json()
    assert repo.writes == []
    assert (body["source"], body["target"], body["source_sha"], body["target_sha"], body["ahead"]) == ("develop", "master", "d1", "m0", 1)
    assert (body["tag_exists"], body["open_mr"]) == (False, None)


def test_the_preview_sorts_commits_by_readiness(client, repo):
    repo.ahead = [commit("LKAG-1: ready"), commit("LKAG-4: done"), commit("LKAG-2 testing"), commit("LKAG-99 elsewhere"), commit("no key")]
    body = preview(client).json()
    assert body["ready"] == ["LKAG-1", "LKAG-4"]
    assert body["not_ready"] == [{"key": "LKAG-2", "status": "Тестирование"}]
    assert body["foreign"] == ["LKAG-99"]
    assert body["no_key"] == 1


def test_the_preview_lists_the_commits_going_out(client, repo):
    repo.ahead = [commit("LKAG-1: ready"), commit("no key"), commit("Merge branch 'x'", parents=("a", "b"))]
    body = preview(client).json()
    assert body["ahead"] == 3
    assert [(c["title"], c["issues"]) for c in body["commits"]] == [("LKAG-1: ready", ["LKAG-1"]), ("no key", [])]


def test_the_preview_sees_an_existing_tag_and_mr(client, repo):
    repo.tags = ["v1.1.0"]
    repo.mrs = [{"iid": 5, "state": "opened", "web_url": "u"}]
    body = preview(client).json()
    assert (body["tag_exists"], body["open_mr"]) == (True, {"iid": 5, "url": "u"})


def test_the_commands_use_the_real_target_head_and_tag(client):
    assert preview(client).json()["commands"] == ALL_COMMANDS


def test_nothing_ahead_means_no_merge_in_the_commands(client, repo):
    repo.ahead = []
    assert preview(client).json()["commands"] == [
        "git fetch origin --tags", "git checkout master", "git pull --ff-only origin master",
        "git tag v1.1.0 m0", "git push origin v1.1.0",
    ]


def test_the_commands_follow_the_target_branch(client, repo):
    repo.branches = {"main": "m0", "develop": "d1"}
    assert "git checkout main" in preview(client).json()["commands"]
