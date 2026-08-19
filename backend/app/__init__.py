"""GitLab dashboard backend.

Layering, innermost first — each layer may import the ones above it, never below:

    config       env vars and logging
    cache        bounded TTL cache
    discussions  pure functions over GitLab discussion payloads
    gitlab       the HTTP client: concurrency limit, error mapping, pagination
    session      encrypted session cookie and the authenticated-GitLab dependency
    service      domain reads built on gitlab + cache + discussions
    routes       HTTP endpoints
"""
