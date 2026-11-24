import asyncio
import uuid

import httpx
import respx

from app import chats as chat_live
from app.anizip import API as ANIZIP
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.models import ChatMessage, PushSubscription
from tests.conftest import make_user
from tests.mal_fixtures import mock_details, node
from tests.test_friends import befriend


async def user_id(client, headers) -> str:
    return (await client.get("/me", headers=headers)).json()["id"]


async def direct(client, headers, other_id):
    return await client.post("/chats/direct", json={"user_id": other_id}, headers=headers)


async def say(client, headers, chat_id, body):
    return await client.post(f"/chats/{chat_id}/messages", json={"body": body}, headers=headers)


async def test_only_friends_can_open_a_chat_and_there_is_one_per_pair(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, eve = await make_user(session, "eve")
    await befriend(client, ana, bob, "bob")
    bob_id, eve_id, ana_id = (
        await user_id(client, bob),
        await user_id(client, eve),
        await user_id(client, ana),
    )

    first = await direct(client, ana, bob_id)
    assert first.status_code == 200
    chat = first.json()
    assert chat["kind"] == "direct" and chat["can_send"] is True and chat["last"] is None
    assert [m["username"] for m in chat["members"]] == ["bob"]
    # Bob opening it from his side gets the same chat.
    assert (await direct(client, bob, ana_id)).json()["id"] == chat["id"]
    assert (await direct(client, ana, eve_id)).json()["error"]["code"] == "not_friends"
    assert (await direct(client, ana, ana_id)).json()["error"]["code"] == "chat_self"
    # Eve isn't in it: to her it doesn't exist.
    assert (await client.get(f"/chats/{chat['id']}", headers=eve)).status_code == 404
    assert (await client.get(f"/chats/{chat['id']}/messages", headers=eve)).status_code == 404
    assert (await say(client, eve, chat["id"], "hi")).status_code == 404
    assert (await client.get("/chats")).status_code == 401


async def test_messages_unread_and_seen(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    chat_id = (await direct(client, ana, await user_id(client, bob))).json()["id"]

    r = await say(client, ana, chat_id, "  did you finish the first arc?  ")
    assert r.status_code == 201
    assert r.json()["body"] == "did you finish the first arc?" and r.json()["mine"] is True
    await say(client, ana, chat_id, "hello?")
    assert (await say(client, ana, chat_id, " \n ")).json()["error"]["code"] == "message_empty"
    too_long = await say(client, ana, chat_id, "x" * 2001)
    assert too_long.json()["error"]["code"] == "message_too_long"

    bobs = (await client.get("/chats", headers=bob)).json()["items"]
    assert len(bobs) == 1
    assert bobs[0]["unread"] == 2 and bobs[0]["last"]["body"] == "hello?"
    assert bobs[0]["last"]["mine"] is False and bobs[0]["last"]["user"]["username"] == "ana"
    assert (await client.get("/chats/unread", headers=bob)).json() == {"chats": 1}
    # The sender has read their own messages.
    assert (await client.get("/chats/unread", headers=ana)).json() == {"chats": 0}

    page = (await client.get(f"/chats/{chat_id}/messages", headers=bob)).json()
    assert [m["body"] for m in page["items"]] == ["did you finish the first arc?", "hello?"]
    assert page["next"] is None

    before = (await client.get(f"/chats/{chat_id}", headers=ana)).json()["read_at"]
    assert (await client.put(f"/chats/{chat_id}/read", headers=bob)).status_code == 204
    assert (await client.get("/chats/unread", headers=bob)).json() == {"chats": 0}
    seen = (await client.get(f"/chats/{chat_id}", headers=ana)).json()["read_at"]
    assert seen > before


async def test_muted_chats_do_not_count_on_the_icon(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    chat_id = (await direct(client, ana, await user_id(client, bob))).json()["id"]
    await say(client, ana, chat_id, "psst")
    r = await client.put(f"/chats/{chat_id}/mute", json={"muted": True}, headers=bob)
    assert r.status_code == 204
    assert (await client.get("/chats/unread", headers=bob)).json() == {"chats": 0}
    chat = (await client.get(f"/chats/{chat_id}", headers=bob)).json()
    assert chat["muted"] is True and chat["unread"] == 1


async def test_pages_go_back_in_time(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    chat_id = (await direct(client, ana, await user_id(client, bob))).json()["id"]
    for i in range(5):
        await say(client, ana, chat_id, f"m{i}")
    first = (
        await client.get(f"/chats/{chat_id}/messages", params={"limit": 3}, headers=bob)
    ).json()
    assert [m["body"] for m in first["items"]] == ["m2", "m3", "m4"]
    rest = (
        await client.get(
            f"/chats/{chat_id}/messages", params={"before": first["next"]}, headers=bob
        )
    ).json()
    assert [m["body"] for m in rest["items"]] == ["m0", "m1"] and rest["next"] is None
    bad = await client.get(f"/chats/{chat_id}/messages", params={"before": "x"}, headers=bob)
    assert bad.status_code == 422


async def test_after_unfriending_the_chat_is_read_only(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    bob_id = await user_id(client, bob)
    chat_id = (await direct(client, ana, bob_id)).json()["id"]
    await say(client, ana, chat_id, "bye")
    await client.delete(f"/friends/{bob_id}", headers=ana)

    chat = (await client.get(f"/chats/{chat_id}", headers=ana)).json()
    assert chat["can_send"] is False and chat["last"]["body"] == "bye"
    assert (await say(client, bob, chat_id, "wait")).json()["error"]["code"] == "not_friends"


async def test_only_your_own_message_can_be_taken_back(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    chat_id = (await direct(client, ana, await user_id(client, bob))).json()["id"]
    mid = (await say(client, ana, chat_id, "oops")).json()["id"]
    assert (await client.delete(f"/chats/{chat_id}/messages/{mid}", headers=bob)).status_code == 404
    assert (await client.delete(f"/chats/{chat_id}/messages/{mid}", headers=ana)).status_code == 204
    items = (await client.get(f"/chats/{chat_id}/messages", headers=bob)).json()["items"]
    assert items == []


async def test_groups_are_made_from_friends(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, cid = await make_user(session, "cid")
    _, eve = await make_user(session, "eve")
    await befriend(client, ana, bob, "bob")
    await befriend(client, ana, cid, "cid")
    await befriend(client, bob, eve, "eve")
    bob_id, cid_id, eve_id = (
        await user_id(client, bob),
        await user_id(client, cid),
        await user_id(client, eve),
    )

    r = await client.post("/chats/groups", json={"user_ids": [eve_id]}, headers=ana)
    assert r.json()["error"]["code"] == "not_friends"
    r = await client.post(
        "/chats/groups", json={"name": "  Saturday   anime ", "user_ids": [bob_id]}, headers=ana
    )
    assert r.status_code == 201
    group = r.json()
    assert group["kind"] == "group" and group["name"] == "Saturday anime"

    # Any member adds their own friends: bob brings eve, whom ana doesn't know.
    r = await client.post(f"/chats/{group['id']}/members", json={"user_ids": [cid_id]}, headers=bob)
    assert r.json()["error"]["code"] == "not_friends"
    r = await client.post(f"/chats/{group['id']}/members", json={"user_ids": [eve_id]}, headers=bob)
    assert sorted(m["username"] for m in r.json()["members"]) == ["ana", "eve"]
    await say(client, eve, group["id"], "hi all")
    last = (await client.get(f"/chats/{group['id']}", headers=ana)).json()["last"]
    assert last["body"] == "hi all" and last["user"]["username"] == "eve"

    r = await client.patch(f"/chats/{group['id']}", json={"name": "Friday"}, headers=eve)
    assert r.json()["name"] == "Friday"

    for who in (ana, bob):
        assert (
            await client.delete(f"/chats/{group['id']}/members/me", headers=who)
        ).status_code == 204
    assert (await client.get(f"/chats/{group['id']}", headers=ana)).status_code == 404
    assert (await client.delete(f"/chats/{group['id']}/members/me", headers=eve)).status_code == 204
    # The last one out: the group is gone.
    assert (await client.get(f"/chats/{group['id']}", headers=eve)).status_code == 404


@respx.mock
async def test_sharing_a_title_uses_mal_and_ani_zip(client, session):
    _, ana = await make_user(session, "ana", nsfw=True)
    _, bob = await make_user(session, "bob", nsfw=True)
    _, cid = await make_user(session, "cid", nsfw=False)
    await befriend(client, ana, bob, "bob")
    await befriend(client, ana, cid, "cid")
    bob_id, cid_id = await user_id(client, bob), await user_id(client, cid)
    group = (
        await client.post("/chats/groups", json={"user_ids": [bob_id, cid_id]}, headers=ana)
    ).json()
    mock_details(52991, title="Frieren")
    respx.get(ANIZIP, params={"mal_id": "52991"}).mock(
        return_value=httpx.Response(
            200,
            json={
                "images": [{"coverType": "Fanart", "url": "https://img/wide.jpg"}],
                "episodes": {"4": {"image": "https://img/ep4.jpg"}},
            },
        )
    )

    r = await client.post(
        "/chats/share",
        json={
            "share": {"kind": "anime", "id": 52991, "episode": 4, "title": "ignored"},
            "body": "the fight at the end",
            "user_ids": [bob_id],
            "chat_ids": [group["id"]],
        },
        headers=ana,
    )
    assert r.status_code == 201
    assert len(r.json()["chat_ids"]) == 2
    bobs = (await client.get("/chats", headers=bob)).json()["items"]
    assert len(bobs) == 2
    for chat in bobs:
        last = chat["last"]
        assert last["body"] == "the fight at the end"
        assert last["share"] == {
            "kind": "anime",
            "id": 52991,
            "episode": 4,
            "chapter": None,
            "title": "Frieren",
            "image": "https://img/ep4.jpg",
            "poster": "https://img/52991l.jpg",
            "hidden": False,
        }

    # An adult title shows no art to someone who hides adult titles.
    respx.get(f"{API_BASE}/anime/7").mock(
        return_value=httpx.Response(200, json=node(7, "Night", rating="rx"))
    )
    respx.get(ANIZIP, params={"mal_id": "7"}).mock(return_value=httpx.Response(404))
    r = await client.post(
        f"/chats/{group['id']}/messages",
        json={"share": {"kind": "anime", "id": 7}},
        headers=ana,
    )
    assert r.status_code == 201 and r.json()["body"] is None
    assert r.json()["share"]["poster"] == "https://img/7l.jpg"
    cids = (await client.get(f"/chats/{group['id']}/messages", headers=cid)).json()["items"]
    # To someone who hides adult titles it isn't named or linked either.
    assert cids[-1]["share"] == {
        "kind": "anime",
        "id": 0,
        "episode": None,
        "chapter": None,
        "title": "",
        "image": None,
        "poster": None,
        "hidden": True,
    }
    last = (await client.get(f"/chats/{group['id']}", headers=cid)).json()["last"]
    assert last["share"]["hidden"] is True and last["share"]["title"] == ""
    bobs = (await client.get(f"/chats/{group['id']}/messages", headers=bob)).json()["items"]
    assert bobs[-1]["share"]["title"] == "Night" and bobs[-1]["share"]["hidden"] is False


async def test_someone_added_to_a_group_sees_only_what_comes_after(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, cid = await make_user(session, "cid")
    await befriend(client, ana, bob, "bob")
    await befriend(client, ana, cid, "cid")
    bob_id, cid_id = await user_id(client, bob), await user_id(client, cid)
    group = (await client.post("/chats/groups", json={"user_ids": [bob_id]}, headers=ana)).json()
    await say(client, bob, group["id"], "before cid")
    await client.post(f"/chats/{group['id']}/members", json={"user_ids": [cid_id]}, headers=ana)

    assert (await client.get(f"/chats/{group['id']}/messages", headers=cid)).json()["items"] == []
    chat = (await client.get(f"/chats/{group['id']}", headers=cid)).json()
    assert chat["last"] is None and chat["unread"] == 0
    assert (await client.get("/chats/unread", headers=cid)).json() == {"chats": 0}

    await say(client, bob, group["id"], "welcome")
    items = (await client.get(f"/chats/{group['id']}/messages", headers=cid)).json()["items"]
    assert [m["body"] for m in items] == ["welcome"]
    assert (await client.get(f"/chats/{group['id']}", headers=cid)).json()["unread"] == 1
    # Those already in it still see everything.
    items = (await client.get(f"/chats/{group['id']}/messages", headers=ana)).json()["items"]
    assert [m["body"] for m in items] == ["before cid", "welcome"]


@respx.mock
async def test_share_checks(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    bob_id = await user_id(client, bob)
    share = {"kind": "manga", "id": 3, "chapter": "112.5"}
    assert (await client.post("/chats/share", json={"share": share}, headers=ana)).json()["error"][
        "code"
    ] == "no_targets"
    bad = {"kind": "manga", "id": 3, "episode": 2}
    r = await client.post("/chats/share", json={"share": bad, "user_ids": [bob_id]}, headers=ana)
    assert r.status_code == 422
    for chapter in ("../x", "12\n"):
        bad = {"kind": "manga", "id": 3, "chapter": chapter}
        r = await client.post(
            "/chats/share", json={"share": bad, "user_ids": [bob_id]}, headers=ana
        )
        assert r.status_code == 422
    respx.get(f"{API_BASE}/manga/3").mock(return_value=httpx.Response(500))
    r = await client.post("/chats/share", json={"share": share, "user_ids": [bob_id]}, headers=ana)
    assert r.json()["error"]["code"] == "title_unavailable"
    # Nothing was sent.
    chats = (await client.get("/chats", headers=bob)).json()["items"]
    assert all(c["last"] is None for c in chats)


async def test_live_events_reach_members_only(client, session):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    eve_user, _ = await make_user(session, "eve")
    await befriend(client, ana, bob, "bob")
    chat_id = (await direct(client, ana, str(bob_user.id))).json()["id"]
    hub = fastapi_app.state.chat_hub
    bobs, eves = hub.subscribe(bob_user.id), hub.subscribe(eve_user.id)
    try:
        await say(client, ana, chat_id, "live")
        kind, data = bobs.get_nowait()
        assert kind == "message" and data["body"] == "live" and data["mine"] is False
        assert eves.empty()
        await client.put(f"/chats/{chat_id}/read", headers=bob)
        kind, data = bobs.get_nowait()
        assert kind == "read" and data["user_id"] == str(bob_user.id)
    finally:
        hub.unsubscribe(bob_user.id, bobs)
        hub.unsubscribe(eve_user.id, eves)


def test_a_stream_that_falls_behind_is_told_to_reload():
    hub = chat_live.ChatHub()
    who = uuid.uuid4()
    queue = hub.subscribe(who)
    for i in range(chat_live.QUEUE_SIZE + 1):
        hub.publish([who], "message", {"i": i})
    assert queue.get_nowait() == ("resync", {})
    assert queue.empty()


async def test_phone_push_goes_to_who_has_not_read_it(client, session, monkeypatch):
    ana_user, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    cid_user, cid = await make_user(session, "cid")
    await befriend(client, ana, bob, "bob")
    await befriend(client, ana, cid, "cid")
    for who in (bob_user, cid_user):
        session.add(
            PushSubscription(
                user_id=who.id, endpoint=f"https://push/{who.username}", p256dh="k", auth="a"
            )
        )
    await session.commit()
    sent: list[tuple[str, str, str]] = []

    async def deliver(http, settings, subs, message):
        sent.extend((s.endpoint, message.title, message.body) for s in subs)
        return len(subs)

    monkeypatch.setattr(chat_live.push, "deliver", deliver)
    pusher = fastapi_app.state.chat_pusher
    monkeypatch.setattr(pusher._settings, "vapid_private_key", "set")
    monkeypatch.setattr(pusher, "delay", 0.05)

    group = (
        await client.post(
            "/chats/groups",
            json={"name": "Club", "user_ids": [str(bob_user.id), str(cid_user.id)]},
            headers=ana,
        )
    ).json()
    await client.put(f"/chats/{group['id']}/mute", json={"muted": True}, headers=cid)
    await say(client, ana, group["id"], "who's in for saturday?")
    await pusher.drain()
    assert sent == [("https://push/bob", "Club", "ana: who's in for saturday?")]

    sent.clear()
    chat_id = (await direct(client, ana, str(bob_user.id))).json()["id"]
    await say(client, ana, chat_id, "you there?")
    # Bob has the chat open and reads it before the push goes out.
    await asyncio.sleep(0)
    await client.put(f"/chats/{chat_id}/read", headers=bob)
    await pusher.drain()
    assert sent == []
    assert ana_user is not None


def test_push_text_names_the_share():
    message = ChatMessage(
        chat_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        body=None,
        anime_id=1,
        episode=4,
        share_title="Frieren",
    )
    note = chat_live.compose(message, None, "junior", "pt")
    assert (note.title, note.body) == ("junior", "Te mandou Frieren · Ep. 4")
    assert note.url == f"/pt/messages/{message.chat_id}"
    note = chat_live.compose(message, "Club", "junior", "en")
    assert note.body == "junior: Sent Frieren · Ep 4"


def test_push_text_does_not_name_an_adult_title_to_who_hides_them():
    message = ChatMessage(
        chat_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        body=None,
        anime_id=7,
        episode=2,
        share_title="Night",
        share_adult=True,
    )
    assert chat_live.compose(message, None, "junior", "en", show_adult=False).body == (
        "Sent you a +18 title"
    )
    assert chat_live.compose(message, "Club", "junior", "pt", show_adult=False).body == (
        "junior: Mandou um título +18"
    )
    assert chat_live.compose(message, None, "junior", "en", show_adult=True).body == (
        "Sent you Night · Ep 2"
    )
