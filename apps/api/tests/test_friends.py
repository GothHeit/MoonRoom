import respx

from tests.conftest import make_user
from tests.mal_fixtures import mock_details


async def watch(client, headers, anime, episode, completed=True):
    await client.put(
        f"/me/progress/{anime}/{episode}",
        json={"position_seconds": 60, "duration_seconds": 1400, "completed": completed},
        headers=headers,
    )


async def befriend(client, a_headers, b_headers, b_name):
    await client.post("/friends/requests", json={"username": b_name}, headers=a_headers)
    a_id = (await client.get("/me", headers=a_headers)).json()["id"]
    r = await client.post(f"/friends/requests/{a_id}/accept", headers=b_headers)
    assert r.status_code == 200


async def test_lookup_shows_name_picture_and_relation(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    r = await client.get("/users/lookup", params={"username": "BOB"}, headers=ana)
    assert r.status_code == 200
    assert r.json()["user"]["username"] == "bob"
    assert r.json()["user"]["avatar"]["kind"] == "none"
    assert r.json()["relation"] == "none"
    own = await client.get("/users/lookup", params={"username": "ana"}, headers=ana)
    assert own.json()["relation"] == "self"
    missing = await client.get("/users/lookup", params={"username": "nobody"}, headers=ana)
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "user_not_found"
    assert (await client.get("/users/lookup", params={"username": "bob"})).status_code == 401


async def test_request_must_be_accepted_by_the_other_side(client, session):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    sent = await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    assert sent.status_code == 201 and sent.json()["relation"] == "outgoing"
    # Not friends yet, for either side.
    assert (await client.get("/friends", headers=ana)).json() == []
    assert (await client.get("/friends", headers=bob)).json() == []
    incoming = (await client.get("/friends/requests", headers=bob)).json()["incoming"]
    assert [i["user"]["username"] for i in incoming] == ["ana"]
    outgoing = (await client.get("/friends/requests", headers=ana)).json()["outgoing"]
    assert [i["user"]["username"] for i in outgoing] == ["bob"]
    # The sender can't accept their own request.
    assert (
        await client.post(f"/friends/requests/{bob_user.id}/accept", headers=ana)
    ).status_code == 404

    ana_id = (await client.get("/me", headers=ana)).json()["id"]
    await client.post(f"/friends/requests/{ana_id}/accept", headers=bob)
    for headers, name in ((ana, "bob"), (bob, "ana")):
        friends = (await client.get("/friends", headers=headers)).json()
        assert [f["user"]["username"] for f in friends] == [name]


async def test_request_errors(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    own = await client.post("/friends/requests", json={"username": "ana"}, headers=ana)
    assert own.json()["error"]["code"] == "friend_self"
    ghost = await client.post("/friends/requests", json={"username": "ghost"}, headers=ana)
    assert ghost.status_code == 404
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    again = await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    assert again.status_code == 409 and again.json()["error"]["code"] == "already_requested"
    # Asking back while they have asked you accepts it.
    mutual = await client.post("/friends/requests", json={"username": "ana"}, headers=bob)
    assert mutual.json()["relation"] == "friends"
    done = await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    assert done.json()["error"]["code"] == "already_friends"


async def test_decline_cancel_and_unfriend(client, session):
    ana_user, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    # Bob declines; Ana may ask again.
    assert (await client.delete(f"/friends/requests/{ana_user.id}", headers=bob)).status_code == 204
    assert (await client.get("/friends/requests", headers=bob)).json()["incoming"] == []
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    # Ana takes it back.
    assert (await client.delete(f"/friends/requests/{bob_user.id}", headers=ana)).status_code == 204
    await befriend(client, ana, bob, "bob")
    # A friendship is not a request.
    assert (await client.delete(f"/friends/requests/{bob_user.id}", headers=ana)).status_code == 404
    assert (await client.delete(f"/friends/{bob_user.id}", headers=ana)).status_code == 204
    assert (await client.get("/friends", headers=bob)).json() == []
    assert (await client.delete(f"/friends/{bob_user.id}", headers=ana)).status_code == 404


async def test_profile_is_for_friends_and_self_only(client, session):
    ana_user, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    _, cy = await make_user(session, "cy")
    mine = await client.get(f"/users/{ana_user.id}/profile", headers=ana)
    assert mine.status_code == 200 and mine.json()["relation"] == "self"
    stranger = await client.get(f"/users/{bob_user.id}/profile", headers=ana)
    assert stranger.status_code == 403 and stranger.json()["error"]["code"] == "not_friends"
    await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    # A pending request is not enough.
    assert (await client.get(f"/users/{bob_user.id}/profile", headers=ana)).status_code == 403
    await befriend(client, ana, bob, "bob")
    ok = await client.get(f"/users/{bob_user.id}/profile", headers=ana)
    assert ok.status_code == 200 and ok.json()["relation"] == "friends"
    assert ok.json()["friends_since"] is not None
    assert (await client.get(f"/users/{bob_user.id}/profile", headers=cy)).status_code == 403
    missing = await client.get("/users/00000000-0000-0000-0000-000000000000/profile", headers=ana)
    assert missing.status_code == 404


@respx.mock
async def test_profile_shows_stats_and_titles(client, session):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    mock_details(20, num_episodes=12)
    mock_details(21, num_episodes=12)
    await watch(client, bob, 20, 1)
    await watch(client, bob, 20, 2)
    await watch(client, bob, 21, 1, completed=False)
    body = (await client.get(f"/users/{bob_user.id}/profile", headers=ana)).json()
    assert body["stats"] == {"titles": 2, "episodes": 2, "friends": 1}
    assert {t["anime"]["id"] for t in body["watching"]} == {20, 21}
    assert [(r["anime"]["id"], r["episode"]) for r in body["recent"]] == [(20, 2)]


@respx.mock
async def test_hidden_activity_stays_hidden_from_friends(client, session):
    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    mock_details(20)
    await watch(client, bob, 20, 1)
    r = await client.patch("/me", json={"share_activity": False}, headers=bob)
    assert r.json()["share_activity"] is False
    body = (await client.get(f"/users/{bob_user.id}/profile", headers=ana)).json()
    assert body["activity_shared"] is False
    assert body["stats"] is None and body["watching"] is None and body["recent"] is None
    assert body["friends"] is None
    assert (await client.get("/friends/activity", headers=ana)).json() == []
    # They still see their own.
    own = (await client.get(f"/users/{bob_user.id}/profile", headers=bob)).json()
    assert own["stats"]["titles"] == 1


@respx.mock
async def test_activity_feed_is_friends_only_newest_first_and_one_line_per_title(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, cy = await make_user(session, "cy")
    await befriend(client, ana, bob, "bob")
    mock_details(20)
    mock_details(21)
    await watch(client, bob, 20, 1)
    await watch(client, bob, 20, 2)
    await watch(client, cy, 21, 1)  # not a friend of ana
    await watch(client, bob, 21, 5)
    feed = (await client.get("/friends/activity", headers=ana)).json()
    assert [(i["user"]["username"], i["anime"]["id"], i["episode"]) for i in feed] == [
        ("bob", 21, 5),
        ("bob", 20, 2),
    ]
    assert (await client.get("/friends/activity", headers=cy)).json() == []


@respx.mock
async def test_adult_titles_are_left_out_for_viewers_who_hide_them(client, session):
    _, ana = await make_user(session, "ana", nsfw=False)
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    mock_details(20, rating="rx")
    mock_details(21)
    await watch(client, bob, 20, 1)
    await watch(client, bob, 21, 1)
    feed = (await client.get("/friends/activity", headers=ana)).json()
    assert [i["anime"]["id"] for i in feed] == [21]


@respx.mock
async def test_a_binge_does_not_crowd_out_the_feed(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    for anime in (20, 21):
        mock_details(anime)
    for episode in range(1, 30):
        await watch(client, bob, 20, episode)
    await watch(client, bob, 21, 1)
    feed = (await client.get("/friends/activity", params={"limit": 2}, headers=ana)).json()
    assert {i["anime"]["id"] for i in feed} == {20, 21}


async def test_simultaneous_requests_end_as_friends(client, session, monkeypatch):
    from app.models import Friendship
    from app.routers import friends

    ana_user, ana = await make_user(session, "ana")
    bob_user, _ = await make_user(session, "bob")
    real = friends._friendship
    calls = 0

    async def blind_first(db, a, b):
        # Ana's first look misses a request from Bob that lands just before her insert.
        nonlocal calls
        calls += 1
        if calls == 1:
            session.add(Friendship(requester_id=bob_user.id, addressee_id=ana_user.id))
            await session.commit()
            return None
        return await real(db, a, b)

    monkeypatch.setattr(friends, "_friendship", blind_first)
    r = await client.post("/friends/requests", json={"username": "bob"}, headers=ana)
    assert r.status_code == 201
    assert r.json()["relation"] == "friends"


async def read(client, headers, manga_id, chapter, finished=True):
    await client.put(
        f"/manga/{manga_id}/progress/{chapter}",
        json={"page": 9 if finished else 2, "pages": 10},
        headers=headers,
    )


@respx.mock
async def test_profile_shows_manga_stats_and_titles(client, session):
    from tests.test_manga import mock_details as mock_manga

    _, ana = await make_user(session, "ana")
    bob_user, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    mock_manga(30, genres=[(1, "Action"), (2, "Adventure")])
    mock_manga(31, genres=[(1, "Action")])
    await read(client, bob, 30, "1")
    await read(client, bob, 30, "2")
    await read(client, bob, 31, "7", finished=False)
    body = (await client.get(f"/users/{bob_user.id}/profile", headers=ana)).json()
    assert body["manga_stats"] == {"titles": 2, "chapters": 2}
    assert {t["manga"]["id"] for t in body["reading"]} == {30, 31}
    assert [(t["manga"]["id"], t["chapter"]) for t in body["recent_manga"]] == [(30, "2")]
    assert [g["name"] for g in body["manga_genres"]] == ["Action", "Adventure"]
    await client.patch("/me", json={"share_activity": False}, headers=bob)
    hidden = (await client.get(f"/users/{bob_user.id}/profile", headers=ana)).json()
    assert hidden["manga_stats"] is None and hidden["reading"] is None
    assert hidden["recent_manga"] is None and hidden["manga_genres"] is None
