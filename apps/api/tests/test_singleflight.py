import asyncio

import httpx
import pytest

from app.errors import ApiError
from app.singleflight import SingleFlight
from app.soft import soft


async def test_concurrent_callers_share_one_call():
    flights: SingleFlight[str, int] = SingleFlight()
    calls = 0

    async def fetch() -> int:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return 7

    results = await asyncio.gather(*(flights.run("k", fetch) for _ in range(5)))
    assert results == [7] * 5
    assert calls == 1
    # Finished calls are forgotten: the next caller starts a new one.
    assert await flights.run("k", fetch) == 7
    assert calls == 2


async def test_failure_reaches_every_waiter_and_is_not_kept():
    flights: SingleFlight[str, int] = SingleFlight()

    async def boom() -> int:
        await asyncio.sleep(0.01)
        raise RuntimeError("down")

    outcomes = await asyncio.gather(
        flights.run("k", boom), flights.run("k", boom), return_exceptions=True
    )
    assert all(isinstance(o, RuntimeError) for o in outcomes)

    async def fine() -> int:
        return 1

    assert await flights.run("k", fine) == 1


async def test_a_caller_giving_up_does_not_cancel_the_call():
    flights: SingleFlight[str, int] = SingleFlight()

    async def slow() -> int:
        await asyncio.sleep(0.05)
        return 3

    first = asyncio.create_task(flights.run("k", slow))
    second = asyncio.create_task(flights.run("k", slow))
    await asyncio.sleep(0)
    first.cancel()
    assert await second == 3


async def test_soft_turns_expected_failures_into_none():
    async def api() -> int:
        raise ApiError(502, "mal_unavailable", "down")

    async def http() -> int:
        raise httpx.ReadTimeout("slow")

    async def value() -> int:
        raise ValueError("bad token")

    async def ok() -> int:
        return 1

    assert await soft(api(), "a") is None
    assert await soft(http(), "b") is None
    assert await soft(value(), "c") is None
    assert await soft(ok(), "d") == 1


async def test_soft_lets_unexpected_errors_through():
    async def bug() -> int:
        raise KeyError("x")

    with pytest.raises(KeyError):
        await soft(bug(), "e")
