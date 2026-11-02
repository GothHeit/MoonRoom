import asyncio
import hashlib
import secrets
import uuid
from datetime import timedelta

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


def create_access_token(user_id: uuid.UUID, session_id: uuid.UUID | None = None) -> str:
    minutes = get_settings().access_token_minutes
    claims: dict = {"sub": str(user_id), "typ": "access"}
    if session_id is not None:
        claims["sid"] = str(session_id)
    return _encode(claims, timedelta(minutes=minutes))


def decode_access_token(token: str) -> tuple[uuid.UUID, uuid.UUID | None] | None:
    """The user id and, for tokens issued by a login, the id of the session they belong to."""
    claims = _decode(token, "access")
    if not claims:
        return None
    sid = claims.get("sid")
    return uuid.UUID(claims["sub"]), uuid.UUID(sid) if sid else None


def create_playback_token(
    user_id: uuid.UUID, source: str, anime_id: int, episode: int, lang: str
) -> str:
    """A token scoped to one episode, for players that can't send an Authorization header."""
    minutes = get_settings().playback_token_minutes
    claims = {
        "sub": str(user_id),
        "typ": "playback",
        "src": source,
        "aid": anime_id,
        "ep": episode,
        "lang": lang,
    }
    return _encode(claims, timedelta(minutes=minutes))


def decode_playback_token(token: str) -> dict | None:
    return _decode(token, "playback")


def new_opaque_token() -> str:
    return secrets.token_urlsafe(48)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
