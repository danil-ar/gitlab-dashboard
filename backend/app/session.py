"""Encrypted session cookie holding the user's GitLab profiles.

The GitLab token never reaches the browser in readable form: profiles are
Fernet-encrypted into one httponly cookie.
"""
import base64
import hashlib
import json

from cryptography.fernet import Fernet
from fastapi import Cookie, Depends, HTTPException
from fastapi.responses import Response

from .config import COOKIE_MAX_AGE, COOKIE_NAME, SECRET_KEY, SECURE_COOKIE, log
from .gitlab import GL

if SECRET_KEY:
    _fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(SECRET_KEY.encode()).digest()))
elif SECURE_COOKIE:
    raise RuntimeError("SECRET_KEY is required when SECURE_COOKIE is enabled")
else:
    _fernet = Fernet(Fernet.generate_key())
    log.warning("SECRET_KEY not set — sessions will reset on every server restart")

EMPTY: dict = {"profiles": [], "activeId": None}


def encrypt(data: dict) -> str:
    return _fernet.encrypt(json.dumps(data).encode()).decode()


def decrypt(value: str) -> dict | None:
    try:
        return json.loads(_fernet.decrypt(value.encode(), ttl=COOKIE_MAX_AGE))
    except Exception:
        return None


def read_session(gl_session: str | None = Cookie(None)) -> dict:
    if not gl_session:
        return dict(EMPTY)
    return decrypt(gl_session) or dict(EMPTY)


def write_cookie(response: Response, session: dict) -> None:
    response.set_cookie(
        COOKIE_NAME,
        encrypt(session),
        httponly=True,
        # "lax" (not "strict") on purpose: it already blocks cross-site POSTs, and
        # "strict" would drop the cookie when someone opens the dashboard from a
        # link in Confluence/Slack, dumping them on the login screen.
        samesite="lax",
        max_age=COOKIE_MAX_AGE,
        path="/",
        secure=SECURE_COOKIE,
    )


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", secure=SECURE_COOKIE)


def public_profile(profile: dict) -> dict:
    """Profile without the token — the only shape that may reach the client."""
    return {
        "id": profile["id"],
        "label": profile["label"],
        "gitlabUrl": profile["gitlabUrl"],
        "jiraConnected": bool(profile.get("jiraToken")),
    }


def active_profile(session: dict) -> dict | None:
    active_id = session.get("activeId")
    return next((p for p in session.get("profiles", []) if p["id"] == active_id), None)


def get_gl(session: dict = Depends(read_session)) -> GL:
    active = active_profile(session)
    if not active:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return GL(active["gitlabUrl"], active["token"])
