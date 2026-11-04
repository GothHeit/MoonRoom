import json
import time
import uuid

import pytest

from app.room_store import KEY, MAX_AGE_SECONDS, RoomStore, restore
from app.rooms import EPISODE_LEAD_SECONDS, Room, Rooms


class FakeRedis:
    """Just the hash commands the room store uses."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, bytes]] = {}
        self.down = False

    def _check(self):
        if self.down:
            raise ConnectionError("down")

    async def hgetall(self, key):
        self._check()
        return dict(self.hashes.get(key, {}))

    async def hdel(self, key, *fields):
        self._check()
        for f in fields:
            self.hashes.get(key, {}).pop(f.decode() if isinstance(f, bytes) else f, None)

    def pipeline(self, transaction: bool = False):
        return FakePipe(self)

    async def aclose(self):
        pass


class FakePipe:
    def __init__(self, redis: FakeRedis) -> None:
        self.redis = redis
        self.ops: list = []

    def hset(self, key, mapping):
        self.ops.append(("hset", key, mapping))

    def hdel(self, key, *fields):
        self.ops.append(("hdel", key, fields))

    async def execute(self):
        self.redis._check()
        for op, key, arg in self.ops:
            target = self.redis.hashes.setdefault(key, {})
            if op == "hset":
                target.update({k: v.encode() for k, v in arg.items()})
            else:
                for f in arg:
                    target.pop(f, None)


def store_with(redis: FakeRedis) -> RoomStore:
    store = RoomStore()
    store._redis = redis  # type: ignore[assignment]
    return store


def playing_room() -> tuple[Rooms, Room, uuid.UUID]:
    rooms = Rooms()
    host = uuid.uuid4()
    room = rooms.create(host, "zoko", 21, "One Piece", 3, "sub")
    room.join(host, "kafka")
    room.control(host, "play", 120)
    room.moved_at -= 30  # playing for half a minute
    room.say(host, "hi")
    return rooms, room, host


async def test_a_room_comes_back_after_a_restart_where_it_was():
    rooms, room, host = playing_room()
    redis = FakeRedis()
    store = store_with(redis)
    saves, removed = rooms.pending()
    assert await store.save(saves, removed)

    after = Rooms()
    await restore(after, store)
    back = after.get(room.code)
    assert (back.anime_id, back.episode, back.source, back.host_id) == (21, 3, "zoko", host)
    assert [m["text"] for m in back.chat] == ["hi"]
    # Still playing, from the same spot at the same moment, newer than anything a viewer holds.
    assert back.playing and abs(back.now_position() - room.now_position()) < 0.05
    assert back.version > room.version and back.revision > room.revision


async def test_a_room_keeps_playing_through_the_time_the_server_was_away():
    rooms, room, host = playing_room()
    saved = room.dump()
    # Saved 8 s ago; the viewers' players kept going meanwhile.
    saved["at"] -= 8
    saved["saved_at"] -= 8
    back = Room.load(saved)
    assert abs(back.now_position() - (room.now_position() + 8)) < 0.05


async def test_a_scheduled_start_is_still_scheduled_after_a_restart():
    rooms = Rooms()
    host = uuid.uuid4()
    room = rooms.create(host, "zoko", 21, "One Piece", 1, "sub")
    room.join(host, "kafka")
    room.vote_episode(host, 2)
    back = Room.load(room.dump())
    assert back.playback()["at"] == pytest.approx(room.playback()["at"], abs=5)
    assert back.playback()["at"] >= time.time() * 1000 + EPISODE_LEAD_SECONDS * 1000 - 100


async def test_a_paused_room_stays_paused_and_the_host_gets_a_grace_period():
    rooms, room, host = playing_room()
    room.control(host, "pause", 200)
    back = Room.load(room.dump())
    back.join(uuid.uuid4(), "friend")
    assert back.playing is False and back.position == 200
    # Someone else joining right away doesn't take the room from its host.
    assert back.host_id == host


async def test_changes_and_occupied_rooms_are_saved_and_closed_rooms_deleted():
    rooms, room, host = playing_room()
    saves, _ = rooms.pending()
    assert [s["code"] for s in saves] == [room.code]
    # Occupied rooms are saved every time, so a restart resumes them from close to now.
    saves, _ = rooms.pending()
    assert [s["code"] for s in saves] == [room.code]

    queue = next(iter(room.members[host].queues))
    room.leave(host, queue)
    room.empty_since = time.monotonic() - 3600
    rooms.pending()
    rooms.sweep()
    saves, removed = rooms.pending()
    assert saves == [] and removed == [room.code]


async def test_old_and_broken_saves_are_dropped():
    redis = FakeRedis()
    rooms, room, _ = playing_room()
    old = room.dump() | {"code": "OLD123", "saved_at": time.time() - MAX_AGE_SECONDS - 1}
    redis.hashes[KEY] = {
        room.code: json.dumps(room.dump()).encode(),
        "OLD123": json.dumps(old).encode(),
        "BAD123": b"{not json",
    }
    loaded = await store_with(redis).load()
    assert [r["code"] for r in loaded] == [room.code]
    assert set(redis.hashes[KEY]) == {room.code}


async def test_without_redis_nothing_is_saved_and_nothing_breaks():
    redis = FakeRedis()
    redis.down = True
    store = store_with(redis)
    rooms, _, _ = playing_room()
    assert await store.save(*rooms.pending()) is False
    assert await store.load() == []
    assert await RoomStore().save(*rooms.pending()) is True
