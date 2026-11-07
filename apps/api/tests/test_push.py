import json
import struct
from datetime import timedelta

import httpx
import jwt
import pytest
import respx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import select, update

from app import push, webpush
from app.config import get_settings
from app.db import utcnow
from app.models import Notification, PushSubscription
from tests.conftest import make_user

ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"
APPLE = "https://web.push.apple.com/QGxyz"


class Device:
    """A browser's side of a subscription: it holds the private key that reads the messages."""

    def __init__(self, endpoint: str = ENDPOINT):
        self.endpoint = endpoint
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = b"0123456789abcdef"

    @property
    def subscription(self):
        return {
            "endpoint": self.endpoint,
            "keys": {
                "p256dh": webpush.b64e(webpush._public_bytes(self.key.public_key())),
                "auth": webpush.b64e(self.auth),
            },
        }

    def read(self, body: bytes) -> dict:
        """Decrypts a push body the way a browser does (RFC 8291, section 3.4)."""
        salt, size, idlen = body[:16], struct.unpack(">I", body[16:20])[0], body[20]
        sender_raw = body[21 : 21 + idlen]
        sender = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), sender_raw)
        receiver_raw = webpush._public_bytes(self.key.public_key())
        ikm = HKDF(
            hashes.SHA256(), 32, self.auth, b"WebPush: info\x00" + receiver_raw + sender_raw
        ).derive(self.key.exchange(ec.ECDH(), sender))
        key = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
        nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
        assert size == 4096
        plain = AESGCM(key).decrypt(nonce, body[21 + idlen :], None)
        assert plain.endswith(b"\x02")
        return json.loads(plain[:-1])


@pytest.fixture
def vapid(monkeypatch):
    settings = get_settings()
    key = webpush.new_vapid_key()
    monkeypatch.setattr(settings, "vapid_private_key", key)
    return key


@pytest.fixture
async def http():
    async with httpx.AsyncClient() as c:
        yield c


def test_encryption_matches_the_rfc_8291_example():
    sender = ec.derive_private_key(
        int.from_bytes(webpush.b64d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"),
        ec.SECP256R1(),
    )
    body = webpush.encrypt(
        b"When I grow up, I want to be a watermelon",
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        "BTBZMqHH6r4Tts7J_aSIgg",
        salt=webpush.b64d("DGv6ra1nlYgDCS1FRnbzlw"),
        sender=sender,
    )
    assert webpush.b64e(body) == (
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmY"
        "WAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexS"
        "gSxsj_Qulcy4a-fN"
    )


def test_the_vapid_header_is_signed_for_the_push_service():
    secret = webpush.new_vapid_key()
    header = webpush.vapid_authorization(secret, "mailto:ops@example.com", ENDPOINT, now=1000)
    token, public = header.removeprefix("vapid t=").split(", k=")
    assert public == webpush.vapid_public_key(secret)
    key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.b64d(public))
    claims = jwt.decode(
        token,
        key,
        algorithms=["ES256"],
        audience="https://fcm.googleapis.com",
        options={"verify_exp": False},
    )
    assert claims == {
        "aud": "https://fcm.googleapis.com",
        "exp": 1000 + 12 * 3600,
        "sub": "mailto:ops@example.com",
    }


def test_only_known_push_services_are_accepted():
    assert webpush.is_push_endpoint(ENDPOINT)
    assert webpush.is_push_endpoint(APPLE)
    assert webpush.is_push_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x")
    assert not webpush.is_push_endpoint("http://fcm.googleapis.com/x")
    assert not webpush.is_push_endpoint("https://169.254.169.254/latest")
    assert not webpush.is_push_endpoint("https://fcm.googleapis.com.evil.example/x")
    assert not webpush.is_push_endpoint("https://evilfcm.googleapis.com@evil.example/x")
    assert not webpush.is_push_endpoint("https://fcm.googleapis.com:8443/x")


async def test_the_config_says_whether_push_is_set_up(client, session, vapid, monkeypatch):
    _, ana = await make_user(session, "ana")
    config = (await client.get("/push/config", headers=ana)).json()
    assert config == {"enabled": True, "public_key": webpush.vapid_public_key(vapid)}
    monkeypatch.setattr(get_settings(), "vapid_private_key", "")
    assert (await client.get("/push/config", headers=ana)).json() == {
        "enabled": False,
        "public_key": None,
    }
    response = await client.put("/push/subscription", json=Device().subscription, headers=ana)
    assert response.status_code == 404


async def test_subscribing_checks_what_the_browser_sends(client, session, vapid):
    _, ana = await make_user(session, "ana")
    ok = Device().subscription
    assert (await client.put("/push/subscription", json=ok, headers=ana)).status_code == 204

    internal = {**ok, "endpoint": "https://10.0.0.5/push"}
    assert (await client.put("/push/subscription", json=internal, headers=ana)).status_code == 422
    short_key = {**ok, "keys": {**ok["keys"], "p256dh": webpush.b64e(b"x" * 10)}}
    assert (await client.put("/push/subscription", json=short_key, headers=ana)).status_code == 422
    short_auth = {**ok, "keys": {**ok["keys"], "auth": webpush.b64e(b"x" * 5)}}
    assert (await client.put("/push/subscription", json=short_auth, headers=ana)).status_code == 422
    assert (await client.put("/push/subscription", json=ok)).status_code == 401


async def test_a_device_belongs_to_whoever_signed_in_last(client, session, vapid):
    ana_user, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    device = Device()
    await client.put("/push/subscription", json=device.subscription, headers=ana)
    await client.put("/push/subscription", json=device.subscription, headers=bob)
    rows = list(await session.scalars(select(PushSubscription)))
    assert [r.user_id for r in rows] == [bob_user.id]

    # Ana can't remove bob's device.
    await client.post("/push/unsubscribe", json={"endpoint": device.endpoint}, headers=ana)
    assert len(list(await session.scalars(select(PushSubscription)))) == 1
    await client.post("/push/unsubscribe", json={"endpoint": device.endpoint}, headers=bob)
    assert list(await session.scalars(select(PushSubscription))) == []


async def test_a_user_keeps_only_the_newest_devices(client, session, vapid):
    _, ana = await make_user(session, "ana")
    for i in range(push.MAX_PER_USER + 2):
        sub = Device(f"https://fcm.googleapis.com/fcm/send/dev{i}").subscription
        await client.put("/push/subscription", json=sub, headers=ana)
    ends = set(await session.scalars(select(PushSubscription.endpoint)))
    assert len(ends) == push.MAX_PER_USER
    assert "https://fcm.googleapis.com/fcm/send/dev0" not in ends
    assert f"https://fcm.googleapis.com/fcm/send/dev{push.MAX_PER_USER + 1}" in ends


async def befriend_request(client, headers, to: str):
    await client.post("/friends/requests", json={"username": to}, headers=headers)


@respx.mock
async def test_a_bell_entry_reaches_the_phone_in_the_users_language(client, session, vapid, http):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    device = Device()
    await client.put("/push/subscription", json=device.subscription, headers=bob)
    route = respx.post(ENDPOINT).mock(return_value=httpx.Response(201))

    await befriend_request(client, ana, "bob")
    assert await push.push_pending(http, get_settings()) == 1

    assert route.call_count == 1
    sent = route.calls[0].request
    assert sent.headers["content-encoding"] == "aes128gcm"
    assert sent.headers["authorization"].startswith("vapid t=")
    message = device.read(sent.content)
    assert message["body"] == "ana quer ser seu amigo"
    assert message["url"] == "/pt/friends"
    assert message["title"] == "MoonRoom"

    # Handled once: another round finds nothing to send.
    assert await push.push_pending(http, get_settings()) == 0
    assert route.call_count == 1


@respx.mock
async def test_english_new_episode_text_and_link(client, session, vapid, http):
    user, ana = await make_user(session, "ana")
    user.locale = "en"
    device = Device()
    await client.put("/push/subscription", json=device.subscription, headers=ana)
    route = respx.post(ENDPOINT).mock(return_value=httpx.Response(201))
    session.add(
        Notification(
            user_id=user.id, kind="new_episode", anime_id=52991, episode=7, title="Frieren"
        )
    )
    await session.commit()

    await push.push_pending(http, get_settings())
    assert device.read(route.calls[0].request.content) == {
        "title": "Frieren",
        "body": "Episode 7 is out",
        "url": "/en/anime/52991",
        "tag": "new_episode:52991",
    }


@respx.mock
async def test_a_new_manga_chapter_is_pushed_with_a_link_to_the_manga(client, session, vapid, http):
    user, ana = await make_user(session, "ana")
    user.locale = "en"
    device = Device()
    await client.put("/push/subscription", json=device.subscription, headers=ana)
    route = respx.post(ENDPOINT).mock(return_value=httpx.Response(201))
    session.add(
        Notification(user_id=user.id, kind="new_chapter", manga_id=13, episode=12, title="Berserk")
    )
    await session.commit()

    await push.push_pending(http, get_settings())
    assert device.read(route.calls[0].request.content) == {
        "title": "Berserk",
        "body": "Chapter 12 is out",
        "url": "/en/manga/13",
        "tag": "new_chapter:13",
    }


@respx.mock
async def test_muted_kinds_read_entries_and_stale_ones_are_not_pushed(client, session, vapid, http):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await client.put("/push/subscription", json=Device().subscription, headers=bob)
    route = respx.post(ENDPOINT).mock(return_value=httpx.Response(201))

    await client.put("/notifications/settings", json={"muted": ["friend_request"]}, headers=bob)
    await befriend_request(client, ana, "bob")
    assert await push.push_pending(http, get_settings()) == 0  # never created

    await client.put("/notifications/settings", json={"muted": []}, headers=bob)
    await befriend_request(client, ana, "bob")
    await client.post("/notifications/read", headers=bob)  # seen in the app first
    await push.push_pending(http, get_settings())
    assert route.call_count == 0

    session.add(
        Notification(user_id=bob_user.id, kind="new_episode", anime_id=1, episode=2, title="X")
    )
    await session.commit()
    await session.execute(
        update(Notification)
        .where(Notification.kind == "new_episode")
        .values(created_at=utcnow() - timedelta(seconds=push.MAX_AGE_SECONDS + 5))
    )
    await session.commit()
    await push.push_pending(http, get_settings())
    assert route.call_count == 0


@respx.mock
async def test_a_gone_subscription_is_forgotten_and_a_flaky_one_after_a_few_tries(
    client, session, vapid, http
):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    gone, flaky = Device(), Device(APPLE)
    for d in (gone, flaky):
        await client.put("/push/subscription", json=d.subscription, headers=bob)
    respx.post(ENDPOINT).mock(return_value=httpx.Response(410))
    respx.post(APPLE).mock(return_value=httpx.Response(503))

    await befriend_request(client, ana, "bob")
    await push.push_pending(http, get_settings())
    rows = list(await session.scalars(select(PushSubscription)))
    assert [(r.endpoint, r.failures) for r in rows] == [(APPLE, 1)]

    await session.execute(update(PushSubscription).values(failures=push.MAX_FAILURES - 1))
    await session.commit()
    bob_id = await session.scalar(select(Notification.user_id))
    session.add(Notification(user_id=bob_id, kind="new_episode", anime_id=9, episode=1, title="Y"))
    await session.commit()
    await push.push_pending(http, get_settings())
    session.expire_all()
    assert list(await session.scalars(select(PushSubscription))) == []


@respx.mock
async def test_the_test_message_goes_to_every_device(client, session, vapid):
    _, ana = await make_user(session, "ana")
    assert (await client.post("/push/test", headers=ana)).status_code == 409

    device = Device()
    await client.put("/push/subscription", json=device.subscription, headers=ana)
    route = respx.post(ENDPOINT).mock(return_value=httpx.Response(201))
    assert (await client.post("/push/test", headers=ana)).status_code == 204
    assert device.read(route.calls[0].request.content)["title"] == "Notificações ativadas"

    respx.post(ENDPOINT).mock(return_value=httpx.Response(500))
    assert (await client.post("/push/test", headers=ana)).status_code == 502
