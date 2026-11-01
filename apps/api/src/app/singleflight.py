import asyncio
from collections.abc import Awaitable, Callable, Hashable


class SingleFlight[K: Hashable, V]:
    """Lets concurrent callers for the same key share one in-flight call."""

    def __init__(self) -> None:
        self._inflight: dict[K, asyncio.Future[V]] = {}

    async def run(self, key: K, fetch: Callable[[], Awaitable[V]]) -> V:
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.ensure_future(fetch())
            self._inflight[key] = task
            task.add_done_callback(lambda t: self._finish(key, t))
        # Shielded: one caller giving up must not cancel the call the others wait on.
        return await asyncio.shield(task)

    def _finish(self, key: K, task: asyncio.Future[V]) -> None:
        self._inflight.pop(key, None)
        # Read the outcome, so a call that fails after every waiter gave up isn't reported
        # as "exception was never retrieved".
        if not task.cancelled():
            task.exception()
