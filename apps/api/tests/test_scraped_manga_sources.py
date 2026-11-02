"""Mangapill and Madara sources, against recorded shapes of their pages."""

import httpx
import pytest
import respx

from app.manga import load_manga_sources
from app.manga.madara import MadaraSource
from app.manga.mangapill import MangapillSource

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


def test_sources_load_by_name():
    sources = load_manga_sources(["mangadex", "mangalivre", "mangapill"])
    assert list(sources) == ["mangadex", "mangalivre", "mangapill"]
    with pytest.raises(ValueError):
        load_manga_sources(["nope"])
