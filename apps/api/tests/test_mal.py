from datetime import date, timedelta

import httpx
import respx

from app.db import utcnow
from app.mal.client import API_BASE, current_season, filter_nsfw, rank_search_results
from app.models import MalLink
from tests.conftest import login_token, make_user


def test_current_season():
    assert current_season(date(2026, 1, 5)) == (2026, "winter")
    assert current_season(date(2026, 4, 1)) == (2026, "spring")
    assert current_season(date(2026, 8, 31)) == (2026, "summer")
    assert current_season(date(2026, 10, 26)) == (2026, "fall")


def test_nsfw_filter():
    items = [
        {"node": {"id": 1, "rating": "pg_13", "genres": [{"name": "Action"}]}},
        {"node": {"id": 2, "rating": "rx", "genres": []}},
        {"node": {"id": 3, "rating": "r", "genres": [{"name": "Ecchi"}]}},
    ]
    assert [i["node"]["id"] for i in filter_nsfw(items, False)] == [1]
    assert len(filter_nsfw(items, True)) == 3


def test_search_prefers_exact_title_over_popularity():
    items = [
        {"node": {"id": 1, "title": "Naruto: Shippuuden", "num_list_users": 3_000_000}},
        {"node": {"id": 2, "title": "Naruto", "num_list_users": 2_000_000}},
    ]
    assert rank_search_results("naruto", items)[0]["node"]["id"] == 2


@respx.mock
async def test_seasonal_uses_current_season_and_users_nsfw_setting(client, session):
    _, headers = await make_user(session, "kafka")
    year, season = current_season()
    route = respx.get(f"{API_BASE}/anime/season/{year}/{season}").mock(
        return_value=httpx.Response(200, json={"data": [], "paging": {}})
    )
    r = await client.get("/anime/seasonal", headers=headers)
    assert r.status_code == 200
    assert r.json()["season"] == season
    assert route.calls.last.request.url.params["nsfw"] == "false"


@respx.mock
async def test_mal_errors_become_clear_api_errors(client, session):
    _, headers = await make_user(session, "kafka")
    respx.get(f"{API_BASE}/anime/1").mock(return_value=httpx.Response(404))
    respx.get(f"{API_BASE}/anime/2").mock(return_value=httpx.Response(403, json={"error": "x"}))
    assert (await client.get("/anime/1", headers=headers)).json()["error"]["code"] == (
        "anime_not_found"
    )
    r = await client.get("/anime/2", headers=headers)
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "mal_unavailable"


async def test_anime_routes_need_login(client):
    assert (await client.get("/anime/top")).status_code == 401


async def test_mal_callback_handles_denied_consent(client):
    r = await client.get("/mal/callback", params={"error": "access_denied", "state": "s"})
    assert r.status_code == 307
    assert r.headers["location"].endswith("/pt/settings?mal=denied")


async def test_mal_callback_rejects_unknown_state(client):
    r = await client.get("/mal/callback", params={"code": "c", "state": "unknown"})
    assert r.headers["location"].endswith("/pt/settings?mal=failed")


async def test_list_entry_without_a_mal_link(client, session):
    _, headers = await make_user(session, "kafka")
    r = await client.get("/me/animelist/5", headers=headers)
    assert r.status_code == 200
    assert r.json() == {"linked": False, "status": None, "score": 0, "num_episodes_watched": 0}


@respx.mock
async def test_list_entry_reads_the_users_status(client, session):
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
    route = respx.get(f"{API_BASE}/anime/5").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": 5,
                "my_list_status": {"status": "watching", "score": 8, "num_episodes_watched": 3},
            },
        )
    )
    respx.get(f"{API_BASE}/anime/6").mock(return_value=httpx.Response(200, json={"id": 6}))

    body = (await client.get("/me/animelist/5", headers=headers)).json()
    assert body == {"linked": True, "status": "watching", "score": 8, "num_episodes_watched": 3}
    assert route.calls.last.request.headers["authorization"] == "Bearer a"
    assert (await client.get("/me/animelist/6", headers=headers)).json()["status"] is None


async def test_mal_callback_returns_to_the_users_language(client, session):
    from app.models import MalOAuthState

    user, _ = await make_user(session, "kafka")
    session.add(MalOAuthState(state="abc", user_id=user.id, verifier="v", locale="en"))
    await session.commit()
    r = await client.get("/mal/callback", params={"error": "access_denied", "state": "abc"})
    assert r.headers["location"].endswith("/en/settings?mal=denied")


@respx.mock
async def test_animelist_is_cached_until_the_list_changes(client, session):
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
    listing = respx.get(f"{API_BASE}/users/@me/animelist").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    respx.patch(f"{API_BASE}/anime/5/my_list_status").mock(
        return_value=httpx.Response(200, json={"status": "completed"})
    )

    await client.get("/me/animelist", headers=headers)
    await client.get("/me/animelist", headers=headers)
    assert listing.call_count == 1

    await client.patch("/me/animelist/5", json={"status": "completed"}, headers=headers)
    await client.get("/me/animelist", headers=headers)
    assert listing.call_count == 2


@respx.mock
async def test_animelist_cache_is_dropped_on_delete_and_unlink(client, session):
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
    listing = respx.get(f"{API_BASE}/users/@me/animelist").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    respx.delete(f"{API_BASE}/anime/5/my_list_status").mock(return_value=httpx.Response(200))

    await client.get("/me/animelist", headers=headers)
    await client.delete("/me/animelist/5", headers=headers)
    await client.get("/me/animelist", headers=headers)
    assert listing.call_count == 2

    await client.delete("/me/mal", headers=headers)
    assert (await client.get("/me/animelist", headers=headers)).status_code != 200
    assert listing.call_count == 2


@respx.mock
async def test_mal_callback_refuses_a_browser_signed_in_as_someone_else(client, session):
    from sqlalchemy import select

    from app.models import MalLink, MalOAuthState

    starter, _ = await make_user(session, "kafka")
    victim, _ = await make_user(session, "friend")
    session.add(MalOAuthState(state="abc", user_id=starter.id, verifier="v", locale="en"))
    await session.commit()
    token = respx.post("https://myanimelist.net/v1/oauth2/token").mock(
        return_value=httpx.Response(
            200, json={"access_token": "a", "refresh_token": "r", "expires_in": 3600}
        )
    )
    respx.get(f"{API_BASE}/users/@me").mock(
        return_value=httpx.Response(200, json={"name": "victim"})
    )

    client.cookies.set("mr_access", await login_token(session, victim))
    r = await client.get("/mal/callback", params={"code": "c", "state": "abc"})
    assert r.headers["location"].endswith("/en/settings?mal=failed")
    assert not token.called
    assert await session.scalar(select(MalLink)) is None


@respx.mock
async def test_mal_callback_links_for_the_signed_in_browser(client, session):
    from sqlalchemy import select

    from app.models import MalLink, MalOAuthState

    user, _ = await make_user(session, "kafka")
    session.add(MalOAuthState(state="abc", user_id=user.id, verifier="v", locale="en"))
    await session.commit()
    respx.post("https://myanimelist.net/v1/oauth2/token").mock(
        return_value=httpx.Response(
            200, json={"access_token": "a", "refresh_token": "r", "expires_in": 3600}
        )
    )
    respx.get(f"{API_BASE}/users/@me").mock(
        return_value=httpx.Response(200, json={"name": "kafka"})
    )

    client.cookies.set("mr_access", await login_token(session, user))
    r = await client.get("/mal/callback", params={"code": "c", "state": "abc"})
    assert r.headers["location"].endswith("/en/settings?mal=linked")
    assert await session.scalar(select(MalLink.user_id)) == user.id


async def test_mal_callback_without_a_session_is_refused(client, session):
    from app.models import MalOAuthState

    user, _ = await make_user(session, "kafka")
    session.add(MalOAuthState(state="abc", user_id=user.id, verifier="v", locale="en"))
    await session.commit()
    r = await client.get("/mal/callback", params={"code": "c", "state": "abc"})
    assert r.headers["location"].endswith("/en/settings?mal=failed")


@respx.mock
async def test_mal_calls_are_capped_in_flight(client):
    import asyncio

    from app.mal.client import MAX_CONCURRENT_CALLS, MalClient

    running = peak = 0

    async def slow(request):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.01)
        running -= 1
        return httpx.Response(200, json={"id": 1})

    respx.get(url__regex=rf"{API_BASE}/anime/\d+").mock(side_effect=slow)
    async with httpx.AsyncClient() as http:
        mal = MalClient("id", http)
        await asyncio.gather(*(mal.details(i) for i in range(1, 40)))
    assert peak <= MAX_CONCURRENT_CALLS
