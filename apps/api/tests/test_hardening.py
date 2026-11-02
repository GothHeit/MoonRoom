import logging
import uuid

import httpx
import jwt
import pytest

from app.config import get_settings
from app.errors import ApiError
from app.logs import RedactSecrets, redact
from app.main import create_app
from app.ratelimit import ACTION_RULES, ActionLimits
from app.security import ALGORITHM, create_access_token, decode_access_token
from tests.conftest import make_user
from tests.test_ratelimit import Clock


def test_redact_hides_tokens_signatures_and_oauth_codes():
    assert redact("/watch/hls?token=abc.def&x=1") == "/watch/hls?token=[redacted]&x=1"
    assert redact("/watch/hls?u=https%3A%2F%2Fh&e=9&s=f00d") == (
        "/watch/hls?u=https%3A%2F%2Fh&e=9&s=[redacted]"
    )
    assert redact("/mal/callback?code=c1&state=s1") == (
        "/mal/callback?code=[redacted]&state=[redacted]"
    )
    # Names that only end like a secret are left alone.
    assert redact("/x?ids=1&episode=2") == "/x?ids=1&episode=2"


def test_access_log_lines_lose_their_token():
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", "/watch/video?token=secret", "1.1", 200),
        None,
    )
    RedactSecrets().filter(record)
    assert "secret" not in record.getMessage()


def test_action_limits_cap_each_action_per_key():
    clock = Clock()
    limits = ActionLimits({"chat": (2, 60)}, clock)
    limits.hit("chat", "a")
    limits.hit("chat", "a")
    with pytest.raises(ApiError) as exc:
        limits.hit("chat", "a")
    assert exc.value.status == 429
    limits.hit("chat", "b")
    clock.now += 61
    limits.hit("chat", "a")


async def test_mal_callback_is_rate_limited_per_address(client):
    limit = ACTION_RULES["mal_callback"][0]
    for _ in range(limit):
        r = await client.get("/mal/callback", params={"error": "access_denied"})
        assert r.status_code == 307
    r = await client.get("/mal/callback", params={"error": "access_denied"})
    assert r.status_code == 429


async def test_user_lookup_is_rate_limited_per_user(client, session):
    _, headers = await make_user(session, "kafka")
    _, other = await make_user(session, "mika")
    limit = ACTION_RULES["user_lookup"][0]
    for _ in range(limit):
        r = await client.get("/users/lookup", params={"username": "nobody"}, headers=headers)
        assert r.status_code == 404
    r = await client.get("/users/lookup", params={"username": "nobody"}, headers=headers)
    assert r.status_code == 429
    # Someone else is not affected.
    r = await client.get("/users/lookup", params={"username": "nobody"}, headers=other)
    assert r.status_code == 404


async def test_api_docs_can_be_turned_off(monkeypatch):
    monkeypatch.setattr(get_settings(), "api_docs", False)
    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert (await c.get(path)).status_code == 404
    # The spec can still be exported for the generated client.
    assert "paths" in app.openapi()


def test_tokens_signed_before_a_rotation_stay_valid(monkeypatch):
    settings = get_settings()
    user_id = uuid.uuid4()
    old_token = create_access_token(user_id)
    old_secret = settings.jwt_secret
    monkeypatch.setattr(settings, "jwt_secret", "a-brand-new-secret-of-at-least-32-chars")
    assert decode_access_token(old_token) is None
    monkeypatch.setattr(settings, "jwt_previous_secrets", old_secret)
    assert decode_access_token(old_token) == (user_id, None)
    # New tokens are signed with the new secret only.
    new = create_access_token(user_id)
    assert jwt.decode(new, settings.jwt_secret, algorithms=[ALGORITHM])["sub"] == str(user_id)


def test_a_forged_token_is_refused_by_every_secret(monkeypatch):
    monkeypatch.setattr(get_settings(), "jwt_previous_secrets", "x" * 32)
    forged = jwt.encode({"sub": str(uuid.uuid4()), "typ": "access"}, "y" * 32, algorithm=ALGORITHM)
    assert decode_access_token(forged) is None


def test_url_objects_and_exceptions_in_log_args_are_redacted():
    url = httpx.URL("https://api.example/watch/hls?token=secret&x=1")
    record = logging.LogRecord(
        "httpx", logging.INFO, __file__, 1, "HTTP Request: %s %s %s", ("GET", url, 7), None
    )
    RedactSecrets().filter(record)
    assert "secret" not in record.getMessage()
    assert isinstance(record.args, tuple) and record.args[2] == 7
    error = RuntimeError("failed for /watch/video?token=secret")
    record = logging.LogRecord("app", logging.WARNING, __file__, 1, "failed: %s", (error,), None)
    RedactSecrets().filter(record)
    assert "secret" not in record.getMessage()
