"""Two-factor login: TOTP codes from an authenticator app, one-time backup codes, and
"trust this device" tokens that skip the second step for a while."""

import hmac
import secrets
import uuid
from datetime import timedelta

import pyotp
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import BackupCode, TrustedDevice, User
from app.security import new_opaque_token, sha256

ISSUER = "MoonRoom"
BACKUP_CODE_COUNT = 10
TRUSTED_DEVICE_DAYS = 30
# A code is also accepted one step (30 s) either side, for clocks that drift.
WINDOW = 1
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no look-alikes (0/o, 1/l/i)


def new_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, username: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=ISSUER)


def is_enabled(user: User) -> bool:
    return user.totp_secret is not None and user.two_factor_at is not None


def _normalize(code: str) -> str:
    return "".join(code.split()).replace("-", "").lower()


def _looks_like_totp(code: str) -> bool:
    return len(code) == 6 and code.isdigit()


def matching_step(secret: str, code: str, after: int | None) -> int | None:
    """The 30 s step `code` is valid for, if it is newer than `after` (the last accepted step)."""
    code = _normalize(code)
    if not _looks_like_totp(code):
        return None
    totp = pyotp.TOTP(secret)
    now = totp.timecode(utcnow())
    found = None
    for step in range(now - WINDOW, now + WINDOW + 1):
        # Every step is compared, so timing doesn't say which one nearly matched.
        if hmac.compare_digest(totp.at(step * totp.interval), code) and (
            after is None or step > after
        ):
            found = step
    return found


def new_backup_code() -> str:
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(10))
    return f"{raw[:5]}-{raw[5:]}"


async def replace_backup_codes(db: AsyncSession, user: User) -> list[str]:
    """Throws away the old codes and returns ten new ones (shown once, never stored)."""
    await db.execute(delete(BackupCode).where(BackupCode.user_id == user.id))
    codes = [new_backup_code() for _ in range(BACKUP_CODE_COUNT)]
    db.add_all(BackupCode(user_id=user.id, code_hash=sha256(_normalize(c))) for c in codes)
    return codes


async def backup_codes_left(db: AsyncSession, user: User) -> int:
    return (
        await db.scalar(
            select(func.count())
            .select_from(BackupCode)
            .where(BackupCode.user_id == user.id, BackupCode.used_at.is_(None))
        )
        or 0
    )


async def check_code(db: AsyncSession, user: User, code: str) -> str | None:
    """Accepts an authenticator code or a backup code. Returns "totp" or "backup" when it
    was valid and is now spent, else None. The caller commits."""
    if user.totp_secret is None:
        return None
    step = matching_step(user.totp_secret, code, user.totp_last_step)
    if step is not None:
        user.totp_last_step = step
        return "totp"
    normalized = _normalize(code)
    if _looks_like_totp(normalized):
        return None
    # Spent in one statement, so two requests can't use the same code.
    used = await db.scalar(
        update(BackupCode)
        .where(
            BackupCode.user_id == user.id,
            BackupCode.code_hash == sha256(normalized),
            BackupCode.used_at.is_(None),
        )
        .values(used_at=utcnow())
        .returning(BackupCode.id)
    )
    return "backup" if used is not None else None


async def trust_device(db: AsyncSession, user: User) -> str:
    token = new_opaque_token()
    db.add(
        TrustedDevice(
            user_id=user.id,
            token_hash=sha256(token),
            expires_at=utcnow() + timedelta(days=TRUSTED_DEVICE_DAYS),
        )
    )
    return token


async def is_trusted(db: AsyncSession, user: User, token: str | None) -> bool:
    if not token:
        return False
    found = await db.scalar(
        select(TrustedDevice.id).where(
            TrustedDevice.user_id == user.id,
            TrustedDevice.token_hash == sha256(token),
            TrustedDevice.expires_at > utcnow(),
        )
    )
    return found is not None


async def forget_devices(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(delete(TrustedDevice).where(TrustedDevice.user_id == user_id))


async def turn_off(db: AsyncSession, user: User) -> None:
    user.totp_secret = None
    user.two_factor_at = None
    user.totp_last_step = None
    await db.execute(delete(BackupCode).where(BackupCode.user_id == user.id))
    await forget_devices(db, user.id)
