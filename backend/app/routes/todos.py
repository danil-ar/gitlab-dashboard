"""GitLab to-do list."""
from fastapi import APIRouter, Depends, Query

from ..gitlab import GL
from ..session import get_gl

router = APIRouter(prefix="/todos", tags=["todos"])

_TODO_ACTIONS = {
    "assigned", "review_requested", "mentioned", "directly_addressed",
    "approval_required", "build_failed", "unmergeable", "marked",
}


@router.get("")
async def todos_list(
    state: str = Query("pending", pattern="^(pending|done|all)$"),
    action: str = Query(""),
    target_type: str = Query(""),
    per_page: int = Query(50, ge=1, le=100),
    gl: GL = Depends(get_gl),
):
    params: dict = {"per_page": per_page}
    if state != "all":
        params["state"] = state
    if action and action in _TODO_ACTIONS:
        params["action"] = action
    if target_type:
        params["type"] = target_type
    return (await gl.get("/todos", params)).json()


@router.post("/mark_all_done")
async def mark_all_todos_done(gl: GL = Depends(get_gl)):
    await gl.post("/todos/mark_as_done")
    return {"ok": True}


@router.post("/{todo_id}/done")
async def mark_todo_done(todo_id: int, gl: GL = Depends(get_gl)):
    await gl.post(f"/todos/{todo_id}/mark_as_done")
    return {"ok": True}
