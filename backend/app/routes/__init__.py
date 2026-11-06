from fastapi import APIRouter

from . import auth, branches, merge_requests, meta, releases, todos

router = APIRouter(prefix="/api")
router.include_router(meta.router)
router.include_router(auth.router)
router.include_router(merge_requests.router)
router.include_router(branches.router)
router.include_router(todos.router)
router.include_router(releases.router)
