"""Periodic removal of rows that only ever pile up."""

from datetime import timedelta

from sqlalchemy import delete, or_

from app.db import new_session, utcnow
from app.models import DeviceLogin, MalOAuthState, RefreshToken, SessionUnlock, TrustedDevice

# Rotated tokens are kept this long so a replayed (stolen) one is still recognised as such.
TOKEN_RETENTION = timedelta(days=7)
STATE_RETENTION = timedelta(hours=1)


async def prune() -> tuple[int, int]:
    """Deletes dead refresh tokens and stale MAL OAuth states; returns how many of each."""
    now = utcnow()
    async with new_session() as session:
        tokens = await session.execute(
            delete(RefreshToken).where(
                or_(
                    RefreshToken.expires_at < now - TOKEN_RETENTION,
                    RefreshToken.revoked_at < now - TOKEN_RETENTION,
                )
            )
        )
        await session.execute(delete(SessionUnlock).where(SessionUnlock.unlocked_until < now))
        await session.execute(delete(TrustedDevice).where(TrustedDevice.expires_at < now))
        await session.execute(
            delete(DeviceLogin).where(DeviceLogin.expires_at < now - STATE_RETENTION)
        )
        states = await session.execute(
            delete(MalOAuthState).where(MalOAuthState.created_at < now - STATE_RETENTION)
        )
        await session.commit()
    return tokens.rowcount, states.rowcount  # type: ignore[attr-defined]
