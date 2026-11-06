"""Releases: Jira versions, their deploy and rollback plans, and building a tag."""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from .. import release_plan, releases
from ..config import JIRA_URL
from ..gitlab import GL
from ..jira import Jira, get_jira
from ..session import get_gl, read_session, request_profile, write_cookie

router = APIRouter(tags=["releases"])


class JiraConnectBody(BaseModel):
    token: str


class BuildTagBody(BaseModel):
    path: str
    tag: str
    source_sha: str
    target_sha: str
    merged_sha: str | None = None


def _require_version_tag(tag: str) -> None:
    if not release_plan.parse_tag(tag):
        raise HTTPException(status_code=400, detail="The tag must look like vX.Y.Z")


@router.post("/jira/connect")
async def jira_connect(
    body: JiraConnectBody,
    response: Response,
    session: dict = Depends(read_session),
    profile: dict = Depends(request_profile),
):
    if not JIRA_URL:
        raise HTTPException(status_code=404, detail="Jira integration is not configured")
    token = body.token.strip()
    await Jira(token).get("/myself")
    profiles = [{**p, "jiraToken": token} if p["id"] == profile["id"] else p for p in session["profiles"]]
    write_cookie(response, {**session, "profiles": profiles})
    return {"ok": True}


@router.get("/jira/releases")
async def jira_releases(jira: Jira = Depends(get_jira)):
    return await releases.list_releases(jira)


@router.get("/jira/releases/{version_id}/plan")
async def jira_release_plan(
    version_id: int,
    released: bool = Query(False),
    jira: Jira = Depends(get_jira),
    gl: GL = Depends(get_gl),
):
    return await releases.build_plan(jira, gl, version_id, released)


@router.get("/jira/releases/{version_id}/repo-preview")
async def release_repo_preview(
    version_id: int,
    path: str = Query(...),
    tag: str = Query(...),
    jira: Jira = Depends(get_jira),
    gl: GL = Depends(get_gl),
):
    _require_version_tag(tag)
    return await releases.repo_preview(jira, gl, version_id, path, tag)


@router.post("/releases/build-tag")
async def build_release_tag(body: BuildTagBody, gl: GL = Depends(get_gl)):
    _require_version_tag(body.tag)
    return await releases.build_tag(gl, body.path, body.tag, body.source_sha, body.target_sha, body.merged_sha)
