from datetime import timedelta

from sqlalchemy import update

from app.db import utcnow
from app.models import DeviceLogin
from app.routers.device_login import normalize_code
from tests.conftest import make_user

TV = {"user-agent": "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) Chrome/94 TV Safari/537.36"}


async def start(client):
    r = await client.post("/auth/device", headers=TV)
    assert r.status_code == 201
    return r.json()


async def poll(client, device_token):
    return await client.post("/auth/device/token", json={"device_token": device_token})


async def test_code_approved_on_the_phone_signs_the_tv_in_once(client, session):
    _, phone = await make_user(session)
    login = await start(client)
    assert len(normalize_code(login["user_code"])) == 8
    assert login["expires_in"] == 600 and login["interval"] == 5

    r = await poll(client, login["device_token"])
    assert r.status_code == 200 and r.json() == {"status": "pending", "tokens": None}

    # Typed loosely on the phone: lower case, a space instead of the dash.
    typed = login["user_code"].lower().replace("-", " ")
    info = await client.post("/auth/device/lookup", json={"code": typed}, headers=phone)
    assert info.status_code == 200 and "Tizen" in info.json()["user_agent"]
    assert (
        await client.post("/auth/device/approve", json={"code": typed}, headers=phone)
    ).status_code == 204

    r = await poll(client, login["device_token"])
    assert r.status_code == 200 and r.json()["status"] == "approved"
    tokens = r.json()["tokens"]
    me = await client.get("/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert me.status_code == 200 and me.json()["username"] == "kafka"

    # The TV's session is named after the TV and the code can't sign anyone in again.
    sessions = (await client.get("/me/sessions", headers=phone)).json()
    assert any(s["user_agent"] and "Tizen" in s["user_agent"] for s in sessions)
    assert (await poll(client, login["device_token"])).status_code == 410
    again = await client.post("/auth/device/approve", json={"code": typed}, headers=phone)
    assert again.status_code == 404


async def test_declined_code_never_signs_in(client, session):
    _, phone = await make_user(session)
    login = await start(client)
    r = await client.post("/auth/device/deny", json={"code": login["user_code"]}, headers=phone)
    assert r.status_code == 204
    assert (await poll(client, login["device_token"])).status_code == 403
    r = await client.post("/auth/device/approve", json={"code": login["user_code"]}, headers=phone)
    assert r.status_code == 404


async def test_expired_code_is_refused(client, session):
    _, phone = await make_user(session)
    login = await start(client)
    await session.execute(update(DeviceLogin).values(expires_at=utcnow() - timedelta(seconds=1)))
    await session.commit()
    r = await client.post("/auth/device/approve", json={"code": login["user_code"]}, headers=phone)
    assert r.status_code == 404
    assert (await poll(client, login["device_token"])).status_code == 410


async def test_approving_needs_a_signed_in_user(client):
    login = await start(client)
    r = await client.post("/auth/device/approve", json={"code": login["user_code"]})
    assert r.status_code == 401


async def test_unknown_device_token_is_refused(client):
    assert (await poll(client, "nope")).status_code == 410


async def test_only_hashes_are_stored(client, session):
    login = await start(client)
    row = (await session.execute(DeviceLogin.__table__.select())).first()
    assert row is not None
    stored = str(tuple(row))
    assert login["device_token"] not in stored
    assert normalize_code(login["user_code"]) not in stored


async def test_guessing_codes_is_rate_limited(client, session):
    _, phone = await make_user(session)
    statuses = [
        (
            await client.post("/auth/device/lookup", json={"code": "BBBB-BBBB"}, headers=phone)
        ).status_code
        for _ in range(21)
    ]
    assert statuses[:20] == [404] * 20 and statuses[20] == 429


async def test_starting_logins_is_rate_limited_per_address(client):
    statuses = [(await client.post("/auth/device")).status_code for _ in range(21)]
    assert statuses[:20] == [201] * 20 and statuses[20] == 429
