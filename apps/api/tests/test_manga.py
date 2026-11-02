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
    assert ids == ["continue_reading", "top", "popular", "manhwa", "manhua"]
    [reading] = home["rows"][0]["items"]
    assert reading["manga"]["title"] == "Book 1"
    assert reading["progress"]["chapter"] == "3" and reading["progress"]["page"] == 4


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
