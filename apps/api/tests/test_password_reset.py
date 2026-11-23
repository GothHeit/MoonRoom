from datetime import timedelta

from sqlalchemy import select

from app.db import utcnow
from app.models import PasswordReset
from tests.conftest import make_user


async def link_for(client, admin_headers, user, hours=1):
    r = await client.post(
        f"/admin/users/{user.id}/password-reset",
        json={"hours_valid": hours},
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def login(client, username, password):
    return await client.post("/auth/login", json={"username": username, "password": password})


async def test_only_admins_see_users_and_make_links(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    friend, friend_headers = await make_user(session, "friend")
    assert (await client.get("/admin/users", headers=friend_headers)).status_code == 403
    r = await client.post(
        f"/admin/users/{friend.id}/password-reset", json={}, headers=friend_headers
    )
    assert r.status_code == 403
    rows = (await client.get("/admin/users", headers=admin)).json()
    assert [u["username"] for u in rows] == ["friend", "owner"]
    assert "password_hash" not in rows[0]


async def test_unknown_user_is_404(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    r = await client.post(
        "/admin/users/00000000-0000-0000-0000-000000000000/password-reset",
        json={},
        headers=admin,
    )
    assert (r.status_code, r.json()["error"]["code"]) == (404, "user_not_found")


async def test_a_friend_gets_back_in_with_a_new_password(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    friend, _ = await make_user(session, "friend", login=False)
    link = await link_for(client, admin, friend)
    check = await client.post("/auth/password-reset/check", json={"token": link["token"]})
    assert check.json()["username"] == "friend"
    r = await client.post(
        "/auth/password-reset", json={"token": link["token"], "new_password": "brand-new-pass"}
    )
    assert r.status_code == 204
    assert (await login(client, "friend", "password123")).status_code == 401
    assert (await login(client, "friend", "brand-new-pass")).status_code == 200


async def test_the_token_is_stored_only_as_a_hash(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    friend, _ = await make_user(session, "friend", login=False)
    link = await link_for(client, admin, friend)
    stored = (await session.scalars(select(PasswordReset))).all()
    assert len(stored) == 1 and link["token"] not in stored[0].token_hash
    assert len(stored[0].token_hash) == 64


async def test_a_link_works_once(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    friend, _ = await make_user(session, "friend", login=False)
    token = (await link_for(client, admin, friend))["token"]
    body = {"token": token, "new_password": "brand-new-pass"}
    assert (await client.post("/auth/password-reset", json=body)).status_code == 204
    again = await client.post("/auth/password-reset", json={**body, "new_password": "other-pass-1"})
    assert (again.status_code, again.json()["error"]["code"]) == (400, "invalid_reset_link")
    assert (
        await client.post("/auth/password-reset/check", json={"token": token})
    ).status_code == 400
    assert (await login(client, "friend", "brand-new-pass")).status_code == 200


async def test_an_expired_link_is_refused(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    friend, _ = await make_user(session, "friend", login=False)
    token = (await link_for(client, admin, friend))["token"]
    row = (await session.scalars(select(PasswordReset))).one()
    row.expires_at = utcnow() - timedelta(seconds=1)
    await session.commit()
    r = await client.post(
        "/auth/password-reset", json={"token": token, "new_password": "brand-new-pass"}
    )
    assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid_reset_link")
    assert (await login(client, "friend", "password123")).status_code == 200


async def test_a_new_link_replaces_the_old_one(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    friend, _ = await make_user(session, "friend", login=False)
    old = (await link_for(client, admin, friend))["token"]
    new = (await link_for(client, admin, friend))["token"]
    body = {"new_password": "brand-new-pass"}
    assert (
        await client.post("/auth/password-reset", json={"token": old, **body})
    ).status_code == 400
    assert (
        await client.post("/auth/password-reset", json={"token": new, **body})
    ).status_code == 204


async def test_a_wrong_token_is_refused_and_counted(client, session):
    for _ in range(20):
        r = await client.post("/auth/password-reset/check", json={"token": "nope"})
        assert r.status_code == 400
    r = await client.post("/auth/password-reset/check", json={"token": "nope"})
    assert r.status_code == 429


async def test_the_new_password_must_be_long_enough(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    friend, _ = await make_user(session, "friend", login=False)
    token = (await link_for(client, admin, friend))["token"]
    r = await client.post("/auth/password-reset", json={"token": token, "new_password": "short"})
    assert r.status_code == 422
    # The link is still good.
    assert (
        await client.post("/auth/password-reset/check", json={"token": token})
    ).status_code == 200


async def test_a_reset_signs_every_device_out(client, session):
    _, admin = await make_user(session, "owner", admin=True)
    friend, phone = await make_user(session, "friend")
    assert (await client.get("/me", headers=phone)).status_code == 200
    token = (await link_for(client, admin, friend))["token"]
    await client.post(
        "/auth/password-reset", json={"token": token, "new_password": "brand-new-pass"}
    )
    assert (await client.get("/me", headers=phone)).status_code == 401


async def test_a_reset_keeps_two_factor_on(client, session):
    from app import two_factor

    _, admin = await make_user(session, "owner", admin=True)
    friend, _ = await make_user(session, "friend", login=False)
    friend.totp_secret = two_factor.new_secret()
    friend.two_factor_at = utcnow()
    await session.commit()
    token = (await link_for(client, admin, friend))["token"]
    await client.post(
        "/auth/password-reset", json={"token": token, "new_password": "brand-new-pass"}
    )
    r = await login(client, "friend", "brand-new-pass")
    # The password alone gets a challenge, not tokens.
    assert r.json().get("mfa_required") is True
    assert "access_token" not in r.json()
