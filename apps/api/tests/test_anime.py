import asyncio

import httpx
import respx

from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.sources.base import EpisodeList
from tests.conftest import make_user
from tests.mal_fixtures import listing, mock_details, mock_ranking, mock_season, node


@respx.mock
async def test_seasonal_and_top_are_typed_and_flattened(client, session):
    _, headers = await make_user(session, "kafka")
    mock_season(node(1, "One", genres=[1]))
    mock_ranking(node(2, "Two"))

    seasonal = (await client.get("/anime/seasonal", headers=headers)).json()
    assert seasonal["data"][0]["id"] == 1
    assert seasonal["data"][0]["genres"] == [{"id": 1, "name": "g1"}]
    assert seasonal["has_next"] is False

    top = (await client.get("/anime/top", headers=headers)).json()
    assert [a["title"] for a in top["data"]] == ["Two"]


@respx.mock
async def test_list_responses_are_cached(client, session):
    _, headers = await make_user(session, "kafka")
    route = mock_ranking(node(2, "Two"))
    await client.get("/anime/top", headers=headers)
    await client.get("/anime/top", headers=headers)
    assert route.call_count == 1


async def test_genres_hide_nsfw_ones_by_default(client, session):
    _, normal = await make_user(session, "kafka")
    _, nsfw = await make_user(session, "friend", nsfw=True)
    names = {g["name"] for g in (await client.get("/anime/genres", headers=normal)).json()}
    assert "Action" in names and "Hentai" not in names
    names = {g["name"] for g in (await client.get("/anime/genres", headers=nsfw)).json()}
    assert "Hentai" in names


@respx.mock
async def test_browse_filters_by_genre_within_a_season(client, session):
    _, headers = await make_user(session, "kafka")
    mock_season(
        node(1, genres=[1]), node(2, genres=[4]), node(3, genres=[1, 4]), year=2025, season="fall"
    )
    r = await client.get(
        "/anime/browse", params={"genre": 1, "year": 2025, "season": "fall"}, headers=headers
    )
    body = r.json()
    assert [a["id"] for a in body["data"]] == [1, 3]
    assert body["page"] == 1 and body["has_next"] is False


@respx.mock
async def test_browse_adult_genre_without_a_year_scans_deeper_than_the_top(client, session):
    _, headers = await make_user(session, "friend", nsfw=True)
    route = respx.get(f"{API_BASE}/anime/ranking").mock(
        side_effect=lambda req: httpx.Response(
            200,
            json=listing(node(1, genres=[1]))
            if req.url.params.get("offset") is None
            else listing(node(2, genres=[12])),
        )
    )
    r = await client.get("/anime/browse", params={"genre": 12}, headers=headers)
    assert [a["id"] for a in r.json()["data"]] == [2]
    assert route.call_count > 1


@respx.mock
async def test_browse_deep_scan_survives_a_failed_page(client, session):
    _, headers = await make_user(session, "friend", nsfw=True)
    respx.get(f"{API_BASE}/anime/ranking").mock(
        side_effect=lambda req: (
            httpx.Response(200, json=listing(node(2, genres=[12])))
            if req.url.params.get("offset") is None
            else httpx.Response(500)
        )
    )
    r = await client.get("/anime/browse", params={"genre": 12}, headers=headers)
    assert [a["id"] for a in r.json()["data"]] == [2]


@respx.mock
async def test_browse_deep_scan_fails_when_every_page_fails(client, session):
    _, headers = await make_user(session, "friend", nsfw=True)
    respx.get(f"{API_BASE}/anime/ranking").mock(return_value=httpx.Response(500))
    r = await client.get("/anime/browse", params={"genre": 12}, headers=headers)
    assert r.status_code == 502


@respx.mock
async def test_browse_deep_scan_keeps_adult_titles_hidden_when_the_switch_is_off(client, session):
    _, headers = await make_user(session, "kafka")
    respx.get(f"{API_BASE}/anime/ranking").mock(
        return_value=httpx.Response(
            200, json=listing(node(2, genres=[12], rating="rx"), node(3, genres=[1]))
        )
    )
    r = await client.get("/anime/browse", params={"genre": 1}, headers=headers)
    assert [a["id"] for a in r.json()["data"]] == [3]
    r = await client.get("/anime/browse", params={"genre": 12}, headers=headers)
    assert r.status_code == 422


@respx.mock
async def test_browse_pages_results(client, session):
    _, headers = await make_user(session, "kafka")
    mock_ranking(*(node(i) for i in range(1, 31)))
    first = (await client.get("/anime/browse", headers=headers)).json()
    assert len(first["data"]) == 24 and first["has_next"] is True
    second = (await client.get("/anime/browse", params={"page": 2}, headers=headers)).json()
    assert len(second["data"]) == 6 and second["has_next"] is False


@respx.mock
async def test_browse_a_whole_year_merges_its_seasons(client, session):
    _, headers = await make_user(session, "kafka")
    mock_season(node(1), year=2024, season="winter")
    mock_season(node(2), year=2024, season="spring")
    mock_season(node(1), node(3), year=2024, season="summer")
    mock_season(year=2024, season="fall")
    r = await client.get("/anime/browse", params={"year": 2024}, headers=headers)
    assert sorted(a["id"] for a in r.json()["data"]) == [1, 2, 3]


async def test_browse_validates_filters(client, session):
    _, headers = await make_user(session, "kafka")
    r = await client.get("/anime/browse", params={"season": "fall"}, headers=headers)
    assert r.status_code == 422
    r = await client.get("/anime/browse", params={"genre": 9999}, headers=headers)
    assert r.json()["error"]["code"] == "validation_failed"
    hentai = await client.get("/anime/browse", params={"genre": 12}, headers=headers)
    assert hentai.status_code == 422


@respx.mock
async def test_details_include_related_recommendations_and_lazy_sources(client, session):
    class Source:
        async def episodes(self, anime, lang):
            return EpisodeList(episodes=[1], source_title="x") if anime["id"] == 5 else None

    fastapi_app.state.sources = {"present": Source()}
    _, headers = await make_user(session, "kafka")
    mock_details(
        5,
        synopsis="Plot",
        related_anime=[
            {
                "node": node(6, "Sequel"),
                "relation_type": "sequel",
                "relation_type_formatted": "Sequel",
            }
        ],
        recommendations=[{"node": node(7, "Similar"), "num_recommendations": 12}],
    )
    mock_details(6)
    mock_details(7)
    mock_details(8)

    body = (await client.get("/anime/5", headers=headers)).json()
    assert body["synopsis"] == "Plot"
    assert body["related_anime"][0]["anime"]["title"] == "Sequel"
    assert body["recommendations"][0]["num_recommendations"] == 12
    assert "available_sources" not in body

    assert (await client.get("/anime/5/sources", headers=headers)).json() == {
        "sources": ["present"],
        "choice": None,
        "stream": {"source": "auto", "lang": "sub"},
        "listing": {
            "source": "auto",
            "source_title": "x",
            "episodes": [1],
            "thumbnails": {},
        },
    }
    assert (await client.get("/anime/8/sources", headers=headers)).json() == {
        "sources": [],
        "choice": None,
        "stream": None,
        "listing": None,
    }


@respx.mock
async def test_details_of_nsfw_titles_are_hidden_unless_enabled(client, session):
    fastapi_app.state.sources = {}
    _, normal = await make_user(session, "kafka")
    _, nsfw = await make_user(session, "friend", nsfw=True)
    mock_details(9, rating="rx")
    r = await client.get("/anime/9", headers=normal)
    assert r.status_code == 404
    assert (await client.get("/anime/9", headers=nsfw)).status_code == 200


@respx.mock
async def test_a_failing_or_slow_source_is_skipped_and_remembered(client, session, monkeypatch):
    import app.routers.anime as anime_router

    monkeypatch.setattr(anime_router, "SOURCE_PROBE_TIMEOUT", 0.05)
    calls = {"broken": 0, "slow": 0}

    class Broken:
        async def episodes(self, anime, lang):
            calls["broken"] += 1
            raise RuntimeError("down")

    class Slow:
        async def episodes(self, anime, lang):
            calls["slow"] += 1
            await asyncio.sleep(5)

    fastapi_app.state.sources = {"broken": Broken(), "slow": Slow()}
    _, headers = await make_user(session, "kafka")
    mock_details(5)
    for _ in range(2):
        r = await client.get("/anime/5/sources", headers=headers)
        assert r.status_code == 200
        assert r.json()["sources"] == []
    assert calls == {"broken": 1, "slow": 1}  # the second request used the cached failure


@respx.mock
async def test_details_do_not_wait_for_the_sources(client, session):
    class Hung:
        async def episodes(self, anime, lang):
            raise AssertionError("details must not probe sources")

    fastapi_app.state.sources = {"hung": Hung()}
    _, headers = await make_user(session, "kafka")
    mock_details(5)
    assert (await client.get("/anime/5", headers=headers)).status_code == 200


@respx.mock
async def test_related_and_recommended_nsfw_titles_are_hidden_unless_enabled(client, session):
    fastapi_app.state.sources = {}
    _, normal = await make_user(session, "kafka")
    _, nsfw = await make_user(session, "friend", nsfw=True)

    def link(anime_id):
        return {
            "node": node(anime_id, f"Show {anime_id}"),
            "relation_type": "sequel",
            "relation_type_formatted": "Sequel",
        }

    mock_details(
        5,
        related_anime=[link(6), link(7)],
        recommendations=[{"node": node(7), "num_recommendations": 3}],
    )
    mock_details(6)
    mock_details(7, rating="rx")

    body = (await client.get("/anime/5", headers=normal)).json()
    assert [r["anime"]["id"] for r in body["related_anime"]] == [6]
    assert body["recommendations"] == []
    body = (await client.get("/anime/5", headers=nsfw)).json()
    assert [r["anime"]["id"] for r in body["related_anime"]] == [6, 7]
    assert len(body["recommendations"]) == 1


async def test_safe_check_leaves_out_slow_titles_after_the_budget(monkeypatch):
    import asyncio
    from typing import cast

    from app.mal.client import MalClient
    from app.routers import anime as router

    monkeypatch.setattr(router, "SAFE_CHECK_BUDGET", 0.05)

    class Mal:
        async def details(self, anime_id):
            if anime_id == 2:
                await asyncio.sleep(1)
            return {"id": anime_id, "rating": "pg_13"}

    entries = [{"node": {"id": 1}}, {"node": {"id": 2}}]
    (kept,) = await router._only_safe(cast(MalClient, Mal()), entries)
    assert [e["node"]["id"] for e in kept] == [1]


@respx.mock
async def test_concurrent_cold_requests_share_one_mal_call(client, session):
    fastapi_app.state.sources = {}
    _, headers = await make_user(session, "kafka")
    route = mock_ranking(node(2, "Two"))
    replies = await asyncio.gather(*(client.get("/anime/top", headers=headers) for _ in range(5)))
    assert all(r.status_code == 200 for r in replies)
    assert route.call_count == 1
