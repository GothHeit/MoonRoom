from tests.conftest import make_user
from tests.test_friends import befriend, watch


async def post(client, headers, body, spoiler=False, kind="anime", title=1):
    return await client.post(
        f"/{kind}/{title}/comments", json={"body": body, "spoiler": spoiler}, headers=headers
    )


async def test_comments_are_seen_by_the_author_and_their_friends_only(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, eve = await make_user(session, "eve")
    await befriend(client, ana, bob, "bob")

    r = await post(client, ana, "  Great show  ", spoiler=True)
    assert r.status_code == 201
    assert r.json()["body"] == "Great show"
    assert r.json()["spoiler"] is True and r.json()["mine"] is True
    await post(client, eve, "Stranger's take")

    seen_by_bob = (await client.get("/anime/1/comments", headers=bob)).json()
    assert [c["body"] for c in seen_by_bob["items"]] == ["Great show"]
    assert seen_by_bob["items"][0]["mine"] is False
    assert seen_by_bob["total"] == 1
    # Eve is nobody's friend: she sees only her own.
    seen_by_eve = (await client.get("/anime/1/comments", headers=eve)).json()
    assert [c["body"] for c in seen_by_eve["items"]] == ["Stranger's take"]
    # Another title, or the manga with the same id, has none.
    assert (await client.get("/anime/2/comments", headers=ana)).json()["total"] == 0
    assert (await client.get("/manga/1/comments", headers=ana)).json()["total"] == 0
    assert (await client.get("/anime/1/comments")).status_code == 401


async def test_pages_go_newest_first(client, session):
    _, ana = await make_user(session, "ana")
    for i in range(5):
        await post(client, ana, f"c{i}", kind="manga", title=7)
    first = (await client.get("/manga/7/comments", headers=ana)).json()
    assert [c["body"] for c in first["items"]] == ["c4", "c3", "c2"]
    assert first["total"] == 5 and first["next"]
    rest = (
        await client.get(
            "/manga/7/comments", params={"before": first["next"], "limit": 10}, headers=ana
        )
    ).json()
    assert [c["body"] for c in rest["items"]] == ["c1", "c0"]
    assert rest["next"] is None


async def test_text_is_cleaned_and_checked(client, session):
    _, ana = await make_user(session, "ana")
    assert (await post(client, ana, "   \n\t ")).json()["error"]["code"] == "comment_empty"
    assert (await post(client, ana, "​\x07")).status_code == 422
    assert (await post(client, ana, "x" * 1001)).json()["error"]["code"] == "comment_too_long"
    assert (await post(client, ana, "x" * 1000)).status_code == 201
    r = await post(client, ana, "a\x00b\r\n\n\n\n\nc")
    assert r.json()["body"] == "ab\n\nc"


async def test_only_the_author_edits_or_deletes(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    await befriend(client, ana, bob, "bob")
    cid = (await post(client, ana, "first")).json()["id"]

    assert (
        await client.patch(f"/comments/{cid}", json={"body": "hacked"}, headers=bob)
    ).status_code == 404
    assert (await client.delete(f"/comments/{cid}", headers=bob)).status_code == 404

    marked = await client.patch(f"/comments/{cid}", json={"spoiler": True}, headers=ana)
    assert marked.json()["spoiler"] is True and marked.json()["edited_at"] is None
    edited = await client.patch(f"/comments/{cid}", json={"body": "second"}, headers=ana)
    assert edited.json()["body"] == "second" and edited.json()["edited_at"] is not None
    empty = await client.patch(f"/comments/{cid}", json={"body": " "}, headers=ana)
    assert empty.status_code == 422

    assert (await client.delete(f"/comments/{cid}", headers=ana)).status_code == 204
    assert (await client.get("/anime/1/comments", headers=bob)).json()["total"] == 0


async def test_friends_on_a_title_show_their_latest_spot(client, session):
    _, ana = await make_user(session, "ana")
    _, bob = await make_user(session, "bob")
    _, cid = await make_user(session, "cid")
    _, eve = await make_user(session, "eve")
    await befriend(client, ana, bob, "bob")
    await befriend(client, ana, cid, "cid")
    await watch(client, bob, 5, 3)
    await watch(client, bob, 5, 4, completed=False)
    await watch(client, cid, 5, 1)
    await watch(client, eve, 5, 9)  # not a friend
    await client.put("/manga/5/progress/12", json={"page": 4, "pages": 20}, headers=bob)

    friends = (await client.get("/anime/5/friends", headers=ana)).json()
    assert [(f["user"]["username"], f["episode"], f["completed"]) for f in friends] == [
        ("cid", 1, True),
        ("bob", 4, False),
    ]
    reading = (await client.get("/manga/5/friends", headers=ana)).json()
    assert [(f["user"]["username"], f["chapter"]) for f in reading] == [("bob", "12")]
    assert (await client.get("/anime/6/friends", headers=ana)).json() == []

    # A friend who keeps their activity private isn't listed.
    await client.patch("/me", json={"share_activity": False}, headers=cid)
    friends = (await client.get("/anime/5/friends", headers=ana)).json()
    assert [f["user"]["username"] for f in friends] == ["bob"]


async def test_next_page_survives_the_last_shown_comment_going_away(client, session):
    _, ana = await make_user(session, "ana")
    for i in range(5):
        await post(client, ana, f"c{i}")
    first = (await client.get("/anime/1/comments", headers=ana)).json()
    anchor = first["items"][-1]["id"]
    assert (await client.delete(f"/comments/{anchor}", headers=ana)).status_code == 204
    rest = await client.get(
        "/anime/1/comments", params={"before": first["next"], "limit": 10}, headers=ana
    )
    assert rest.status_code == 200
    assert [c["body"] for c in rest.json()["items"]] == ["c1", "c0"]
    bad = await client.get("/anime/1/comments", params={"before": "nope"}, headers=ana)
    assert bad.status_code == 422


async def test_joined_emoji_stay_whole(client, session):
    _, ana = await make_user(session, "ana")
    family = "\U0001f468\u200d\U0001f469\u200d\U0001f467"
    r = await post(client, ana, f"{family} \u202eflip\u2066")
    assert r.json()["body"] == f"{family} flip"
