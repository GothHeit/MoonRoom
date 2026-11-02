import html
import json

import httpx
import respx

from app.sources import load_sources
from app.sources.anizone import (
    BASE,
    AniZoneSource,
    parse_chapters,
    parse_player,
    parse_results,
    parse_subtitles,
)

FRIEREN = {
    "id": 52991,
    "title": "Sousou no Frieren",
    "alternative_titles": {"en": "Frieren: Beyond Journey's End", "synonyms": []},
    "start_date": "2023-09-29",
    "num_episodes": 28,
}
SEASON_2 = {
    "id": 59978,
    "title": "Sousou no Frieren 2nd Season",
    "alternative_titles": {"synonyms": []},
    "start_date": "2026-01-16",
    "num_episodes": 10,
}
MASTER = "https://seiryuu.vid-cdn.xyz/abc/master.m3u8"
CHAPTERS = "https://seiryuu.vid-cdn.xyz/abc/chapters.vtt"


def js_literal(value: object) -> str:
    """How Blade writes JSON into a single-quoted JS string: hex-escaped quotes and slashes."""
    text = json.dumps(value).replace("\\", "\\\\").replace("/", "\\/").replace('"', "\\u0022")
    return text.replace("'", "\\u0027")


ITEMS = [
    {
        "slug": "mdkytdqp",
        "main_title": "Sousou no Frieren",
        "title_list": {"1": "Frieren: Beyond Journey's End", "2": "Frieren"},
        "start_year": 2023,
        "episode_count": 28,
        "is_ongoing": False,
    },
    {
        "slug": "y25twzsk",
        "main_title": "Sousou no Frieren (2026)",
        "title_list": {"1": "Frieren: Beyond Journey's End (2026)"},
        "start_year": 2026,
        "episode_count": 10,
        "is_ongoing": True,
    },
]
SNAPSHOT_JSON = html.escape(json.dumps({"data": {"search": None, "sort": "title-asc"}}))
INDEX = f'<html><meta name="csrf-token" content="tok123"><div wire:snapshot="{SNAPSHOT_JSON}">'
SEARCH_ANSWER = {
    "components": [
        {"effects": {"html": f"<div x-data=\"{{ items: JSON.parse('{js_literal(ITEMS)}') }}\">"}}
    ]
}
CONFIG = {
    "src": MASTER,
    "chapter": CHAPTERS,
    "subtitles": [
        {
            "title": "English (US)",
            "language": "en",
            "file": "https://seiryuu.vid-cdn.xyz/abc/0_en.ass",
        },
        {"title": "Portuguese (Brazil)", "language": "pt-BR", "file": "https://x/pt.ass"},
        {"title": "Bad", "language": "de", "file": "http://x/insecure.ass"},
    ],
    "fonts": [],
}
EPISODE_PAGE = f"<div x-data=\"vidstackPlayer(JSON.parse('{js_literal(CONFIG)}'))\">"


def mock_site():
    respx.get(f"{BASE}/anime").mock(return_value=httpx.Response(200, text=INDEX))
    respx.post(f"{BASE}/livewire/update").mock(return_value=httpx.Response(200, json=SEARCH_ANSWER))
    respx.get(f"{BASE}/anime/mdkytdqp/3").mock(return_value=httpx.Response(200, text=EPISODE_PAGE))
    respx.get(CHAPTERS).mock(
        return_value=httpx.Response(
            200,
            text="WEBVTT\n\n00:00:00.000 --> 00:01:28.041\nIntro\n\n"
            "00:22:18.041 --> 00:24:00.042\nCredits\n",
        )
    )


def test_page_json_is_read_from_the_js_literals() -> None:
    markup = f"x-data=\"{{ items: JSON.parse('{js_literal(ITEMS)}') }}\""
    assert [i["slug"] for i in parse_results(markup)] == ["mdkytdqp", "y25twzsk"]
    assert parse_results("<html></html>") == []
    config = parse_player(EPISODE_PAGE)
    assert config and config["src"] == MASTER
    assert parse_player("<html></html>") is None


def test_subtitles_are_ass_with_the_app_language_codes() -> None:
    tracks = parse_subtitles(CONFIG["subtitles"])
    assert [(t.lang, t.url, t.ass_url) for t in tracks] == [
        (
            "en",
            "https://seiryuu.vid-cdn.xyz/abc/0_en.ass",
            "https://seiryuu.vid-cdn.xyz/abc/0_en.ass",
        ),
        ("pt-BR", "https://x/pt.ass", "https://x/pt.ass"),
    ]


def test_chapters_become_skips() -> None:
    chapters = parse_chapters(
        "WEBVTT \n\n00:00:00.000 --> 00:01:28.041\nIntro\n\n"
        "00:22:18.041 --> 00:24:00.042\nCredits\n"
    )
    assert chapters[0] == {"title": "Intro", "start": 0.0, "end": 88.041}
    assert chapters[1]["title"] == "Credits"


def test_source_is_registered() -> None:
    assert isinstance(load_sources(["anizone"])["anizone"], AniZoneSource)


@respx.mock
async def test_matches_the_show_by_year_and_lists_its_episodes() -> None:
    mock_site()
    async with httpx.AsyncClient() as client:
        source = AniZoneSource(client)
        listed = await source.episodes(FRIEREN, "sub")
        assert listed and listed.episodes == list(range(1, 29))
        # The sequel only matches the entry from its own year.
        sequel = await source.episodes(SEASON_2, "sub")
        assert sequel and len(sequel.episodes) == 10
        sent = next(c.request for c in respx.calls if c.request.method == "POST")
        body = json.loads(sent.content)
        assert body["_token"] == "tok123"
        assert body["components"][0]["updates"] == {"search": "Sousou no Frieren"}


@respx.mock
async def test_resolves_the_stream_with_subtitles_and_skips() -> None:
    mock_site()
    async with httpx.AsyncClient() as client:
        stream = await AniZoneSource(client).stream(FRIEREN, 3, "sub")
    assert stream and stream.url == MASTER and stream.upstream_headers == {}
    assert [s.lang for s in stream.subtitles] == ["en", "pt-BR"]
    assert [(k.kind, k.start) for k in stream.skips] == [("intro", 0.0), ("outro", 1338.041)]


@respx.mock
async def test_dub_missing_episode_and_unknown_show_give_nothing() -> None:
    mock_site()
    respx.get(f"{BASE}/anime/mdkytdqp/9").mock(return_value=httpx.Response(404))
    async with httpx.AsyncClient() as client:
        source = AniZoneSource(client)
        assert await source.episodes(FRIEREN, "dub") is None
        assert await source.stream(FRIEREN, 3, "dub") is None
        assert await source.stream(FRIEREN, 9, "sub") is None
        nothing = {"id": 1, "title": "Unrelated Show", "start_date": "1999-01-01"}
        assert await source.episodes(nothing, "sub") is None


@respx.mock
async def test_search_retries_once_with_a_fresh_session() -> None:
    respx.get(f"{BASE}/anime").mock(return_value=httpx.Response(200, text=INDEX))
    respx.post(f"{BASE}/livewire/update").mock(
        side_effect=[httpx.Response(419), httpx.Response(200, json=SEARCH_ANSWER)]
    )
    async with httpx.AsyncClient() as client:
        found = await AniZoneSource(client)._search("frieren")
    assert [i["slug"] for i in found] == ["mdkytdqp", "y25twzsk"]
