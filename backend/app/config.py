"""Environment configuration and logging setup. Imported first, depends on nothing."""
import logging
import os

from dotenv import load_dotenv

load_dotenv()

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("dashboard")


class _DropHealthChecks(logging.Filter):
    """The container healthcheck hits /api/health every 10s; that is six access
    log lines a minute saying nothing."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/api/health" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_DropHealthChecks())

# httpx logs one line per outbound call at INFO. With a dashboard that fans out
# across every project that buries our own logs, so it only speaks up on DEBUG.
for _noisy in ("httpx", "httpcore"):
    logging.getLogger(_noisy).setLevel(logging.DEBUG if LOG_LEVEL == "DEBUG" else logging.WARNING)


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in ("1", "true", "yes")


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        log.warning("%s is not a number, falling back to %s", name, default)
        return default


DEFAULT_URL   = os.environ.get("GITLAB_URL", "").rstrip("/")
DEFAULT_GROUP = os.environ.get("GITLAB_DEFAULT_GROUP", "").strip()
SECRET_KEY    = os.environ.get("SECRET_KEY", "")
SECURE_COOKIE = env_flag("SECURE_COOKIE")
CORS_ORIGINS  = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]

COOKIE_NAME    = "gl_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365  # 1 year

# GraphQL returns MRs, approvers, pipeline, diff size and merge status in one
# query per batch of projects. It falls back to REST on any error, so leaving it
# on is safe; set USE_GRAPHQL=false to pin the old path.
USE_GRAPHQL           = os.environ.get("USE_GRAPHQL", "true").lower() not in ("0", "false", "no")
GRAPHQL_PROJECT_BATCH = env_int("GRAPHQL_PROJECT_BATCH", 5)   # projects per query
GRAPHQL_MR_LIMIT      = env_int("GRAPHQL_MR_LIMIT", 50)       # MRs per project
GRAPHQL_PIPELINE_DEPTH = env_int("GRAPHQL_PIPELINE_DEPTH", 5)  # pipelines per MR to choose from
GRAPHQL_RETRY_AFTER   = env_int("GRAPHQL_RETRY_AFTER", 600)   # cool-off after a failure

CACHE_TTL         = env_int("CACHE_TTL", 60)          # short-lived GitLab reads
APPROVAL_TTL      = env_int("APPROVAL_TTL", 900)      # keyed by mr.updated_at, safe to keep longer
CACHE_MAXSIZE     = env_int("CACHE_MAXSIZE", 4096)
CONCURRENCY       = env_int("GITLAB_CONCURRENCY", 10)
MAX_PROJECT_PAGES = env_int("MAX_PROJECT_PAGES", 10)  # /projects, 100 per page
MAX_MR_PAGES      = env_int("MAX_MR_PAGES", 5)        # per merge-request query
MAX_NOTE_PAGES    = env_int("MAX_NOTE_PAGES", 20)     # approval-note scan
