"""Projects no issue in the release points at, with work waiting since their last tag."""
import httpx
import pytest
from fastapi.testclient import TestClient

import main

SELLER = "grp/lk-seller"


def commit(title, parents=("p",), message=None):
    return {"id": title.ljust(40, "0"), "short_id": title[:8], "title": title, "message": message or title,
            "author_name": "Dana", "web_url": f"https://g.test/c/{title}", "parent_ids": list(parents)}


class FakeGitLab:
    def __init__(self):
        self.repos = {}
        self.calls = []
        self.read_failure = None

    def add(self, path, tags=(), commits=(), branches=("develop", "master"), languages=None):
        self.repos[path] = {"tags": list(tags), "commits": list(commits), "branches": branches, "languages": languages or {"Python": 90}}

    def __call__(self, req):
        raw = req.url.raw_path.decode().split("?")[0].removeprefix("/api/v4")
        self.calls.append((req.method, raw))
        if raw == "/user":
            return httpx.Response(200, json={"id": 1, "name": "n", "username": "u"})
        assert req.method == "GET", "this only reads"
        if self.read_failure:
            return httpx.Response(self.read_failure, json={"message": "boom"})
        parts = raw.split("/")
        repo = self.repos.get(parts[2].replace("%2F", "/"))
        if repo is None:
            return httpx.Response(404, json={"message": "404 Project Not Found"})
        tail = "/".join(parts[3:])
        if tail.startswith("repository/branches/"):
            return httpx.Response(200, json={}) if parts[-1] in repo["branches"] else httpx.Response(404, json={"message": "404 Branch Not Found"})
        if tail == "repository/tags":
            return httpx.Response(200, headers={"X-Next-Page": ""}, json=[{"name": t} for t in repo["tags"]])
        if tail == "repository/commits":
            assert req.url.params["ref_name"].endswith("..develop")
            self.range = req.url.params["ref_name"]
            return httpx.Response(200, headers={"X-Next-Page": ""}, json=repo["commits"])
        if tail == "languages":
            return httpx.Response(200, json=repo["languages"])
        return httpx.Response(500, text=f"unexpected {raw}")


@pytest.fixture
def gitlab(use_handler):
    fake = FakeGitLab()
    use_handler(fake)
    return fake


@pytest.fixture
def client(gitlab):
    c = TestClient(main.app, raise_server_exceptions=False)
    assert c.post("/api/auth/login", json={"gitlab_url": "https://g.test", "token": "t"}).status_code == 200
    return c


def check(client, *paths):
    return client.get("/api/releases/unplanned", params={"path": list(paths)})


def test_a_project_with_work_since_its_last_tag_is_offered_as_a_ready_plan_row(client, gitlab):
    gitlab.add(SELLER, tags=["v1.7.0", "v1.6.0", "build-9"], commits=[commit("LKAG-1: a"), commit("no key"), commit("LKAG-2: b")])
    body = check(client, SELLER).json()
    assert body["unchecked"] == []
    row = body["repos"][0]
    assert (row["state"], row["latest_tag"], row["rollback_tag"], row["deploy_tag"]) == ("new_tag", "v1.7.0", "v1.7.0", "v1.8.0")
    assert (row["path"], row["name"], row["group"]) == (SELLER, "lk-seller", "backend")
    assert row["issues"] == ["LKAG-1", "LKAG-2"]
    assert row["no_key"] == 1
    assert [c["title"] for c in row["commits"]] == ["LKAG-1: a", "no key", "LKAG-2: b"]
    assert row["compare_url"] == f"https://g.test/{SELLER}/-/compare/v1.7.0...develop"
    assert (row["warnings"], row["unmerged"], row["error"]) == ([], [], None)
    assert gitlab.range == "v1.7.0..develop"


def test_it_only_reads(client, gitlab):
    gitlab.add(SELLER, tags=["v1.0.0"], commits=[commit("a")])
    check(client, SELLER)
    assert all(method == "GET" for method, path in gitlab.calls if path != "/user")


def test_a_project_with_nothing_new_isnt_offered(client, gitlab):
    gitlab.add(SELLER, tags=["v1.0.0"], commits=[])
    assert check(client, SELLER).json() == {"repos": [], "unchecked": []}


def test_merge_commits_alone_arent_work(client, gitlab):
    """master merged back into develop after a release looks like this."""
    gitlab.add(SELLER, tags=["v1.0.0"], commits=[commit("Merge branch 'master' into 'develop'", parents=("a", "b"))])
    assert check(client, SELLER).json() == {"repos": [], "unchecked": []}


def test_a_project_without_develop_isnt_released_this_way(client, gitlab):
    """lk-utils goes out on its own, from master."""
    gitlab.add("grp/lk-packages/lk-utils", tags=["v1.0.0"], commits=[commit("a")], branches=("master",))
    assert check(client, "grp/lk-packages/lk-utils").json() == {"repos": [], "unchecked": []}


def test_a_project_without_develop_costs_one_call(client, gitlab):
    gitlab.add("grp/lk-utils", branches=("master",))
    before = len(gitlab.calls)
    check(client, "grp/lk-utils")
    assert len(gitlab.calls) - before == 1


def test_a_project_with_no_version_tags_is_named_as_unchecked(client, gitlab):
    gitlab.add(SELLER, tags=["build-1"], commits=[commit("a")])
    assert check(client, SELLER).json() == {"repos": [], "unchecked": [{"name": "lk-seller", "reason": "no vX.Y.Z tags to compare with"}]}


def test_a_project_that_cant_be_read_is_named_without_hiding_the_others(client, gitlab):
    gitlab.add(SELLER, tags=["v1.0.0"], commits=[commit("a")])
    gitlab.add("grp/lk-sick", tags=["v1.0.0"])
    real = gitlab.__call__

    def failing(req):
        return httpx.Response(500, json={"message": "boom"}) if "lk-sick" in str(req.url) else real(req)

    from app import gitlab as client_module
    client_module._http = httpx.AsyncClient(transport=httpx.MockTransport(failing))
    body = check(client, SELLER, "grp/lk-sick").json()
    assert [r["name"] for r in body["repos"]] == ["lk-seller"]
    assert [u["name"] for u in body["unchecked"]] == ["lk-sick"]


def test_a_dead_token_is_a_401(client, gitlab):
    gitlab.add(SELLER, tags=["v1.0.0"])
    gitlab.read_failure = 401
    assert check(client, SELLER).status_code == 401


def test_another_trackers_keys_dont_count_as_issues(client, gitlab):
    gitlab.add(SELLER, tags=["v1.0.0"], commits=[commit("RESECT-5 other tracker")])
    row = check(client, SELLER).json()["repos"][0]
    assert (row["issues"], row["no_key"]) == ([], 1)


def test_a_frontend_project_lands_in_the_frontend_section(client, gitlab):
    gitlab.add("grp/consent-ui", tags=["v1.0.0"], commits=[commit("a")], languages={"Shell": 100})
    assert check(client, "grp/consent-ui").json()["repos"][0]["group"] == "frontend"


def test_a_missing_tag_isnt_logged_as_a_problem(client, gitlab, caplog):
    gitlab.add("grp/lk-utils", branches=("master",))
    with caplog.at_level("WARNING", logger="dashboard"):
        check(client, "grp/lk-utils")
    assert "404" not in caplog.text
