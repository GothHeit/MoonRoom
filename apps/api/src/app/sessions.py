"""Is a login session still open? Asked on every authenticated request, so a signed-out device
or a revoked session stops working at once instead of when its access token expires.

A session is open while its refresh-token family has a live token. Answers are cached per
process for a short time; revocations made by this process drop the cached answer right away,
so the cache only delays revocations made by another API instance, by at most `ttl` seconds.
A shared store (Redis) would remove even that once there are several instances.
"""

import time
import uuid
from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import RefreshToken

CACHE_SECONDS = 30
MAX_ENTRIES = 50_000


class SessionCheck:
    def __init__(
        self, ttl: float = CACHE_SECONDS, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._ttl = ttl
        self._clock = clock
        # session id -> (user id, open?, valid until)
        self._known: dict[uuid.UUID, tuple[uuid.UUID, bool, float]] = {}

    async def is_open(self, db: AsyncSession, user_id: uuid.UUID, sid: uuid.UUID) -> bool:
        now = self._clock()
        known = self._known.get(sid)
        if known is not None and known[2] > now and known[0] == user_id:
            return known[1]
        found = await db.scalar(
            select(RefreshToken.id)
            .where(
                RefreshToken.family_id == sid,
                RefreshToken.user_id == user_id,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > utcnow(),
            )
            .limit(1)
        )
        if len(self._known) >= MAX_ENTRIES:
            self.sweep()
            if len(self._known) >= MAX_ENTRIES:
                self._known.clear()
        self._known[sid] = (user_id, found is not None, now + self._ttl)
        return found is not None

    def closed(self, sid: uuid.UUID) -> None:
        """Called after a session is revoked here, so it stops working now."""
        known = self._known.get(sid)
        if known is not None:
            self._known[sid] = (known[0], False, known[2])

    def closed_for_user(self, user_id: uuid.UUID, keep: uuid.UUID | None = None) -> None:
        """Every session of a user was revoked here, except `keep`."""
        for sid, (owner, _, until) in list(self._known.items()):
            if owner == user_id and sid != keep:
                self._known[sid] = (owner, False, until)

    def sweep(self) -> None:
        now = self._clock()
        for sid, (_, _, until) in list(self._known.items()):
            if until <= now:
                del self._known[sid]
