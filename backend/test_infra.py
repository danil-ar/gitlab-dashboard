"""Tests for the cache and the GitLab client's cache namespacing."""
import pytest

from app import service
from app.cache import MISS, TTLCache
from app.gitlab import GL
from app.routes.meta import origin_of


# ─── cache ────────────────────────────────────────────────────────────────────

def test_none_is_a_real_cached_value():
    """An MR with no pipeline must not be re-fetched on every refresh."""
    cache = TTLCache(ttl=60)
    cache.set(("pipeline",), None)
    assert cache.get(("pipeline",)) is None
    assert cache.get(("absent",)) is MISS


def test_cache_evicts_least_recently_used():
    cache = TTLCache(ttl=60, maxsize=2)
    cache.set(("a",), 1)
    cache.set(("b",), 2)
    cache.get(("a",))       # refresh "a", making "b" the coldest entry
    cache.set(("c",), 3)
    assert cache.get(("b",)) is MISS
    assert cache.get(("a",)) == 1
    assert len(cache) == 2


def test_expired_entries_are_dropped():
    cache = TTLCache(ttl=0)
    cache.set(("a",), 1)
    assert cache.get(("a",)) is MISS


def test_delete_removes_an_entry():
    cache = TTLCache(ttl=60)
    cache.set(("a",), 1)
    cache.delete(("a",))
    assert cache.get(("a",)) is MISS


# ─── cache namespacing ────────────────────────────────────────────────────────

def test_cache_keys_are_namespaced_per_token():
    """Two people on one backend must never read each other's cached data."""
    a = GL("https://gitlab.example.com", "token-a")
    b = GL("https://gitlab.example.com", "token-b")
    assert a.key("approvals", 1, 2) != b.key("approvals", 1, 2)


def test_cache_keys_are_namespaced_per_instance():
    same_token_elsewhere = GL("https://gitlab.other.com", "token-a")
    here = GL("https://gitlab.example.com", "token-a")
    assert here.key("approvals", 1, 2) != same_token_elsewhere.key("approvals", 1, 2)


# ─── avatar proxy origin check ────────────────────────────────────────────────

GITLAB = "https://gitlab.example.com"


def test_same_origin_is_accepted():
    assert origin_of(f"{GITLAB}/uploads/avatar.png") == origin_of(GITLAB)


def test_lookalike_host_is_rejected():
    """The bug this replaced: a string prefix check let this through, and the
    proxy then handed the user's token to the attacker's server."""
    assert origin_of("https://gitlab.example.com.attacker.tld/steal") != origin_of(GITLAB)


def test_userinfo_trick_is_rejected():
    assert origin_of("https://gitlab.example.com@attacker.tld/steal") != origin_of(GITLAB)


def test_malformed_port_is_rejected():
    assert origin_of("https://gitlab.example.com:443.attacker.tld/steal") is None


def test_other_port_on_the_same_host_is_rejected():
    """Same machine, different service — still not somewhere to send a token."""
    assert origin_of(f"{GITLAB}:8080/internal") != origin_of(GITLAB)


def test_non_http_schemes_are_rejected():
    assert origin_of("file:///etc/passwd") is None
    assert origin_of("gopher://gitlab.example.com/") is None


def test_default_ports_are_normalised():
    assert origin_of("https://gitlab.example.com") == origin_of("https://gitlab.example.com:443")


# ─── the follow-up batches must not re-ask what the list already answered ─────

@pytest.mark.asyncio
async def test_enrich_seeds_the_approvals_cache():
    """The client fires the activities batch straight after a list, and that
    batch's first question is "did I approve this one?".

    Without the seed it answers that with one GitLab call per MR, re-learning
    approvers the list already carried — 25 of the 53 calls the Merged tab used
    to make. Here such a call cannot even happen: no HTTP client is started in
    this test, so reaching the network would assert.
    """
    gl = GL("https://gitlab.example.com", "seed-token")
    approver = {"id": 314, "name": "Me Myself", "username": "me.myself", "avatar_url": None}
    mrs = [
        {"project_id": 1515, "iid": 354, "approved_by_users": [approver]},
        {"project_id": 1515, "iid": 187, "approved_by_users": []},
    ]

    await service.enrich(gl, mrs)

    assert await service.approvals(gl, 1515, 354) == [approver]
    assert await service.approvals(gl, 1515, 187) == []
