"""Application assembly. The pieces themselves live in `app/` — see app/__init__.py."""
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app import gitlab, routes
from app.config import CACHE_TTL, CONCURRENCY, CORS_ORIGINS, log


@asynccontextmanager
async def lifespan(app: FastAPI):
    await gitlab.startup()
    log.info("started — concurrency=%s cache_ttl=%ss", CONCURRENCY, CACHE_TTL)
    yield
    await gitlab.shutdown()


app = FastAPI(title="GitLab Dashboard API", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def log_timing(request, call_next):
    calls = gitlab.start_call_counter()
    t = time.monotonic()
    response = await call_next(request)
    elapsed = time.monotonic() - t
    if not request.url.path.startswith("/api/health"):
        # Fan-out is this dashboard's main cost, so the count sits next to the
        # duration: "slow" and "slow because it made 90 calls" need different fixes.
        level = logging.INFO if elapsed > 1 or calls[0] > 20 else logging.DEBUG
        log.log(level, "%s %s → %s (%.2fs, %d GitLab calls)",
                request.method, request.url.path, response.status_code, elapsed, calls[0])
    return response


# Same-origin in every supported setup (nginx proxies /api, vite proxies it in dev),
# so CORS stays off unless an origin is opted in explicitly.
if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )
    log.info("CORS enabled for %s", CORS_ORIGINS)

app.include_router(routes.router)
