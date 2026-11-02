import uuid
from urllib.parse import parse_qs, urlsplit

import httpx
import respx

from app import hls
from app.config import get_settings
from app.main import app as fastapi_app
from app.security import create_access_token
from tests.conftest import make_user
from tests.test_watch import VIDEO_URL, FakeSource, mock_details, streams_alive  # noqa: F401


async def login(client, agent="Firefox"):
    r = await client.post(
        "/auth/login",
        json={"username": "kafka", "password": "password123"},
        headers={"user-agent": agent},
    )
    tokens = r.json()
    return tokens, {"Authorization": f"Bearer {tokens['access_token']}"}


async def test_signing_out_stops_the_access_token_at_once(client, session):
    await make_user(session, "kafka", login=False)
    tokens, headers = await login(client)
    assert (await client.get("/me", headers=headers)).status_code == 200
    await client.post("/auth/logout", json={"refresh_token": tokens["refresh_token"]})
    r = await client.get("/me", headers=headers)
    assert (r.status_code, r.json()["error"]["code"]) == (401, "invalid_token")


async def test_a_revoked_device_is_cut_off_at_once(client, session):
    await make_user(session, "kafka", login=False)
    _, laptop = await login(client)
    _, phone = await login(client, "Safari iPhone")
    assert (await client.get("/me", headers=phone)).status_code == 200
    rows = (await client.get("/me/sessions", headers=laptop)).json()
    sid = next(row["id"] for row in rows if not row["current"])
    assert (await client.delete(f"/me/sessions/{sid}", headers=laptop)).status_code == 204
    assert (await client.get("/me", headers=phone)).status_code == 401
    assert (await client.get("/me", headers=laptop)).status_code == 200


async def test_a_password_change_cuts_off_the_other_devices(client, session):
    await make_user(session, "kafka", login=False)
    _, laptop = await login(client)
    _, phone = await login(client, "Safari iPhone")
    r = await client.post(
        "/me/password",
        json={"current_password": "password123", "new_password": "a-new-password"},
        headers=laptop,
    )
    assert r.status_code == 204
    assert (await client.get("/me", headers=phone)).status_code == 401
    assert (await client.get("/me", headers=laptop)).status_code == 200


async def test_a_session_ended_by_another_server_stops_within_the_cache_time(client, session):
    from sqlalchemy import update

    from app.models import RefreshToken

    user, headers = await make_user(session, "kafka")
    assert (await client.get("/me", headers=headers)).status_code == 200
    # Revoked straight in the database, as another API instance would: this one has a cached
    # "open" answer until it expires.
    await session.execute(update(RefreshToken).values(revoked_at=RefreshToken.created_at))
    await session.commit()
    fastapi_app.state.session_check._known.clear()
    assert (await client.get("/me", headers=headers)).status_code == 401


def test_tokens_without_a_session_are_refused():
    import jwt

    from app.security import ALGORITHM, decode_access_token

    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "typ": "access"}, get_settings().jwt_secret, ALGORITHM
    )
    assert decode_access_token(token) is None


async def test_a_token_for_a_session_that_never_existed_is_refused(client, session):
    user, _ = await make_user(session, "kafka", login=False)
    headers = {"Authorization": f"Bearer {create_access_token(user.id, uuid.uuid4())}"}
    assert (await client.get("/me", headers=headers)).status_code == 401


@respx.mock
async def test_a_playback_link_needs_its_own_users_session(client, session):
    fastapi_app.state.sources = {"fake": FakeSource()}
    user, headers = await make_user(session, "kafka")
    _, other = await make_user(session, "mika")
    mock_details()
    respx.get(VIDEO_URL).mock(return_value=httpx.Response(200, content=b"data"))
    url = (await client.post("/watch/fake/21/episodes/1/play", headers=headers)).json()["url"]

    # Copied out of a log or a history: worthless without a login.
    assert (await client.get(url)).status_code == 401
    r = await client.get(url, headers=other)
    assert (r.status_code, r.json()["error"]["code"]) == (403, "invalid_link")
    assert (await client.get(url, headers=headers)).status_code == 200

    await client.delete("/me/sessions", headers=headers)
    assert (await client.get(url, headers=headers)).status_code == 401


async def test_stream_links_stop_with_the_session(client, session):
    user, headers = await make_user(session, "kafka")
    link = hls.signed_link("https://cdn.example/seg.ts", "", str(user.id), "")
    q = {k: v[0] for k, v in parse_qs(urlsplit(link).query).items()}
    await client.delete("/me/sessions", headers=headers)
    r = await client.get("/watch/hls", params=q, headers=headers)
    assert r.status_code == 401


def test_stream_links_survive_a_secret_rotation(monkeypatch):
    settings = get_settings()
    link = hls.signed_link("https://cdn.example/seg.ts", "", "viewer", "")
    q = {k: v[0] for k, v in parse_qs(urlsplit(link).query).items()}

    def valid() -> bool:
        return hls.verify_link(q["u"], "", "", "viewer", int(q["e"]), q["s"])

    old = settings.jwt_secret
    monkeypatch.setattr(settings, "jwt_secret", "a-brand-new-secret-of-at-least-32-chars")
    assert not valid()
    monkeypatch.setattr(settings, "jwt_previous_secrets", old)
    assert valid()
