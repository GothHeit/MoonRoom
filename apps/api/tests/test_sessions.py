from sqlalchemy import select

from app.config import get_settings
from app.models import RefreshToken, User
from tests.conftest import make_user


async def login(client, username="kafka", password="password123", agent="Firefox/130"):
    r = await client.post(
        "/auth/login",
        json={"username": username, "password": password},
        headers={"user-agent": agent},
    )
    assert r.status_code == 200
    tokens = r.json()
    return tokens, {"Authorization": f"Bearer {tokens['access_token']}"}


async def test_sessions_list_marks_the_current_one(client, session):
    await make_user(session, "kafka", login=False)
    _, laptop = await login(client, agent="Firefox/130 Linux")
    await login(client, agent="Safari iPhone")
    r = await client.get("/me/sessions", headers=laptop)
    assert r.status_code == 200
    rows = r.json()
    assert {row["user_agent"] for row in rows} == {"Firefox/130 Linux", "Safari iPhone"}
    assert [row["user_agent"] for row in rows if row["current"]] == ["Firefox/130 Linux"]


async def test_refresh_keeps_the_same_session(client, session):
    await make_user(session, "kafka", login=False)
    tokens, headers = await login(client)
    before = (await client.get("/me/sessions", headers=headers)).json()
    rotated = (
        await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    ).json()
    new_headers = {"Authorization": f"Bearer {rotated['access_token']}"}
    rows = (await client.get("/me/sessions", headers=new_headers)).json()
    assert len(rows) == 1 and rows[0]["current"] is True
    assert rows[0]["id"] == before[0]["id"]


async def test_revoking_a_session_ends_its_refresh_token(client, session):
    await make_user(session, "kafka", login=False)
    _, laptop = await login(client)
    phone_tokens, _ = await login(client, agent="Safari iPhone")
    rows = (await client.get("/me/sessions", headers=laptop)).json()
    phone = next(row for row in rows if not row["current"])
    assert (await client.delete(f"/me/sessions/{phone['id']}", headers=laptop)).status_code == 204
    r = await client.post("/auth/refresh", json={"refresh_token": phone_tokens["refresh_token"]})
    assert r.status_code == 401
    assert len((await client.get("/me/sessions", headers=laptop)).json()) == 1


async def test_users_cannot_revoke_each_others_sessions(client, session):
    await make_user(session, "kafka", login=False)
    await make_user(session, "ana", login=False)
    kafka_tokens, kafka = await login(client)
    _, ana = await login(client, "ana")
    sid = (await client.get("/me/sessions", headers=kafka)).json()[0]["id"]
    assert (await client.delete(f"/me/sessions/{sid}", headers=ana)).status_code == 404
    r = await client.post("/auth/refresh", json={"refresh_token": kafka_tokens["refresh_token"]})
    assert r.status_code == 200


async def test_revoke_all_signs_out_everywhere(client, session):
    await make_user(session, "kafka", login=False)
    first, headers = await login(client)
    second, _ = await login(client)
    assert (await client.delete("/me/sessions", headers=headers)).status_code == 204
    for tokens in (first, second):
        r = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        assert r.status_code == 401
    # The access token of this device stops working at once too.
    r = await client.get("/me/sessions", headers=headers)
    assert (r.status_code, r.json()["error"]["code"]) == (401, "invalid_token")


async def test_change_password_keeps_this_device_and_drops_the_others(client, session):
    await make_user(session, "kafka", login=False)
    mine, headers = await login(client)
    other, _ = await login(client, agent="Safari iPhone")
    r = await client.post(
        "/me/password",
        json={"current_password": "password123", "new_password": "a-brand-new-one"},
        headers=headers,
    )
    assert r.status_code == 204
    gone = await client.post("/auth/refresh", json={"refresh_token": other["refresh_token"]})
    assert gone.status_code == 401
    kept = await client.post("/auth/refresh", json={"refresh_token": mine["refresh_token"]})
    assert kept.status_code == 200
    old = await client.post("/auth/login", json={"username": "kafka", "password": "password123"})
    assert old.status_code == 401
    new = await client.post(
        "/auth/login", json={"username": "kafka", "password": "a-brand-new-one"}
    )
    assert new.status_code == 200


async def test_change_password_checks_the_current_one(client, session):
    user, headers = await make_user(session, "kafka")
    r = await client.post(
        "/me/password",
        json={"current_password": "wrong", "new_password": "a-brand-new-one"},
        headers=headers,
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "wrong_password"
    short = await client.post(
        "/me/password",
        json={"current_password": "password123", "new_password": "short"},
        headers=headers,
    )
    assert short.status_code == 422
    stored = await session.scalar(select(User.password_hash).where(User.id == user.id))
    assert stored == user.password_hash


async def test_wrong_current_passwords_are_throttled(client, session):
    _, headers = await make_user(session, "kafka")
    for _ in range(get_settings().login_user_limit):
        r = await client.post(
            "/me/password",
            json={"current_password": "wrong", "new_password": "a-brand-new-one"},
            headers=headers,
        )
        assert r.status_code == 403
    r = await client.post(
        "/me/password",
        json={"current_password": "password123", "new_password": "a-brand-new-one"},
        headers=headers,
    )
    assert r.status_code == 429


async def test_every_token_belongs_to_a_session(client, session):
    await make_user(session, "kafka", login=False)
    await login(client)
    tokens = (await session.scalars(select(RefreshToken))).all()
    assert tokens and all(t.family_id and t.started_at for t in tokens)


async def test_subtitle_lang_auto_clears_the_preference(client, session):
    _, headers = await make_user(session, "kafka")
    await client.patch("/me", json={"subtitle_lang": "en"}, headers=headers)
    r = await client.patch("/me", json={"subtitle_lang": "auto"}, headers=headers)
    assert r.json()["subtitle_lang"] is None
