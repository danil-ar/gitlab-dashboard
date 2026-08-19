"""Bounded in-memory caching."""
import time
from collections import OrderedDict

from .config import APPROVAL_TTL, CACHE_MAXSIZE, CACHE_TTL, GRAPHQL_RETRY_AFTER, UNREVIEWED_TTL

MISS = object()


class TTLCache:
    """Bounded LRU cache with per-entry expiry.

    `None` is a cacheable value: misses come back as the `MISS` sentinel so an
    MR without a pipeline is not re-fetched on every single refresh.
    """

    __slots__ = ("_ttl", "_maxsize", "_data")

    def __init__(self, ttl: int, maxsize: int = CACHE_MAXSIZE):
        self._ttl = ttl
        self._maxsize = maxsize
        self._data: OrderedDict[tuple, tuple[float, object]] = OrderedDict()

    def get(self, key: tuple):
        entry = self._data.get(key)
        if entry is None:
            return MISS
        expires, value = entry
        if expires <= time.monotonic():
            self._data.pop(key, None)
            return MISS
        self._data.move_to_end(key)
        return value

    def set(self, key: tuple, value) -> None:
        self._data[key] = (time.monotonic() + self._ttl, value)
        self._data.move_to_end(key)
        while len(self._data) > self._maxsize:
            self._data.popitem(last=False)

    def delete(self, key: tuple) -> None:
        self._data.pop(key, None)

    def __len__(self) -> int:
        return len(self._data)


# Remembers instances where GraphQL failed, so a broken query costs one wasted
# round trip every few minutes rather than one on every single request.
graphql_broken = TTLCache(GRAPHQL_RETRY_AFTER, maxsize=64)

# The (projects, merge-requests) query size this instance's complexity budget
# accepts, so the search for it happens once rather than on every request.
graphql_budget = TTLCache(3600, maxsize=64)

users        = TTLCache(CACHE_TTL * 5, maxsize=256)
approvals    = TTLCache(CACHE_TTL)
discussions  = TTLCache(CACHE_TTL)
pipelines    = TTLCache(CACHE_TTL)
# The sidebar badge and the view itself ask the same question moments apart.
unreviewed   = TTLCache(UNREVIEWED_TTL)
approval_at  = TTLCache(APPROVAL_TTL)
activities   = TTLCache(APPROVAL_TTL)
