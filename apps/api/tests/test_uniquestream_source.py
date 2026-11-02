import httpx
import respx

from app import hls
from app.sources import load_sources
from app.sources.uniquestream import (
    BASE,
    UniqueStreamSource,
    dub_locale,
    parse_subtitles,
    pick_season,
    season_mal_id,
    whole,
)

API = f"{BASE}/api/v1"
FRIEREN = {
    "id": 52991,
    "title": "Sousou no Frieren",
    "alternative_titles": {"en": "Frieren: Beyond Journey's End", "synonyms": []},
    "num_episodes": 6,
}
SEASON_2 = {
    "id": 59978,
    "title": "Sousou no Frieren 2nd Season",
    "alternative_titles": {"en": "Frieren: Beyond Journey's End Season 2", "synonyms": []},
    "num_episodes": 2,
}
SERIES = {
    "seasons": [
        {"content_id": "s1", "season_number": 1, "episode_count": 6, "mal_id": "None"},
        {"content_id": "s2", "season_number": 2, "episode_count": 2, "mal_id": "59978"},
    ]
}
MASTER = "https://get4.mediacache.cc/episode/x/s1/e2/abc_ja-JP/master.m3u8?sign=a&expires=9"


def entry(number, locales=("ja-JP", "pt-BR", "en-US"), **extra):
    return {
        "content_id": f"e{number}",
        "episode_number": float(number),
        "is_clip": False,
        "image": f"https://media.uniquestream.net/e{number}.webp",
        "audio_locales": list(locales),
        **extra,
    }


def mock_site() -> None:
    respx.get(f"{API}/search").mock(
        return_value=httpx.Response(
            200,
            json={
                "series": [{"content_id": "z5T4zQKO", "title": "Frieren: Beyond Journey's End"}],
                "movies": [],
            },
        )
    )
    respx.get(f"{API}/series/z5T4zQKO").mock(return_value=httpx.Response(200, json=SERIES))

    def page(numbers_by_page):
        def answer(request: httpx.Request) -> httpx.Response:
            n = int(request.url.params["page"])
            return httpx.Response(200, json=numbers_by_page.get(n, []))

        return answer

    respx.get(f"{API}/season/s1/episodes").mock(
        side_effect=page(
            {
                1: [entry(n) for n in (1, 2, 3, 4, 5)],
                2: [entry(6, ("ja-JP",)), entry(6.5), entry(7, is_clip=True)],
            }
        )
    )
    respx.get(f"{API}/season/s2/episodes").mock(
        side_effect=page({1: [entry(1), entry(2, ("ja-JP",))]})
    )
    respx.get(f"{API}/episode/e2/media/dash/ja-JP").mock(
        return_value=httpx.Response(
            200,
            json={
                "hls": {
                    "locale": "ja-JP",
                    "playlist": MASTER,
                    "subtitles": [
                        {"language": "pt-BR", "url": "https://media.uniquestream.net/pt.vtt"},
                        {"language": "en-US", "url": "https://media.uniquestream.net/en.vtt"},
                        {"language": "xx", "url": "http://insecure/x.vtt"},
                    ],
                }
            },
        )
    )
    respx.get(f"{API}/episode/e2/media/dash/pt-BR").mock(
        return_value=httpx.Response(
            200,
            json={"hls": {"playlist": MASTER.replace("ja-JP", "pt-BR"), "subtitles": []}},
        )
    )


def test_source_is_registered() -> None:
    assert isinstance(load_sources(["uniquestream"])["uniquestream"], UniqueStreamSource)


def test_helpers_read_the_loose_api_values() -> None:
    assert whole(3.0) == 3 and whole(12.5) is None and whole(0) is None and whole("1") is None
    assert season_mal_id({"mal_id": "59978"}) == 59978
    assert season_mal_id({"mal_id": "None"}) is None and season_mal_id({"mal_id": None}) is None
    assert dub_locale({"audio_locales": ["ja-JP", "en-US"]}) == "en-US"
    assert dub_locale({"audio_locales": ["en-US", "pt-BR"]}) == "pt-BR"
    assert dub_locale({"audio_locales": ["ja-JP"]}) is None and dub_locale({}) is None
    tracks = parse_subtitles(
        [
            {"language": "pt-BR", "url": "https://s/pt.vtt"},
            {"language": "en-US", "url": "https://s/en.vtt"},
            {"language": "de-DE", "url": "http://s/insecure.vtt"},
        ]
    )
    assert [(t.lang, t.label) for t in tracks] == [
        ("en-US", "English"),
        ("pt-BR", "Portuguese (Brazil)"),
    ]
    assert parse_subtitles("junk") == ()


def test_season_is_found_by_mal_id_or_by_number_when_the_episodes_add_up() -> None:
    seasons = SERIES["seasons"]
    assert pick_season(SEASON_2, seasons)["content_id"] == "s2"  # type: ignore[index]
    assert pick_season(FRIEREN, seasons)["content_id"] == "s1"  # type: ignore[index]
    # Same number, different length: a cour split, not this entry.
    assert pick_season({**FRIEREN, "num_episodes": 12}, seasons) is None
    # A season tagged with another MAL id is never taken by number.
    tagged = [{"content_id": "s1", "season_number": 1, "episode_count": 6, "mal_id": "1"}]
    assert pick_season(FRIEREN, tagged) is None
    assert pick_season(FRIEREN, "junk") is None


@respx.mock
async def test_lists_whole_episodes_across_pages_and_skips_clips_and_fractions() -> None:
    mock_site()
    async with httpx.AsyncClient() as client:
        source = UniqueStreamSource(client)
        listed = await source.episodes(FRIEREN, "sub")
        assert listed and listed.episodes == [1, 2, 3, 4, 5, 6]
        assert listed.thumbnails[2] == "https://media.uniquestream.net/e2.webp"
        dubbed = await source.episodes(FRIEREN, "dub")
        assert dubbed and dubbed.episodes == [1, 2, 3, 4, 5]
        # A finished season is listed once.
        calls = respx.calls.call_count
        await source.episodes(FRIEREN, "sub")
        assert respx.calls.call_count == calls


@respx.mock
async def test_a_later_season_resolves_to_its_own_episodes() -> None:
    mock_site()
    async with httpx.AsyncClient() as client:
        source = UniqueStreamSource(client)
        listed = await source.episodes(SEASON_2, "sub")
        assert listed and listed.episodes == [1, 2]


@respx.mock
async def test_the_original_and_the_dub_are_separate_locales_of_the_same_episode() -> None:
    mock_site()
    async with httpx.AsyncClient() as client:
        source = UniqueStreamSource(client)
        sub = await source.stream(FRIEREN, 2, "sub")
        assert sub and sub.kind == "hls" and sub.url == MASTER
        assert sub.upstream_headers == {"Referer": f"{BASE}/"}
        assert [s.lang for s in sub.subtitles] == ["en-US", "pt-BR"]
        dub = await source.stream(FRIEREN, 2, "dub")
        assert dub and "pt-BR" in dub.url
        # Served from the cache the second time.
        calls = respx.calls.call_count
        assert await source.stream(FRIEREN, 2, "sub") == sub
        assert respx.calls.call_count == calls
        # Episode 6 has no dub; an episode the site lacks has nothing at all.
        assert await source.stream(FRIEREN, 6, "dub") is None
        assert await source.stream(FRIEREN, 99, "sub") is None


@respx.mock
async def test_a_title_the_site_lacks_is_missing() -> None:
    respx.get(f"{API}/search").mock(
        return_value=httpx.Response(
            200, json={"series": [{"content_id": "x", "title": "Something Else"}]}
        )
    )
    async with httpx.AsyncClient() as client:
        source = UniqueStreamSource(client)
        assert await source.episodes(FRIEREN, "sub") is None
        assert await source.stream(FRIEREN, 1, "sub") is None


@respx.mock
async def test_a_refused_media_answer_is_no_stream() -> None:
    mock_site()
    respx.get(f"{API}/episode/e2/media/dash/ja-JP").mock(return_value=httpx.Response(404))
    async with httpx.AsyncClient() as client:
        source = UniqueStreamSource(client)
        assert await source.stream(FRIEREN, 2, "sub") is None


def test_encrypted_variants_keep_their_own_signed_key_and_segment_links() -> None:
    variant = (
        "#EXTM3U\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin?expires=9&sign=k"\n'
        "#EXTINF:5,\nseg-1.png?expires=9&sign=a\n"
    )
    base = "https://get4.mediacache.cc/episode/x/s1/e2/abc_ja-JP/720p/index.m3u8?sign=m&expires=9"
    out = hls.rewrite_playlist(variant, base, f"{BASE}/", "viewer")
    # Both the key and the segment are proxied, resolved against the playlist's directory.
    assert out.count("hls?u=") == 2
    assert "episode%2Fx%2Fs1%2Fe2%2Fabc_ja-JP%2Fkeys%2Fkey.bin%3Fexpires%3D9%26sign%3Dk" in out
    assert "720p%2Fseg-1.png%3Fexpires%3D9%26sign%3Da" in out


def test_crlf_variants_are_rewritten_without_carriage_returns() -> None:
    variant = (
        "#EXTM3U\r\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin?expires=9&sign=k"\r\n'
        "#EXTINF:5,\r\nseg-0.png\r\n#EXT-X-ENDLIST\r\n"
    )
    base = "https://get4.mediacache.cc/episode/x/s1/e2/abc_ja-JP/720p/index.m3u8?sign=m&expires=9"
    out = hls.rewrite_playlist(variant, base, f"{BASE}/", "viewer")
    assert "\r" not in out
    assert out.count("hls?u=") == 2
    assert "720p%2Fseg-0.png&" in out


@respx.mock
async def test_the_dub_says_which_language_it_is_and_the_ranking_reads_it() -> None:
    from app.choose import build_offer

    for locale in ("pt-BR", "en-US", "ja-JP"):
        respx.get(f"{API}/episode/e1/media/dash/{locale}").mock(
            return_value=httpx.Response(200, json={"hls": {"playlist": f"{MASTER}&l={locale}"}})
        )
    async with httpx.AsyncClient() as client:
        source = UniqueStreamSource(client)

        async def entries(_anime):
            return {1: entry(1, ("ja-JP", "en-US")), 2: entry(1, ("ja-JP", "pt-BR", "en-US"))}

        source._entries = entries  # type: ignore[method-assign]
        english = await source.stream(FRIEREN, 1, "dub")
        portuguese = await source.stream(FRIEREN, 2, "dub")
        original = await source.stream(FRIEREN, 1, "sub")
    assert english and portuguese and original
    assert (english.dub_audio_lang, portuguese.dub_audio_lang) == ("en", "pt")
    assert original.dub_audio_lang is None
    heard = lambda s: build_offer("uniquestream", 0, "dub", s, None, source.traits).audio  # noqa: E731
    assert heard(english) == {"en"} and heard(portuguese) == {"pt"}
