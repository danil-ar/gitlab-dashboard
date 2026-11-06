"""GitLab dashboard backend.

Layering, innermost first — each layer may import the ones above it, never below:

    config       env vars and logging
    cache        bounded TTL cache
    discussions  pure functions over GitLab discussion payloads
    gitlab       the HTTP client: concurrency limit, error mapping, pagination
    session      encrypted session cookie and the authenticated-GitLab dependency
    jira         the Jira client, authenticated with each user's own token
    service      domain reads built on gitlab + cache + discussions
    release_plan release rules with no I/O: tags, plan rows, what a merge carries
    releases     release plans and tag builds, on gitlab + jira + release_plan
    routes       HTTP endpoints
"""
