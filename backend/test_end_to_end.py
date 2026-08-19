"""The plumbing between the rules, exercised against a fake GitLab.

The unit tests decide what each rule says about one branch or one commit. This
file checks the other half: that a request turns into the right calls, that the
answers are put together the way the rules intend, and that work already ruled
out never costs a round trip.
"""
import threading

import pytest
import pytest_asyncio

import fake_gitlab
from app import gitlab, service
from app.gitlab import GL


@pytest_asyncio.fixture
async def gl(monkeypatch):
    """A GitLab client pointed at a fake on a port of its own."""
    # httpx honours HTTP_PROXY, and a developer machine behind a corporate proxy
    # would send these requests into it and get nothing back.
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        monkeypatch.delenv(var, raising=False)

    server = fake_gitlab.serve(port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    await gitlab.startup()
    try:
        yield GL(f"http://127.0.0.1:{server.server_address[1]}", "test-token")
    finally:
        await gitlab.shutdown()
        server.shutdown()
        server.server_close()


# The fake counts by normalised path — /projects/1/… and /projects/2/… both
# land under /projects/N/… — so these ask by exact key rather than substring.
def calls(path: str) -> int:
    return fake_gitlab.hits.get(path, 0)


def api_calls() -> int:
    """Everything that actually went over the wire, ignoring the tagged copies
    the fake keeps alongside for readability."""
    return sum(n for path, n in fake_gitlab.hits.items()
               if path.startswith("/api") and "[" not in path)


COMMITS      = "/api/v4/projects/N/repository/commits"
CARRIED_BY   = COMMITS + "/{}/merge_requests"


# ─── what has not been through review ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_branch_without_a_merge_request_is_found(gl):
    found = await service.unreviewed(gl, [1, 2, 3], days=90)
    assert [b["branch"] for b in found["branches"]] == ["LKAG-3210"]


@pytest.mark.asyncio
async def test_the_branches_ruled_out_are_all_the_ones_that_should_be(gl):
    """`feat` has a merge request, `landed` is already in the trunk, `ancient`
    has not moved in months, `develop` is the trunk and `master` protects it."""
    found = await service.unreviewed(gl, [1, 2, 3], days=90)
    assert {b["branch"] for b in found["branches"]}.isdisjoint(
        {"feat", "landed", "ancient", "develop", "master", "main"}
    )


@pytest.mark.asyncio
async def test_a_commit_that_reached_the_trunk_without_a_merge_request_is_found(gl):
    found = await service.unreviewed(gl, [1, 2, 3], days=90)
    assert {c["short_id"] for c in found["commits"]} == {"dir333", "rel444"}


@pytest.mark.asyncio
async def test_a_squashed_commit_is_cleared_by_asking_gitlab(gl):
    """`sqh222` has a single parent like a direct push, and only GitLab knows a
    merge request carried it — the shape of the commit cannot say."""
    found = await service.unreviewed(gl, [1, 2, 3], days=90)
    assert "sqh222" not in {c["short_id"] for c in found["commits"]}
    assert calls(CARRIED_BY.format("sqh222")) == 1


@pytest.mark.asyncio
async def test_a_commit_on_two_trunks_is_one_row_naming_both(gl):
    """`master` and `develop` share history, so the same commit turns up twice.
    It skipped review once."""
    found = await service.unreviewed(gl, [1, 2, 3], days=90)
    shared = next(c for c in found["commits"] if c["short_id"] == "dir333")
    assert sorted(shared["branches"]) == ["develop", "master"]
    assert calls(CARRIED_BY.format("dir333")) == 1


@pytest.mark.asyncio
async def test_the_repositorys_first_commit_is_never_asked_about(gl):
    """Ruled out by shape, so it costs no round trip."""
    found = await service.unreviewed(gl, [1, 2, 3], days=90)
    assert "root000" not in {c["short_id"] for c in found["commits"]}
    assert calls(CARRIED_BY.format("root000")) == 0


@pytest.mark.asyncio
async def test_a_trunk_nobody_has_touched_is_not_read(gl):
    """Project 2's `main` last moved long ago: its history inside the window is
    empty by definition, and reading it would be a round trip to learn nothing."""
    await service.unreviewed(gl, [1, 2, 3], days=14)
    # three trunks exist across the fixture — develop and master in project 1,
    # main in project 2 — and only the two live ones are read
    assert calls(COMMITS) == 2


@pytest.mark.asyncio
async def test_the_answer_is_cached_until_somebody_asks_for_it_again(gl):
    await service.unreviewed(gl, [1], days=90)
    spent = api_calls()
    await service.unreviewed(gl, [1], days=90)
    assert api_calls() == spent

    await service.unreviewed(gl, [1], days=90, refresh=True)
    assert api_calls() > spent


# ─── reading only as much of a project's merge requests as the page shows ─────

@pytest.mark.asyncio
async def test_a_page_of_merge_requests_does_not_read_the_whole_history(gl):
    """Project 1 has 120 merge requests; showing 25 of them must not fetch 120."""
    mrs, total = await service.fetch_mrs_for_projects(
        gl, [1, 2, 3], {"state": "opened"}, want=25,
    )
    assert total == 121                      # counted by GitLab, not by us
    assert len(mrs) < 121
    assert calls("/api/graphql") == 1  # one query, not one per project


@pytest.mark.asyncio
async def test_triage_still_reads_every_merge_request(gl):
    mrs, total = await service.fetch_mrs_for_projects(gl, [1, 2, 3], {"state": "opened"})
    assert len(mrs) == total == 121
