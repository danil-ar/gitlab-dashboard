"""Work that has not been through review: branches with no merge request, and
commits that reached a protected branch without one."""
from fastapi import APIRouter, Depends, Query

from .. import service
from ..gitlab import GL
from ..session import get_gl

router = APIRouter(tags=["unreviewed"])


@router.get("/unreviewed")
async def unreviewed(
    days: int = Query(14, ge=1, le=90),
    project_ids: str = Query(""),
    refresh: bool = Query(False),
    gl: GL = Depends(get_gl),
):
    ids = [int(x) for x in project_ids.split(",") if x.strip().isdigit()] if project_ids else []
    return await service.unreviewed(gl, ids, days, refresh=refresh)
