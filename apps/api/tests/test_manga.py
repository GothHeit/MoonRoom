"""The manga section: MAL catalog, chapters from a source, signed page links and progress."""

from urllib.parse import parse_qs, urlsplit

import httpx
import respx

from app import hls
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.manga.base import Chapter, ChapterList, Pages
from tests.conftest import make_user, viewer_of
from tests.test_hls import public_dns  # noqa: F401


def manga(manga_id, title="Book", media_type="manga", genres=(), **extra):
    return {
        "id": manga_id,
        "title": title,
        "main_picture": {"medium": f"https://img/{manga_id}.jpg"},
        "mean": 8.0,
        "media_type": media_type,
        "num_list_users": 1000,
        "genres": [{"id": g, "name": n} for g, n in genres],
        **extra,
    }


def mock_ranking(*nodes):
    return respx.get(f"{API_BASE}/manga/ranking").mock(
        return_value=httpx.Response(200, json={"data": [{"node": n} for n in nodes]})
    )


def mock_details(manga_id, **fields):
    return respx.get(f"{API_BASE}/manga/{manga_id}").mock(
        return_value=httpx.Response(200, json=manga(manga_id, f"Book {manga_id}", **fields))
    )


CHAPTERS = [
    Chapter("c1", "1", "1", "One", "en", "Group", "2024-01-01T00:00:00+00:00", 2),
    Chapter("c2", "2", "1", None, "en", None, None, 3),
]


class FakeSource:
    name = "fake"

    def __init__(self):
        self.asked: list[str | None] = []

    async def chapters(self, detail, lang):
        self.asked.append(lang)
        if detail["id"] != 1:
            return None
        if lang == "pt-br":
            return ChapterList(
                "x", "Book", ["pt-br", "en"], [Chapter("p1", "1", None, None, "pt-br")]
            )
        return ChapterList("x", "Book", ["pt-br", "en"], CHAPTERS)

    async def pages(self, detail, chapter_id):
        if detail["id"] == 1 and chapter_id == "c1":
            return Pages(["https://pages.example/1.jpg", "https://pages.example/2.jpg"], {})
        return None


class BrokenSource:
    name = "broken"

    async def chapters(self, detail, lang):
        raise RuntimeError("down")

    async def pages(self, detail, chapter_id):
        raise RuntimeError("down")


@respx.mock
async def test_home_lists_rankings_and_what_the_user_is_reading(client, session):
    _, headers = await make_user(session, "kafka")
    mock_ranking(manga(1, "One"), manga(2, "Two"))
    mock_details(1)
    r = await client.put("/manga/1/progress/3", json={"page": 4, "pages": 20}, headers=headers)
    assert r.status_code == 200 and r.json()["completed"] is False

    home = (await client.get("/manga/home", headers=headers)).json()
    ids = [row["id"] for row in home["rows"]]
    assert ids == ["continue_reading", "top", "popular", "manhwa", "manhua", "favorites"]
    [reading] = home["rows"][0]["items"]
    assert reading["manga"]["title"] == "Book 1"
    assert reading["progress"]["chapter"] == "3" and reading["progress"]["page"] == 4


@respx.mock
async def test_home_adds_genre_rows_and_what_goes_with_the_last_title_read(
    client, session, monkeypatch
):
    from app.routers import manga as manga_router

    monkeypatch.setattr(manga_router, "todays_genres", lambda today, count=4: [1, 4])
    _, headers = await make_user(session, "kafka")
    action = [manga(n, f"A{n}", genres=[(1, "Action")]) for n in range(100, 110)]
    mock_ranking(*action, manga(2, "Two", genres=[(4, "Comedy")]))
    mock_details(
        1,
        recommendations=[
            {"node": {"id": n, "title": f"R{n}"}, "num_recommendations": 3} for n in range(50, 56)
        ],
    )
    # Recommendations carry no genres: with the adult switch off, each is checked.
    for n in range(50, 56):
        mock_details(n)
    await client.put("/manga/1/progress/3", json={"page": 4, "pages": 20}, headers=headers)

    home = (await client.get("/manga/home", headers=headers)).json()
    rows = {row["id"]: row for row in home["rows"]}
    assert [row["id"] for row in home["rows"]] == [
        "continue_reading",
        "similar",
        "top",
        "popular",
        "manhwa",
        "manhua",
        "genre",
        "favorites",
    ]
    # Comedy has one title: too short a row to show. Action has ten.
    assert rows["genre"]["genre"]["name"] == "Action"
    assert len(rows["genre"]["items"]) == 10
    assert rows["similar"]["about"]["title"] == "Book 1"
    assert [i["manga"]["id"] for i in rows["similar"]["items"]] == list(range(50, 56))


@respx.mock
async def test_browse_filters_a_ranking_by_genre(client, session):
    _, headers = await make_user(session, "kafka")
    route = mock_ranking(
        manga(1, "One", genres=[(22, "Romance")]),
        manga(2, "Two", genres=[(1, "Action")]),
        manga(3, "Three", genres=[(22, "Romance"), (1, "Action")]),
    )
    found = (
        await client.get("/manga/browse", params={"row": "manhwa", "genre": 22}, headers=headers)
    ).json()
    assert [m["id"] for m in found["data"]] == [1, 3] and found["has_next"] is False
    # The deep pool is several pages of the row's own ranking, not the default one.
    assert {
        parse_qs(urlsplit(str(c.request.url)).query)["ranking_type"][0] for c in route.calls
    } == {"manhwa"}
    assert len(route.calls) > 1

    assert (
        await client.get("/manga/browse", params={"genre": 999}, headers=headers)
    ).status_code == 422
    # Adult genres are not offered, nor accepted, with the switch off.
    listed = (await client.get("/manga/genres", headers=headers)).json()
    assert "Hentai" not in {g["name"] for g in listed}
    assert (
        await client.get("/manga/browse", params={"genre": 12}, headers=headers)
    ).status_code == 422


@respx.mock
async def test_adult_titles_are_hidden_unless_the_user_allows_them(client, session):
    _, normal = await make_user(session, "kafka")
    _, adult = await make_user(session, "friend", nsfw=True)
    mock_details(9, genres=[(12, "Hentai")])
    assert (await client.get("/manga/9", headers=normal)).status_code == 404
    assert (await client.get("/manga/9", headers=adult)).status_code == 200

    respx.get(f"{API_BASE}/manga").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {"node": manga(9, "Nine", genres=[(12, "Hentai")])},
                    {"node": manga(8, "Eight")},
                ]
            },
        )
    )
    found = (await client.get("/manga/search", params={"q": "ni"}, headers=normal)).json()
    assert [m["id"] for m in found["data"]] == [8]


@respx.mock
async def test_chapters_come_from_the_first_source_that_has_the_title(client, session):
    fake = FakeSource()
    fastapi_app.state.manga_sources = {"broken": BrokenSource(), "fake": fake}
    user, headers = await make_user(session, "kafka")
    mock_details(1)
    mock_details(2)

    r = await client.get("/manga/1/chapters", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "fake" and body["languages"] == ["pt-br", "en"]
    # The user's locale is Portuguese and the source has it: listed again in pt-br.
    assert body["lang"] == "pt-br" and [c["id"] for c in body["chapters"]] == ["p1"]
    assert fake.asked == [None, "pt-br"]

    r = await client.get("/manga/1/chapters", params={"lang": "en"}, headers=headers)
    assert [c["id"] for c in r.json()["chapters"]] == ["c1", "c2"]
    assert r.json()["chapters"][0]["group"] == "Group"

    assert (await client.get("/manga/2/chapters", headers=headers)).status_code == 404


class EmptySource:
    """Knows the title but has no readable chapters, as MangaDex does for a licensed one."""

    name = "empty"

    async def chapters(self, detail, lang):
        return ChapterList("e", "Book", ["en"], [])

    async def pages(self, detail, chapter_id):
        return None


@respx.mock
async def test_a_source_without_chapters_does_not_stop_the_next_one(client, session):
    fastapi_app.state.manga_sources = {"empty": EmptySource(), "fake": FakeSource()}
    user, headers = await make_user(session, "kafka")
    mock_details(1)
    body = (await client.get("/manga/1/chapters", params={"lang": "en"}, headers=headers)).json()
    assert body["source"] == "fake" and len(body["chapters"]) == 2

    # When nobody has chapters, the empty answer still tells the user which languages exist.
    fastapi_app.state.manga_sources = {"empty": EmptySource()}
    body = (await client.get("/manga/1/chapters", headers=headers)).json()
    assert body["source"] == "empty" and body["chapters"] == []


@respx.mock
async def test_pages_are_signed_for_the_reader_and_served_through_the_cache(
    client, session, tmp_path
):
    from app.routers.manga import new_page_cache

    fastapi_app.state.manga_sources = {"fake": FakeSource()}
    fastapi_app.state.page_cache = new_page_cache(str(tmp_path), 10)
    _, headers = await make_user(session, "kafka")
    _, other = await make_user(session, "friend")
    mock_details(1)

    r = await client.get("/manga/1/read/fake/c1", params={"lang": "en"}, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["chapter"]["number"] == "1" and body["previous"] is None
    assert body["next"]["id"] == "c2" and body["progress"] is None
    await client.put("/manga/1/progress/1", json={"page": 1, "pages": 2}, headers=headers)
    r = await client.get("/manga/1/read/fake/c1", params={"lang": "en"}, headers=headers)
    assert r.json()["progress"]["page"] == 1
    assert len(body["pages"]) == 2 and body["pages"][0].startswith("/manga/page?u=")
    q = {k: v[0] for k, v in parse_qs(urlsplit(body["pages"][0]).query).items()}
    assert q["k"] == "img" and hls.Viewer(q["v"], q["i"]) == viewer_of(headers)

    image = respx.get("https://pages.example/1.jpg").mock(
        return_value=httpx.Response(
            200, content=b"\xff\xd8jpeg", headers={"content-type": "image/jpeg"}
        )
    )
    link = body["pages"][0]
    served = await client.get(link)  # no login header: the link stands on its own
    assert served.status_code == 200 and served.content == b"\xff\xd8jpeg"
    assert served.headers["content-type"] == "image/jpeg"
    assert "private" in served.headers["cache-control"]
    again = await client.get(link)
    assert again.status_code == 200 and again.content == b"\xff\xd8jpeg"
    assert image.call_count == 1  # the second read came from disk

    # A tampered or foreign link is refused.
    assert (await client.get(link.replace("&s=", "&s=0"))).status_code == 403
    assert (
        await client.get(link.replace(f"v={q['v']}", f"v={viewer_of(other).user}"))
    ).status_code == 403
    assert (await client.get("/manga/1/read/fake/gone", headers=headers)).status_code == 404
    # A chapter of another title is not served under this one.
    mock_details(2)
    assert (await client.get("/manga/2/read/fake/c1", headers=headers)).status_code == 404
    # A host that answers with something other than a picture is not cached or served.
    respx.get("https://pages.example/2.jpg").mock(
        return_value=httpx.Response(200, content=b"<html>", headers={"content-type": "text/html"})
    )
    assert (await client.get(body["pages"][1])).status_code == 502
    assert (await client.get(body["pages"][1])).status_code == 502
    assert (await client.get("/manga/1/read/nope/c1", headers=headers)).status_code == 404


async def test_progress_is_upserted_and_finishes_on_the_last_page(client, session):
    _, headers = await make_user(session, "kafka")
    r = await client.put("/manga/5/progress/12.5", json={"page": 3, "pages": 10}, headers=headers)
    assert r.status_code == 200
    assert r.json()["chapter"] == "12.5" and r.json()["completed"] is False
    r = await client.put("/manga/5/progress/12.5", json={"page": 99, "pages": 10}, headers=headers)
    assert r.json()["page"] == 9 and r.json()["completed"] is True
    assert (
        await client.put("/manga/5/progress/1", json={"page": 0, "pages": 0}, headers=headers)
    ).status_code == 422


async def _link(session, user):
    from datetime import timedelta

    from app.db import utcnow
    from app.models import MalLink

    session.add(
        MalLink(
            user_id=user.id,
            access_token="a",
            refresh_token="r",
            expires_at=utcnow() + timedelta(hours=1),
        )
    )
    await session.commit()


@respx.mock
async def test_finishing_a_chapter_is_mirrored_on_the_mal_list_once(client, session):
    import asyncio

    user, headers = await make_user(session, "kafka")
    await _link(session, user)
    mock_details(4, num_chapters=0)
    respx.get(f"{API_BASE}/manga/4").mock(
        return_value=httpx.Response(200, json={**manga(4), "my_list_status": {}})
    )
    patch = respx.patch(f"{API_BASE}/manga/4/my_list_status").mock(
        return_value=httpx.Response(200, json={})
    )
    for _ in range(2):  # saving the last page again doesn't sync again
        r = await client.put(
            "/manga/4/progress/12.5", json={"page": 9, "pages": 10}, headers=headers
        )
        assert r.json()["completed"] is True
        await asyncio.gather(*fastapi_app.state.__dict__.get("mal_sync_tasks", set()))
    assert patch.call_count == 1
    body = patch.calls.last.request.content
    assert b"status=reading" in body and b"num_chapters_read=12" in body

    # An unnumbered chapter has no place on MAL: nothing is sent.
    await client.put("/manga/4/progress/abc", json={"page": 9, "pages": 10}, headers=headers)
    await asyncio.gather(*fastapi_app.state.__dict__.get("mal_sync_tasks", set()))
    assert patch.call_count == 1


@respx.mock
async def test_home_shows_the_users_mal_manga_list(client, session):
    user, headers = await make_user(session, "kafka")
    await _link(session, user)
    mock_ranking(manga(1, "One"))
    respx.get(f"{API_BASE}/users/@me/mangalist").mock(
        return_value=httpx.Response(
            200,
            json={"data": [{"node": manga(7, "Listed"), "list_status": {"status": "reading"}}]},
        )
    )
    home = (await client.get("/manga/home", headers=headers)).json()
    assert [row["id"] for row in home["rows"]][:2] == ["my_list", "top"]
    assert home["rows"][0]["items"][0]["manga"]["title"] == "Listed"


class OneLanguage:
    """A site with a single language, like MangaPill or a pt-BR scraper."""

    def __init__(self, name, lang, count=1):
        self.name = name
        self._lang = lang
        self._count = count

    async def chapters(self, detail, lang):
        chapters = [
            Chapter(f"{self.name}{n}", str(n), None, None, self._lang)
            for n in range(1, self._count + 1)
        ]
        return ChapterList(self.name, "Book", [self._lang], chapters)

    async def pages(self, detail, chapter_id):
        return None


@respx.mock
async def test_every_source_is_asked_and_the_language_menu_is_their_union(client, session):
    # English first in the order, but a Portuguese reader is still offered the pt-br source.
    fastapi_app.state.manga_sources = {
        "en_site": OneLanguage("en_site", "en"),
        "pt_site": OneLanguage("pt_site", "pt-br"),
        "pt_two": OneLanguage("pt_two", "pt-br"),
    }
    _, headers = await make_user(session, "kafka")
    mock_details(1)

    body = (await client.get("/manga/1/chapters", headers=headers)).json()
    assert body["languages"] == ["pt-br", "en"]
    assert body["lang"] == "pt-br" and body["source"] == "pt_site"
    assert body["sources"] == ["pt_site", "pt_two"]

    body = (
        await client.get("/manga/1/chapters", params={"source": "pt_two"}, headers=headers)
    ).json()
    assert body["source"] == "pt_two"
    # A source that doesn't have the language is ignored rather than trusted.
    body = (
        await client.get("/manga/1/chapters", params={"source": "en_site"}, headers=headers)
    ).json()
    assert body["source"] == "pt_site"

    body = (await client.get("/manga/1/chapters", params={"lang": "en"}, headers=headers)).json()
    assert body["source"] == "en_site" and body["sources"] == ["en_site"]


class ClaimsEnglish(OneLanguage):
    """Like MangaDex for a licensed title: lists English but has chapters only in pt-br."""

    async def chapters(self, detail, lang):
        return ChapterList(
            self.name, "Book", ["pt-br", "en"], [Chapter("c1", "85", None, None, "pt-br")]
        )


@respx.mock
async def test_a_source_that_only_claims_a_language_does_not_hide_the_one_that_has_it(
    client, session
):
    fastapi_app.state.manga_sources = {
        "hollow": ClaimsEnglish("hollow", "pt-br"),
        "en_site": OneLanguage("en_site", "en"),
    }
    _, headers = await make_user(session, "kafka")
    mock_details(1)
    body = (await client.get("/manga/1/chapters", params={"lang": "en"}, headers=headers)).json()
    assert body["lang"] == "en" and body["source"] == "en_site"
    assert body["chapters"][0]["id"] == "en_site1"


@respx.mock
async def test_the_default_manga_language_beats_the_site_language(client, session):
    fastapi_app.state.manga_sources = {
        "en_site": OneLanguage("en_site", "en"),
        "pt_site": OneLanguage("pt_site", "pt-br"),
    }
    _, headers = await make_user(session, "kafka")
    mock_details(1)
    r = await client.patch("/me", json={"manga_lang": "en"}, headers=headers)
    assert r.json()["manga_lang"] == "en"
    assert (await client.get("/manga/1/chapters", headers=headers)).json()["lang"] == "en"
    # Back to following the site language; a language the title lacks falls back to what exists.
    r = await client.patch("/me", json={"manga_lang": "auto"}, headers=headers)
    assert r.json()["manga_lang"] is None
    fastapi_app.state.manga_sources = {"en_site": OneLanguage("en_site", "en")}
    assert (await client.get("/manga/1/chapters", headers=headers)).json()["lang"] == "en"
    bad = await client.patch("/me", json={"manga_lang": "fr!"}, headers=headers)
    assert bad.status_code == 422


@respx.mock
async def test_removing_from_continue_reading_keeps_progress_until_read_again(client, session):
    _, headers = await make_user(session, "kafka")
    _, friend = await make_user(session, "friend")
    mock_ranking(manga(1, "One"), manga(2, "Two"))
    mock_details(1)
    for who in (headers, friend):
        await client.put("/manga/1/progress/3", json={"page": 4, "pages": 20}, headers=who)

    r = await client.delete("/manga/1/continue", headers=headers)
    assert r.status_code == 204
    # Idempotent.
    assert (await client.delete("/manga/1/continue", headers=headers)).status_code == 204

    def ids(home):
        return [row["id"] for row in home["rows"]]

    assert "continue_reading" not in ids((await client.get("/manga/home", headers=headers)).json())
    assert "continue_reading" in ids((await client.get("/manga/home", headers=friend)).json())

    await client.put("/manga/1/progress/4", json={"page": 1, "pages": 20}, headers=headers)
    assert "continue_reading" in ids((await client.get("/manga/home", headers=headers)).json())


async def test_remove_from_continue_reading_needs_login(client):
    assert (await client.delete("/manga/1/continue")).status_code == 401


@respx.mock
async def test_the_most_complete_source_in_the_language_is_listed_first(client, session):
    fastapi_app.state.manga_sources = {
        "short": OneLanguage("short", "pt-br", 3),
        "whole": OneLanguage("whole", "pt-br", 20),
        "tie": OneLanguage("tie", "pt-br", 20),
    }
    _, headers = await make_user(session, "kafka")
    mock_details(1)

    body = (await client.get("/manga/1/chapters", headers=headers)).json()
    assert body["source"] == "whole" and len(body["chapters"]) == 20
    assert body["source_counts"] == {"short": 3, "whole": 20, "tie": 20}
    # Asking for a source still wins over the count.
    body = (
        await client.get("/manga/1/chapters", params={"source": "short"}, headers=headers)
    ).json()
    assert body["source"] == "short" and len(body["chapters"]) == 3
