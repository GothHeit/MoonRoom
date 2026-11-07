"""The TV PIN: an optional code that a TV session must enter before it shows the account.

The PIN is stored hashed like a password. Sessions that signed in through the TV code flow
(`RefreshToken.is_tv`) start locked and unlock by entering the PIN, which is checked here and
remembered per session in `session_unlocks`. A locked session is refused by every normal
endpoint (see `deps.current_user`), so the lock is enforced by the API, not by the TV page.
"""

import re
import uuid
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import RefreshToken, SessionUnlock, User

PIN_PATTERN = re.compile(r"^\d{4,6}$")
# The longest an unlock lasts. The TV page also locks itself when it opens, goes to the
# background or sits idle; this only bounds a TV that never does any of that.
UNLOCK_LIFETIME = timedelta(hours=8)


def is_enabled(user: User) -> bool:
    return user.pin_hash is not None


async def is_tv_session(db: AsyncSession, user_id: uuid.UUID, sid: uuid.UUID) -> bool:
    return bool(
        await db.scalar(
            select(RefreshToken.is_tv)
            .where(RefreshToken.family_id == sid, RefreshToken.user_id == user_id)
            .order_by(RefreshToken.created_at.desc())
            .limit(1)
        )
    )


async def is_locked(db: AsyncSession, user: User, sid: uuid.UUID) -> bool:
    """True when `user` has a PIN and this TV session has not entered it (recently)."""
    if user.pin_hash is None or not await is_tv_session(db, user.id, sid):
        return False
    until = await db.scalar(
        select(SessionUnlock.unlocked_until).where(SessionUnlock.family_id == sid)
    )
    return until is None or until <= utcnow()


async def unlock(db: AsyncSession, user_id: uuid.UUID, sid: uuid.UUID) -> None:
    row = await db.get(SessionUnlock, sid)
    until = utcnow() + UNLOCK_LIFETIME
    if row is None:
        db.add(SessionUnlock(family_id=sid, user_id=user_id, unlocked_until=until))
    else:
        row.unlocked_until = until
    await db.commit()


async def lock(db: AsyncSession, sid: uuid.UUID) -> None:
    await db.execute(delete(SessionUnlock).where(SessionUnlock.family_id == sid))
    await db.commit()


async def lock_all(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(delete(SessionUnlock).where(SessionUnlock.user_id == user_id))
