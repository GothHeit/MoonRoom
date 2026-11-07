"""A small in-process sliding-window limiter.

State lives in this process only, which is fine for a single API instance. Running several
instances would need a shared store (e.g. Redis) instead.
"""

import time
from collections import deque
from collections.abc import Callable

from app.errors import ApiError


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


class AuthLimits:
    """The limiters guarding /auth/login and /auth/register."""

    def __init__(self, settings):
        window = settings.login_window_seconds
        self.login_ip = RateLimiter(settings.login_ip_limit, window)
        self.login_user = RateLimiter(settings.login_user_limit, window)
        self.register_ip = RateLimiter(settings.register_ip_limit, settings.register_window_seconds)
        self.register_user = RateLimiter(
            settings.register_user_limit, settings.register_window_seconds
        )
        # Wrong current passwords on /me/password, per user.
        self.password_user = RateLimiter(settings.login_user_limit, window)
        # Wrong second-step codes, per user and per address. A 6-digit code has only a million
        # values, so these stay tight.
        self.mfa_user = RateLimiter(settings.login_user_limit, window)
        self.mfa_ip = RateLimiter(settings.login_ip_limit, window)
        # Wrong TV PINs. A PIN has only 10^4 to 10^6 values, so a TV session gets a few tries
        # and the account a few more across every TV; successes take their hit back.
        self.pin_session = RateLimiter(5, 300)
        self.pin_user = RateLimiter(20, 3600)

    def sweep(self) -> None:
        for limiter in (self.login_ip, self.login_user, self.register_ip, self.register_user):
            limiter.sweep()
        self.password_user.sweep()
        self.mfa_user.sweep()
        self.mfa_ip.sweep()
        self.pin_session.sweep()
        self.pin_user.sweep()


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
    "stream_start": (120, 600),
    # TV sign-in: showing a code and polling it per address, entering codes per user.
    "device_start": (20, 600),
    "device_poll": (300, 600),
    "device_code": (20, 600),
    "push_test": (10, 600),
    "push_subscribe": (30, 600),
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
