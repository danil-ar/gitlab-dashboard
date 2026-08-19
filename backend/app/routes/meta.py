"""Health, config, current user, projects, mentions and the avatar proxy."""
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from .. import cache, graphql, service
from ..config import DEFAULT_GROUP, DEFAULT_URL, USE_GRAPHQL
from ..gitlab import GL, fetch_public
from ..session import get_gl

router = APIRouter(tags=["meta"])

_GRAVATAR_HOSTS = {"secure.gravatar.com", "www.gravatar.com"}
_DEFAULT_PORTS = {"http": 80, "https": 443}


def origin_of(url: str) -> tuple[str, str, int] | None:
    """(scheme, host, port), or None if the URL is not one we would ever call."""
    parts = urlsplit(url)
    if parts.scheme not in _DEFAULT_PORTS or not parts.hostname:
        return None
    try:
        port = parts.port
    except ValueError:
        return None  # malformed port, e.g. "gitlab.example.com:443.attacker.tld"
    return (parts.scheme, parts.hostname.lower(), port or _DEFAULT_PORTS[parts.scheme])


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/config")
async def config():
    return {
        "gitlab_url":    DEFAULT_URL   or None,
        "default_group": DEFAULT_GROUP or None,
    }


@router.get("/avatar")
async def proxy_avatar(url: str = Query(..., max_length=2048), gl: GL = Depends(get_gl)):
    # Full-origin equality, not a string prefix: this request carries the user's
    # token, and "gitlab.example.com.attacker.tld" starts with the GitLab URL
    # while being a completely different server.
    target = origin_of(url)
    if target is None:
        raise HTTPException(status_code=400, detail="URL not allowed")

    if target == origin_of(gl.url):
        r = await gl.fetch_url(url)
    elif target[0] == "https" and target[1] in _GRAVATAR_HOSTS:
        r = await fetch_public(url)  # public host — never send credentials
    else:
        raise HTTPException(status_code=400, detail="URL not allowed")

    if r.status_code != 200:
        raise HTTPException(status_code=404, detail="Avatar not available")
    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "image/png"),
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/graphql-check")
async def graphql_check(
    project_id: int = Query(...),
    iid: int | None = Query(None),
    gl: GL = Depends(get_gl),
):
    """Does GraphQL work on this instance? Answers with the real query and a
    mapped sample, so the answer is 'yes, and here is what it returns'.
    Add `iid` to inspect one MR's pipeline list and the status chosen from it."""
    result = await graphql.probe(gl, project_id, iid)
    budget = cache.graphql_budget.get(gl.key("graphql_budget"))
    # (projects per query, MRs per project) that the complexity budget accepted
    settled = ({"projects": budget[0], "merge_requests": budget[1]}
               if isinstance(budget, tuple) else None)
    return {
        "enabled": USE_GRAPHQL,
        "cooling_off": cache.graphql_broken.get(gl.key("graphql_broken")) is not cache.MISS,
        "settled_on": settled,
        **result,
    }


@router.get("/me")
async def me(gl: GL = Depends(get_gl)):
    user = (await gl.get("/user")).json()
    cache.users.set(gl.key("user"), user)
    return user


@router.get("/projects")
async def projects(gl: GL = Depends(get_gl)):
    return await service.fetch_projects(gl)


@router.get("/mentions")
async def mentions(gl: GL = Depends(get_gl)):
    r = await gl.get("/todos", {"action": "mentioned", "state": "pending", "per_page": 50})
    seen: set = set()
    mr_list: list = []
    for todo in r.json():
        if todo.get("target_type") != "MergeRequest":
            continue
        target = todo.get("target") or {}
        mid = target.get("id")
        if mid and mid not in seen:
            seen.add(mid)
            mr_list.append(target)
    # These MRs live outside the main list, so the client never patches pipeline
    # and thread stats into them — they have to arrive complete.
    return await service.enrich(gl, mr_list, with_details=True)
