"""The Jira Server/Data Center client. Each user connects with their own Personal Access Token."""
import httpx
from fastapi import Depends, HTTPException

from . import gitlab
from .config import JIRA_PROJECT, JIRA_URL
from .session import active_profile, read_session


class Jira:
    """Its failures never surface as 401, which the frontend reads as a dead GitLab token."""

    def __init__(self, token: str):
        self.headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    async def get(self, path: str, params: dict | None = None):
        try:
            r = await gitlab.http().get(f"{JIRA_URL}/rest/api/2{path}", headers=self.headers, params=params, follow_redirects=False)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="Jira API timeout")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Jira unreachable: {e}")
        reason = gitlab.error_reason(r) or f"HTTP {r.status_code}"
        if r.status_code == 401 or r.is_redirect:
            raise HTTPException(status_code=403, detail="Jira rejected the token. Create a new Personal Access Token.")
        if r.status_code == 403:
            raise HTTPException(status_code=403, detail=f"Jira denied access: {reason}")
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=f"Jira: {reason}")
        try:
            return r.json()
        except ValueError:
            raise HTTPException(status_code=502, detail="Jira returned a non-JSON response. Check JIRA_URL.")


def get_jira(session: dict = Depends(read_session)) -> Jira:
    if not JIRA_URL or not JIRA_PROJECT:
        raise HTTPException(status_code=404, detail="Jira integration is not configured")
    active = active_profile(session)
    if not active:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not active.get("jiraToken"):
        raise HTTPException(status_code=403, detail="Connect Jira first")
    return Jira(active["jiraToken"])
