import asyncio
import types
import uuid

import httpx
import pytest
import respx

from app import chats as chat_live
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.routers.rooms import live_frames
from app.security import decode_access_token
from tests.conftest import make_user
from tests.mal_fixtures import mock_details
from tests.test_chats import direct, say, user_id
from tests.test_friends import befriend


def stream_for(headers):
    """What a stream opened with these credentials holds: a request and the viewer's ids."""
    decoded = decode_access_token(headers["Authorization"].removeprefix("Bearer "))
    assert decoded is not None
    user_id_, sid = decoded
    request = types.SimpleNamespace(app=fastapi_app, state=types.SimpleNamespace(stream_sid=sid))
    return request, user_id_, sid


async def test_a_stream_stops_delivering_once_the_session_is_signed_out(client, session):
    _, bob = await make_user(session, "bob")
    request, bob_id, sid = stream_for(bob)
    queue: asyncio.Queue = asyncio.Queue()
    frames = live_frames(request, bob_id, queue, dict, keepalive=0.05)
    assert await anext(frames) == "retry: 3000\n\n"
    queue.put_nowait(("message", {"body": "hi"}))
    assert "event: message" in await anext(frames)
    # Signed out here (a password change or a reset link does the same).
    fastapi_app.state.session_check.closed(sid)
    queue.put_nowait(("message", {"body": "secret"}))
    with pytest.raises(StopAsyncIteration):
        await anext(frames)


async def test_an_idle_stream_ends_at_the_next_tick_after_sign_out(client, session):
    _, bob = await make_user(session, "bob")
    request, bob_id, sid = stream_for(bob)
    frames = live_frames(request, bob_id, asyncio.Queue(), dict, keepalive=0.05)
    await anext(frames)
    assert "event: tick" in await anext(frames)
    fastapi_app.state.session_check.closed(sid)
    with pytest.raises(StopAsyncIteration):
        await anext(frames)


def test_opening_too_many_streams_closes_the_oldest():
    hub = chat_live.ChatHub()
    who = uuid.uuid4()
    queues = [hub.subscribe(who) for _ in range(chat_live.MAX_STREAMS + 1)]
    assert queues[0].get_nowait() is None
    assert all(q.empty() for q in queues[1:])
    hub.publish([who], "message", {})
    assert queues[0].empty() and not queues[-1].empty()


@respx.mock
async def test_sending_or_sharing_does_not_mark_the_chat_read(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    ana_id = await user_id(client, ana)
    chat_id = (await direct(client, bob, ana_id)).json()["id"]
    await say(client, ana, chat_id, "one")
    await say(client, ana, chat_id, "two")
    seen_before = (await client.get(f"/chats/{chat_id}", headers=ana)).json()["read_at"]
    mock_details(7)
    bob_id = await user_id(client, bob)
    # Bob answers by sharing a title from elsewhere, and by typing; he hasn't opened the chat.
    r = await client.post(
        "/chats/share",
        json={"share": {"kind": "anime", "id": 7}, "chat_ids": [chat_id]},
        headers=bob,
    )
    assert r.status_code == 201
    await say(client, bob, chat_id, "typed")
    assert (await client.get("/chats/unread", headers=bob)).json() == {"chats": 1}
    assert (await client.get(f"/chats/{chat_id}", headers=bob)).json()["unread"] == 2
    # Ana sees no "Seen" from him yet.
    assert (await client.get(f"/chats/{chat_id}", headers=ana)).json()["read_at"] == seen_before
    assert bob_id


async def test_reading_a_group_is_told_to_the_reader_only(client, session):
    ana_user, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    cid_user, cid = await make_user(session, "cid")
    await befriend(client, ana, bob, "bob")
    await befriend(client, ana, cid, "cid")
    group = (
        await client.post(
            "/chats/groups", json={"user_ids": [str(bob_user.id), str(cid_user.id)]}, headers=ana
        )
    ).json()
    hub = fastapi_app.state.chat_hub
    a, b = hub.subscribe(ana_user.id), hub.subscribe(bob_user.id)
    try:
        await client.put(f"/chats/{group['id']}/read", headers=bob)
        assert b.get_nowait()[0] == "read"
        assert a.empty()
    finally:
        hub.unsubscribe(ana_user.id, a)
        hub.unsubscribe(bob_user.id, b)


async def test_adding_the_same_friend_twice_at_once_is_not_an_error(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, cid = await make_user(session, "cid")
    await befriend(client, ana, bob, "bob")
    await befriend(client, ana, cid, "cid")
    bob_id, cid_id = await user_id(client, bob), await user_id(client, cid)
    group = (await client.post("/chats/groups", json={"user_ids": [bob_id]}, headers=ana)).json()
    url = f"/chats/{group['id']}/members"
    results = await asyncio.gather(
        *(client.post(url, json={"user_ids": [cid_id]}, headers=ana) for _ in range(4))
    )
    assert [r.status_code for r in results] == [200] * 4
    chat = (await client.get(f"/chats/{group['id']}", headers=ana)).json()
    assert sorted(m["username"] for m in chat["members"]) == ["bob", "cid"]


async def test_group_names_lose_hidden_direction_marks(client, session):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    r = await client.post(
        "/chats/groups",
        json={"user_ids": [str(bob_user.id)], "name": "Fri‮ends​"},
        headers=ana,
    )
    assert r.json()["name"] == "Friends"


@respx.mock
async def test_a_share_counts_once_per_target(client, session, monkeypatch):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    mock_details(7)
    limits = fastapi_app.state.action_limits
    small = type(limits._limiters["chat_message"])(3, 60)
    monkeypatch.setitem(limits._limiters, "chat_message", small)
    chats = [(await direct(client, ana, str(bob_user.id))).json()["id"]]
    groups = [
        (
            await client.post("/chats/groups", json={"user_ids": [str(bob_user.id)]}, headers=ana)
        ).json()["id"]
        for _ in range(3)
    ]
    body = {"share": {"kind": "anime", "id": 7}, "chat_ids": chats + groups}
    r = await client.post("/chats/share", json=body, headers=ana)
    assert r.status_code == 429


@respx.mock
async def test_an_unknown_title_is_not_found(client, session):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    respx.get(f"{API_BASE}/anime/99").mock(return_value=httpx.Response(404))
    r = await client.post(
        "/chats/share",
        json={"share": {"kind": "anime", "id": 99}, "user_ids": [str(bob_user.id)]},
        headers=ana,
    )
    assert r.status_code == 404


async def reply_bell(client, headers):
    items = (await client.get("/notifications", headers=headers)).json()["items"]
    return [n for n in items if n["kind"] == "comment_reply"]


async def test_the_bell_drops_a_reply_that_is_deleted(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    first = (await client.post("/anime/1/comments", json={"body": "Great"}, headers=ana)).json()
    reply = (
        await client.post(f"/comments/{first['id']}/replies", json={"body": "oops"}, headers=bob)
    ).json()
    assert [n["excerpt"] for n in await reply_bell(client, ana)] == ["oops"]
    edited = await client.patch(f"/comments/{reply['id']}", json={"body": "better"}, headers=bob)
    assert edited.status_code == 200
    assert [n["excerpt"] for n in await reply_bell(client, ana)] == ["better"]
    assert (await client.delete(f"/comments/{reply['id']}", headers=bob)).status_code == 204
    assert await reply_bell(client, ana) == []


async def test_the_bell_drops_replies_when_the_friendship_ends(client, session):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    first = (await client.post("/anime/1/comments", json={"body": "Great"}, headers=ana)).json()
    await client.post(f"/comments/{first['id']}/replies", json={"body": "hi"}, headers=bob)
    assert len(await reply_bell(client, ana)) == 1
    assert (await client.delete(f"/friends/{bob_user.id}", headers=ana)).status_code == 204
    assert await reply_bell(client, ana) == []
