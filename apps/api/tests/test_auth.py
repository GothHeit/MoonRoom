from datetime import timedelta

from sqlalchemy import select, update

from app.db import utcnow
from app.models import RefreshToken, User
from app.security import sha256
from tests.conftest import make_user


async def register(client, code, username="Kafka", password="password123"):
    return await client.post(
        "/auth/register",
        json={
            "username": username,
            "password": password,
            "invite_code": code,
            "locale": "en",
        },
    )


async def test_register_needs_a_valid_invite(client):
    r = await register(client, "nope")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_invite"


async def test_register_consumes_the_invite(client, invite_code, session):
    r = await register(client, invite_code)
    assert r.status_code == 201
    tokens = r.json()
    assert tokens["access_token"] and tokens["refresh_token"]

    user = await session.scalar(select(User))
    assert user.username == "kafka"
    assert user.locale == "en"

    again = await register(client, invite_code, username="other")
    assert again.json()["error"]["code"] == "invalid_invite"


async def test_usernames_are_case_insensitive(client, invite_code, session):
    await make_user(session, "kafka", login=False)
    r = await register(client, invite_code, username="KAFKA")
    assert r.status_code == 409


async def test_register_validates_input(client, invite_code):
    assert (await register(client, invite_code, username="")).status_code == 422
    assert (await register(client, invite_code, password="short")).status_code == 422


async def test_login(client, session):
    await make_user(session, "kafka", login=False)
    ok = await client.post("/auth/login", json={"username": "Kafka", "password": "password123"})
    assert ok.status_code == 200
    bad = await client.post("/auth/login", json={"username": "kafka", "password": "wrong"})
    assert bad.status_code == 401
    assert bad.json()["error"]["code"] == "invalid_credentials"


async def test_missing_token_is_401_not_422(client):
    r = await client.get("/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "not_authenticated"


async def test_refresh_rotates_and_detects_reuse(client, session):
    await make_user(session, "kafka", login=False)
    first = (
        await client.post("/auth/login", json={"username": "kafka", "password": "password123"})
    ).json()

    rotated = await client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert rotated.status_code == 200
    second = rotated.json()

    # Once the grace window has passed, the old token coming back is treated as theft and
    # kills the newer one too.
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == sha256(first["refresh_token"]))
        .values(revoked_at=utcnow() - timedelta(minutes=5))
    )
    await session.commit()
    reused = await client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert reused.status_code == 401
    after = await client.post("/auth/refresh", json={"refresh_token": second["refresh_token"]})
    assert after.status_code == 401


async def test_a_lost_refresh_response_can_be_retried(client, session):
    await make_user(session, "kafka", login=False)
    first = (
        await client.post("/auth/login", json={"username": "kafka", "password": "password123"})
    ).json()
    # The device never saw this answer.
    await client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})

    retry = await client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert retry.status_code == 200
    headers = {"Authorization": f"Bearer {retry.json()['access_token']}"}
    # Still one session, and the new token keeps working.
    assert len((await client.get("/me/sessions", headers=headers)).json()) == 1
    again = await client.post(
        "/auth/refresh", json={"refresh_token": retry.json()["refresh_token"]}
    )
    assert again.status_code == 200


async def test_logout_revokes_refresh_token(client, session):
    await make_user(session, "kafka", login=False)
    tokens = (
        await client.post("/auth/login", json={"username": "kafka", "password": "password123"})
    ).json()
    assert (
        await client.post("/auth/logout", json={"refresh_token": tokens["refresh_token"]})
    ).status_code == 204
    r = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 401


async def test_update_me(client, session):
    _, headers = await make_user(session, "kafka")
    r = await client.patch("/me", json={"locale": "en", "show_nsfw": True}, headers=headers)
    assert r.status_code == 200
    assert r.json()["locale"] == "en" and r.json()["show_nsfw"] is True
    assert (await client.patch("/me", json={"locale": "fr"}, headers=headers)).status_code == 422


async def test_only_admins_create_invites(client, session):
    _, user_headers = await make_user(session, "friend")
    _, admin_headers = await make_user(session, "kafka", admin=True)
    assert (await client.post("/invites", json={}, headers=user_headers)).status_code == 403
    r = await client.post("/invites", json={"days_valid": 3}, headers=admin_headers)
    assert r.status_code == 201
    listed = await client.get("/invites", headers=admin_headers)
    assert [i["code"] for i in listed.json()] == [r.json()["code"]]


async def test_losing_a_registration_race_is_a_conflict(client, invite_code, session, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession

    await make_user(session, "kafka", login=False)
    real_scalar = AsyncSession.scalar

    async def blind_to_users(self, statement, *args, **kwargs):
        # Simulates the "is the name taken?" check running before a rival's insert.
        if "FROM users" in str(statement):
            return None
        return await real_scalar(self, statement, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "scalar", blind_to_users)
    r = await register(client, invite_code, username="kafka")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "username_taken"


async def test_unknown_user_still_runs_a_password_check(client, session, monkeypatch):
    from app.routers import auth

    calls = []
    real_verify = auth.verify_password_async

    async def spy(password, password_hash):
        calls.append(password_hash)
        return await real_verify(password, password_hash)

    monkeypatch.setattr(auth, "verify_password_async", spy)
    r = await client.post("/auth/login", json={"username": "nobody", "password": "password123"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_credentials"
    assert calls == [auth.DUMMY_PASSWORD_HASH]


async def test_adult_titles_are_on_by_default_and_can_be_switched(client, invite_code):
    tokens = (await register(client, invite_code)).json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    assert (await client.get("/me", headers=headers)).json()["show_nsfw"] is True
    off = await client.patch("/me", json={"show_nsfw": False}, headers=headers)
    assert off.json()["show_nsfw"] is False
    on = await client.patch("/me", json={"show_nsfw": True}, headers=headers)
    assert on.json()["show_nsfw"] is True


async def test_subtitle_preference_is_saved_and_validated(client, session):
    _, headers = await make_user(session, "kafka")
    assert (await client.get("/me", headers=headers)).json()["subtitle_lang"] is None
    r = await client.patch("/me", json={"subtitle_lang": "pt-BR"}, headers=headers)
    assert r.json()["subtitle_lang"] == "pt-BR"
    assert (
        await client.patch("/me", json={"subtitle_lang": "off"}, headers=headers)
    ).status_code == 200
    bad = await client.patch("/me", json={"subtitle_lang": "../x"}, headers=headers)
    assert bad.status_code == 422


async def _rotated(client):
    first = (
        await client.post("/auth/login", json={"username": "kafka", "password": "password123"})
    ).json()
    second = (
        await client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    ).json()
    return first, second


async def test_an_ended_session_cannot_be_revived_through_the_grace_window(client, session):
    await make_user(session, "kafka", login=False)
    first, second = await _rotated(client)
    await client.post("/auth/logout", json={"refresh_token": second["refresh_token"]})
    revived = await client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert revived.status_code == 401


async def test_revoking_a_session_blocks_its_just_rotated_token(client, session):
    await make_user(session, "kafka", login=False)
    first, second = await _rotated(client)
    headers = {"Authorization": f"Bearer {second['access_token']}"}
    assert (await client.delete("/me/sessions", headers=headers)).status_code == 204
    revived = await client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert revived.status_code == 401
    # A plain 401: it must not have been read as theft of anything else.


async def test_changing_the_password_blocks_other_devices_just_rotated_token(client, session):
    await make_user(session, "kafka", login=False)
    first, _ = await _rotated(client)
    other = (
        await client.post("/auth/login", json={"username": "kafka", "password": "password123"})
    ).json()
    headers = {"Authorization": f"Bearer {other['access_token']}"}
    changed = await client.post(
        "/me/password",
        json={"current_password": "password123", "new_password": "newpassword456"},
        headers=headers,
    )
    assert changed.status_code == 204
    revived = await client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert revived.status_code == 401
    # The device that changed it keeps its session.
    kept = await client.post("/auth/refresh", json={"refresh_token": other["refresh_token"]})
    assert kept.status_code == 200
