"""MangaDex source, against recorded shapes of its API answers."""

import httpx
import pytest
import respx

from app.manga.mangadex import (
    API,
    MangaDexSource,
    match_entry,
    order_languages,
    pick_language,
    search_queries,
)

FRIEREN = {
    "id": 52991,
    "title": "Sousou no Frieren",
    "alternative_titles": {"en": "Frieren: Beyond Journey's End", "ja": "葬送のフリーレン"},
}


def entry(uuid, title, mal=None, langs=("en",), cover="c.jpg", alt=()):
    return {
        "id": uuid,
        "type": "manga",
        "attributes": {
            "title": {"en": title},
            "altTitles": [{"ja": a} for a in alt],
            "links": {"mal": str(mal)} if mal else {},
            "availableTranslatedLanguages": list(langs),
        },
        "relationships": [{"type": "cover_art", "attributes": {"fileName": cover}}],
    }


def chapter(uuid, number, volume=None, title=None, pages=12, external=None, published="2024-01-01"):
    return {
        "id": uuid,
        "attributes": {
            "chapter": number,
            "volume": volume,
            "title": title,
            "translatedLanguage": "en",
            "pages": pages,
            "externalUrl": external,
            "publishAt": published,
        },
        "relationships": [{"type": "scanlation_group", "attributes": {"name": "Group"}}],
    }


def test_match_prefers_the_mal_link_then_a_close_title():
    linked = entry("a", "Something else entirely", mal=52991)
    close = entry("b", "Frieren: Beyond Journey's End")
    assert match_entry(FRIEREN, [close, linked]) is linked
    assert match_entry(FRIEREN, [close]) is close
    assert match_entry(FRIEREN, [entry("c", "Frieren at the Funeral Parlor")]) is None


def test_languages_put_the_app_ones_first():
    assert order_languages(["ja", "en", "fr", "pt-br"]) == ["pt-br", "en", "fr", "ja"]
    assert pick_language(["en", "pt-br"], "pt-br") == "pt-br"
    assert pick_language(["en", "fr"], "pt-br") == "en"
    assert pick_language([], "en") is None


@pytest.fixture
async def source():
    async with httpx.AsyncClient() as client:
        yield MangaDexSource(client)


@respx.mock
async def test_chapters_dedupe_groups_and_skip_external_ones(source):
    search = respx.get(f"{API}/manga").mock(
        return_value=httpx.Response(
            200, json={"data": [entry("md-1", "Frieren", mal=52991, langs=["en", "pt-br"])]}
        )
    )
    feed = respx.get(f"{API}/manga/md-1/feed").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    chapter("c2", "2", "1"),
                    chapter("c1", "1", "1", title="Start"),
                    chapter("c1b", "1", "1", published="2024-02-01"),
                    chapter("plus", "3", "1", pages=0, external="https://publisher.example"),
                    chapter("c10", "10", "2"),
                ],
                "total": 5,
            },
        )
    )
    listed = await source.chapters(FRIEREN, "en")
    assert listed is not None
    assert listed.source_id == "md-1" and listed.source_title == "Frieren"
    assert listed.languages == ["pt-br", "en"]
    assert [c.id for c in listed.chapters] == ["c1", "c2", "c10"]
    assert listed.chapters[0].title == "Start" and listed.chapters[0].group == "Group"
    assert "translatedLanguage%5B%5D=en" in str(feed.calls.last.request.url)
    # The match and the list are remembered.
    await source.chapters(FRIEREN, "en")
    assert search.call_count == 1 and feed.call_count == 1  # the first search matched, once


@respx.mock
async def test_a_title_mangadex_lacks_is_remembered_as_missing(source):
    search = respx.get(f"{API}/manga").mock(return_value=httpx.Response(200, json={"data": []}))
    assert await source.chapters(FRIEREN, None) is None
    assert await source.chapters(FRIEREN, None) is None
    assert search.call_count == 3  # one per title and synonym searched, once


C1 = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"


def mock_owner(chapter_id, manga_id):
    return respx.get(f"{API}/chapter/{chapter_id}").mock(
        return_value=httpx.Response(
            200,
            json={"data": {"id": chapter_id, "relationships": [{"type": "manga", "id": manga_id}]}},
        )
    )


@respx.mock
async def test_pages_come_from_the_at_home_server_for_the_titles_own_chapters(source):
    respx.get(f"{API}/manga").mock(
        return_value=httpx.Response(200, json={"data": [entry("md-1", "Frieren", mal=52991)]})
    )
    mock_owner(C1, "md-1")
    mock_owner(OTHER, "md-9")
    respx.get(f"{API}/at-home/server/{C1}").mock(
        return_value=httpx.Response(
            200,
            json={
                "baseUrl": "https://node.mangadex.network",
                "chapter": {"hash": "abc", "data": ["1.png", "2.png"], "dataSaver": ["1.jpg"]},
            },
        )
    )
    found = await source.pages(FRIEREN, C1)
    assert found is not None
    assert found.urls == [
        "https://node.mangadex.network/data/abc/1.png",
        "https://node.mangadex.network/data/abc/2.png",
    ]
    # Another title's chapter, a made-up id and a missing chapter all answer nothing.
    assert await source.pages(FRIEREN, OTHER) is None
    assert await source.pages(FRIEREN, "../manga") is None
    gone = "33333333-3333-4333-8333-333333333333"
    respx.get(f"{API}/chapter/{gone}").mock(return_value=httpx.Response(404))
    assert await source.pages(FRIEREN, gone) is None


def test_search_queries_try_synonyms_and_the_part_after_the_colon():
    manga = {
        "title": "Seiyoku Monster Sanshimai: Bitch na Harem Sakusei",
        "alternative_titles": {"synonyms": ["Bitch Gal Sanshimal Harem Sakusei"]},
    }
    queries = search_queries(manga)
    assert queries[0] == manga["title"]
    assert "Bitch Gal Sanshimal Harem Sakusei" in queries
    assert "Bitch na Harem Sakusei" in queries
