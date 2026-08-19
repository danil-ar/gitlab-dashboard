"""Tests for the GraphQL → REST-shape mapper.

The fixture mirrors what GitLab 18.4.3 actually returned for this query —
including the quirks that make the mapping necessary: global ids, a string
`iid`, SCREAMING pipeline statuses and relative avatar paths.
"""
import pytest

from app import graphql

BASE = "https://gitlab.example.com"

PAYLOAD = {
    "data": {
        "projects": {
            "nodes": [
                {
                    "id": "gid://gitlab/Project/1515",
                    "fullPath": "team/backend",
                    "mergeRequests": {
                        "nodes": [
                            {
                                "id": "gid://gitlab/MergeRequest/99001",
                                "iid": "354",
                                "title": "Refactor products",
                                "state": "opened",
                                "draft": False,
                                "conflicts": False,
                                "webUrl": f"{BASE}/team/backend/-/merge_requests/354",
                                "createdAt": "2026-08-16T08:00:00Z",
                                "updatedAt": "2026-08-17T08:18:59Z",
                                "sourceBranch": "LKAG-2755",
                                "targetBranch": "develop",
                                "reference": "team/backend!354",
                                "detailedMergeStatus": "DISCUSSIONS_NOT_RESOLVED",
                                "author": {
                                    "id": "gid://gitlab/User/500", "name": "Author One",
                                    "username": "author.one",
                                    "avatarUrl": "/uploads/-/system/user/avatar/500/avatar.png",
                                },
                                "assignees": {"nodes": []},
                                "reviewers": {"nodes": [
                                    {"id": "gid://gitlab/User/827", "name": "Rev Iewer",
                                     "username": "rev.iewer", "avatarUrl": None},
                                ]},
                                "approvedBy": {"nodes": []},
                                "labels": {"nodes": [{"title": "needs-refactoring"}]},
                                "pipelines": {"nodes": [
                                    {"id": "gid://gitlab/Ci::Pipeline/7001", "status": "SUCCESS",
                                     "source": "push", "path": "/team/backend/-/pipelines/7001"},
                                ]},
                                "diffStatsSummary": {"additions": 1703, "deletions": 991, "fileCount": 43},
                            },
                            {
                                "id": "gid://gitlab/MergeRequest/99002",
                                "iid": "187",
                                "title": "Update the build runner",
                                "state": "opened",
                                "draft": False,
                                "conflicts": False,
                                "webUrl": f"{BASE}/team/backend/-/merge_requests/187",
                                "createdAt": "2026-06-29T10:00:00Z",
                                "updatedAt": "2026-06-30T12:32:40Z",
                                "sourceBranch": "devops/update-runner",
                                "targetBranch": "develop",
                                "reference": "team/backend!187",
                                "detailedMergeStatus": "UNCHECKED",
                                "author": {"id": "gid://gitlab/User/501", "name": "Author Two",
                                           "username": "author.two", "avatarUrl": None},
                                "assignees": {"nodes": []},
                                "reviewers": {"nodes": []},
                                "approvedBy": {"nodes": [
                                    {"id": "gid://gitlab/User/314", "name": "Me Myself",
                                     "username": "me.myself",
                                     "avatarUrl": f"{BASE}/uploads/avatar.png"},
                                ]},
                                "labels": {"nodes": []},
                                "pipelines": {"nodes": [
                                    {"id": "gid://gitlab/Ci::Pipeline/7002", "status": "MANUAL",
                                     "source": "push", "path": "/team/backend/-/pipelines/7002"},
                                ]},
                                "diffStatsSummary": {"additions": 1, "deletions": 1, "fileCount": 1},
                            },
                        ]
                    },
                }
            ]
        }
    }
}


def mapped():
    return graphql.map_response(PAYLOAD, BASE)


# ─── the quirks that forced a mapper ──────────────────────────────────────────

def test_global_ids_become_plain_numbers():
    """The frontend compares approver ids against the numeric id from /api/me."""
    assert graphql.gid_int("gid://gitlab/User/314") == 314
    assert graphql.gid_int("gid://gitlab/Ci::Pipeline/7001") == 7001
    assert graphql.gid_int(None) is None
    assert graphql.gid_int(42) == 42


def test_iid_becomes_an_integer():
    """GraphQL returns iid as a string; every URL the app builds expects a number."""
    assert [mr["iid"] for mr in mapped()] == [354, 187]


def test_pipeline_status_is_lowercased():
    """constants.js keys the status colours off lowercase names."""
    assert [mr["pipeline"]["status"] for mr in mapped()] == ["success", "manual"]


def test_relative_avatar_paths_are_absolutised():
    first = mapped()[0]
    assert first["author"]["avatar_url"] == f"{BASE}/uploads/-/system/user/avatar/500/avatar.png"


def test_absolute_avatar_urls_are_left_alone():
    approver = mapped()[1]["approved_by_users"][0]
    assert approver["avatar_url"] == f"{BASE}/uploads/avatar.png"


def test_missing_avatar_stays_none():
    assert mapped()[1]["author"]["avatar_url"] is None


def test_pipeline_path_becomes_an_absolute_web_url():
    assert mapped()[0]["pipeline"]["web_url"] == f"{BASE}/team/backend/-/pipelines/7001"


# ─── the shape the rest of the app already speaks ─────────────────────────────

def test_project_id_comes_from_the_enclosing_project():
    assert {mr["project_id"] for mr in mapped()} == {1515}


def test_rest_field_names_are_preserved():
    mr = mapped()[0]
    assert mr["has_conflicts"] is False
    assert mr["source_branch"] == "LKAG-2755"
    assert mr["target_branch"] == "develop"
    assert mr["references"]["full"] == "team/backend!354"
    assert mr["state"] == "opened"
    assert mr["labels"] == ["needs-refactoring"]


def test_approvers_arrive_without_a_second_call():
    """This is the whole point: REST needed one extra request per MR for these."""
    assert [u["username"] for u in mapped()[1]["approved_by_users"]] == ["me.myself"]
    assert mapped()[0]["approved_by_users"] == []


def test_reviewers_are_carried_through():
    assert [u["username"] for u in mapped()[0]["reviewers"]] == ["rev.iewer"]


# ─── signals REST did not give us cheaply ─────────────────────────────────────

def test_merge_status_and_diff_size_are_exposed():
    mr = mapped()[0]
    assert mr["detailed_merge_status"] == "DISCUSSIONS_NOT_RESOLVED"
    assert mr["diff_stats"] == {"additions": 1703, "deletions": 991, "files": 43}


# ─── defensive mapping ────────────────────────────────────────────────────────

def test_missing_pipeline_maps_to_none():
    payload = {"data": {"projects": {"nodes": [{"id": "gid://gitlab/Project/1", "mergeRequests": {"nodes": [
        {"id": "gid://gitlab/MergeRequest/1", "iid": "1", "pipelines": {"nodes": []}},
    ]}}]}}}
    assert graphql.map_response(payload, BASE)[0]["pipeline"] is None


# ─── which pipeline gets shown ────────────────────────────────────────────────

def test_branch_pipeline_wins_over_the_detached_mr_pipeline():
    """Real data from lk-portfolio!7. The head pipeline is a MANUAL gate on
    `merge_request_event`; the FAILED branch pipeline beside it is the one a
    reviewer needs to see. Picking the head pipeline hid broken builds."""
    nodes = [
        {"id": "gid://gitlab/Ci::Pipeline/673004", "status": "MANUAL",
         "source": "merge_request_event", "path": "/p/-/pipelines/673004"},
        {"id": "gid://gitlab/Ci::Pipeline/673002", "status": "FAILED",
         "source": "push", "path": "/p/-/pipelines/673002"},
    ]
    assert graphql.pick_pipeline(nodes)["status"] == "FAILED"


def test_detached_pipeline_is_used_when_it_is_the_only_one():
    nodes = [{"id": "gid://gitlab/Ci::Pipeline/1", "status": "MANUAL",
              "source": "merge_request_event", "path": "/p/-/pipelines/1"}]
    assert graphql.pick_pipeline(nodes)["status"] == "MANUAL"


def test_newest_branch_pipeline_wins():
    nodes = [  # GitLab returns these newest-first
        {"id": "gid://gitlab/Ci::Pipeline/3", "status": "SUCCESS", "source": "push", "path": "/p/3"},
        {"id": "gid://gitlab/Ci::Pipeline/2", "status": "FAILED", "source": "push", "path": "/p/2"},
    ]
    assert graphql.pick_pipeline(nodes)["id"].endswith("/3")


def test_no_pipelines_at_all():
    assert graphql.pick_pipeline([]) is None
    assert graphql.pick_pipeline(None) is None


# Real pipelines from lk-backend!172: three branch builds where the newest is
# green and an older one is red. Both APIs return this exact set, so the choice
# here is what decides whether the row reads "passed" or "failed".
LKAG_1377 = [
    {"id": "gid://gitlab/Ci::Pipeline/587950", "status": "FAILED",
     "source": "push", "createdAt": "2026-01-24T14:44:37Z"},
    {"id": "gid://gitlab/Ci::Pipeline/587951", "status": "SUCCESS",
     "source": "push", "createdAt": "2026-01-24T15:15:42Z"},
    {"id": "gid://gitlab/Ci::Pipeline/588543", "status": "SUCCESS",
     "source": "push", "createdAt": "2026-01-26T08:34:15Z"},
]


def test_newest_build_wins_regardless_of_the_order_graphql_returns():
    """GraphQL connections promise no ordering, so the answer must not depend on
    it: an old red build must never mask a newer green one."""
    oldest_first = LKAG_1377
    newest_first = list(reversed(LKAG_1377))
    shuffled     = [LKAG_1377[1], LKAG_1377[2], LKAG_1377[0]]
    for order in (oldest_first, newest_first, shuffled):
        assert graphql.pick_pipeline(order)["id"].endswith("/588543")
        assert graphql.pick_pipeline(order)["status"] == "SUCCESS"


# ─── not losing MRs past the first page ───────────────────────────────────────

def _with_page_info(has_next, cursor="cur1"):
    return {"data": {"projects": {"nodes": [{
        "id": "gid://gitlab/Project/1515",
        "mergeRequests": {"pageInfo": {"hasNextPage": has_next, "endCursor": cursor}, "nodes": []},
    }]}}}


def test_a_truncated_project_is_reported_with_its_cursor():
    assert graphql.truncated_projects(_with_page_info(True)) == [(1515, "cur1")]


def test_a_complete_project_is_not_reported():
    assert graphql.truncated_projects(_with_page_info(False)) == []


def test_missing_cursor_is_not_treated_as_more_pages():
    """Without a cursor there is nothing to resume from; looping would spin."""
    assert graphql.truncated_projects(_with_page_info(True, cursor=None)) == []


def test_payload_without_page_info_is_not_truncated():
    assert graphql.truncated_projects(PAYLOAD) == []


# ─── fitting inside the instance's complexity budget ──────────────────────────

def test_query_sizes_shrink_from_the_configured_one():
    assert graphql._profiles(5, 50) == [(5, 50), (2, 50), (1, 50), (1, 25), (1, 10)]


def test_query_sizes_never_repeat_a_size():
    """batch=1 already: the halving steps collapse into one another."""
    sizes = graphql._profiles(1, 10)
    assert sizes == [(1, 10)]
    assert len(sizes) == len(set(sizes))


def test_query_sizes_stay_useful_at_the_bottom():
    """Even the smallest profile must ask for enough MRs to be worth a query."""
    assert all(first >= 10 and batch >= 1 for batch, first in graphql._profiles(5, 50))


def test_ordering_falls_back_to_id_when_timestamps_are_missing():
    nodes = [
        {"id": "gid://gitlab/Ci::Pipeline/10", "status": "FAILED", "source": "push"},
        {"id": "gid://gitlab/Ci::Pipeline/20", "status": "SUCCESS", "source": "push"},
    ]
    assert graphql.pick_pipeline(nodes)["status"] == "SUCCESS"


def test_empty_payload_maps_to_empty_list():
    assert graphql.map_response({"data": {"projects": {"nodes": []}}}, BASE) == []
    assert graphql.map_response({}, BASE) == []


# ─── reading only as much as the view can display ─────────────────────────────
#
# Browse shows 25 MRs at a time across several projects. The newest 25 overall
# can only come from the newest 25 of each project, so that is all it may read —
# draining a project's whole merged history to render one page is what made the
# Merged tab take 21 seconds.


class FakeGL:
    """Records every query instead of sending it, and answers from a fixture of
    `{project_id: how many MRs that project has}`."""

    url = BASE

    def __init__(self, sizes: dict[int, int]):
        self.sizes = sizes
        self.calls: list[dict] = []

    def payload(self, variables: dict) -> dict:
        first  = variables["first"]
        start  = int(variables.get("after") or 0)
        wanted = [int(i.rsplit("/", 1)[1]) for i in variables["ids"]]
        return {"data": {"projects": {"nodes": [
            {
                "id": f"gid://gitlab/Project/{pid}",
                "fullPath": f"team/p{pid}",
                "mergeRequests": {
                    "count": self.sizes[pid],
                    "pageInfo": {"hasNextPage": start + first < self.sizes[pid],
                                 "endCursor": str(start + first)},
                    "nodes": [
                        {"id": f"gid://gitlab/MergeRequest/{pid * 10_000 + i}", "iid": str(i)}
                        for i in range(start, min(start + first, self.sizes[pid]))
                    ],
                },
            }
            for pid in wanted
        ]}}}


@pytest.fixture
def gl(monkeypatch):
    """One busy project with a long history beside two quiet ones."""
    fake = FakeGL({1: 300, 2: 4, 3: 0})

    async def _query(gl_, variables, document=graphql.MR_QUERY):
        gl_.calls.append(variables)
        return gl_.payload(variables)

    monkeypatch.setattr(graphql, "_query", _query)
    return fake


def pages_read(gl) -> list[tuple[int, str]]:
    """(first, cursor-or-'') per query, in the order they were issued."""
    return [(c["first"], c.get("after") or "") for c in gl.calls]


@pytest.mark.asyncio
async def test_the_total_comes_from_the_server_not_from_counting_rows(gl):
    """304 MRs matched; the request must not download 304 to say so."""
    mrs, total = await graphql.fetch_mrs(gl, [1, 2, 3], "merged", first=50, batch=5, want=25)
    assert total == 304
    assert len(mrs) < 304


@pytest.mark.asyncio
async def test_the_first_page_costs_exactly_one_query(gl):
    """25 rows wanted, so 25 asked for, so nothing left to drain."""
    mrs, _ = await graphql.fetch_mrs(gl, [1, 2, 3], "merged", first=50, batch=5, want=25)
    assert pages_read(gl) == [(25, "")]
    assert len(mrs) == 25 + 4  # every project's newest 25, capped by what it has


@pytest.mark.asyncio
async def test_a_deep_page_drains_only_far_enough_to_cover_it(gl):
    """Page 3 of 25 needs the newest 75 per project — not the other 225."""
    mrs, _ = await graphql.fetch_mrs(gl, [1, 2, 3], "merged", first=50, batch=5, want=75)
    assert pages_read(gl) == [(50, ""), (50, "50")]
    assert len(mrs) >= 75  # enough to slice page 3 out of
    assert len(mrs) < 300


@pytest.mark.asyncio
async def test_triage_still_reads_everything(gl):
    """`want=None` is the caller saying it groups every open MR, so truncating
    it is the data loss this pagination existed to fix."""
    mrs, total = await graphql.fetch_mrs(gl, [1, 2, 3], "merged", first=50, batch=5, want=None)
    assert total == 304
    assert len(mrs) == 304


@pytest.mark.asyncio
async def test_a_page_deeper_than_the_drain_limit_is_still_correct(monkeypatch):
    """MAX_PAGES brakes an open-ended read; a page that names its target must not
    be silently served the wrong rows because of it. Reaching this far means the
    user paged that deep by hand, and the cost is theirs to spend."""
    fake = FakeGL({1: 1000})

    async def _query(gl_, variables, document=graphql.MR_QUERY):
        gl_.calls.append(variables)
        return gl_.payload(variables)

    monkeypatch.setattr(graphql, "_query", _query)

    want = (graphql.MAX_PAGES + 3) * 50           # past what MAX_PAGES alone reaches
    mrs, _ = await graphql.fetch_mrs(fake, [1], "merged", first=50, batch=5, want=want)
    assert len(mrs) >= want
    assert len(mrs) < 1000                        # and no further than that


@pytest.mark.asyncio
async def test_a_capped_read_is_not_remembered_as_a_proven_query_size(gl):
    """It was accepted asking for 25, which says nothing about 50 — recording it
    would send the next full-size read into a needless complexity search."""
    remembered = []
    await graphql.fetch_mrs(gl, [1, 2, 3], "merged", first=50, batch=5, want=25,
                            remember=remembered.append)
    assert remembered == []

    await graphql.fetch_mrs(gl, [1, 2, 3], "merged", first=50, batch=5, want=None,
                            remember=remembered.append)
    assert remembered == [(5, 50)]


def test_total_count_tolerates_a_payload_without_counts():
    assert graphql.total_count(PAYLOAD) == 0
    assert graphql.total_count({}) == 0


# ─── counters ride with the list, thread text does not ────────────────────────

def test_discussion_counters_come_from_the_list():
    """The row shows "11/12"; GitLab counts that server-side, so rendering it
    must not cost a discussions call per MR."""
    node = dict(PAYLOAD["data"]["projects"]["nodes"][0]["mergeRequests"]["nodes"][0],
                resolvableDiscussionsCount=12, resolvedDiscussionsCount=11)
    mr = graphql.map_merge_request(node, 1515, BASE)
    assert mr["discussion_stats"] == {"resolved": 11, "total": 12}


def test_no_counters_in_the_payload_means_no_stats_key():
    """Absence is the signal the client keys off: without it, it falls back to
    the batch instead of showing every MR as having zero threads."""
    assert "discussion_stats" not in mapped()[0]


def test_thread_previews_are_not_part_of_the_list_shape():
    """They are the drill-down for one MR, fetched when a row is opened — the
    counters and the text behind them are two different questions."""
    node = dict(PAYLOAD["data"]["projects"]["nodes"][0]["mergeRequests"]["nodes"][0],
                resolvableDiscussionsCount=12, resolvedDiscussionsCount=11)
    stats = graphql.map_merge_request(node, 1515, BASE)["discussion_stats"]
    assert set(stats) == {"resolved", "total"}
