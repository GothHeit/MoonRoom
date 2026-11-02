from datetime import timedelta

import httpx
import respx
from sqlalchemy import text

from app.anizip import API as ANIZIP
from app.db import utcnow
from app.main import app as fastapi_app
from app.mal.client import API_BASE, current_season
from app.models import MalLink
from tests.conftest import make_user
from tests.mal_fixtures import mock_details, mock_ranking, mock_season, node


async def watch(client, headers, anime, episode, position=60, duration=1400, **extra):
    await client.put(
        f"/me/progress/{anime}/{episode}",
        json={"position_seconds": position, "duration_seconds": duration, **extra},
        headers=headers,
    )


@respx.mock
async def test_home_has_hero_and_rows_in_order(client, session):
    fastapi_app.state.sources = {}
    _, headers = await make_user(session, "kafka")
    mock_season(
        node(1, "Popular", mean=7.5),
        node(2, "Best", mean=8.9),
        node(3, "No art", mean=9.5, main_picture=None),
    )
    mock_ranking(node(10, "Classic"))
    mock_details(1)
    mock_details(2, synopsis="Why it is best", pictures=[{"large": "https://img/back.jpg"}])
    respx.get(ANIZIP, params={"mal_id": "2"}).mock(
        return_value=httpx.Response(
            200, json={"images": [{"coverType": "Fanart", "url": "https://img/wide.jpg"}]}
        )
    )
    await watch(client, headers, 20, 3)
    mock_details(20, num_episodes=12)

    body = (await client.get("/home", headers=headers)).json()
    # Best scores first; the title without art is skipped.
    assert [h["anime"]["title"] for h in body["heroes"]] == ["Best", "Popular"]
    assert body["heroes"][0]["synopsis"] == "Why it is best"
    assert body["heroes"][0]["backdrop"] == "https://img/back.jpg"
    # Wide art comes from ani.zip; a title it can't answer for has none.
    assert body["heroes"][0]["wide_art"] == "https://img/wide.jpg"
    assert body["heroes"][1]["wide_art"] is None
    # No MAL link, so there is no "my list" row.
    assert [r["id"] for r in body["rows"]] == ["continue_watching", "seasonal", "top"]
    first = body["rows"][0]["items"][0]
    assert first["anime"]["id"] == 20
    assert first["progress"]["episode"] == 3
    assert first["resume_episode"] == 3


@respx.mock
async def test_continue_watching_moves_to_the_next_episode_and_drops_finished_series(
    client, session
):
    _, headers = await make_user(session, "kafka")
    mock_season(node(1))
    mock_ranking(node(10))
    mock_details(1)
    await watch(client, headers, 20, 3, completed=True)
    await watch(client, headers, 21, 12, completed=True)
    mock_details(20, num_episodes=12)
    mock_details(21, num_episodes=12)

    body = (await client.get("/home", headers=headers)).json()
    items = body["rows"][0]["items"]
    assert [(i["anime"]["id"], i["resume_episode"]) for i in items] == [(20, 4)]


@respx.mock
async def test_home_survives_a_failing_section_but_not_total_mal_failure(client, session):
    _, headers = await make_user(session, "kafka")
    year, season = current_season()
    respx.get(f"{API_BASE}/anime/season/{year}/{season}").mock(return_value=httpx.Response(500))
    mock_ranking(node(10, "Classic"))
    body = (await client.get("/home", headers=headers)).json()
    assert [r["id"] for r in body["rows"]] == ["top"]
    assert body["heroes"] == []

    respx.get(f"{API_BASE}/anime/ranking").mock(return_value=httpx.Response(500))
    fastapi_app.state.mal._pages.clear()
    fastapi_app.state.shared_cache._local.clear()
    r = await client.get("/home", headers=headers)
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "mal_unavailable"


async def test_home_needs_login(client):
    assert (await client.get("/home")).status_code == 401


@respx.mock
async def test_my_list_row_shows_watching_then_plan_to_watch(client, session):
    user, headers = await make_user(session, "kafka")
    session.add(
        MalLink(
            user_id=user.id,
            access_token="a",
            refresh_token="r",
            expires_at=utcnow() + timedelta(hours=1),
        )
    )
    await session.commit()
    mock_season(node(1))
    mock_ranking(node(10))
    mock_details(1)

    def answer(request):
        status = request.url.params["status"]
        return httpx.Response(
            200, json={"data": [{"node": node(30 if status == "watching" else 31)}]}
        )

    route = respx.get(f"{API_BASE}/users/@me/animelist").mock(side_effect=answer)
    body = (await client.get("/home", headers=headers)).json()
    my_list = next(r for r in body["rows"] if r["id"] == "my_list")
    assert [i["anime"]["id"] for i in my_list["items"]] == [30, 31]

    # A reload within the TTL reuses the list; changing it from the site drops the cache.
    await client.get("/home", headers=headers)
    assert route.call_count == 2
    respx.patch(f"{API_BASE}/anime/30/my_list_status").mock(
        return_value=httpx.Response(200, json={"status": "completed"})
    )
    await client.patch("/me/animelist/30", json={"status": "completed"}, headers=headers)
    await client.get("/home", headers=headers)
    assert route.call_count == 4


@respx.mock
async def test_home_skips_my_list_when_the_stored_token_cannot_be_decrypted(client, session):
    user, headers = await make_user(session, "kafka")
    user_id = user.id
    session.add(
        MalLink(
            user_id=user_id,
            access_token="a",
            refresh_token="r",
            expires_at=utcnow() + timedelta(hours=1),
        )
    )
    await session.commit()
    await session.execute(
        text("UPDATE mal_links SET access_token = 'gAAAAAnot-valid' WHERE user_id = :u"),
        {"u": user_id},
    )
    await session.commit()
    mock_season(node(1))
    mock_ranking(node(10))
    mock_details(1)
    r = await client.get("/home", headers=headers)
    assert r.status_code == 200
    assert "my_list" not in [row["id"] for row in r.json()["rows"]]


@respx.mock
async def test_genre_rows_show_only_genres_with_enough_titles(client, session, monkeypatch):
    from app.routers import home

    monkeypatch.setattr(home, "todays_genres", lambda today, count=4: [1, 4])
    _, headers = await make_user(session, "kafka")
    mock_season(node(1))
    mock_ranking(
        *(node(100 + i, genres=(1,)) for i in range(9)),
        *(node(200 + i, genres=(4,)) for i in range(3)),
    )
    mock_details(1)
    body = (await client.get("/home", headers=headers)).json()
    genre_rows = [r for r in body["rows"] if r["id"] == "genre"]
    assert [r["genre"]["name"] for r in genre_rows] == ["Action"]
    assert len(genre_rows[0]["items"]) == 9


@respx.mock
async def test_popular_with_friends_needs_enough_titles_and_respects_adult_filter(client, session):
    from tests.test_friends import befriend

    _, kafka = await make_user(session, "kafka")
    _, ana = await make_user(session, "ana")
    await befriend(client, kafka, ana, "ana")
    mock_season(node(1))
    mock_ranking(node(10))
    mock_details(1)
    for i in range(7):
        mock_details(300 + i)
        await watch(client, ana, 300 + i, 1)

    def ids(body):
        return [r["id"] for r in body["rows"]]

    assert "friends_popular" not in ids((await client.get("/home", headers=kafka)).json())

    mock_details(307, rating="rx")
    await watch(client, ana, 307, 1)
    mock_details(308)
    await watch(client, ana, 308, 1)
    body = (await client.get("/home", headers=kafka)).json()
    row = next(r for r in body["rows"] if r["id"] == "friends_popular")
    assert 307 not in {i["anime"]["id"] for i in row["items"]}
    assert len(row["items"]) == 8


@respx.mock
async def test_continue_watching_fills_up_with_the_mal_watching_list(client, session):
    user, headers = await make_user(session, "kafka", nsfw=False)
    session.add(
        MalLink(
            user_id=user.id,
            access_token="a",
            refresh_token="r",
            expires_at=utcnow() + timedelta(hours=1),
        )
    )
    await session.commit()
    mock_season(node(1))
    mock_ranking(node(10))
    mock_details(1)
    await watch(client, headers, 20, 3)
    mock_details(20, num_episodes=12)

    def entry(anime_id, watched, days_ago, total=12):
        updated = (utcnow() - timedelta(days=days_ago)).isoformat()
        status = {"num_episodes_watched": watched, "updated_at": updated}
        return {"node": node(anime_id, num_episodes=total), "list_status": status}

    adult = entry(43, 1, 1)
    adult["node"]["rating"] = "rx"

    def answer(request):
        if request.url.params["status"] != "watching":
            return httpx.Response(200, json={"data": []})
        data = [
            entry(20, 5, 1),  # already has MoonRoom progress
            entry(40, 4, 2),
            entry(41, 0, 90),  # untouched for too long
            entry(42, 12, 1),  # all episodes watched
            adult,
        ]
        return httpx.Response(200, json={"data": data})

    respx.get(f"{API_BASE}/users/@me/animelist").mock(side_effect=answer)
    body = (await client.get("/home", headers=headers)).json()
    items = body["rows"][0]["items"]
    assert [(i["anime"]["id"], i["resume_episode"], i["from_mal"]) for i in items] == [
        (20, 3, False),
        (40, 5, True),
    ]
    assert items[1]["progress"] is None

    # With the adult switch on, the +18 entry shows up too.
    await client.patch("/me", json={"show_nsfw": True}, headers=headers)
    body = (await client.get("/home", headers=headers)).json()
    assert 43 in [i["anime"]["id"] for i in body["rows"][0]["items"]]
    await client.patch("/me", json={"show_nsfw": False}, headers=headers)

    # Removing the MAL card hides it until MAL changes.
    await client.delete("/me/progress/40/continue", headers=headers)
    body = (await client.get("/home", headers=headers)).json()
    assert [i["anime"]["id"] for i in body["rows"][0]["items"]] == [20]


@respx.mock
async def test_home_survives_a_timing_out_mal_list(client, session):
    user, headers = await make_user(session, "kafka")
    session.add(
        MalLink(
            user_id=user.id,
            access_token="a",
            refresh_token="r",
            expires_at=utcnow() + timedelta(hours=1),
        )
    )
    await session.commit()
    mock_season(node(1))
    mock_ranking(node(10))
    mock_details(1)
    respx.get(f"{API_BASE}/users/@me/animelist").mock(side_effect=httpx.ReadTimeout("slow"))

    r = await client.get("/home", headers=headers)
    assert r.status_code == 200
    assert "my_list" not in [row["id"] for row in r.json()["rows"]]

    # The list endpoints answer a clean 502 instead of a 500.
    r = await client.get("/me/animelist", headers=headers)
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "mal_unavailable"
