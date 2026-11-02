import pyotp
from sqlalchemy import select

from app.db import utcnow
from app.models import BackupCode, User
from tests.conftest import make_user

PASSWORD = "password123"


def code_for(secret: str, offset: int = 0) -> str:
    totp = pyotp.TOTP(secret)
    return totp.at(utcnow(), counter_offset=offset)


async def enable(client, headers) -> tuple[str, list[str]]:
    setup = await client.post("/me/2fa/setup", json={"password": PASSWORD}, headers=headers)
    assert setup.status_code == 200
    secret = setup.json()["secret"]
    assert setup.json()["otpauth_uri"].startswith("otpauth://totp/MoonRoom:")
    done = await client.post("/me/2fa/enable", json={"code": code_for(secret)}, headers=headers)
    assert done.status_code == 200
    return secret, done.json()["backup_codes"]


async def login(client, **extra):
    return await client.post(
        "/auth/login", json={"username": "kafka", "password": PASSWORD, **extra}
    )


async def test_login_without_two_factor_is_unchanged(client, session):
    await make_user(session, login=False)
    r = await login(client)
    assert r.status_code == 200 and "access_token" in r.json()


async def test_setup_alone_does_not_turn_it_on(client, session):
    _, headers = await make_user(session)
    await client.post("/me/2fa/setup", json={"password": PASSWORD}, headers=headers)
    assert (await client.get("/me/2fa", headers=headers)).json()["enabled"] is False
    assert "access_token" in (await login(client)).json()


async def test_setup_needs_the_password(client, session):
    _, headers = await make_user(session)
    r = await client.post("/me/2fa/setup", json={"password": "nope"}, headers=headers)
    assert r.status_code == 403


async def test_enable_needs_a_right_code(client, session):
    _, headers = await make_user(session)
    await client.post("/me/2fa/setup", json={"password": PASSWORD}, headers=headers)
    r = await client.post("/me/2fa/enable", json={"code": "000000"}, headers=headers)
    assert r.status_code == 400
    assert (await client.get("/me/2fa", headers=headers)).json()["enabled"] is False


async def test_secret_is_encrypted_at_rest(client, session):
    user, headers = await make_user(session)
    secret, _ = await enable(client, headers)
    from sqlalchemy import text

    raw = await session.scalar(text("SELECT totp_secret FROM users"))
    assert raw != secret and raw.startswith("gAAAA")


async def test_login_asks_for_a_code_then_signs_in(client, session):
    _, headers = await make_user(session)
    secret, backups = await enable(client, headers)
    assert len(backups) == 10
    status = (await client.get("/me/2fa", headers=headers)).json()
    assert status == {"enabled": True, "backup_codes_left": 10}

    first = await login(client)
    assert first.status_code == 200
    assert first.json()["mfa_required"] is True and "access_token" not in first.json()
    token = first.json()["mfa_token"]

    # The challenge token is no bearer token.
    me = await client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 401

    bad = await client.post("/auth/login/2fa", json={"mfa_token": token, "code": "123456"})
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "invalid_code"

    # The code used to enable it is spent; the next step's code works.
    ok = await client.post(
        "/auth/login/2fa", json={"mfa_token": token, "code": code_for(secret, 1)}
    )
    assert ok.status_code == 200
    assert ok.json()["trusted_device"] is None
    me = await client.get("/me", headers={"Authorization": f"Bearer {ok.json()['access_token']}"})
    assert me.status_code == 200


async def test_a_code_works_only_once(client, session):
    _, headers = await make_user(session)
    secret, _ = await enable(client, headers)
    code = code_for(secret, 1)
    token = (await login(client)).json()["mfa_token"]
    assert (
        await client.post("/auth/login/2fa", json={"mfa_token": token, "code": code})
    ).status_code == 200
    token = (await login(client)).json()["mfa_token"]
    again = await client.post("/auth/login/2fa", json={"mfa_token": token, "code": code})
    assert again.status_code == 401


async def test_a_backup_code_works_once(client, session):
    _, headers = await make_user(session)
    _, backups = await enable(client, headers)
    token = (await login(client)).json()["mfa_token"]
    ok = await client.post("/auth/login/2fa", json={"mfa_token": token, "code": backups[0]})
    assert ok.status_code == 200
    token = (await login(client)).json()["mfa_token"]
    again = await client.post("/auth/login/2fa", json={"mfa_token": token, "code": backups[0]})
    assert again.status_code == 401
    # Spacing and case are forgiven.
    loose = backups[1].upper().replace("-", " ")
    ok = await client.post("/auth/login/2fa", json={"mfa_token": token, "code": loose})
    assert ok.status_code == 200
    assert (await client.get("/me/2fa", headers=headers)).json()["backup_codes_left"] == 8
    stored = (await session.scalars(select(BackupCode.code_hash))).all()
    assert backups[0] not in stored  # only hashes


async def test_wrong_codes_are_rate_limited(client, session):
    _, headers = await make_user(session)
    await enable(client, headers)
    token = (await login(client)).json()["mfa_token"]
    statuses = [
        (
            await client.post("/auth/login/2fa", json={"mfa_token": token, "code": "111111"})
        ).status_code
        for _ in range(10)
    ]
    assert statuses[0] == 401 and statuses[-1] == 429


async def test_trusted_device_skips_the_second_step(client, session):
    _, headers = await make_user(session)
    secret, _ = await enable(client, headers)
    token = (await login(client)).json()["mfa_token"]
    ok = await client.post(
        "/auth/login/2fa",
        json={"mfa_token": token, "code": code_for(secret, 1), "trust_device": True},
    )
    trusted = ok.json()["trusted_device"]
    assert trusted
    again = await login(client, trusted_device=trusted)
    assert "access_token" in again.json()
    # Someone else's or a made-up token doesn't.
    fake = await login(client, trusted_device="x" * 40)
    assert fake.json()["mfa_required"] is True


async def test_password_change_forgets_trusted_devices(client, session):
    _, headers = await make_user(session)
    secret, _ = await enable(client, headers)
    token = (await login(client)).json()["mfa_token"]
    ok = await client.post(
        "/auth/login/2fa",
        json={"mfa_token": token, "code": code_for(secret, 1), "trust_device": True},
    )
    trusted = ok.json()["trusted_device"]
    r = await client.post(
        "/me/password",
        json={"current_password": PASSWORD, "new_password": "another-password"},
        headers=headers,
    )
    assert r.status_code == 204
    again = await client.post(
        "/auth/login",
        json={"username": "kafka", "password": "another-password", "trusted_device": trusted},
    )
    assert again.json()["mfa_required"] is True


async def test_disable_needs_password_and_code_and_clears_everything(client, session):
    user, headers = await make_user(session)
    secret, backups = await enable(client, headers)
    wrong = await client.post(
        "/me/2fa/disable", json={"password": "nope", "code": backups[0]}, headers=headers
    )
    assert wrong.status_code == 403
    wrong = await client.post(
        "/me/2fa/disable", json={"password": PASSWORD, "code": "000000"}, headers=headers
    )
    assert wrong.status_code == 403
    r = await client.post(
        "/me/2fa/disable", json={"password": PASSWORD, "code": backups[0]}, headers=headers
    )
    assert r.status_code == 204
    assert (await client.get("/me/2fa", headers=headers)).json() == {
        "enabled": False,
        "backup_codes_left": 0,
    }
    assert "access_token" in (await login(client)).json()
    row = await session.scalar(select(User).where(User.id == user.id))
    await session.refresh(row)
    assert row.totp_secret is None


async def test_new_backup_codes_replace_the_old_ones(client, session):
    _, headers = await make_user(session)
    _, backups = await enable(client, headers)
    r = await client.post(
        "/me/2fa/backup-codes", json={"password": PASSWORD, "code": backups[0]}, headers=headers
    )
    assert r.status_code == 200
    fresh = r.json()["backup_codes"]
    assert len(fresh) == 10 and not set(fresh) & set(backups)
    token = (await login(client)).json()["mfa_token"]
    old = await client.post("/auth/login/2fa", json={"mfa_token": token, "code": backups[1]})
    assert old.status_code == 401


async def test_cannot_set_up_twice(client, session):
    _, headers = await make_user(session)
    await enable(client, headers)
    r = await client.post("/me/2fa/setup", json={"password": PASSWORD}, headers=headers)
    assert r.status_code == 409


async def test_two_factor_endpoints_need_sign_in(client):
    assert (await client.get("/me/2fa")).status_code == 401
    r = await client.post("/auth/login/2fa", json={"mfa_token": "junk", "code": "123456"})
    assert r.status_code == 401
