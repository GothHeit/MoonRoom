"""Sliding-window limiters.

`RateLimiter` lives in this process only: fine for cheap action caps. `SharedLimiter` guards the
guessable things (passwords, 2FA codes, TV PINs): its counts live in Redis, so an API restart
(every deploy) or a second worker does not hand out fresh guesses. If Redis is not configured or
cannot be reached, it counts in this process instead: stricter than shared counting never is, and
never open.
"""

import hashlib
import logging
import time
import uuid
from collections import deque
from collections.abc import Callable

from redis.asyncio import Redis

from app.errors import ApiError

log = logging.getLogger(__name__)


class RateLimiter:
    def __init__(
        self, limit: int, window_seconds: float, clock: Callable[[], float] = time.monotonic
    ):
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def _recent(self, key: str) -> deque[float]:
        now = self._clock()
        hits = self._hits.setdefault(key, deque())
        while hits and hits[0] <= now - self._window:
            hits.popleft()
        if not hits:
            # Drop idle keys so the table doesn't grow with every address ever seen.
            del self._hits[key]
            return deque()
        return hits

    def retry_after(self, key: str) -> int | None:
        """Seconds until `key` may try again, or None when it is under the limit."""
        hits = self._recent(key)
        if len(hits) < self._limit:
            return None
        return max(1, int(hits[0] + self._window - self._clock()) + 1)

    def check(self, key: str) -> None:
        wait = self.retry_after(key)
        if wait is not None:
            raise ApiError(
                429,
                "rate_limited",
                "Too many attempts, try again later",
                headers={"Retry-After": str(wait)},
            )

    def record(self, key: str) -> None:
        self._recent(key)
        self._hits.setdefault(key, deque()).append(self._clock())

    def sweep(self) -> None:
        """Drop every key whose hits have all expired; `_recent` prunes each key it visits."""
        for key in list(self._hits):
            self._recent(key)

    def forgive(self, key: str) -> None:
        """Drop the most recent hit, e.g. when an attempt turned out to be fine."""
        hits = self._hits.get(key)
        if hits:
            hits.pop()

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)


# Longest wait for Redis before the call counts as a failure.
REDIS_TIMEOUT = 0.5
# After a failure Redis is skipped for this long, so a dead server costs one timeout.
BREAKER_SECONDS = 30.0

# KEYS are windows (sorted sets of hit times); ARGV is [member, limit1, window1, limit2, ...].
# Either every window has room and each gets one hit, or none does and nothing is counted.
# Returns 0 on success, otherwise the longest wait in seconds. Time comes from Redis itself.
_HIT_SCRIPT = """
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000
local wait = 0
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[2 * i])
  local window = tonumber(ARGV[2 * i + 1])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  if redis.call('ZCARD', key) >= limit then
    local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local w = math.floor(tonumber(first[2]) + window - now) + 1
    if w < 1 then w = 1 end
    if w > wait then wait = w end
  end
end
if wait > 0 then return wait end
for i, key in ipairs(KEYS) do
  redis.call('ZADD', key, now, ARGV[1])
  redis.call('EXPIRE', key, math.ceil(tonumber(ARGV[2 * i + 1])))
end
return 0
"""


class AttemptStore:
    """The Redis connection behind the shared limiters, with a breaker."""

    def __init__(self, redis_url: str = "", prefix: str = "moonroom"):
        self.prefix = prefix
        self.redis: Redis | None = (
            Redis.from_url(
                redis_url, socket_timeout=REDIS_TIMEOUT, socket_connect_timeout=REDIS_TIMEOUT
            )
            if redis_url
            else None
        )
        self._script = self.redis.register_script(_HIT_SCRIPT) if self.redis else None
        self._down_until = 0.0

    @property
    def usable(self) -> bool:
        return self.redis is not None and time.monotonic() >= self._down_until

    def failed(self, exc: Exception) -> None:
        if time.monotonic() >= self._down_until:
            log.warning("Redis unavailable, counting login attempts in-process: %s", exc)
        self._down_until = time.monotonic() + BREAKER_SECONDS

    def redis_key(self, name: str, key: str) -> str:
        return f"{self.prefix}:rl:{name}:{hashlib.sha256(key.encode()).hexdigest()[:32]}"

    async def hit(self, entries: list[tuple["SharedLimiter", str]]) -> int | None:
        """All-or-nothing count. Returns the wait in seconds when over a limit, else None;
        raises when Redis fails."""
        assert self._script is not None
        keys = [self.redis_key(lim.name, key) for lim, key in entries]
        args: list[str | int | float] = [uuid.uuid4().hex]
        for lim, _ in entries:
            args += [lim.limit, lim.window]
        wait = int(await self._script(keys=keys, args=args))
        return wait or None

    async def aclose(self) -> None:
        if self.redis is not None:
            await self.redis.aclose()


class SharedLimiter:
    """A sliding window whose counts live in Redis, with an in-process copy as the fallback."""

    def __init__(self, name: str, limit: int, window_seconds: float, store: AttemptStore):
        self.name = name
        self.limit = limit
        self.window = window_seconds
        self._store = store
        self._local = RateLimiter(limit, window_seconds)

    async def forgive(self, key: str) -> None:
        """Drop the most recent hit, e.g. when an attempt turned out to be fine."""
        self._local.forgive(key)
        if self._store.usable:
            try:
                assert self._store.redis is not None
                await self._store.redis.zpopmax(self._store.redis_key(self.name, key))
            except Exception as exc:
                self._store.failed(exc)

    async def reset(self, key: str) -> None:
        self._local.reset(key)
        if self._store.usable:
            try:
                assert self._store.redis is not None
                await self._store.redis.delete(self._store.redis_key(self.name, key))
            except Exception as exc:
                self._store.failed(exc)

    def sweep(self) -> None:
        self._local.sweep()


def _too_many(wait: int) -> ApiError:
    return ApiError(
        429,
        "rate_limited",
        "Too many attempts, try again later",
        headers={"Retry-After": str(wait)},
    )


async def hit(*entries: tuple[SharedLimiter, str]) -> None:
    """Counts one attempt on every (limiter, key) pair, or raises 429 and counts none.

    The check and the count are one step, so a burst of concurrent guesses cannot all pass the
    check before any is counted.
    """
    store = entries[0][0]._store
    if store.usable:
        try:
            wait = await store.hit(list(entries))
        except Exception as exc:
            store.failed(exc)
        else:
            if wait is not None:
                raise _too_many(wait)
            return
    # No Redis: count here. The check covers every pair first, so a blocked attempt is free.
    for limiter, key in entries:
        limiter._local.check(key)
    for limiter, key in entries:
        limiter._local.record(key)


class AuthLimits:
    """The limiters guarding sign-in, registration, passwords, 2FA codes and TV PINs."""

    def __init__(self, settings):
        window = settings.login_window_seconds
        self.store = AttemptStore(settings.redis_url)
        new = lambda name, limit, secs: SharedLimiter(name, limit, secs, self.store)  # noqa: E731
        self.login_ip = new("login_ip", settings.login_ip_limit, window)
        self.login_user = new("login_user", settings.login_user_limit, window)
        self.register_ip = new(
            "register_ip", settings.register_ip_limit, settings.register_window_seconds
        )
        self.register_user = new(
            "register_user", settings.register_user_limit, settings.register_window_seconds
        )
        # Wrong current passwords on /me/password, per user.
        self.password_user = new("password_user", settings.login_user_limit, window)
        # Wrong second-step codes, per user and per address. A 6-digit code has only a million
        # values, so these stay tight.
        self.mfa_user = new("mfa_user", settings.login_user_limit, window)
        self.mfa_ip = new("mfa_ip", settings.login_ip_limit, window)
        # Wrong TV PINs. A PIN has only 10^4 to 10^6 values, so a TV session gets a few tries
        # and the account a few more across every TV; successes take their hit back.
        self.pin_session = new("pin_session", 5, 300)
        self.pin_user = new("pin_user", 20, 3600)

    def _all(self) -> tuple[SharedLimiter, ...]:
        return (
            self.login_ip,
            self.login_user,
            self.register_ip,
            self.register_user,
            self.password_user,
            self.mfa_user,
            self.mfa_ip,
            self.pin_session,
            self.pin_user,
        )

    def sweep(self) -> None:
        for limiter in self._all():
            limiter.sweep()


# Caps on actions that cost other people (notifications), outside services (MAL) or the server
# (image decoding), as (hits, window in seconds). Generous for a person, tight for a script.
ACTION_RULES: dict[str, tuple[int, float]] = {
    # Per client address: the browser reaches this one directly, without a session.
    "mal_callback": (20, 600),
    "mal_link": (10, 600),
    "mal_list_write": (120, 600),
    "user_lookup": (60, 600),
    "friend_request": (30, 3600),
    "avatar_upload": (20, 3600),
    "room_create": (20, 3600),
    "room_invite": (60, 3600),
    # Minting a stream link, and starting a playback from one (each looks the stream up upstream).
    "stream_link": (120, 600),
    # Saving a watch or reading position: a player saves every few seconds, a script can do more.
    "progress_save": (300, 600),
    # Resolving an episode asks the scrapers, warming one does too, and a search asks MAL.
    "play": (90, 600),
    "prepare": (120, 600),
    "search": (120, 60),
    "stream_start": (120, 600),
    # TV sign-in: showing a code and polling it per address, entering codes per user.
    "device_start": (20, 600),
    "device_poll": (300, 600),
    "device_code": (20, 600),
    "push_test": (10, 600),
    "push_subscribe": (30, 600),
    # The TV player's health reports: one every 30 s, plus one per fatal error.
    "tv_health": (60, 600),
    "room_chat": (40, 60),
    "room_reaction": (60, 60),
}


class ActionLimits:
    """One sliding window per action, keyed by user id (or client address)."""

    def __init__(
        self,
        rules: dict[str, tuple[int, float]] = ACTION_RULES,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._limiters = {
            name: RateLimiter(limit, window, clock) for name, (limit, window) in rules.items()
        }

    def hit(self, action: str, key: str) -> None:
        """Counts one attempt, or raises 429 when `key` is over the action's limit."""
        limiter = self._limiters[action]
        limiter.check(key)
        limiter.record(key)

    def sweep(self) -> None:
        for limiter in self._limiters.values():
            limiter.sweep()
