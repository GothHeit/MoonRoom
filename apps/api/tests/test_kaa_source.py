import html
import json

import httpx
import respx

from app.sources import load_sources
from app.sources.kaa import (
    BASE,
    PLAYER_REFERER,
    KaaSource,
    decode_props,
    parse_player,
    parse_subtitles,
    pick_server,
)

FRIEREN = {
    "id": 52991,
    "title": "Sousou no Frieren",
    "alternative_titles": {"en": "Frieren: Beyond Journey's End", "synonyms": []},
    "start_date": "2023-09-29",
    "num_episodes": 3,
}
SEASON_2 = {
    "id": 59978,
    "title": "Sousou no Frieren 2nd Season",
    "alternative_titles": {"en": "Frieren: Beyond Journey's End Season 2", "synonyms": []},
    "start_date": "2026-01-16",
    "num_episodes": 10,
}
PLAYER_URL = "https://krussdomi.com/cat-player/player?id=abc&source=vidstream&ln=ja-JP"
MASTER = "https://hls.krussdomi.com/manifest/abc/master.m3u8"


def island(props: dict) -> str:
    return f'<astro-island uid="x" props="{html.escape(json.dumps(props))}"></astro-island>'


PLAYER_PAGE = island(
    {
        "manifest": [0, MASTER],
        "subtitles": [
            1,
            [
                [
                    0,
                    {"language": [0, "en"], "name": [0, "English"], "src": [0, "https://s/en.vtt"]},
                ],
                [
                    0,
                    {
                        "language": [0, "pt"],
                        "name": [0, "Portuguese"],
                        "src": [0, "https://s/pt.vtt"],
                    },
                ],
                [
                    0,
                    {
                        "language": [0, "ja"],
                        "name": [0, "Bad"],
                        "src": [0, "http://s/insecure.vtt"],
                    },
                ],
            ],
        ],
        "chapters": [0, None],
    }
)

SEARCH = {
    "result": [
        {"slug": "frieren-mini-1", "title": "Frieren Mini", "title_en": "Mini Anime", "year": 2023},
        {
            "slug": "sousou-no-frieren-2d15",
            "title": "Sousou no Frieren",
            "title_en": "Frieren: Beyond Journey's End",
            "year": 2023,
        },
        {
            "slug": "frieren-season-2-7dcd",
            "title": "Sousou no Frieren 2nd Season",
            "title_en": "Frieren: Beyond Journey's End Season 2",
            "year": 2026,
        },
    ]
}


def episodes_page(numbers=(1, 2, 3)):
    return {
        "current_page": 1,
        "pages": [{"number": 1, "from": "01", "to": "03", "eps": list(numbers)}],
        "result": [{"slug": f"e{n}", "episode_number": n} for n in numbers],
    }


def mock_site(search=SEARCH):
    respx.post(f"{BASE}/api/fsearch").mock(return_value=httpx.Response(200, json=search))
    respx.get(f"{BASE}/api/show/sousou-no-frieren-2d15/episodes").mock(
        return_value=httpx.Response(200, json=episodes_page())
    )
    respx.get(f"{BASE}/api/show/sousou-no-frieren-2d15/episode/ep-2-e2").mock(
        return_value=httpx.Response(
            200,
            json={
                "servers": [
                    {
                        "name": "BirdStream",
                        "src": "https://krussdomi.com/cat-player/player?type=dash",
                    },
                    {"name": "VidStreaming", "src": PLAYER_URL},
                ]
            },
        )
    )
    respx.get(PLAYER_URL).mock(return_value=httpx.Response(200, text=PLAYER_PAGE))


def test_astro_props_decode_to_plain_values() -> None:
    assert decode_props([0, {"a": [0, 1], "b": [1, [[0, {"c": [0, "x"]}]]]}]) == {
        "a": 1,
        "b": [{"c": "x"}],
    }
    props = parse_player(PLAYER_PAGE)
    assert props and props["manifest"] == MASTER
    assert parse_player("<html>nothing</html>") is None


def test_subtitles_use_the_app_language_codes_and_skip_insecure_links() -> None:
    tracks = parse_subtitles(parse_player(PLAYER_PAGE)["subtitles"])  # type: ignore[index]
    assert [(t.lang, t.url) for t in tracks] == [
        ("en", "https://s/en.vtt"),
        ("pt-BR", "https://s/pt.vtt"),
    ]
    assert parse_subtitles([{"language": "por", "src": "https://s/x.vtt"}])[0].lang == "pt-BR"
    assert parse_subtitles("junk") == ()


def test_only_the_vidstreaming_server_is_used() -> None:
    assert pick_server([{"name": "BirdStream", "src": "https://b"}]) is None
    assert pick_server([{"name": "VidStreaming", "src": PLAYER_URL}]) == PLAYER_URL
    assert pick_server(None) is None


def test_source_is_registered() -> None:
    assert isinstance(load_sources(["kaa"])["kaa"], KaaSource)


@respx.mock
async def test_lists_every_episode_and_resolves_the_stream_with_a_referer() -> None:
    mock_site()
    async with httpx.AsyncClient() as client:
        source = KaaSource(client)
        listed = await source.episodes(FRIEREN, "sub")
        assert listed and listed.episodes == [1, 2, 3]
        stream = await source.stream(FRIEREN, 2, "sub")
        assert stream and stream.url == MASTER and stream.kind == "hls"
        assert stream.upstream_headers == {"Referer": PLAYER_REFERER}
        assert [s.lang for s in stream.subtitles] == ["en", "pt-BR"]
        # The second ask is served from the cache.
        calls = respx.calls.call_count
        assert await source.stream(FRIEREN, 2, "sub") == stream
        assert respx.calls.call_count == calls


@respx.mock
async def test_dubs_are_audio_tracks_not_separate_listings() -> None:
    mock_site()
    async with httpx.AsyncClient() as client:
        source = KaaSource(client)
        assert await source.episodes(FRIEREN, "dub") is None
        assert await source.stream(FRIEREN, 2, "dub") is None


@respx.mock
async def test_matches_the_season_by_year_and_number() -> None:
    mock_site()
    respx.get(f"{BASE}/api/show/frieren-season-2-7dcd/episodes").mock(
        return_value=httpx.Response(200, json=episodes_page((1, 2)))
    )
    async with httpx.AsyncClient() as client:
        source = KaaSource(client)
        assert await source._show(SEASON_2) == "frieren-season-2-7dcd"
        assert await source._show(FRIEREN) == "sousou-no-frieren-2d15"


@respx.mock
async def test_a_title_the_site_lacks_or_has_no_episodes_for_is_missing() -> None:
    mock_site({"result": [{"slug": "other", "title": "Something Else", "year": 2023}]})
    async with httpx.AsyncClient() as client:
        source = KaaSource(client)
        assert await source.episodes(FRIEREN, "sub") is None
        assert await source.stream(FRIEREN, 1, "sub") is None
    respx.reset()
    mock_site()
    respx.get(f"{BASE}/api/show/sousou-no-frieren-2d15/episodes").mock(
        return_value=httpx.Response(200, json={"current_page": 0, "pages": []})
    )
    async with httpx.AsyncClient() as client:
        assert await KaaSource(client).episodes(FRIEREN, "sub") is None


@respx.mock
async def test_missing_episode_or_player_gives_no_stream() -> None:
    mock_site()
    async with httpx.AsyncClient() as client:
        source = KaaSource(client)
        assert await source.stream(FRIEREN, 9, "sub") is None
    respx.reset()
    mock_site()
    respx.get(PLAYER_URL).mock(return_value=httpx.Response(200, text="<html></html>"))
    async with httpx.AsyncClient() as client:
        assert await KaaSource(client).stream(FRIEREN, 2, "sub") is None
