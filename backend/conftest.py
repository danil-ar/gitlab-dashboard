"""Shared test setup. The environment comes first: app.config reads it once, on import."""
import asyncio
import os

os.environ.update(
    SECRET_KEY="test",
    GITLAB_URL="",
    GITLAB_ALLOWED_URLS="",
    GITLAB_CA_BUNDLE="",
    JIRA_URL="https://jira.test",
    JIRA_PROJECT_KEY="LKAG",
    JIRA_RELEASE_STATUS="Включено в релиз",
)

import httpx  # noqa: E402
import pytest  # noqa: E402

from app import cache, gitlab  # noqa: E402


@pytest.fixture
def use_handler():
    """Answer the app's outgoing calls with a function, starting from empty caches."""
    for value in vars(cache).values():
        if isinstance(value, cache.TTLCache):
            value._data.clear()

    def install(handler) -> None:
        gitlab._http = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)
        gitlab._slots = asyncio.Semaphore(1000)

    yield install
    gitlab._http = None
    gitlab._slots = None
