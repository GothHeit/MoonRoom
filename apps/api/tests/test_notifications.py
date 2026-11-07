from datetime import timedelta
from typing import cast

from sqlalchemy import select, update

from app import notifications
from app.db import utcnow
from app.main import app
from app.mal.client import MalClient
from app.models import EpisodeSeen, Notification
from app.sources.base import VideoSource
from tests.conftest import make_user
from tests.mal_fixtures import node
from tests.test_friends import befriend, watch


async def bell(client, headers):
    return (await client.get("/notifications", headers=headers)).json()


async def test_a_friend_request_and_its_acceptance_reach_the_bell(client, session):
    ana_user, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    first = await bell(client, bob)
    assert first["unread"] == 1
    assert [(i["kind"], i["actor"]["username"]) for i in first["items"]] == [
        ("friend_request", "ana")
    ]
    assert (await bell(client, ana))["items"] == []

    await client.post(f"/friends/requests/{ana_user.id}/accept", headers=bob)
    # The request is answered, so it leaves bob's bell; ana hears about the acceptance.
    assert (await bell(client, bob))["items"] == []
    heard = await bell(client, ana)
    assert [(i["kind"], i["actor"]["username"]) for i in heard["items"]] == [
        ("friend_accepted", "bob")
    ]


async def test_asking_back_accepts_and_a_withdrawn_request_disappears(client, session):
    ana_user, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    await client.delete(f"/friends/requests/{bob_user.id}", headers=ana)
    assert (await bell(client, bob))["items"] == []

    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)  # 409, no repeat
    assert (await bell(client, bob))["unread"] == 1
    await client.post("/friends/requests", json={"username": "ana"}, headers=bob)
    assert (await bell(client, bob))["items"] == []
    assert [i["kind"] for i in (await bell(client, ana))["items"]] == ["friend_accepted"]


async def test_marking_read_and_dismissing(client, session):
    ana_user, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    await client.post("/friends/requests", json={"username": "ana"}, headers=bob)
    _, cat = await make_user(session, "cat")
    await client.post("/friends/requests", json={"username": "ana"}, headers=cat)
    items = (await bell(client, ana))["items"]
    assert [i["kind"] for i in items] == ["friend_request", "friend_accepted"]

    one = items[0]["id"]
    assert (await client.post(f"/notifications/{one}/read", headers=ana)).status_code == 204
    after = await bell(client, ana)
    assert after["items"][0]["read"] is True and after["unread"] == len(items) - 1
    # Someone else's notification is out of reach.
    await client.delete(f"/notifications/{one}", headers=bob)
    assert len((await bell(client, ana))["items"]) == len(items)
    await client.post("/notifications/read", headers=ana)
    assert (await bell(client, ana))["unread"] == 0
    await client.delete(f"/notifications/{one}", headers=ana)
    assert len((await bell(client, ana))["items"]) == len(items) - 1


async def test_muted_kinds_are_not_delivered(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    put = await client.put(
        "/notifications/settings", json={"muted": ["friend_request"]}, headers=bob
    )
    assert put.json() == {"muted": ["friend_request"]}
    assert (await client.get("/notifications/settings", headers=bob)).json() == {
        "muted": ["friend_request"]
    }
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    assert (await bell(client, bob))["items"] == []
    bad = await client.put("/notifications/settings", json={"muted": ["nope"]}, headers=bob)
    assert bad.status_code == 422
    cleared = await client.put("/notifications/settings", json={"muted": []}, headers=bob)
    assert cleared.json() == {"muted": []}


async def test_a_room_invite_shows_who_where_and_whether_the_room_is_open(client, session):
    host, host_headers = await make_user(session, "kafka")
    guest, guest_headers = await make_user(session, "friend")
    await befriend(client, host_headers, guest_headers, "friend")
    app.state.sources = {"zoko": object()}
    app.state.mal._details[21] = {"id": 21, "title": "One Piece", "rating": "pg_13"}
    created = await client.post(
        "/watch/rooms",
        json={"source": "zoko", "anime_id": 21, "title": "One Piece", "episode": 3},
        headers=host_headers,
    )
    code = created.json()["code"]
    app.state.rooms.get(code).join(host.id, "kafka")
    body = {"user_id": str(guest.id)}
    await client.post(f"/watch/rooms/{code}/invite", json=body, headers=host_headers)
    await client.post(f"/watch/rooms/{code}/invite", json=body, headers=host_headers)

    items = (await bell(client, guest_headers))["items"]
    assert [(i["kind"], i["room_code"], i["title"], i["episode"]) for i in items] == [
        ("room_invite", code, "One Piece", 3)
    ]
    assert items[0]["actor"]["username"] == "kafka" and items[0]["room_active"] is True
    del app.state.rooms._rooms[code]
    assert (await bell(client, guest_headers))["items"][0]["room_active"] is False


async def test_old_notifications_are_hidden(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    await session.execute(update(Notification).values(created_at=utcnow() - timedelta(days=31)))
    await session.commit()
    assert await bell(client, bob) == {"items": [], "unread": 0}
    await notifications.purge_old(session)
    await session.commit()
    assert (await session.scalars(select(Notification))).all() == []


class Airing:
    """A video source whose newest episode can be moved."""

    name = "fake"

    def __init__(self, latest):
        self.latest = latest

    async def episodes(self, anime, lang):
        from app.sources.base import EpisodeList

        return EpisodeList(episodes=list(range(1, self.latest + 1)), source_title="x")


class FakeMal:
    def __init__(self, nodes):
        self.nodes = nodes

    async def details(self, anime_id):
        return self.nodes[anime_id]


async def check(mal: FakeMal, source: Airing) -> None:
    await notifications.check_new_episodes(
        cast(MalClient, mal), {"fake": cast(VideoSource, source)}
    )


async def test_new_episodes_reach_people_who_are_behind(client, session):
    from sqlalchemy import delete

    await session.execute(delete(EpisodeSeen))
    await session.commit()
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, cat = await make_user(session, "cat")
    await watch(client, ana, 5, 2)
    await watch(client, bob, 5, 3)
    await watch(client, cat, 5, 3, completed=False)
    mal = FakeMal({5: node(5, "Airing Show", status="currently_airing", nsfw="white")})
    source = Airing(3)

    await check(mal, source)
    # The first look only records where the title is.
    assert await bell(client, ana) == {"items": [], "unread": 0}

    source.latest = 4
    await check(mal, source)
    got = await bell(client, ana)
    assert [(i["kind"], i["anime_id"], i["episode"], i["title"]) for i in got["items"]] == [
        ("new_episode", 5, 4, "Airing Show")
    ]
    assert got["items"][0]["actor"] is None
    assert (await bell(client, bob))["unread"] == 1

    # Nothing new, nothing sent; a later episode replaces the earlier entry.
    await check(mal, source)
    assert (await bell(client, ana))["unread"] == 1
    source.latest = 5
    await check(mal, source)
    again = (await bell(client, ana))["items"]
    assert [(i["episode"], i["read"]) for i in again] == [(5, False)]


async def test_new_episode_checks_skip_finished_titles_adult_ones_and_muted_users(client, session):
    from sqlalchemy import delete

    await session.execute(delete(EpisodeSeen))
    await session.commit()
    _, ana = await make_user(session, "ana", nsfw=False)
    _, bob = await make_user(session, "bob")
    await watch(client, ana, 6, 1)
    await watch(client, bob, 6, 1)
    await watch(client, bob, 7, 1)
    await client.put("/notifications/settings", json={"muted": ["new_episode"]}, headers=bob)
    mal = FakeMal(
        {
            6: node(6, "Adult", status="currently_airing", rating="rx"),
            7: node(7, "Done", status="finished_airing", nsfw="white"),
        }
    )
    source = Airing(1)
    await check(mal, source)
    source.latest = 2
    await check(mal, source)
    assert (await bell(client, ana))["items"] == []
    assert (await bell(client, bob))["items"] == []
    assert await session.get(EpisodeSeen, 7) is None


class DubOnly(Airing):
    """A source that has the airing episodes only in English audio."""

    async def episodes(self, anime, lang):
        return await super().episodes(anime, lang) if lang == "dub" else None


async def test_new_dub_episodes_count_when_there_is_no_sub_listing(client, session):
    from sqlalchemy import delete

    await session.execute(delete(EpisodeSeen))
    await session.commit()
    _, ana = await make_user(session, "ana")
    await watch(client, ana, 5, 2)
    mal = FakeMal({5: node(5, "Airing Show", status="currently_airing", nsfw="white")})
    source = DubOnly(3)
    await check(mal, source)
    source.latest = 4
    await check(mal, source)
    assert [i["episode"] for i in (await bell(client, ana))["items"]] == [4]


async def test_unfriending_clears_what_the_two_sent_each_other(client, session):
    ana_user, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    assert [i["kind"] for i in (await bell(client, ana))["items"]] == ["friend_accepted"]
    session.add(Notification(user_id=bob_user.id, kind="room_invite", actor_id=ana_user.id))
    await session.commit()
    await client.delete(f"/friends/{ana_user.id}", headers=bob)
    assert (await bell(client, ana))["items"] == []
    assert (await bell(client, bob))["items"] == []


class Publishing:
    """A manga source whose newest chapter can be moved."""

    name = "fake"

    def __init__(self, latest):
        self.latest = latest

    async def chapters(self, manga, lang):
        from app.manga.base import Chapter, ChapterList

        return ChapterList(
            "x",
            "x",
            ["en"],
            [Chapter(f"c{n}", str(n), None, None, "en") for n in range(1, self.latest + 1)],
        )


async def read(client, headers, manga, chapter):
    await client.put(
        f"/manga/{manga}/progress/{chapter}", json={"page": 1, "pages": 5}, headers=headers
    )


async def check_manga(mal: FakeMal, source: Publishing) -> None:
    from app.manga.base import MangaSource

    await notifications.check_new_chapters(
        cast(MalClient, mal), {"fake": cast(MangaSource, source)}
    )


async def test_new_chapters_reach_readers_who_are_behind(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, cat = await make_user(session, "cat", nsfw=False)
    _, dan = await make_user(session, "dan")
    for who in (ana, bob, cat, dan):
        await read(client, who, 9, 3)
    await read(client, bob, 9, 5)  # already at the new chapter
    await client.delete("/manga/9/continue", headers=dan)
    await client.put("/notifications/settings", json={"muted": ["new_chapter"]}, headers=cat)
    mal = FakeMal({9: {**node(9, "Running", status="currently_publishing", nsfw="white")}})
    mal.manga_details = mal.details  # type: ignore[attr-defined]
    source = Publishing(4)

    await check_manga(mal, source)
    assert await bell(client, ana) == {"items": [], "unread": 0}  # first look sends nothing

    source.latest = 5
    await check_manga(mal, source)
    got = await bell(client, ana)
    assert [(i["kind"], i["manga_id"], i["episode"], i["title"]) for i in got["items"]] == [
        ("new_chapter", 9, 5, "Running")
    ]
    assert (await bell(client, bob))["items"] == []
    assert (await bell(client, cat))["items"] == []
    assert (await bell(client, dan))["items"] == []

    await check_manga(mal, source)
    assert (await bell(client, ana))["unread"] == 1


async def test_new_chapter_checks_skip_finished_and_adult_titles(client, session):
    _, ana = await make_user(session, "ana", nsfw=False)
    await read(client, ana, 10, 1)
    await read(client, ana, 11, 1)
    mal = FakeMal(
        {
            10: node(10, "Adult", status="currently_publishing", rating="rx"),
            11: node(11, "Done", status="finished", nsfw="white"),
        }
    )
    mal.manga_details = mal.details  # type: ignore[attr-defined]
    source = Publishing(1)
    await check_manga(mal, source)
    source.latest = 2
    await check_manga(mal, source)
    assert (await bell(client, ana))["items"] == []
