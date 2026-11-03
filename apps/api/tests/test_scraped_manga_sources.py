"""Mangapill and Madara sources, against recorded shapes of their pages."""

import httpx
import pytest
import respx

from app.manga import load_manga_sources
from app.manga.leituramanga import LeituramangaSource
from app.manga.madara import MadaraSource
from app.manga.mangapill import MangapillSource
from app.manga.toonbr import ToonbrSource

MONSTER = {"id": 1, "title": "Monster", "alternative_titles": {"en": "Monster"}}

PILL = "https://mangapill.com"
PILL_SEARCH = """
<a href="/manga/2958/monster-hunter-orage" class="mb-2">
  <div class="mt-3 font-black leading-tight line-clamp-2">Monster Hunter Orage</div></a>
<a href="/manga/3/monster" class="mb-2">
  <div class="mt-3 font-black leading-tight line-clamp-2">Monster</div>
  <div class="line-clamp-2 text-xs text-secondary mt-1">MONSTER</div></a>
"""
PILL_TITLE = """
<a href="/chapters/3-10002000/monster-chapter-2" title="x">Chapter 2</a>
<a href="/chapters/3-10001000/monster-chapter-1" title="x">Chapter 1</a>
<a href="/chapters/9-10001000/other-chapter-1" title="x">Chapter 1</a>
"""
PILL_CHAPTER = """
<img class="js-page" data-src="https://cdn.example.com/1.jpeg?t=1" alt="p1"/>
<img class="js-page" data-src="http://insecure.example.com/2.jpeg" alt="p2"/>
"""


@pytest.fixture
async def pill():
    async with httpx.AsyncClient(follow_redirects=True) as client:
        yield MangapillSource(client)


@respx.mock
async def test_mangapill_matches_lists_in_order_and_sends_its_referer(pill):
    respx.get(f"{PILL}/search").mock(return_value=httpx.Response(200, text=PILL_SEARCH))
    respx.get(f"{PILL}/manga/3/x").mock(return_value=httpx.Response(200, text=PILL_TITLE))
    pages = respx.get(f"{PILL}/chapters/3-10001000").mock(
        return_value=httpx.Response(200, text=PILL_CHAPTER)
    )
    listed = await pill.chapters(MONSTER, None)
    assert listed is not None and listed.source_id == "3"
    # Only this title's chapters, first chapter first.
    assert [c.number for c in listed.chapters] == ["1", "2"]
    found = await pill.pages(MONSTER, "3-10001000")
    assert pages.called
    assert found is not None
    assert found.urls == ["https://cdn.example.com/1.jpeg?t=1"]
    assert found.upstream_headers == {"Referer": "https://mangapill.com/"}


@respx.mock
async def test_mangapill_refuses_other_titles_and_odd_ids(pill):
    respx.get(f"{PILL}/search").mock(return_value=httpx.Response(200, text=PILL_SEARCH))
    assert await pill.pages(MONSTER, "9-10001000") is None
    assert await pill.pages(MONSTER, "../../etc") is None


@respx.mock
async def test_mangapill_has_nothing_for_a_title_it_lacks(pill):
    respx.get(f"{PILL}/search").mock(return_value=httpx.Response(200, text=PILL_SEARCH))
    assert await pill.chapters({"id": 2, "title": "Death Note"}, None) is None


LIVRE = "https://livre.example"
LIVRE_SEARCH = """
<div class="row c-tabs-item__content"><div class="tab-thumb">
<a href="https://livre.example/manga/gachiakuta/" title="Gachiakuta"><img></a></div></div>
<div class="row c-tabs-item__content"><div class="tab-thumb">
<a href="https://livre.example/manga/monster-musume/" title="Monster Musume"><img></a></div></div>
"""
LIVRE_CHAPTERS = """
<ul><li class="wp-manga-chapter  ">
<a href="https://livre.example/manga/gachiakuta/capitulo-2/">Capitulo 2 - gachiakuta</a></li>
<li class="wp-manga-chapter  ">
<a href="https://livre.example/manga/gachiakuta/vol-1/capitulo-1-5/">Capitulo 1.5</a></li>
<li class="wp-manga-chapter  ">
<a href="https://livre.example/manga/other/capitulo-9/">Capitulo 9</a></li></ul>
"""
LIVRE_PAGE = """
<img id="image-0" src=" https://livre.example/wp-content/1.webp" class="wp-manga-chapter-img">
<img id="image-1" data-src="https://livre.example/wp-content/2.webp" class="wp-manga-chapter-img">
<img src="https://livre.example/logo.png" class="logo">
"""
GACHI = {"id": 7, "title": "Gachiakuta"}


@pytest.fixture
async def livre():
    async with httpx.AsyncClient(follow_redirects=True) as client:
        yield MadaraSource("livre", LIVRE, "pt-br", client)


@respx.mock
async def test_madara_lists_chapters_and_resolves_pages(livre):
    respx.get(f"{LIVRE}/").mock(return_value=httpx.Response(200, text=LIVRE_SEARCH))
    respx.post(f"{LIVRE}/manga/gachiakuta/ajax/chapters/").mock(
        return_value=httpx.Response(200, text=LIVRE_CHAPTERS)
    )
    page = respx.get(f"{LIVRE}/manga/gachiakuta/vol-1/capitulo-1-5/").mock(
        return_value=httpx.Response(200, text=LIVRE_PAGE)
    )
    listed = await livre.chapters(GACHI, None)
    assert listed is not None and listed.languages == ["pt-br"]
    assert [(c.id, c.number) for c in listed.chapters] == [
        ("gachiakuta~vol-1~capitulo-1-5", "1.5"),
        ("gachiakuta~capitulo-2", "2"),
    ]
    found = await livre.pages(GACHI, "gachiakuta~vol-1~capitulo-1-5")
    assert page.called
    assert found is not None
    assert found.urls == [
        "https://livre.example/wp-content/1.webp",
        "https://livre.example/wp-content/2.webp",
    ]


@respx.mock
async def test_madara_refuses_other_titles_and_odd_ids(livre):
    respx.get(f"{LIVRE}/").mock(return_value=httpx.Response(200, text=LIVRE_SEARCH))
    assert await livre.pages(GACHI, "other~capitulo-9") is None
    assert await livre.pages(GACHI, "gachiakuta~..~..") is None
    assert await livre.pages(GACHI, "gachiakuta") is None


@respx.mock
async def test_madara_follows_a_renamed_title_path():
    html = LIVRE_SEARCH.replace("/manga/", "/obra/")
    chapters = LIVRE_CHAPTERS.replace("/manga/", "/obra/")
    async with httpx.AsyncClient(follow_redirects=True) as client:
        source = MadaraSource("teca", LIVRE, "pt-br", client, prefix="obra")
        respx.get(f"{LIVRE}/").mock(return_value=httpx.Response(200, text=html))
        respx.post(f"{LIVRE}/obra/gachiakuta/ajax/chapters/").mock(
            return_value=httpx.Response(200, text=chapters)
        )
        listed = await source.chapters(GACHI, None)
    assert listed is not None and [c.number for c in listed.chapters] == ["1.5", "2"]


TOON = "https://api.toonbr.test/api"
TOON_ID = "d182a36c-320a-4147-8a4d-de68d0918dc8"
TOON_OTHER = "c1398c80-8812-43da-9b27-652c26b8724c"


@pytest.fixture
async def toon():
    async with httpx.AsyncClient(follow_redirects=True) as client:
        yield ToonbrSource(client, api=TOON, images="https://cdn.toonbr.test")


@respx.mock
async def test_toonbr_lists_chapters_and_resolves_pages(toon):
    respx.get(f"{TOON}/manga", params={"search": "Monster"}).mock(
        return_value=httpx.Response(
            200,
            json={"data": [{"slug": "monster", "title": "Monster"}, {"slug": "x", "title": "Zzz"}]},
        )
    )
    respx.get(f"{TOON}/manga/monster").mock(
        return_value=httpx.Response(
            200,
            json={
                "chapters": [
                    {"id": TOON_OTHER, "chapterNumber": 2},
                    {"id": TOON_ID, "chapterNumber": 1},
                    {"id": "not-a-uuid", "chapterNumber": 3},
                ]
            },
        )
    )
    respx.get(f"{TOON}/chapter/{TOON_ID}").mock(
        return_value=httpx.Response(
            200,
            json={
                "pages": [
                    {"imageUrl": "/manga/pages/b.jpeg", "pageNumber": 2},
                    {"imageUrl": "/manga/pages/a.jpeg", "pageNumber": 1},
                    {"imageUrl": "https://evil.example/c.jpeg", "pageNumber": 3},
                ]
            },
        )
    )
    listed = await toon.chapters(MONSTER, None)
    assert listed is not None and listed.languages == ["pt-br"]
    assert [(c.id, c.number) for c in listed.chapters] == [
        (f"monster~{TOON_ID}", "1"),
        (f"monster~{TOON_OTHER}", "2"),
    ]
    found = await toon.pages(MONSTER, f"monster~{TOON_ID}")
    assert found is not None
    assert found.urls == [
        "https://cdn.toonbr.test/manga/pages/a.jpeg",
        "https://cdn.toonbr.test/manga/pages/b.jpeg",
    ]


@respx.mock
async def test_toonbr_refuses_other_titles_and_odd_ids(toon):
    respx.get(f"{TOON}/manga", params={"search": "Monster"}).mock(
        return_value=httpx.Response(200, json={"data": [{"slug": "monster", "title": "Monster"}]})
    )
    respx.get(f"{TOON}/manga/monster").mock(
        return_value=httpx.Response(200, json={"chapters": [{"id": TOON_ID, "chapterNumber": 1}]})
    )
    assert await toon.pages(MONSTER, f"other~{TOON_ID}") is None
    assert await toon.pages(MONSTER, f"monster~{TOON_OTHER}") is None
    assert await toon.pages(MONSTER, "monster~../x") is None
    assert await toon.pages(MONSTER, "monster") is None


LM_API = "https://api.lm.test/api"
LM_SITE = "https://lm.test"
LM_KEY = "6a8162f6fcef7f84673da6e8"
LM_PAGE = (
    r"{\"images\":[{\"url\":\"monster/capitulo-1/page-1-1.webp\",\"width\":1080},"
    r"{\"url\":\"monster/capitulo-1/page-2-1.webp\"},{\"url\":\"monster/cover-md.webp\"},"
    r"{\"url\":\"other/capitulo-1/page-1-1.webp\"}]}"
)


@pytest.fixture
async def lm():
    async with httpx.AsyncClient(follow_redirects=True) as client:
        yield LeituramangaSource(client, site=LM_SITE, api=LM_API, images="https://cdn.lm.test")


@respx.mock
async def test_leituramanga_lists_chapters_and_resolves_pages(lm):
    respx.get(f"{LM_API}/search/manga", params={"q": "Monster"}).mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "data": [
                        {
                            "_id": LM_KEY,
                            "slug": "monster",
                            "title": "Monster",
                            "readerAccessRule": {"type": "public"},
                        },
                        {
                            "_id": "6a8162f6fcef7f84673da6e9",
                            "slug": "monster-x",
                            "title": "Monster",
                            "readerAccessRule": {"type": "licensed"},
                        },
                    ]
                }
            },
        )
    )
    respx.get(f"{LM_API}/chapter/get-by-manga-id").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "data": [
                        {"chapterNumber": 2, "releaseDate": "2026-01-02"},
                        {"chapterNumber": 1.5},
                        {"chapterNumber": 1},
                    ]
                }
            },
        )
    )
    respx.get(f"{LM_SITE}/manga/monster/chapter/1").mock(
        return_value=httpx.Response(200, text=LM_PAGE)
    )
    listed = await lm.chapters(MONSTER, None)
    assert listed is not None and listed.source_id == "monster"
    assert [(c.id, c.number) for c in listed.chapters] == [
        ("monster~1", "1"),
        ("monster~1.5", "1.5"),
        ("monster~2", "2"),
    ]
    found = await lm.pages(MONSTER, "monster~1")
    assert found is not None
    assert found.urls == [
        "https://cdn.lm.test/monster/capitulo-1/page-1-1.webp",
        "https://cdn.lm.test/monster/capitulo-1/page-2-1.webp",
    ]
    assert found.upstream_headers == {"Referer": "https://lm.test/"}
    # Other titles, unknown chapters and odd ids are refused.
    assert await lm.pages(MONSTER, "other~1") is None
    assert await lm.pages(MONSTER, "monster~9") is None
    assert await lm.pages(MONSTER, "monster~../x") is None


def test_sources_load_by_name():
    names = ["mangadex", "mangalivre", "mangapill", "toonbr", "teca", "leituramanga"]
    assert list(load_manga_sources(names)) == names
    with pytest.raises(ValueError):
        load_manga_sources(["nope"])
