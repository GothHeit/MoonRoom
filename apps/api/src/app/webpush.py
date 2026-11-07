"""Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).

Written against `cryptography` and PyJWT, which the API already uses, so no push library is
needed. The browser's push service (Apple, Google, Mozilla, Microsoft) relays the message; it
never sees the content, which only the user's device can decrypt."""

import base64
import os
import struct
import time
from urllib.parse import urlparse

import httpx
import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# Push services a subscription may point at. The address comes from the browser, so without
# this list the server could be told to post to any internal address.
PUSH_HOSTS = (
    "fcm.googleapis.com",
    "push.apple.com",
    "push.services.mozilla.com",
    "notify.windows.com",
)

RECORD_SIZE = 4096
VAPID_LIFETIME_SECONDS = 12 * 3600
SEND_TIMEOUT_SECONDS = 10


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def is_push_endpoint(url: str) -> bool:
    try:
        parts = urlparse(url)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    return (
        parts.scheme == "https"
        and parts.port in (None, 443)
        and not parts.username
        and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)
    )


def new_vapid_key() -> str:
    """A fresh signing key, as the 32-byte private value in URL-safe base64."""
    key = ec.generate_private_key(ec.SECP256R1())
    return b64e(key.private_numbers().private_value.to_bytes(32, "big"))


def _private_key(secret: str) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(b64d(secret), "big"), ec.SECP256R1())


def _public_bytes(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )


def vapid_public_key(secret: str) -> str:
    """The key the browser needs to subscribe (applicationServerKey), in URL-safe base64."""
    return b64e(_public_bytes(_private_key(secret).public_key()))


def vapid_authorization(secret: str, subject: str, endpoint: str, now: float | None = None) -> str:
    parts = urlparse(endpoint)
    claims = {
        "aud": f"{parts.scheme}://{parts.netloc}",
        "exp": int((now if now is not None else time.time()) + VAPID_LIFETIME_SECONDS),
        "sub": subject,
    }
    token = jwt.encode(claims, _private_key(secret), algorithm="ES256")
    return f"vapid t={token}, k={vapid_public_key(secret)}"


def encrypt(
    payload: bytes,
    p256dh: str,
    auth: str,
    *,
    salt: bytes | None = None,
    sender: ec.EllipticCurvePrivateKey | None = None,
) -> bytes:
    """The request body for one message to one subscription (RFC 8291, a single record)."""
    receiver_raw = b64d(p256dh)
    auth_secret = b64d(auth)
    receiver = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), receiver_raw)
    sender = sender or ec.generate_private_key(ec.SECP256R1())
    sender_raw = _public_bytes(sender.public_key())
    salt = salt or os.urandom(16)

    shared = sender.exchange(ec.ECDH(), receiver)
    ikm = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=auth_secret,
        info=b"WebPush: info\x00" + receiver_raw + sender_raw,
    ).derive(shared)
    key = HKDF(
        algorithm=hashes.SHA256(), length=16, salt=salt, info=b"Content-Encoding: aes128gcm\x00"
    ).derive(ikm)
    nonce = HKDF(
        algorithm=hashes.SHA256(), length=12, salt=salt, info=b"Content-Encoding: nonce\x00"
    ).derive(ikm)

    # One record: the message, then the 0x02 marker that ends the last record.
    if len(payload) > RECORD_SIZE - 17:
        raise ValueError("push payload too large")
    ciphertext = AESGCM(key).encrypt(nonce, payload + b"\x02", None)
    header = salt + struct.pack(">IB", RECORD_SIZE, len(sender_raw)) + sender_raw
    return header + ciphertext


async def send(
    http: httpx.AsyncClient,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: bytes,
    vapid_secret: str,
    vapid_subject: str,
    ttl: int = 24 * 3600,
    urgency: str = "normal",
) -> int:
    """Posts one message; returns the push service's status code (0 when unreachable).

    201 is delivered to the service. 404 and 410 mean the subscription is gone for good."""
    if not is_push_endpoint(endpoint):
        return 410
    try:
        response = await http.post(
            endpoint,
            content=encrypt(payload, p256dh, auth),
            headers={
                "Authorization": vapid_authorization(vapid_secret, vapid_subject, endpoint),
                "Content-Encoding": "aes128gcm",
                "Content-Type": "application/octet-stream",
                "TTL": str(ttl),
                "Urgency": urgency,
            },
            timeout=SEND_TIMEOUT_SECONDS,
            follow_redirects=False,
        )
    except httpx.HTTPError:
        return 0
    return response.status_code


if __name__ == "__main__":
    # `python -m app.webpush` prints a new key pair for VAPID_PRIVATE_KEY.
    secret = new_vapid_key()
    print(f"VAPID_PRIVATE_KEY={secret}")
    print(f"# public key (served to browsers automatically): {vapid_public_key(secret)}")
