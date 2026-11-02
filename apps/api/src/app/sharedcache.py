"""A cache for JSON values that survives restarts and is shared by every API worker.

Redis holds the copy everyone shares; a small in-process layer sits in front of it so a hot key
costs no network hop. Without a Redis address, or while Redis is unreachable, only the
in-process layer is used: the app is slower after a restart but never wrong or down. A failed
Redis call opens a short breaker so a dead server costs one timeout, not one per request.
"""

import hashlib
import json
import logging
import time
from typing import Any

from cachetools import TLRUCache
from redis.asyncio import Redis

log = logging.getLogger(__name__)

# Longest wait for Redis before the call counts as a failure.
REDIS_TIMEOUT = 0.5
# After a failure Redis is skipped for this long.
BREAKER_SECONDS = 30.0
# A value is kept in-process at most this long, so a refresh by another worker shows up soon.
LOCAL_MAX_TTL = 60.0

_MISSING = object()


class SharedCache:
    def __init__(self, redis_url: str = "", prefix: str = "moonroom", local_size: int = 2048):
        self._prefix = prefix
        self._redis: Redis | None = (
            Redis.from_url(
                redis_url,
                socket_timeout=REDIS_TIMEOUT,
                socket_connect_timeout=REDIS_TIMEOUT,
            )
            if redis_url
            else None
        )
        self._down_until = 0.0
        # Values are (data, ttl in seconds).
        self._local: TLRUCache[str, tuple[Any, float]] = TLRUCache(
            maxsize=local_size, ttu=lambda _k, value, now: now + value[1]
        )

    @property
    def using_redis(self) -> bool:
        return self._redis is not None and time.monotonic() >= self._down_until

    def _key(self, namespace: str, key: Any) -> str:
        digest = hashlib.sha256(json.dumps(key, sort_keys=True, default=str).encode()).hexdigest()
        return f"{self._prefix}:{namespace}:{digest[:32]}"

    def _failed(self, exc: Exception) -> None:
        if time.monotonic() >= self._down_until:
            log.warning("Redis unavailable, using the in-process cache: %s", exc)
        self._down_until = time.monotonic() + BREAKER_SECONDS

    async def get(self, namespace: str, key: Any) -> Any | None:
        """The cached value, or None. A cached JSON null reads as a miss: store a marker instead."""
        full = self._key(namespace, key)
        if (hit := self._local.get(full)) is not None:
            return hit[0]
        if not self.using_redis:
            return None
        assert self._redis is not None
        try:
            raw, ttl_ms = await self._read(full)
        except Exception as exc:
            self._failed(exc)
            return None
        if raw is None:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        self._local[full] = (data, min(LOCAL_MAX_TTL, max(ttl_ms, 1000) / 1000))
        return data

    async def _read(self, full: str) -> tuple[bytes | None, int]:
        assert self._redis is not None
        pipe = self._redis.pipeline(transaction=False)
        pipe.get(full)
        pipe.pttl(full)
        raw, ttl_ms = await pipe.execute()
        return raw, int(ttl_ms)

    async def set(self, namespace: str, key: Any, value: Any, ttl: float) -> None:
        full = self._key(namespace, key)
        self._local[full] = (value, min(LOCAL_MAX_TTL, ttl))
        if not self.using_redis:
            return
        assert self._redis is not None
        try:
            await self._redis.set(full, json.dumps(value, separators=(",", ":")), ex=int(ttl))
        except Exception as exc:
            self._failed(exc)

    async def aclose(self) -> None:
        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception as exc:  # shutting down: nothing to recover
                log.debug("Closing Redis: %s", exc)
