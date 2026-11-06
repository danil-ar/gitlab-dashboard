"""A read that failed or stopped early must not look like a complete answer, least of all from a cache."""
import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from app import service
from app.gitlab import GL

NOW = "2026-06-01T00:00:00Z"


def thread(number):
    note = {"id": number, "resolvable": True, "resolved": False, "body": "b", "author": {"name": "a"}, "created_at": NOW, "system": False}
    return {"id": f"d{number}", "individual_note": False, "notes": [note]}


def paged(req, items):
    page = int(req.url.params.get("page", "1"))
    pages = max(1, -(-len(items) // 100))
    return httpx.Response(200, headers={"X-Total-Pages": str(pages)}, json=items[(page - 1) * 100:page * 100])


class FakeGitLab:
    def __init__(self):
        self.threads = []
        self.todos = []
        self.commits = []
        self.threads_fail = None
        self.commits_fail = None
        self.calls = []

    def __call__(self, req):
        path = req.url.path.removeprefix("/api/v4")
        self.calls.append(path)
        if path == "/user":
            return httpx.Response(200, json={"id": 1, "name": "n", "username": "u"})
        if path.endswith("/discussions"):
            return httpx.Response(self.threads_fail, text="bad") if self.threads_fail else paged(req, self.threads)
        if path.endswith("/commits"):
            return httpx.Response(self.commits_fail, text="bad") if self.commits_fail else httpx.Response(200, json=self.commits)
        if path.endswith("/notes"):
            note = {"system": True, "author": {"id": 1}, "body": "approved this merge request", "created_at": "2026-01-01T00:00:00Z"}
            return httpx.Response(200, headers={"X-Total-Pages": "1"}, json=[note])
        if path == "/todos":
            return paged(req, self.todos)
        return httpx.Response(404, json={"message": "404"})


@pytest.fixture
def fake(use_handler):
    gitlab = FakeGitLab()
    use_handler(gitlab)
    return gitlab


@pytest.fixture
def client(fake):
    c = TestClient(main.app, raise_server_exceptions=False)
    assert c.post("/api/auth/login", json={"gitlab_url": "https://g.test", "token": "t"}).status_code == 200
    return c


def activity(updated_at="u1"):
    return asyncio.run(service.activities_after_approval(GL("https://g.test", "t"), 1, 1, 1, updated_at))


NEW_COMMIT = {"id": "c", "short_id": "c", "title": "new", "committed_date": NOW, "message": "new"}


# ─── threads ──────────────────────────────────────────────────────────────────

def test_threads_past_the_first_page_are_counted(client, fake):
    """They come oldest first, so what used to be cut off was the newest."""
    fake.threads = [thread(i) for i in range(120)]
    stats = client.get("/api/projects/1/merge_requests/1/discussion-stats").json()
    assert stats["total"] == 120
    assert sum(path.endswith("/discussions") for path in fake.calls) == 2


def test_threads_that_cant_be_read_are_an_error_not_zero_threads(client, fake):
    """As zero, it overwrote the counters in the list and showed a dash."""
    fake.threads_fail = 502
    response = client.get("/api/projects/1/merge_requests/1/discussion-stats")
    assert response.status_code == 502
    assert "threads" in response.json()["detail"]


def test_a_failed_thread_read_isnt_cached(client, fake):
    fake.threads_fail = 502
    client.get("/api/projects/1/merge_requests/1/discussion-stats")
    fake.threads_fail = None
    fake.threads = [thread(1)]
    assert client.get("/api/projects/1/merge_requests/1/discussion-stats").json()["total"] == 1


def test_a_401_on_threads_means_the_token_is_dead(client, fake):
    fake.threads_fail = 401
    assert client.get("/api/projects/1/merge_requests/1/discussion-stats").status_code == 401


def test_a_batch_leaves_out_threads_it_couldnt_read(client, fake):
    fake.threads_fail = 500
    response = client.post("/api/merge-requests/discussion-stats-batch", json=[{"project_id": 1, "iid": 1}])
    assert (response.status_code, response.json()) == (200, {})


def test_html_with_status_200_isnt_taken_for_threads(client, use_handler, fake):
    def proxy_page(req):
        if req.url.path.endswith("/discussions"):
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<html>proxy</html>")
        return fake(req)

    use_handler(proxy_page)
    assert client.get("/api/projects/1/merge_requests/1/discussion-stats").status_code == 502


# ─── activity after an approval ───────────────────────────────────────────────

def test_an_outage_isnt_remembered_as_no_activity(fake):
    """This cache only ends when the MR changes, so one bad moment hid new commits for 15 minutes."""
    fake.commits_fail = 502
    fake.threads_fail = 502
    assert activity() is None
    fake.commits_fail = fake.threads_fail = None
    fake.commits = [NEW_COMMIT]
    assert [c["title"] for c in activity()["commits"]] == ["new"]


def test_half_an_answer_is_shown_but_not_remembered(fake):
    fake.commits_fail = 502
    fake.threads = [thread(1)]
    assert activity()["commits"] == []
    fake.commits_fail = None
    fake.commits = [NEW_COMMIT]
    assert len(activity()["commits"]) == 1


def test_a_complete_answer_is_remembered(fake):
    fake.commits = [NEW_COMMIT]
    activity()
    reads = fake.calls.count("/projects/1/merge_requests/1/commits")
    activity()
    assert fake.calls.count("/projects/1/merge_requests/1/commits") == reads


def test_a_complete_no_is_remembered_too(fake):
    assert activity() is None
    reads = len(fake.calls)
    assert activity() is None
    assert len(fake.calls) == reads


# ─── to-dos ───────────────────────────────────────────────────────────────────

def todo(number, action="assigned"):
    return {"id": number, "action_name": action, "target_type": "MergeRequest", "target": {"id": number}}


def test_todos_past_the_first_page_are_returned(client, fake):
    fake.todos = [todo(i) for i in range(130)]
    assert len(client.get("/api/todos", params={"state": "pending", "per_page": 100}).json()) == 130


def test_mentions_past_the_first_page_of_todos_are_found(fake):
    fake.todos = [todo(i) for i in range(120)] + [todo(500, "mentioned")]
    mentions = asyncio.run(service.mentioned_merge_requests(GL("https://g.test", "t")))
    assert [mr["id"] for mr in mentions] == [500]
