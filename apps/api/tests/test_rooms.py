import time
import uuid

import httpx
import pytest
import respx

from app.errors import ApiError
from app.main import app
from app.mal.client import API_BASE
from app.rooms import (
    EMPTY_GRACE_SECONDS,
    EPISODE_LEAD_SECONDS,
    HOST_GRACE_SECONDS,
    MAX_MEMBERS,
    SEEK_LEAD_SECONDS,
    START_LEAD_SECONDS,
    Room,
    Rooms,
)
from tests.conftest import make_user
from tests.mal_fixtures import node


@pytest.fixture(autouse=True)
def known_title(request):
    """Creating a room looks the title up; seed the cache so no test calls MAL."""
    if "client" in request.fixturenames:
        request.getfixturevalue("client")
        app.state.mal._details[21] = node(21, rating="pg_13")


def drain(queue):
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


def new_room() -> tuple[Room, uuid.UUID]:
    host = uuid.uuid4()
    return Rooms().create(host, "zoko", 21, "One Piece", 1, "sub"), host


async def test_join_sends_the_state_and_tells_the_others():
    room, host = new_room()
    first = room.join(host, "kafka")
    assert drain(first)[0][0] == "state"
    guest = uuid.uuid4()
    room.join(guest, "friend")
    kind, data = drain(first)[0]
    assert kind == "state"
    assert [m["username"] for m in data["members"]] == ["kafka", "friend"]


async def test_the_room_holds_ten_people_and_a_second_tab_does_not_count():
    room, host = new_room()
    room.join(host, "kafka")
    for i in range(MAX_MEMBERS - 1):
        room.join(uuid.uuid4(), f"user{i}")
    with pytest.raises(ApiError) as full:
        room.join(uuid.uuid4(), "late")
    assert full.value.code == "room_full"
    room.join(host, "kafka")


async def test_play_pause_and_seek_reach_everyone():
    room, host = new_room()
    q1 = room.join(host, "kafka")
    guest = uuid.uuid4()
    q2 = room.join(guest, "friend")
    drain(q1), drain(q2)
    room.control(guest, "play", 10)
    room.control(host, "seek", 300)
    events = drain(q1)
    assert [e[0] for e in events] == ["playback", "playback"]
    assert events[0][1]["playing"] is True
    assert events[1][1]["position"] >= 300
    room.control(guest, "pause", 301)
    paused = drain(q2)[-1][1]
    assert (paused["playing"], paused["position"], paused["by"]) == (False, 301, str(guest))


async def test_starts_are_scheduled_a_moment_ahead_so_everyone_starts_together():
    room, host = new_room()
    q = room.join(host, "kafka")
    drain(q)
    before = time.time() * 1000
    room.control(host, "play", 10)
    started = drain(q)[-1][1]
    assert started["playing"] is True and started["position"] == 10
    # The start is a moment away: until then the room waits at 10.
    assert started["at"] >= before + START_LEAD_SECONDS * 1000 - 5
    assert room.now_position() == 10

    room.control(host, "seek", 100)
    sought = drain(q)[-1][1]
    assert sought["at"] >= before + SEEK_LEAD_SECONDS * 1000 - 5

    room.control(host, "pause", 100.5)
    paused = drain(q)[-1][1]
    assert paused["playing"] is False and paused["position"] == 100.5


async def test_every_playback_change_has_a_newer_version():
    room, host = new_room()
    q = room.join(host, "kafka")
    slow = uuid.uuid4()
    room.join(slow, "slow")
    versions = [room.version]
    room.control(host, "play", 0)
    versions.append(room.version)
    room.set_buffering(slow, True)
    versions.append(room.version)
    room.set_buffering(slow, False)
    versions.append(room.version)
    room.vote_episode(host, 2)
    versions.append(room.version)
    assert versions == sorted(set(versions))
    playbacks = [d for kind, d in drain(q) if kind == "playback"]
    assert [p["version"] for p in playbacks] == sorted(p["version"] for p in playbacks)


async def test_a_new_episode_starts_after_a_countdown():
    room, host = new_room()
    room.join(host, "kafka")
    room.vote_episode(host, 2)
    playback = room.playback()
    assert playback["playing"] is True and playback["position"] == 0
    assert playback["at"] >= time.time() * 1000 + EPISODE_LEAD_SECONDS * 1000 - 50


async def test_each_snapshot_has_a_new_revision_and_a_joiner_has_the_latest():
    room, host = new_room()
    q = room.join(host, "kafka")
    first = drain(q)[0][1]["revision"]
    guest = uuid.uuid4()
    q2 = room.join(guest, "friend")
    told = drain(q)[0][1]["revision"]
    assert told > first
    assert drain(q2)[0][1]["revision"] == told == room.revision


async def test_locked_controls_are_host_only():
    room, host = new_room()
    room.join(host, "kafka")
    guest = uuid.uuid4()
    room.join(guest, "friend")
    with pytest.raises(ApiError):
        room.set_locked(guest, True)
    room.set_locked(host, True)
    with pytest.raises(ApiError) as locked:
        room.control(guest, "pause", 0)
    assert locked.value.code == "controls_locked"
    room.control(host, "pause", 0)


async def test_the_host_switches_the_stream_for_everyone_at_the_same_spot():
    room, host = new_room()
    room.join(host, "kafka")
    guest = uuid.uuid4()
    q = room.join(guest, "friend")
    room.control(host, "play", 300)
    room.set_buffering(guest, True)
    drain(q)
    with pytest.raises(ApiError) as error:
        room.set_stream(guest, "animesdigital", "sub")
    assert error.value.code == "host_only"

    room.set_stream(host, "animesdigital", "dub")
    kind, state = drain(q)[-1]
    assert kind == "state"
    assert (state["source"], state["lang"], state["episode"]) == ("animesdigital", "dub", 1)
    assert state["playback"]["position"] >= 300
    # The old stream's stall no longer holds anyone.
    assert state["buffering"] == [] and not room.held

    room.set_stream(host, "animesdigital", "dub")
    assert drain(q) == []


async def test_strangers_cannot_act():
    room, host = new_room()
    room.join(host, "kafka")
    with pytest.raises(ApiError) as error:
        room.say(uuid.uuid4(), "hi")
    assert error.value.code == "not_in_room"


async def test_episode_changes_by_majority_and_the_host_overrides():
    room, host = new_room()
    room.join(host, "kafka")
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for user, name in ((a, "a"), (b, "b"), (c, "c")):
        room.join(user, name)
    room.vote_episode(a, 2)
    assert room.episode == 1
    room.vote_episode(b, 2)
    assert room.episode == 1  # 2 of 4 is not a majority
    room.vote_episode(c, 2)
    assert room.episode == 2
    assert room.votes == {}
    assert room.playing and room.now_position() < 1
    room.vote_episode(host, 5)
    assert room.episode == 5


async def test_a_vote_leaves_with_its_voter_and_can_be_withdrawn():
    room, host = new_room()
    room.join(host, "kafka")
    a, b = uuid.uuid4(), uuid.uuid4()
    qa = room.join(a, "a")
    room.join(b, "b")
    room.vote_episode(a, 3)
    room.withdraw_vote(a)
    assert room.votes == {}
    room.vote_episode(a, 3)
    room.leave(a, qa)
    assert room.votes == {}


async def test_the_host_passes_to_the_next_person_and_an_empty_room_is_swept():
    rooms = Rooms()
    host, guest = uuid.uuid4(), uuid.uuid4()
    room = rooms.create(host, "zoko", 21, "One Piece", 1, "sub")
    q1 = room.join(host, "kafka")
    room.join(guest, "friend")
    room.leave(host, q1)
    assert room.host_id == host  # a reload doesn't cost the host the room
    room._pass_host(host)
    assert room.host_id == guest
    room.empty_since = time.monotonic() - EMPTY_GRACE_SECONDS - 1
    rooms.sweep()
    assert len(rooms) == 1  # not empty, so kept
    room.leave(guest, next(iter(room.members[guest].queues)))
    room.empty_since = time.monotonic() - EMPTY_GRACE_SECONDS - 1
    rooms.sweep()
    assert len(rooms) == 0


async def test_chat_is_trimmed_kept_for_latecomers_and_reactions_are_not():
    room, host = new_room()
    room.join(host, "kafka")
    room.say(host, "  hello  ")
    room.react(host, "🔥")
    with pytest.raises(ApiError):
        room.say(host, "   ")
    with pytest.raises(ApiError):
        room.react(host, "💩")
    late = room.join(uuid.uuid4(), "late")
    chats = [data for kind, data in drain(late) if kind == "chat"]
    assert [c["text"] for c in chats] == ["hello"]


async def test_the_api_creates_and_runs_a_room(client, session):
    _, host_headers = await make_user(session, "kafka")
    guest, guest_headers = await make_user(session, "friend")
    app.state.sources = {"zoko": object()}

    created = await client.post(
        "/watch/rooms",
        json={"source": "zoko", "anime_id": 21, "title": "One Piece", "episode": 1},
        headers=host_headers,
    )
    assert created.status_code == 201
    assert created.json()["title"] == app.state.mal._details[21]["title"]
    code = created.json()["code"]

    found = await client.get(f"/watch/rooms/{code.lower()}", headers=guest_headers)
    assert found.status_code == 200
    missing = await client.get("/watch/rooms/NOPE00", headers=guest_headers)
    assert missing.status_code == 404

    queue = app.state.rooms.get(code).join(guest.id, "friend")
    drain(queue)
    chat = await client.post(
        f"/watch/rooms/{code}/chat", json={"text": "hi"}, headers=guest_headers
    )
    assert chat.status_code == 204
    assert drain(queue)[0][1]["text"] == "hi"

    stranger = await client.post(
        f"/watch/rooms/{code}/control", json={"action": "play"}, headers=host_headers
    )
    assert stranger.status_code == 403 and stranger.json()["error"]["code"] == "not_in_room"

    locked = await client.put(
        f"/watch/rooms/{code}/lock", json={"locked": True}, headers=guest_headers
    )
    assert locked.status_code == 403

    stream = {"source": "zoko", "lang": "dub"}
    switched = await client.put(f"/watch/rooms/{code}/stream", json=stream, headers=host_headers)
    assert switched.status_code == 204
    assert app.state.rooms.get(code).lang == "dub"
    off = await client.put(
        f"/watch/rooms/{code}/stream", json={"source": "nope", "lang": "sub"}, headers=host_headers
    )
    assert off.status_code == 404
    guest_switch = await client.put(
        f"/watch/rooms/{code}/stream", json=stream, headers=guest_headers
    )
    assert guest_switch.status_code == 403


async def test_the_clock_tells_the_server_time(client):
    before = time.time() * 1000
    response = await client.get("/watch/rooms/clock")
    assert response.status_code == 200
    assert before - 5 <= response.json()["now"] <= time.time() * 1000 + 5


async def test_creating_a_room_needs_login_and_an_enabled_source(client, session):
    body = {"source": "nope", "anime_id": 21, "title": "One Piece", "episode": 1}
    assert (await client.post("/watch/rooms", json=body)).status_code == 401
    _, headers = await make_user(session, "kafka")
    app.state.sources = {}
    missing = await client.post("/watch/rooms", json=body, headers=headers)
    assert missing.status_code == 404


async def test_a_host_who_comes_back_keeps_the_room():
    room, host = new_room()
    q1 = room.join(host, "kafka")
    room.join(uuid.uuid4(), "friend")
    room.leave(host, q1)
    room.join(host, "kafka")
    room._pass_host(host)
    assert room.host_id == host


async def test_a_vote_that_becomes_a_majority_when_someone_leaves_switches():
    room, host = new_room()
    room.join(host, "kafka")
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    room.join(a, "a")
    room.join(b, "b")
    qc = room.join(c, "c")
    room.vote_episode(a, 2)
    room.vote_episode(b, 2)
    assert room.episode == 1
    room.leave(c, qc)
    assert room.episode == 2


async def test_one_person_cannot_hold_many_rooms():
    rooms = Rooms()
    host = uuid.uuid4()
    for _ in range(3):
        rooms.create(host, "zoko", 21, "One Piece", 1, "sub").join(host, "kafka")
    with pytest.raises(ApiError) as error:
        rooms.create(host, "zoko", 21, "One Piece", 1, "sub")
    assert error.value.code == "too_many_rooms"


async def open_room(client, headers):
    app.state.sources = {"zoko": object()}
    created = await client.post(
        "/watch/rooms",
        json={"source": "zoko", "anime_id": 21, "title": "One Piece", "episode": 3},
        headers=headers,
    )
    return created.json()["code"]


async def befriend(client, a_headers, a_id, b_headers, b_name):
    await client.post("/friends/requests", json={"username": b_name}, headers=a_headers)
    await client.post(f"/friends/requests/{a_id}/accept", headers=b_headers)


async def test_an_invited_friend_joining_can_not_be_invited_again(client, session):
    host, host_headers = await make_user(session, "kafka")
    guest, guest_headers = await make_user(session, "friend")
    await befriend(client, host_headers, host.id, guest_headers, "friend")
    code = await open_room(client, host_headers)
    room = app.state.rooms.get(code)
    room.join(host.id, "kafka")
    body = {"user_id": str(guest.id)}
    sent = await client.post(f"/watch/rooms/{code}/invite", json=body, headers=host_headers)
    assert sent.status_code == 204
    room.join(guest.id, "friend")
    again = await client.post(f"/watch/rooms/{code}/invite", json=body, headers=host_headers)
    assert again.status_code == 409


async def test_only_members_can_invite_and_only_friends_can_be_invited(client, session):
    host, host_headers = await make_user(session, "kafka")
    guest, guest_headers = await make_user(session, "friend")
    code = await open_room(client, host_headers)
    body = {"user_id": str(guest.id)}
    stranger = await client.post(f"/watch/rooms/{code}/invite", json=body, headers=host_headers)
    assert stranger.status_code == 403 and stranger.json()["error"]["code"] == "invite_not_friends"
    await befriend(client, host_headers, host.id, guest_headers, "friend")
    outside = await client.post(f"/watch/rooms/{code}/invite", json=body, headers=host_headers)
    assert outside.status_code == 403 and outside.json()["error"]["code"] == "not_in_room"


async def test_a_stalled_viewer_holds_the_room_until_they_recover():
    room, host = new_room()
    q_host = room.join(host, "kafka")
    slow = uuid.uuid4()
    room.join(slow, "slow")
    room.control(host, "play", 50)
    drain(q_host)

    room.set_buffering(slow, True)
    kinds = [kind for kind, _ in drain(q_host)]
    assert "playback" in kinds
    assert room.playing is False and room.held is True
    assert room.snapshot()["buffering"] == [str(slow)]

    room.set_buffering(slow, False)
    assert room.playing is True and room.held is False
    assert room.snapshot()["buffering"] == []
    assert room.now_position() >= 50


async def test_the_hold_waits_for_everyone_and_a_viewer_who_leaves_releases_it():
    room, host = new_room()
    room.join(host, "kafka")
    a, b = uuid.uuid4(), uuid.uuid4()
    qa = room.join(a, "a")
    room.join(b, "b")
    room.control(host, "play", 0)
    room.set_buffering(a, True)
    room.set_buffering(b, True)
    room.set_buffering(a, False)
    assert room.held is True
    room.leave(b, next(iter(room.members[b].queues)))
    assert room.playing is True and room.held is False
    del qa


async def test_buffering_while_paused_does_not_start_playback():
    room, host = new_room()
    room.join(host, "kafka")
    slow = uuid.uuid4()
    room.join(slow, "slow")
    room.set_buffering(slow, True)
    room.set_buffering(slow, False)
    assert room.playing is False


async def test_someone_choosing_to_pause_during_a_hold_keeps_the_room_paused():
    room, host = new_room()
    room.join(host, "kafka")
    slow = uuid.uuid4()
    room.join(slow, "slow")
    room.control(host, "play", 5)
    room.set_buffering(slow, True)
    room.control(host, "pause", 5)
    room.set_buffering(slow, False)
    assert room.playing is False


async def test_a_viewer_who_stays_stuck_times_out_and_cannot_hold_the_room_again():
    room, host = new_room()
    room.join(host, "kafka")
    slow = uuid.uuid4()
    room.join(slow, "slow")
    room.control(host, "play", 0)
    room.set_buffering(slow, True)
    room._release_hold()
    assert room.playing is True and room.buffering == {}
    room.set_buffering(slow, True)
    assert room.buffering == {} and room.playing is True


async def test_the_buffering_endpoint_needs_membership(client, session):
    _, host_headers = await make_user(session, "kafka")
    app.state.sources = {"zoko": object()}
    created = await client.post(
        "/watch/rooms",
        json={"source": "zoko", "anime_id": 21, "title": "One Piece", "episode": 1},
        headers=host_headers,
    )
    code = created.json()["code"]
    response = await client.post(
        f"/watch/rooms/{code}/buffering", json={"buffering": True}, headers=host_headers
    )
    assert response.status_code == 403


async def test_abandoned_rooms_do_not_count_against_the_host():
    rooms = Rooms(max_per_host=10)
    host = uuid.uuid4()
    for _ in range(3):
        rooms.create(host, "zoko", 21, "One Piece", 1, "sub")
    # None of them has anyone in it, so a fourth is fine and replaces them. A room only just
    # created is kept, because its host has not connected yet.
    rooms.create(host, "zoko", 21, "One Piece", 1, "sub")
    assert len(rooms) == 4
    for room in rooms._rooms.values():
        room.empty_since = time.monotonic() - EMPTY_GRACE_SECONDS - 1
    rooms.create(host, "zoko", 21, "One Piece", 1, "sub")
    assert len(rooms) == 1


async def test_a_guest_cannot_hold_a_locked_room():
    room, host = new_room()
    room.join(host, "kafka")
    guest = uuid.uuid4()
    room.join(guest, "friend")
    room.control(host, "play", 0)
    room.set_locked(host, True)
    room.set_buffering(guest, True)
    assert room.playing is True and room.buffering == {}


async def test_a_seek_during_a_hold_keeps_the_hold_so_the_room_still_resumes():
    room, host = new_room()
    room.join(host, "kafka")
    slow = uuid.uuid4()
    room.join(slow, "slow")
    room.control(host, "play", 0)
    room.set_buffering(slow, True)
    room.control(host, "seek", 30)
    assert room.held is True and room.playing is False
    room.set_buffering(slow, False)
    assert room.playing is True and room.now_position() >= 30


async def test_flapping_the_flag_cannot_keep_pausing_the_room():
    room, host = new_room()
    room.join(host, "kafka")
    rude = uuid.uuid4()
    room.join(rude, "rude")
    room.control(host, "play", 0)
    room.set_buffering(rude, True)
    room.set_buffering(rude, False)
    room.set_buffering(rude, True)
    assert room.playing is True and room.buffering == {}


async def test_two_stalled_viewers_share_one_hold_and_the_room_waits_for_both():
    room, host = new_room()
    room.join(host, "kafka")
    a, b = uuid.uuid4(), uuid.uuid4()
    room.join(a, "a")
    room.join(b, "b")
    room.control(host, "play", 0)
    room.set_buffering(a, True)
    room.set_buffering(b, True)
    assert set(room.buffering) == {a, b}
    room.set_buffering(a, False)
    assert room.playing is False
    room.set_buffering(b, False)
    assert room.playing is True


@respx.mock
async def test_a_room_cannot_be_made_for_a_title_hidden_by_the_adult_switch(client, session):
    _, headers = await make_user(session, "kafka", nsfw=False)
    app.state.sources = {"zoko": object()}
    respx.get(f"{API_BASE}/anime/9").mock(
        return_value=httpx.Response(200, json=node(9, rating="rx"))
    )
    body = {"source": "zoko", "anime_id": 9, "title": "Hidden", "episode": 1}
    hidden = await client.post("/watch/rooms", json=body, headers=headers)
    assert hidden.status_code == 404
    _, adult = await make_user(session, "adult", nsfw=True)
    assert (await client.post("/watch/rooms", json=body, headers=adult)).status_code == 201


async def test_a_room_whose_host_never_returns_goes_to_the_next_joiner():
    room, host = new_room()
    friend = uuid.uuid4()
    qh = room.join(host, "kafka")
    qf = room.join(friend, "friend")
    room.leave(host, qh)
    room.leave(friend, qf)  # a Wi-Fi blip took both out; the host's timer found nobody to pass to

    room.host_left_at = time.monotonic() - 1
    room.join(friend, "friend")  # back within the grace: the host may still return
    assert room.host_id == host

    room.leave(friend, next(iter(room.members[friend].queues)))
    room.host_left_at = time.monotonic() - HOST_GRACE_SECONDS - 1
    room.join(friend, "friend")  # the grace is over: the room is theirs
    assert room.host_id == friend
    room.join(host, "kafka")
    assert room.host_id == friend
