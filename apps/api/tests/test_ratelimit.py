import asyncio

import pytest

from app.config import get_settings
from app.errors import ApiError
from app.ratelimit import RateLimiter
from tests.conftest import make_user


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_limiter_blocks_then_recovers_when_the_window_passes():
    clock = Clock()
    limiter = RateLimiter(2, 60, clock)
    for _ in range(2):
        limiter.check("a")
        limiter.record("a")
    with pytest.raises(ApiError) as exc:
        limiter.check("a")
    assert exc.value.status == 429
    assert exc.value.headers == {"Retry-After": "61"}
    limiter.check("b")  # other keys are unaffected

    clock.now += 61
    limiter.check("a")


def test_limiter_reset_forgets_a_key():
    limiter = RateLimiter(1, 60, Clock())
    limiter.record("a")
    limiter.reset("a")
    limiter.check("a")


async def login(client, username, password):
    return await client.post("/auth/login", json={"username": username, "password": password})


async def test_repeated_failed_logins_for_one_user_are_throttled(client, session):
    await make_user(session, "kafka", login=False)
    limit = get_settings().login_user_limit
    for _ in range(limit):
        assert (await login(client, "kafka", "wrong-password")).status_code == 401
    r = await login(client, "kafka", "password123")
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"
    assert int(r.headers["retry-after"]) > 0


async def test_successful_login_clears_the_user_counter(client, session):
    await make_user(session, "kafka", login=False)
    limit = get_settings().login_user_limit
    for _ in range(limit - 1):
        await login(client, "kafka", "wrong-password")
    assert (await login(client, "kafka", "password123")).status_code == 200
    for _ in range(limit - 1):
        assert (await login(client, "kafka", "wrong-password")).status_code == 401


async def test_registration_attempts_are_throttled_per_ip(client):
    limit = get_settings().register_ip_limit
    body = {"password": "password123", "invite_code": "nope"}
    for i in range(limit):
        r = await client.post("/auth/register", json={**body, "username": f"user_{i}"})
        assert r.status_code == 400
    r = await client.post("/auth/register", json={**body, "username": "one_more"})
    assert r.status_code == 429


async def test_concurrent_refreshes_with_one_token_leave_one_live_token(client, session):
    from sqlalchemy import func, select

    from app.models import RefreshToken

    await make_user(session, "kafka", login=False)
    refresh_token = (await login(client, "kafka", "password123")).json()["refresh_token"]
    results = await asyncio.gather(
        *(client.post("/auth/refresh", json={"refresh_token": refresh_token}) for _ in range(8))
    )
    # The row lock serialises them; the repeats count as retries of a lost answer, and each
    # one retires the previous answer, so the session ends with a single usable token.
    assert {r.status_code for r in results} == {200}
    live = await session.scalar(
        select(func.count()).select_from(RefreshToken).where(RefreshToken.revoked_at.is_(None))
    )
    assert live == 1


async def test_a_burst_of_concurrent_wrong_guesses_is_counted(client, session):
    await make_user(session, "kafka", login=False)
    limit = get_settings().login_user_limit
    results = await asyncio.gather(
        *(login(client, "kafka", "wrong-password") for _ in range(limit + 6))
    )
    assert sorted({r.status_code for r in results}) == [401, 429]
    assert sum(r.status_code == 401 for r in results) == limit


async def test_successful_logins_do_not_use_up_the_ip_limit(client, session):
    await make_user(session, "kafka", login=False)
    for _ in range(get_settings().login_ip_limit + 3):
        assert (await login(client, "kafka", "password123")).status_code == 200


async def test_a_strangers_guesses_do_not_lock_the_real_user_out(client, session, monkeypatch):
    monkeypatch.setattr(get_settings(), "trust_proxy_headers", True)
    await make_user(session, "kafka", login=False)
    for _ in range(get_settings().login_user_limit):
        r = await client.post(
            "/auth/login",
            json={"username": "kafka", "password": "nope"},
            headers={"x-forwarded-for": "203.0.113.9"},
        )
        assert r.status_code == 401
    blocked = await client.post(
        "/auth/login",
        json={"username": "kafka", "password": "password123"},
        headers={"x-forwarded-for": "203.0.113.9"},
    )
    assert blocked.status_code == 429
    owner = await client.post(
        "/auth/login",
        json={"username": "kafka", "password": "password123"},
        headers={"x-forwarded-for": "198.51.100.4"},
    )
    assert owner.status_code == 200


def test_sweep_drops_idle_keys():
    clock = Clock()
    limiter = RateLimiter(2, 60, clock)
    limiter.record("old")
    clock.now += 30
    limiter.record("new")
    clock.now += 40
    limiter.sweep()
    assert list(limiter._hits) == ["new"]
