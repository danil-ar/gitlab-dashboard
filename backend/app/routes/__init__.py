from fastapi import APIRouter

from . import auth, merge_requests, meta, todos

router = APIRouter(prefix="/api")
router.include_router(meta.router)
router.include_router(auth.router)
router.include_router(merge_requests.router)
router.include_router(todos.router)
