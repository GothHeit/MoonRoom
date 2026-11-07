from sqlalchemy import select

from app.models import RefreshToken
from tests.conftest import make_user
from tests.test_device_login import poll, start


async def tv_headers(client, phone):
    login = await start(client)
    await client.post("/auth/device/approve", json={"code": login["user_code"]}, headers=phone)
    tokens = (await poll(client, login["device_token"])).json()["tokens"]
    return {"Authorization": f"Bearer {tokens['access_token']}"}, tokens


async def set_pin(client, phone, pin="1234"):
    return await client.put(
        "/auth/pin", json={"pin": pin, "password": "password123"}, headers=phone
    )


async def test_tv_session_is_locked_until_the_pin_is_entered(client, session):
    _, phone = await make_user(session)
    tv, _ = await tv_headers(client, phone)
    assert (await client.get("/me", headers=tv)).status_code == 200  # no PIN yet

    assert (await set_pin(client, phone)).status_code == 204
    r = await client.get("/me", headers=tv)
    assert r.status_code == 403 and r.json()["error"]["code"] == "pin_required"
    # The phone isn't affected, and the TV can still ask whether it is locked.
    assert (await client.get("/me", headers=phone)).json()["pin_enabled"] is True
    status = (await client.get("/auth/pin", headers=tv)).json()
    assert status["enabled"] is True and status["locked"] is True
    assert status["username"] == "kafka"

    wrong = await client.post("/auth/pin/unlock", json={"pin": "0000"}, headers=tv)
    assert wrong.status_code == 403 and wrong.json()["error"]["code"] == "wrong_pin"
    assert (await client.get("/me", headers=tv)).status_code == 403

    assert (
        await client.post("/auth/pin/unlock", json={"pin": "1234"}, headers=tv)
    ).status_code == 204
    assert (await client.get("/me", headers=tv)).status_code == 200
    assert (await client.get("/auth/pin", headers=tv)).json()["locked"] is False

    assert (await client.post("/auth/pin/lock", headers=tv)).status_code == 204
    assert (await client.get("/me", headers=tv)).status_code == 403


async def test_wrong_guesses_are_limited_per_session(client, session):
    _, phone = await make_user(session)
    tv, _ = await tv_headers(client, phone)
    await set_pin(client, phone)
    for _ in range(5):
        r = await client.post("/auth/pin/unlock", json={"pin": "0000"}, headers=tv)
        assert r.status_code == 403
    r = await client.post("/auth/pin/unlock", json={"pin": "1234"}, headers=tv)
    assert r.status_code == 429 and "Retry-After" in r.headers


async def test_setting_the_pin_needs_the_password_and_not_a_tv(client, session):
    _, phone = await make_user(session)
    tv, _ = await tv_headers(client, phone)
    bad = await client.put("/auth/pin", json={"pin": "1234", "password": "nope"}, headers=phone)
    assert bad.status_code == 403
    for pin in ("12", "1234567", "12a4"):
        r = await client.put(
            "/auth/pin", json={"pin": pin, "password": "password123"}, headers=phone
        )
        assert r.status_code == 422
    # A TV (unlocked, since no PIN yet) can't set one.
    r = await set_pin(client, tv)
    assert r.status_code == 403 and r.json()["error"]["code"] == "pin_not_on_tv"


async def test_changing_the_pin_relocks_tvs_and_removing_it_frees_them(client, session):
    _, phone = await make_user(session)
    tv, _ = await tv_headers(client, phone)
    await set_pin(client, phone)
    await client.post("/auth/pin/unlock", json={"pin": "1234"}, headers=tv)
    assert (await client.get("/me", headers=tv)).status_code == 200

    await set_pin(client, phone, "999999")
    assert (await client.get("/me", headers=tv)).status_code == 403
    assert (
        await client.post("/auth/pin/unlock", json={"pin": "1234"}, headers=tv)
    ).status_code == 403
    assert (
        await client.post("/auth/pin/unlock", json={"pin": "999999"}, headers=tv)
    ).status_code == 204

    r = await client.post("/auth/pin/remove", json={"password": "password123"}, headers=phone)
    assert r.status_code == 204
    assert (await client.get("/me", headers=tv)).status_code == 200
    assert (await client.get("/me", headers=phone)).json()["pin_enabled"] is False


async def test_lock_survives_token_refresh_and_old_tvs_are_recognised(client, session):
    _, phone = await make_user(session)
    tv, tokens = await tv_headers(client, phone)
    await set_pin(client, phone)
    r = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 200
    rotated = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await client.get("/me", headers=rotated)).status_code == 403
    live = await session.scalar(
        select(RefreshToken.is_tv)
        .where(RefreshToken.revoked_at.is_(None), RefreshToken.is_tv.is_(True))
        .limit(1)
    )
    assert live is True


async def test_normal_sessions_are_never_locked(client, session):
    _, phone = await make_user(session)
    await set_pin(client, phone)
    assert (await client.get("/me", headers=phone)).status_code == 200
    status = (await client.get("/auth/pin", headers=phone)).json()
    assert status["enabled"] is True and status["locked"] is False


async def test_tv_adds_a_pin_with_the_password_then_changes_it_with_the_old_pin(client, session):
    _, phone = await make_user(session)
    tv, _ = await tv_headers(client, phone)
    # No PIN yet: the password is required, a PIN alone or a wrong password is refused.
    r = await client.put("/auth/pin/tv", json={"pin": "1234"}, headers=tv)
    assert r.status_code == 422 and r.json()["error"]["code"] == "password_required"
    r = await client.put("/auth/pin/tv", json={"pin": "1234", "password": "nope"}, headers=tv)
    assert r.status_code == 403 and r.json()["error"]["code"] == "wrong_password"
    r = await client.put(
        "/auth/pin/tv", json={"pin": "1234", "password": "password123"}, headers=tv
    )
    assert r.status_code == 204
    # The TV that set it stays unlocked.
    assert (await client.get("/me", headers=tv)).status_code == 200

    # Changing needs the current PIN, not the password.
    r = await client.put(
        "/auth/pin/tv", json={"pin": "5678", "password": "password123"}, headers=tv
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "current_pin_required"
    r = await client.put("/auth/pin/tv", json={"pin": "5678", "current_pin": "0000"}, headers=tv)
    assert r.status_code == 403 and r.json()["error"]["code"] == "wrong_pin"
    r = await client.put("/auth/pin/tv", json={"pin": "5678", "current_pin": "1234"}, headers=tv)
    assert r.status_code == 204
    assert (await client.get("/me", headers=tv)).status_code == 200
    await client.post("/auth/pin/lock", headers=tv)
    ok = await client.post("/auth/pin/unlock", json={"pin": "5678"}, headers=tv)
    assert ok.status_code == 204


async def test_tv_removes_the_pin_with_the_current_pin(client, session):
    _, phone = await make_user(session)
    tv, _ = await tv_headers(client, phone)
    await set_pin(client, phone)
    await client.post("/auth/pin/unlock", json={"pin": "1234"}, headers=tv)
    r = await client.post("/auth/pin/tv/remove", json={"current_pin": "0000"}, headers=tv)
    assert r.status_code == 403
    r = await client.post("/auth/pin/tv/remove", json={"current_pin": "1234"}, headers=tv)
    assert r.status_code == 204
    assert (await client.get("/me", headers=phone)).json()["pin_enabled"] is False


async def test_tv_pin_settings_share_the_wrong_guess_limit_and_are_tv_only(client, session):
    _, phone = await make_user(session)
    tv, _ = await tv_headers(client, phone)
    await set_pin(client, phone)
    await client.post("/auth/pin/unlock", json={"pin": "1234"}, headers=tv)
    for _ in range(5):
        r = await client.post("/auth/pin/tv/remove", json={"current_pin": "0000"}, headers=tv)
        assert r.status_code == 403
    r = await client.post("/auth/pin/tv/remove", json={"current_pin": "1234"}, headers=tv)
    assert r.status_code == 429
    # The phone uses the normal endpoints.
    r = await client.put("/auth/pin/tv", json={"pin": "5678", "current_pin": "1234"}, headers=phone)
    assert r.status_code == 403 and r.json()["error"]["code"] == "pin_only_on_tv"
