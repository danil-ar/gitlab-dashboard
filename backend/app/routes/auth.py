"""Profile management: connect, switch and forget GitLab accounts."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from .. import cache
from ..gitlab import GL
from ..session import clear_cookie, public_profile, read_session, write_cookie

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginBody(BaseModel):
    gitlab_url: str
    token: str
    label: str = ""


class SwitchBody(BaseModel):
    profile_id: str


@router.get("/profiles")
async def auth_profiles(session: dict = Depends(read_session)):
    return {
        "profiles": [public_profile(p) for p in session.get("profiles", [])],
        "activeId": session.get("activeId"),
    }


@router.post("/login")
async def auth_login(body: LoginBody, response: Response, session: dict = Depends(read_session)):
    gl = GL(body.gitlab_url.strip().rstrip("/"), body.token.strip())
    user = (await gl.get("/user")).json()
    cache.users.set(gl.key("user"), user)

    existing = next(
        (p for p in session.get("profiles", []) if p["token"] == gl.token and p["gitlabUrl"] == gl.url),
        None,
    )
    if existing:
        write_cookie(response, {**session, "activeId": existing["id"]})
        return {"profile": public_profile(existing), "user": user}

    profile = {
        "id": str(uuid.uuid4()),
        "label": body.label.strip() or user.get("name") or user.get("username", ""),
        "gitlabUrl": gl.url,
        "token": gl.token,
    }
    write_cookie(response, {"profiles": [*session.get("profiles", []), profile], "activeId": profile["id"]})
    return {"profile": public_profile(profile), "user": user}


@router.post("/switch")
async def auth_switch(body: SwitchBody, response: Response, session: dict = Depends(read_session)):
    profiles = session.get("profiles", [])
    if not any(p["id"] == body.profile_id for p in profiles):
        raise HTTPException(status_code=404, detail="Profile not found")
    write_cookie(response, {**session, "activeId": body.profile_id})
    return {"ok": True}


@router.delete("/profiles/{profile_id}")
async def auth_remove(profile_id: str, response: Response, session: dict = Depends(read_session)):
    profiles = [p for p in session.get("profiles", []) if p["id"] != profile_id]
    active_id = session.get("activeId")
    if active_id == profile_id:
        active_id = profiles[0]["id"] if profiles else None
    if profiles:
        write_cookie(response, {"profiles": profiles, "activeId": active_id})
    else:
        clear_cookie(response)
    return {"ok": True, "activeId": active_id}


@router.post("/logout")
async def auth_logout(response: Response):
    clear_cookie(response)
    return {"ok": True}
