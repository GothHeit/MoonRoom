import httpx
import respx

from app import sharedcache
from app.anizip import API, AniZip
from app.sharedcache import SharedCache


class FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.down = False
        self.ops = 0

    def pipeline(self, transaction: bool = False):
        return FakePipe(self)

    async def set(self, key, value, ex=None):
        self._check()
        self.data[key] = value.encode()

    async def aclose(self):
        pass

    def _check(self):
        self.ops += 1
        if self.down:
            raise ConnectionError("down")


class FakePipe:
    def __init__(self, redis: FakeRedis) -> None:
        self.redis = redis
        self.keys: list[str] = []

    def get(self, key):
        self.keys.append(key)

    def pttl(self, key):
        pass

    async def execute(self):
        self.redis._check()
        return self.redis.data.get(self.keys[0]), 60000


def shared(redis: FakeRedis, **kwargs) -> SharedCache:
    cache = SharedCache(**kwargs)
    cache._redis = redis  # type: ignore[assignment]
    return cache


async def test_values_cross_workers_through_redis():
    redis = FakeRedis()
    a, b = shared(redis), shared(redis)
    await a.set("ns", ("k", 1), {"x": [1, 2]}, 60)
    assert await b.get("ns", ("k", 1)) == {"x": [1, 2]}
    assert await b.get("ns", ("k", 2)) is None


async def test_memory_only_without_redis():
    cache = SharedCache()
    await cache.set("ns", 1, {"a": 1}, 60)
    assert await cache.get("ns", 1) == {"a": 1}
    assert not cache.using_redis


async def test_redis_down_falls_back_and_trips_breaker():
    redis = FakeRedis()
    redis.down = True
    cache = shared(redis)
    await cache.set("ns", 1, {"a": 1}, 60)  # fails, still cached in-process
    assert await cache.get("ns", 1) == {"a": 1}
    assert not cache.using_redis
    ops = redis.ops
    assert await cache.get("ns", 2) is None
    assert redis.ops == ops  # breaker open: Redis not asked again


async def test_redis_recovers_after_breaker(monkeypatch):
    redis = FakeRedis()
    redis.down = True
    cache = shared(redis)
    await cache.get("ns", 1)
    redis.down = False
    monkeypatch.setattr(sharedcache, "BREAKER_SECONDS", 0.0)
    cache._down_until = 0.0
    await cache.set("ns", 1, {"a": 1}, 60)
    assert any(k.startswith("moonroom:ns:") for k in redis.data)


@respx.mock
async def test_anizip_answer_is_shared_between_workers():
    redis = FakeRedis()
    body = {
        "images": [{"coverType": "Fanart", "url": "https://x/f.jpg"}],
        "episodes": {"1": {"title": {"en": "Pilot"}, "image": "https://x/1.jpg"}},
    }
    route = respx.get(API, params={"mal_id": "5"}).mock(return_value=httpx.Response(200, json=body))
    async with httpx.AsyncClient() as http:
        first = await AniZip(http, shared(redis)).art(5)
        second = await AniZip(http, shared(redis)).art(5)  # a "restarted" worker
    assert route.call_count == 1
    assert second == first
    assert second.episodes[1].title("en") == "Pilot"
