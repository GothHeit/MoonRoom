import asyncio
import hashlib
import secrets
import uuid
from datetime import timedelta
from typing import Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError

from app.config import get_settings
from app.db import utcnow

ALGORITHM = "HS256"
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


async def hash_password_async(password: str) -> str:
    """argon2 takes tens of milliseconds and 64 MB: keep it off the event loop."""
    return await asyncio.to_thread(hash_password, password)


# Checked when a username doesn't exist, so an unknown user costs as much as a wrong password.
DUMMY_PASSWORD_HASH = _hasher.hash("not-a-real-password")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerificationError:
        return False


async def verify_password_async(password: str, password_hash: str) -> bool:
    return await asyncio.to_thread(verify_password, password, password_hash)


def _encode(claims: dict, lifetime: timedelta) -> str:
    now = utcnow()
    payload = {**claims, "iat": now, "exp": now + lifetime}
    return jwt.encode(payload, get_settings().jwt_secret, algorithm=ALGORITHM)


def _decode(token: str, kind: str) -> dict | None:
    for secret in get_settings().jwt_verification_secrets:
        try:
            claims = jwt.decode(token, secret, algorithms=[ALGORITHM])
        except jwt.InvalidSignatureError:
            continue  # maybe signed before the last rotation
        except jwt.PyJWTError:
            return None
        return claims if claims.get("typ") == kind else None
    return None


def create_access_token(user_id: uuid.UUID, session_id: uuid.UUID) -> str:
    minutes = get_settings().access_token_minutes
    claims = {"sub": str(user_id), "typ": "access", "sid": str(session_id)}
    return _encode(claims, timedelta(minutes=minutes))


def decode_access_token(token: str) -> tuple[uuid.UUID, uuid.UUID] | None:
    """The user id and the id of the login session the token belongs to. Tokens without a
    session can't be revoked, so they are refused."""
    claims = _decode(token, "access")
    if not claims or not claims.get("sid"):
        return None
    return uuid.UUID(claims["sub"]), uuid.UUID(claims["sid"])


MFA_TOKEN_MINUTES = 5


def create_mfa_token(user_id: uuid.UUID) -> str:
    """Proves the password step of a login is done. Only /auth/login/2fa accepts it."""
    return _encode({"sub": str(user_id), "typ": "mfa"}, timedelta(minutes=MFA_TOKEN_MINUTES))


def decode_mfa_token(token: str) -> uuid.UUID | None:
    claims = _decode(token, "mfa")
    return uuid.UUID(claims["sub"]) if claims else None


# What a playback token opens: "playback" starts an HLS stream and lives minutes, since the
# playlist it opens signs its own links. "mp4" is the whole stream of an MP4 episode: the player
# asks it again for every seek and after every pause, so it lives as long as an HLS segment link.
PlaybackKind = Literal["playback", "mp4"]


def create_playback_token(
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    source: str,
    anime_id: int,
    episode: int,
    lang: str,
    kind: PlaybackKind = "playback",
) -> str:
    """Names the episode a /play answer picked and starts its playback. A TV or an AirPlay
    receiver can't send a login, so the token stands on its own: it is signed with the stream
    link key, and only works while the session it names is open."""
    now = utcnow()
    settings = get_settings()
    lifetime = (
        timedelta(minutes=settings.mp4_link_minutes)
        if kind == "mp4"
        else timedelta(minutes=settings.playback_token_minutes)
    )
    claims = {
        "sub": str(user_id),
        "sid": str(session_id),
        "typ": kind,
        "src": source,
        "aid": anime_id,
        "ep": episode,
        "lang": lang,
        "iat": now,
        "exp": now + lifetime,
    }
    return jwt.encode(claims, settings.stream_link_keys[0], algorithm=ALGORITHM)


def decode_playback_token(
    token: str, kinds: tuple[PlaybackKind, ...] = ("playback",)
) -> dict | None:
    """The claims of a playback token of one of `kinds`, or None. Always carries `sub` and
    `sid`."""
    for key in get_settings().stream_link_keys:
        try:
            claims = jwt.decode(
                token, key, algorithms=[ALGORITHM], options={"require": ["exp", "sub", "sid"]}
            )
        except jwt.InvalidSignatureError:
            continue  # maybe signed before the last rotation
        except jwt.PyJWTError:
            return None
        if claims.get("typ") not in kinds or not claims.get("sid") or not claims.get("sub"):
            return None
        return claims
    return None


def new_opaque_token() -> str:
    return secrets.token_urlsafe(48)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
