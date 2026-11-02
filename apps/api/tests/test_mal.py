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


async def _linked_accounts(session):
    from app.config import get_settings
    from app.mal.account import MalAccounts

    user, _ = await make_user(session, "kafka")
    session.add(
        MalLink(
            user_id=user.id,
            access_token="a",
            refresh_token="r",
            expires_at=utcnow() + timedelta(hours=1),
        )
    )
    await session.commit()
    return user, MalAccounts(get_settings(), httpx.AsyncClient())


def _entry(anime_id, **status):
    body = {"id": anime_id, "my_list_status": status} if status else {"id": anime_id}
    return respx.get(f"{API_BASE}/anime/{anime_id}").mock(
        return_value=httpx.Response(200, json=body)
    )


def _patch(anime_id):
    return respx.patch(f"{API_BASE}/anime/{anime_id}/my_list_status").mock(
        return_value=httpx.Response(200, json={})
    )


@respx.mock
async def test_finishing_an_episode_starts_the_title_as_watching(session):
    user, accounts = await _linked_accounts(session)
    _entry(7)
    patch = _patch(7)
    await accounts.sync_finished_episode(session, user, 7, 1, 12)
    assert b"status=watching" in patch.calls.last.request.content
    assert b"num_watched_episodes=1" in patch.calls.last.request.content


@respx.mock
async def test_finishing_the_last_episode_completes_the_title(session):
    user, accounts = await _linked_accounts(session)
    _entry(7, status="watching", num_episodes_watched=11)
    patch = _patch(7)
    await accounts.sync_finished_episode(session, user, 7, 12, 12)
    assert b"status=completed" in patch.calls.last.request.content


@respx.mock
async def test_sync_never_goes_back_or_overrides_a_parked_title(session):
    user, accounts = await _linked_accounts(session)
    _entry(1, status="watching", num_episodes_watched=5)
    _entry(2, status="dropped", num_episodes_watched=1)
    _entry(3, status="completed", num_episodes_watched=12)
    patches = [_patch(i) for i in (1, 2, 3)]
    await accounts.sync_finished_episode(session, user, 1, 3, 12)
    await accounts.sync_finished_episode(session, user, 2, 4, 12)
    await accounts.sync_finished_episode(session, user, 3, 1, 12)
    assert [p.called for p in patches] == [False, False, False]


async def test_sync_does_nothing_without_a_mal_link(session):
    from app.config import get_settings
    from app.mal.account import MalAccounts

    user, _ = await make_user(session, "kafka")
    await MalAccounts(get_settings(), httpx.AsyncClient()).sync_finished_episode(
        session, user, 7, 1, 12
    )


@respx.mock
async def test_on_hold_and_plan_to_watch_titles_move_to_watching(session):
    user, accounts = await _linked_accounts(session)
    _entry(4, status="on_hold", num_episodes_watched=2)
    _entry(5, status="plan_to_watch", num_episodes_watched=0)
    patches = [_patch(4), _patch(5)]
    await accounts.sync_finished_episode(session, user, 4, 3, 12)
    await accounts.sync_finished_episode(session, user, 5, 1, 12)
    assert all(b"status=watching" in p.calls.last.request.content for p in patches)


def _manga_entry(manga_id, **status):
    body = {"id": manga_id, "my_list_status": status} if status else {"id": manga_id}
    return respx.get(f"{API_BASE}/manga/{manga_id}").mock(
        return_value=httpx.Response(200, json=body)
    )


def _manga_patch(manga_id):
    return respx.patch(f"{API_BASE}/manga/{manga_id}/my_list_status").mock(
        return_value=httpx.Response(200, json={})
    )


@respx.mock
async def test_finishing_a_chapter_starts_the_manga_as_reading(session):
    user, accounts = await _linked_accounts(session)
    _manga_entry(9)
    patch = _manga_patch(9)
    await accounts.sync_finished_chapter(session, user, 9, 1, 0)
    body = patch.calls.last.request.content
    assert b"status=reading" in body and b"num_chapters_read=1" in body


@respx.mock
async def test_finishing_the_last_chapter_completes_the_manga(session):
    user, accounts = await _linked_accounts(session)
    _manga_entry(9, status="reading", num_chapters_read=41)
    patch = _manga_patch(9)
    await accounts.sync_finished_chapter(session, user, 9, 42, 42)
    assert b"status=completed" in patch.calls.last.request.content


@respx.mock
async def test_chapter_sync_never_goes_back_or_overrides_a_parked_manga(session):
    user, accounts = await _linked_accounts(session)
    _manga_entry(1, status="reading", num_chapters_read=5)
    _manga_entry(2, status="dropped", num_chapters_read=1)
    _manga_entry(3, status="completed", num_chapters_read=12)
    patches = [_manga_patch(i) for i in (1, 2, 3)]
    await accounts.sync_finished_chapter(session, user, 1, 3, 12)
    await accounts.sync_finished_chapter(session, user, 2, 4, 12)
    await accounts.sync_finished_chapter(session, user, 3, 1, 12)
    assert [p.called for p in patches] == [False, False, False]


@respx.mock
async def test_manga_list_is_read_and_edited_through_the_same_link(client, session):
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
    listing = respx.get(f"{API_BASE}/users/@me/mangalist").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {
                        "node": {"id": 9, "title": "Berserk", "num_chapters": 0},
                        "list_status": {"status": "reading", "score": 10, "num_chapters_read": 3},
                    }
                ]
            },
        )
    )
    _manga_entry(9, status="reading", score=10, num_chapters_read=3)
    patch = _manga_patch(9)
    delete = respx.delete(f"{API_BASE}/manga/9/my_list_status").mock(
        return_value=httpx.Response(200, json={})
    )

    body = (await client.get("/me/mangalist", headers=headers)).json()
    assert body["data"][0]["node"]["title"] == "Berserk"
    assert body["data"][0]["list_status"]["num_chapters_read"] == 3
    assert listing.calls.last.request.url.params["fields"].startswith("list_status,num_chapters")

    entry = (await client.get("/me/mangalist/9", headers=headers)).json()
    assert entry == {
        "linked": True,
        "status": "reading",
        "score": 10,
        "num_chapters_read": 3,
        "num_volumes_read": 0,
    }

    r = await client.patch("/me/mangalist/9", json={"status": "completed"}, headers=headers)
    assert r.status_code == 200 and b"status=completed" in patch.calls.last.request.content
    assert (await client.delete("/me/mangalist/9", headers=headers)).status_code == 204
    assert delete.called
    # Each write drops the cached list, so the next read sees the change.
    await client.get("/me/mangalist", headers=headers)
    assert listing.call_count == 2


@respx.mock
async def test_manga_list_without_a_link(client, session):
    _, headers = await make_user(session, "kafka")
    assert (await client.get("/me/mangalist/9", headers=headers)).json() == {
        "linked": False,
        "status": None,
        "score": 0,
        "num_chapters_read": 0,
        "num_volumes_read": 0,
    }
    r = await client.get("/me/mangalist", headers=headers)
    assert r.status_code == 400 and r.json()["error"]["code"] == "mal_not_linked"
