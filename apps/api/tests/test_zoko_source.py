import asyncio
import base64
import json

import httpx
import respx

from app.sources.base import Skip
from app.sources.zoko import EMBED, KEY, ZokoSource, decode_blob, parse_skips, parse_subtitles


def blob(data: dict) -> str:
    raw = json.dumps(data).encode()
    return base64.b64encode(bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(raw))).decode()


def page(data: dict | None) -> httpx.Response:
    body = f'<script>window.__P="{blob(data)}"</script>' if data else "<html>Player</html>"
    return httpx.Response(200, text=body)


def test_decode_blob_round_trip_and_garbage():
    assert decode_blob(blob({"src": "https://x/m.m3u8"})) == {"src": "https://x/m.m3u8"}
    assert decode_blob("%%not base64%%") is None
    assert decode_blob(base64.b64encode(b"\x01\x02").decode()) is None


def mock_episodes(last: int, lang: str = "sub"):
    def handler(request: httpx.Request) -> httpx.Response:
        episode = int(request.url.path.split("/")[-2])
        return page({"src": f"https://hls.example/{episode}.m3u8"} if episode <= last else None)

    respx.get(url__regex=rf"{EMBED}/stream/mal/9253/\d+/{lang}").mock(side_effect=handler)


ANIME = {"id": 9253, "title": "Steins;Gate", "num_episodes": 24}


@respx.mock
async def test_episodes_use_known_count_when_the_last_one_exists():
    mock_episodes(24)
    result = await ZokoSource().episodes(ANIME, "sub")
    assert result is not None
    assert result.episodes == list(range(1, 25))


@respx.mock
async def test_episodes_bisect_when_the_source_has_fewer_than_mal():
    mock_episodes(13)
    result = await ZokoSource().episodes(ANIME, "sub")
    assert result is not None
    assert result.episodes[-1] == 13


@respx.mock
async def test_episodes_probe_unknown_length_and_missing_title():
    mock_episodes(137)
    result = await ZokoSource().episodes({**ANIME, "num_episodes": 0}, "sub")
    assert result is not None
    assert result.episodes[-1] == 137

    respx.clear()
    mock_episodes(0)
    assert await ZokoSource().episodes(ANIME, "sub") is None


@respx.mock
async def test_stream_is_hls_with_embed_referer_without_fetching_the_master():
    mock_episodes(24)
    # Playback reads the master once, for the check and the quality; resolving doesn't.
    master = respx.get("https://hls.example/1.m3u8").mock(return_value=httpx.Response(200))
    stream = await ZokoSource().stream(ANIME, 1, "sub")
    assert stream is not None
    assert (stream.kind, stream.resolution) == ("hls", None)
    assert stream.upstream_headers == {"Referer": f"{EMBED}/"}
    assert not master.called


@respx.mock
async def test_stream_missing_episode_is_none():
    mock_episodes(3)
    assert await ZokoSource().stream(ANIME, 9, "sub") is None


def test_subtitles_are_labelled_by_language_not_by_the_embed_lang_field():
    tracks = parse_subtitles(
        [
            {"lang": "en", "label": "English", "src": "https://h/e.vtt", "default": True},
            {"lang": "en", "label": "Portuguese", "src": "https://h/p.vtt", "default": False},
            {"lang": "en", "label": "Klingon", "src": "https://h/k.vtt"},
            {"lang": "en", "label": "Broken", "src": "javascript:alert(1)"},
        ]
    )
    assert [(t.lang, t.label) for t in tracks] == [
        ("en", "English"),
        ("pt-BR", "Portuguese"),
        ("und", "Klingon"),
    ]
    assert parse_subtitles(None) == ()


def test_long_labels_use_their_first_word_and_brazil_marks_pt_br():
    tracks = parse_subtitles(
        [
            {"label": "Portuguese (Portuguese - Brazilian [Full])", "src": "https://h/1.vtt"},
            {"label": "Portuguese (Portuguese - [Full])", "src": "https://h/2.vtt"},
            {"label": "Spanish (- Castilian [Full])", "src": "https://h/3.vtt"},
            {"label": "Japanese (Japanese - [SDH])", "src": "https://h/4.vtt"},
        ]
    )
    assert [t.lang for t in tracks] == ["pt-BR", "pt", "es", "ja"]


def test_skips_come_from_skip_times_then_chapters():
    skips = parse_skips(
        {"intro": {"start": 31, "end": 111}, "outro": {"start": 5, "end": 2}},
        [
            {"title": "Opening", "start": 0, "end": 90},
            {"title": "Ending", "start": 1300, "end": 1390},
            {"title": "Part A", "start": 90, "end": 600},
        ],
    )
    assert skips == (Skip("intro", 31, 111), Skip("outro", 1300, 1390))
    assert parse_skips(None, []) == ()
    assert parse_skips({"intro": {"start": "x"}}, "junk") == ()


@respx.mock
async def test_stream_carries_skips_audio_and_feeds_thumbnails():
    config = {
        "src": "https://hls.example/1.m3u8",
        "skip": {"intro": {"start": 10, "end": 95}},
        "default_audio": "Japanese",
        "poster": "https://img.example/1.jpg",
    }
    respx.get(url__regex=rf"{EMBED}/stream/mal/9253/\d+/sub").mock(
        side_effect=lambda r: page(config if r.url.path.split("/")[-2] == "1" else None)
    )
    respx.get("https://hls.example/1.m3u8").mock(return_value=httpx.Response(200, text="#EXTM3U"))
    source = ZokoSource()
    stream = await source.stream({**ANIME, "num_episodes": 1}, 1, "sub")
    assert stream is not None
    assert stream.skips == (Skip("intro", 10, 95),)
    assert stream.default_audio == "Japanese"
    episodes = await source.episodes({**ANIME, "num_episodes": 1}, "sub")
    assert episodes is not None
    assert episodes.thumbnails == {1: "https://img.example/1.jpg"}


@respx.mock
async def test_probing_caches_pages_misses_included():
    route = respx.get(url__regex=rf"{EMBED}/stream/mal/9253/\d+/sub")
    route.mock(side_effect=lambda r: page(None))
    source = ZokoSource()
    assert await source.stream(ANIME, 3, "sub") is None
    assert await source.stream(ANIME, 3, "sub") is None
    assert route.call_count == 1


@respx.mock
async def test_unknown_length_takes_few_rounds():
    mock_episodes(1500)
    source = ZokoSource()
    result = await source.episodes({**ANIME, "num_episodes": 0}, "sub")
    assert result is not None
    assert result.episodes[-1] == 1500
    # Every page is fetched at most once; the search stays far below one call per episode.
    assert len(source._configs) < 60


@respx.mock
async def test_missing_pages_are_retried_soon_and_shared_while_fetching():
    route = respx.get(url__regex=rf"{EMBED}/stream/mal/9253/\d+/sub")
    route.mock(side_effect=lambda r: page(None))
    source = ZokoSource()
    await asyncio.gather(*(source.stream(ANIME, 9, "sub") for _ in range(5)))
    assert route.call_count == 1
    # A miss is remembered only briefly, so a just-aired episode shows up.
    source._misses.clear()
    source._recent.clear()
    assert await source.stream(ANIME, 9, "sub") is None
    assert route.call_count == 2


@respx.mock
async def test_a_short_episode_list_is_rechecked_soon():
    mock_episodes(3)
    source = ZokoSource()
    airing = {**ANIME, "num_episodes": 12}
    first = await source.episodes(airing, "sub")
    assert first is not None and first.episodes == [1, 2, 3]
    mock_episodes(4)
    still = await source.episodes(airing, "sub")  # still remembered
    assert still is not None and still.episodes == [1, 2, 3]
    source._recent.clear()
    source._configs.clear()
    source._misses.clear()
    later = await source.episodes(airing, "sub")
    assert later is not None and later.episodes == [1, 2, 3, 4]
