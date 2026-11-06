"""A failure must look like a failure: not an empty list, and not a dead session unless the token really is dead."""
import httpx
import pytest
from fastapi.testclient import TestClient

import main

ONE = {"project_ids": "1", "triage": 1}
TWO = {"project_ids": "1,2", "triage": 1}


def merge_request(iid, project=1):
    return {"id": iid, "iid": iid, "project_id": project, "title": f"t{iid}", "state": "opened",
            "updated_at": f"2026-01-0{iid}T00:00:00Z", "author": {"id": 5}}


def failure(status, message="x"):
    return httpx.Response(status, json={"message": message})


class FakeGitLab:
    def __init__(self):
        self.approved = False
        self.first_project = "ok"
        self.second_project = "ok"
        self.global_list = "ok"
        self.approvals = "ok"
        self.todos = "ok"
        self.approve_status = 201

    def __call__(self, req):
        path = req.url.path.removeprefix("/api/v4")
        if path == "/user":
            return httpx.Response(200, json={"id": 1, "name": "n", "username": "u"})
        if req.method == "POST" and path.endswith("/approve"):
            if self.approve_status >= 400:
                return failure(self.approve_status, "nope")
            self.approved = True
            return httpx.Response(201, json={})
        if req.method == "POST" and path.endswith("/unapprove"):
            self.approved = False
            return httpx.Response(201, json={})
        if path == "/projects/1/merge_requests":
            return httpx.Response(200, json=[merge_request(1)]) if self.first_project == "ok" else failure(self.first_project)
        if path == "/projects/2/merge_requests":
            return httpx.Response(200, json=[merge_request(2, 2)]) if self.second_project == "ok" else failure(self.second_project, "404 Project Not Found")
        if path == "/merge_requests":
            if self.global_list != "ok" and req.url.params.get("scope") == "assigned_to_me":
                return failure(self.global_list)
            return httpx.Response(200, json=[merge_request(1)])
        if path.endswith("/approvals"):
            if self.approvals != "ok":
                return failure(self.approvals, "rate limited")
            return httpx.Response(200, json={"approved_by": [{"user": {"id": 1}}] if self.approved else []})
        if path == "/todos":
            if self.todos != "ok":
                return httpx.Response(self.todos, headers={"content-type": "text/html"}, text="<html>" + "x" * 5000)
            return httpx.Response(200, json=[])
        if path.endswith("/pipelines"):
            return failure(500)
        if path.endswith("/discussions"):
            return httpx.Response(200, json=[])
        return failure(404, f"nf {path}")  # including /api/graphql: these go down the REST path


@pytest.fixture
def gitlab(use_handler):
    fake = FakeGitLab()
    use_handler(fake)
    return fake


@pytest.fixture
def client(gitlab):
    c = TestClient(main.app, raise_server_exceptions=False)
    assert c.post("/api/auth/login", json={"gitlab_url": "https://g.test", "token": "tok"}).status_code == 200
    return c


# ─── the merge request list ───────────────────────────────────────────────────

def test_a_healthy_list_has_no_warnings(client):
    assert client.get("/api/merge-requests", params=ONE).json()["warnings"] == []


def test_a_dead_token_is_a_401_not_an_empty_list(client, gitlab):
    gitlab.first_project = gitlab.second_project = 401
    assert client.get("/api/merge-requests", params=TWO).status_code == 401


def test_a_401_from_one_project_means_the_token_is_dead(client, gitlab):
    gitlab.first_project = 401
    assert client.get("/api/merge-requests", params=TWO).status_code == 401


def test_when_the_only_project_fails_it_is_an_error(client, gitlab):
    gitlab.first_project = 500
    assert client.get("/api/merge-requests", params=ONE).status_code == 500


def test_one_project_failing_keeps_the_others_and_says_so(client, gitlab):
    gitlab.second_project = 404
    response = client.get("/api/merge-requests", params=TWO)
    body = response.json()
    assert response.status_code == 200
    assert [mr["id"] for mr in body["items"]] == [1]
    assert len(body["warnings"]) == 1


def test_one_targeted_query_failing_keeps_the_others_and_says_so(client, gitlab):
    gitlab.global_list = 500
    body = client.get("/api/merge-requests", params={"triage": 1}).json()
    assert len(body["items"]) == 1
    assert len(body["warnings"]) == 1


def test_browse_pages_through_several_projects(client):
    body = client.get("/api/merge-requests", params={"project_ids": "1,2", "page": 2, "per_page": 1}).json()
    assert (body["total"], body["total_pages"], body["page"], len(body["items"])) == (2, 2, 2, 1)


# ─── approvals ────────────────────────────────────────────────────────────────

def test_approvals_that_cant_be_read_are_unknown_not_empty(client, gitlab):
    gitlab.approvals = 429
    body = client.get("/api/merge-requests", params=ONE).json()
    assert body["items"][0]["approved_by_users"] is None
    assert len(body["warnings"]) == 1


def test_a_401_on_approvals_means_the_token_is_dead(client, gitlab):
    gitlab.approvals = 401
    assert client.get("/api/merge-requests", params=ONE).status_code == 401


def test_approving_shows_at_once_instead_of_a_minute_later(client):
    approvers = lambda: client.get("/api/merge-requests", params=ONE).json()["items"][0]["approved_by_users"]
    assert approvers() == []
    assert client.post("/api/merge-requests/1/1/approve").status_code == 200
    assert len(approvers()) == 1
    assert client.post("/api/merge-requests/1/1/unapprove").status_code == 200
    assert approvers() == []


def test_a_token_without_write_access_gets_the_403(client, gitlab):
    gitlab.approve_status = 403
    assert client.post("/api/merge-requests/1/1/approve").status_code == 403


def test_gitlab_saying_401_to_an_approval_isnt_a_dead_session(client, gitlab):
    """It answers that for "already approved" and "not allowed", with a valid token."""
    gitlab.approve_status = 401
    response = client.post("/api/merge-requests/1/1/approve")
    assert response.status_code == 409
    assert "refused" in response.json()["detail"]


# ─── errors and per-MR batches ────────────────────────────────────────────────

def test_an_html_error_page_isnt_passed_on(client, gitlab):
    gitlab.todos = 502
    response = client.get("/api/todos")
    assert (response.status_code, response.json()["detail"]) == (502, "GitLab returned 502")


def test_a_failed_item_in_a_batch_is_left_out(client):
    response = client.post("/api/merge-requests/pipelines-batch", json=[{"project_id": 1, "iid": 1}])
    assert (response.status_code, response.json()) == (200, {})


def test_batches_cope_with_nothing_to_do(client):
    assert client.post("/api/merge-requests/discussion-stats-batch", json=[]).json() == {}
    assert client.post("/api/merge-requests/activities", json=[{"project_id": 1, "iid": 1}]).json() == {}


# ─── accounts ─────────────────────────────────────────────────────────────────

def test_a_mistyped_token_in_the_form_isnt_a_dead_session(client, use_handler, gitlab):
    def rejects_new_token(req):
        return failure(401, "401 Unauthorized") if req.url.path.endswith("/user") else gitlab(req)

    use_handler(rejects_new_token)
    assert client.post("/api/auth/login", json={"gitlab_url": "https://g.test", "token": "typo"}).status_code == 400
    assert len(client.get("/api/auth/profiles").json()["profiles"]) == 1


def test_removing_the_active_account_activates_the_other(gitlab):
    c = TestClient(main.app, raise_server_exceptions=False)
    for token in ("a", "b"):
        c.post("/api/auth/login", json={"gitlab_url": "https://g.test", "token": token})
    profiles = c.get("/api/auth/profiles").json()
    first, second = (p["id"] for p in profiles["profiles"])
    assert profiles["activeId"] == second
    c.delete(f"/api/auth/profiles/{second}")
    profiles = c.get("/api/auth/profiles").json()
    assert [p["id"] for p in profiles["profiles"]] == [first]
    assert profiles["activeId"] == first
