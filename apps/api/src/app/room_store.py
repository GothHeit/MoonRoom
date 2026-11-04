"""Keeps a copy of the watch-together rooms in Redis, so a restart or a deploy doesn't end them.

The rooms themselves live in memory (app.rooms); this saves what changed about once a second,
and loads everything back when the API starts. Without a Redis address it does nothing, and a
Redis outage only means rooms would not survive a restart during it.
"""

import asyncio
import json
import logging
import time

from redis.asyncio import Redis

from app.rooms import EMPTY_GRACE_SECONDS, Rooms

log = logging.getLogger(__name__)

KEY = "moonroom:rooms"
REDIS_TIMEOUT = 0.5
SAVE_INTERVAL_SECONDS = 1.0
# A room saved longer ago than this is not brought back: everyone has long gone.
MAX_AGE_SECONDS = 15 * 60


class RoomStore:
    def __init__(self, redis_url: str = "") -> None:
        self._redis: Redis | None = (
            Redis.from_url(
                redis_url, socket_timeout=REDIS_TIMEOUT, socket_connect_timeout=REDIS_TIMEOUT
            )
            if redis_url
            else None
        )
        self._warned = False

    def _failed(self, exc: Exception) -> None:
        if not self._warned:
            log.warning("Redis unavailable, rooms are not being saved: %s", exc)
        self._warned = True

    async def load(self) -> list[dict]:
        """The saved rooms recent enough to bring back; older ones are deleted."""
        if self._redis is None:
            return []
        try:
            raw = await self._redis.hgetall(KEY)
        except Exception as exc:
            self._failed(exc)
            return []
        now = time.time()
        rooms: list[dict] = []
        stale: list[bytes | str] = []
        for code, value in raw.items():
            try:
                data = json.loads(value)
            except ValueError:
                stale.append(code)
                continue
            if not isinstance(data, dict) or now - float(data.get("saved_at", 0)) > MAX_AGE_SECONDS:
                stale.append(code)
                continue
            rooms.append(data)
        if stale:
            try:
                await self._redis.hdel(KEY, *stale)
            except Exception as exc:
                self._failed(exc)
        return rooms

    async def save(self, rooms: list[dict], removed: list[str]) -> bool:
        if self._redis is None or not (rooms or removed):
            return True
        try:
            pipe = self._redis.pipeline(transaction=False)
            if rooms:
                pipe.hset(
                    KEY, mapping={r["code"]: json.dumps(r, separators=(",", ":")) for r in rooms}
                )
            if removed:
                pipe.hdel(KEY, *removed)
            await pipe.execute()
        except Exception as exc:
            self._failed(exc)
            return False
        if self._warned:
            log.info("Redis is back, rooms are being saved again")
        self._warned = False
        return True

    async def aclose(self) -> None:
        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception as exc:  # shutting down: nothing to recover
                log.debug("Closing Redis: %s", exc)


async def keep_saved(rooms: Rooms, store: RoomStore) -> None:
    """Saves what changed every second. What a failed save held is tried again next time."""
    while True:
        await asyncio.sleep(SAVE_INTERVAL_SECONDS)
        saves, removed = rooms.pending()
        if not await store.save(saves, removed):
            for data in saves:
                rooms.dirty.add(data["code"])
            rooms.removed.update(removed)


async def restore(rooms: Rooms, store: RoomStore) -> None:
    count = rooms.restore(await store.load())
    if count:
        log.info(
            "brought back %d watch-together rooms (empty ones close after %d s)",
            count,
            EMPTY_GRACE_SECONDS,
        )
