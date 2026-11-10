import asyncio
import shutil
import socket
import subprocess
import time

import pytest

from app.errors import ApiError
from app.ratelimit import AttemptStore, SharedLimiter, hit


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def redis_url():
    binary = shutil.which("redis-server")
    if binary is None:
        pytest.skip("redis-server is not installed")
    port = free_port()
    proc = subprocess.Popen(
        [binary, "--port", str(port), "--save", "", "--appendonly", "no"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.1).close()
            break
        except OSError:
            time.sleep(0.1)
    yield f"redis://127.0.0.1:{port}/0"
    proc.terminate()
    proc.wait()


async def over_limit(*entries) -> int | None:
    try:
        await hit(*entries)
    except ApiError as exc:
        assert exc.status == 429
        return int((exc.headers or {})["Retry-After"])
    return None


async def test_counts_survive_a_restart_and_are_shared(redis_url):
    first = AttemptStore(redis_url)
    pin = SharedLimiter("pin", 3, 60, first)
    for _ in range(3):
        await hit((pin, "tv"))
    assert await over_limit((pin, "tv")) is not None
    await first.aclose()

    # A new process (a deploy, or a second worker) sees the same count.
    second = AttemptStore(redis_url)
    again = SharedLimiter("pin", 3, 60, second)
    wait = await over_limit((again, "tv"))
    assert wait is not None and 1 <= wait <= 61
    await hit((again, "other"))
    await second.aclose()


async def test_a_blocked_attempt_counts_on_none_of_the_pairs(redis_url):
    store = AttemptStore(redis_url)
    ip = SharedLimiter("ip", 5, 60, store)
    user = SharedLimiter("user", 1, 60, store)
    await hit((ip, "a"), (user, "u"))
    assert await over_limit((ip, "a"), (user, "u")) is not None
    # The blocked tries did not use up the address's budget.
    for _ in range(4):
        await hit((ip, "a"))
    assert await over_limit((ip, "a")) is not None
    await store.aclose()


async def test_forgive_and_reset_take_hits_back(redis_url):
    store = AttemptStore(redis_url)
    limiter = SharedLimiter("l", 2, 60, store)
    await hit((limiter, "k"))
    await hit((limiter, "k"))
    await limiter.forgive("k")
    await hit((limiter, "k"))
    assert await over_limit((limiter, "k")) is not None
    await limiter.reset("k")
    await hit((limiter, "k"))
    await store.aclose()


async def test_concurrent_guesses_cannot_all_pass_the_check(redis_url):
    store = AttemptStore(redis_url)
    limiter = SharedLimiter("c", 5, 60, store)
    results = await asyncio.gather(*(over_limit((limiter, "k")) for _ in range(20)))
    assert sum(r is None for r in results) == 5
    await store.aclose()


async def test_window_expires(redis_url):
    store = AttemptStore(redis_url)
    limiter = SharedLimiter("w", 1, 1, store)
    await hit((limiter, "k"))
    assert await over_limit((limiter, "k")) is not None
    await asyncio.sleep(1.2)
    await hit((limiter, "k"))
    await store.aclose()


async def test_without_redis_it_counts_in_process():
    store = AttemptStore("")
    limiter = SharedLimiter("n", 2, 60, store)
    await hit((limiter, "k"))
    await hit((limiter, "k"))
    assert await over_limit((limiter, "k")) is not None
    await hit((limiter, "other"))
    await limiter.reset("k")
    await hit((limiter, "k"))


async def test_when_redis_is_down_it_does_not_fail_open():
    store = AttemptStore(f"redis://127.0.0.1:{free_port()}/0")
    limiter = SharedLimiter("d", 2, 60, store)
    await hit((limiter, "k"))
    await hit((limiter, "k"))
    assert await over_limit((limiter, "k")) is not None
    assert not store.usable  # the breaker is open: later calls skip the dead server
    await limiter.forgive("k")
    await hit((limiter, "k"))
    await store.aclose()
