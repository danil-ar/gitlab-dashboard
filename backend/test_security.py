"""The token stays with its GitLab, the avatar proxy only serves images, and login only reaches allowed addresses."""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

import main
from app import gitlab, jira
from app.gitlab import GL
from app.routes import auth


# ─── the token on redirects ───────────────────────────────────────────────────

def serve(respond):
    """A real HTTP server: this is about what httpx really sends, so no mock transport."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            status, headers, body = respond(self)
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


@pytest_asyncio.fixture
async def client_lifecycle(monkeypatch):
    # httpx honours these, and a corporate proxy would answer in the servers' place.
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        monkeypatch.delenv(var, raising=False)
    await gitlab.startup()
    yield
    await gitlab.shutdown()


@pytest.mark.asyncio
async def test_the_token_doesnt_follow_a_redirect_to_another_host(client_lifecycle):
    seen = {}

    def other_host(request):
        seen["token"] = request.headers.get("PRIVATE-TOKEN")
        return 200, {"Content-Type": "application/json"}, b"{}"

    storage, storage_url = serve(other_host)
    home, home_url = serve(lambda request: (302, {"Location": f"{storage_url}/file"}, b""))
    try:
        await GL(home_url, "secret-token").get("/uploads/avatar.png")
    finally:
        home.shutdown()
        storage.shutdown()
    assert "token" in seen, "the redirect was followed"
    assert seen["token"] is None


@pytest.mark.asyncio
async def test_the_token_follows_a_redirect_within_its_gitlab(client_lifecycle):
    seen = {}

    def respond(request):
        if request.path.endswith("/start"):
            return 302, {"Location": "/api/v4/end"}, b""
        seen["token"] = request.headers.get("PRIVATE-TOKEN")
        return 200, {"Content-Type": "application/json"}, b"{}"

    home, home_url = serve(respond)
    try:
        await GL(home_url, "secret-token").get("/start")
    finally:
        home.shutdown()
    assert seen["token"] == "secret-token"


@pytest.mark.parametrize("home, target, keeps", [
    ("http://gitlab.test", "https://gitlab.test/x", True),      # the same address moving to https
    ("https://gitlab.test", "https://gitlab.test/x", True),
    ("https://gitlab.test", "http://gitlab.test/x", False),     # never down to plain http
    ("http://gitlab.test", "https://storage.test/x", False),
    ("http://gitlab.test:8080", "https://gitlab.test/x", False),
])
@pytest.mark.asyncio
async def test_where_the_token_may_go(home, target, keeps):
    request = httpx.Request("GET", target, headers={"PRIVATE-TOKEN": "t"}, extensions={"token_home": gitlab.origin_of(home)})
    await gitlab._keep_token_home(request)
    assert ("PRIVATE-TOKEN" in request.headers) is keeps


# ─── cookies between accounts ─────────────────────────────────────────────────

def remembers_cookies(cookie):
    """A server handing out a session cookie and noting the ones it gets back."""
    received = []

    def respond(request):
        received.append(request.headers.get("Cookie"))
        return 200, {"Content-Type": "application/json", "Set-Cookie": f"{cookie}; Path=/"}, b"{}"

    return received, respond


@pytest.mark.asyncio
async def test_a_gitlab_session_set_for_one_account_doesnt_reach_the_next(client_lifecycle):
    received, respond = remembers_cookies("_gitlab_session=session-of-A")
    server, url = serve(respond)
    try:
        await GL(url, "token-A").get("/user")
        await GL(url, "token-B").get("/user")
    finally:
        server.shutdown()
    assert received == [None, None]


@pytest.mark.asyncio
async def test_a_jira_session_set_for_one_account_doesnt_reach_the_next(client_lifecycle, monkeypatch):
    """Jira answers with JSESSIONID, and a session can outrank the token sent beside it."""
    received, respond = remembers_cookies("JSESSIONID=session-of-A")
    server, url = serve(respond)
    monkeypatch.setattr(jira, "JIRA_URL", url)
    try:
        await jira.Jira("jira-A").get("/myself")
        await jira.Jira("jira-B").get("/myself")
    finally:
        server.shutdown()
    assert received == [None, None]


# ─── the avatar proxy ─────────────────────────────────────────────────────────

def serving(content_type, body=b"data", status=200):
    def handler(req):
        if req.url.path == "/api/v4/user":
            return httpx.Response(200, json={"id": 1, "name": "n", "username": "u"})
        return httpx.Response(status, headers={"content-type": content_type}, content=body)
    return handler


def signed_in():
    c = TestClient(main.app, raise_server_exceptions=False)
    assert c.post("/api/auth/login", json={"gitlab_url": "https://g.test", "token": "t"}).status_code == 200
    return c


def avatar(client, path="/uploads/a.png"):
    return client.get("/api/avatar", params={"url": f"https://g.test{path}"})


def test_a_real_avatar_comes_through_locked_down(use_handler):
    use_handler(serving("image/png; charset=binary", b"\x89PNG"))
    response = avatar(signed_in())
    assert response.status_code == 200
    assert response.content == b"\x89PNG"
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]


@pytest.mark.parametrize("content_type", ["image/svg+xml", "IMAGE/SVG+XML; charset=utf-8", "text/html", "application/json", ""])
def test_anything_that_could_run_or_leak_is_refused(use_handler, content_type):
    """SVG can carry a script, and from this address it would run with the user's session."""
    use_handler(serving(content_type, b"<svg><script>alert(1)</script></svg>"))
    response = avatar(signed_in())
    assert response.status_code == 404
    assert b"script" not in response.content


def test_an_api_response_cant_be_read_through_the_avatar_proxy(use_handler):
    use_handler(serving("application/json", b'{"private_token": "x"}'))
    response = avatar(signed_in(), "/api/v4/personal_access_tokens")
    assert response.status_code == 404
    assert b"private_token" not in response.content


def test_another_host_is_refused_without_calling_it(use_handler):
    called = []

    def handler(req):
        called.append(req.url.host)
        return serving("image/png")(req)

    use_handler(handler)
    client = signed_in()
    called.clear()
    assert client.get("/api/avatar", params={"url": "https://g.test.evil.io/a.png"}).status_code == 400
    assert called == []


# ─── which GitLab the login form can reach ────────────────────────────────────

def login(url):
    return TestClient(main.app, raise_server_exceptions=False).post("/api/auth/login", json={"gitlab_url": url, "token": "t"})


@pytest.fixture
def calls(use_handler):
    made = []

    def handler(req):
        made.append(str(req.url))
        return httpx.Response(200, json={"id": 1, "name": "n", "username": "u"})

    use_handler(handler)
    return made


def test_an_address_outside_the_list_is_refused_before_any_call(calls, monkeypatch):
    monkeypatch.setattr(auth, "ALLOWED_GITLAB_URLS", ["https://gitlab.example.com"])
    response = login("http://169.254.169.254")
    assert response.status_code == 400
    assert "GITLAB_ALLOWED_URLS" in response.json()["detail"]
    assert calls == []


@pytest.mark.parametrize("url", ["https://gitlab.example.com", "https://gitlab.example.com/", "https://GITLAB.example.com"])
def test_the_allowed_address_works_however_it_is_typed(calls, monkeypatch, url):
    monkeypatch.setattr(auth, "ALLOWED_GITLAB_URLS", ["https://gitlab.example.com"])
    assert login(url).status_code == 200
    assert calls == ["https://gitlab.example.com/api/v4/user"]


@pytest.mark.parametrize("url", [
    "https://gitlab.example.com.evil.io",
    "https://gitlab.example.com:8443",
    "http://gitlab.example.com",
    "https://gitlab.example.com@evil.io",
])
def test_lookalikes_of_the_allowed_address_are_refused(calls, monkeypatch, url):
    monkeypatch.setattr(auth, "ALLOWED_GITLAB_URLS", ["https://gitlab.example.com"])
    assert login(url).status_code == 400
    assert calls == []


def test_several_addresses_can_be_allowed(calls, monkeypatch):
    monkeypatch.setattr(auth, "ALLOWED_GITLAB_URLS", ["https://one.example.com", "https://two.example.com/"])
    assert login("https://two.example.com").status_code == 200


@pytest.mark.parametrize("url", ["file:///etc/passwd", "gitlab.example.com", "ftp://gitlab.example.com"])
def test_something_that_isnt_a_web_address_is_refused(calls, url):
    assert login(url).status_code == 400
    assert calls == []


def test_with_no_list_any_web_address_works(calls):
    assert auth.ALLOWED_GITLAB_URLS == []
    assert login("https://anything.example.com").status_code == 200
