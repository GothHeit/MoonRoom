import httpx
import pytest
import respx

from app import hls
from app.choose import build_offer
from app.ranking import Prefs, rank
from app.sources import load_sources
from app.sources.animefire import API, AnimeFireSource, parse_episodes, pick_stream
from app.sources.base import Traits


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    async def resolve(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    hls._public_hosts.clear()


ANIME = {
    "id": 52991,
    "title": "Sousou no Frieren",
    "alternative_titles": {"en": "Frieren: Beyond Journey's End"},
}
SEARCH = {
    "data": [
        {
            "id": "fr1",
            "titles": {"BR": "Sousou no Frieren", "JP": "葬送のフリーレン"},
            "audio": "Dublado & Legendado",
        },
        {"id": "fr2", "titles": {"BR": "Sousou no Frieren 2nd Season"}, "audio": "Legendado"},
    ]
}
TITLE = {
    "data": {
        "seasons": [{"number": 1, "first_episode_number": 1}],
        "episodes": [
            {"id": "e1", "season": 1, "number": 1},
            {"id": "e2", "season": 1, "number": 2},
        ],
    }
}
MASTER = "https://cdn.example/s/h.jpg"


def episode(*tracks):
    return {"data": {"streams": list(tracks)}}


def track(audio, url=MASTER, **extra):
    return {"audio": audio, "url": url, "is_offline": False, **extra}


def mock_site(router, streams):
    router.get(f"{API}/animes/pesquisar").respond(json=SEARCH)
    router.get(f"{API}/anime/fr1").respond(json=TITLE)
    router.get(f"{API}/episode/e1").respond(json=streams)


def test_episode_numbers_follow_seasons():
    data = {
        "seasons": [
            {"number": 1, "first_episode_number": 1},
            {"number": 2, "first_episode_number": 13},
        ],
        "episodes": [
            {"id": "a", "season": 1, "number": 12},
            {"id": "b", "season": 2, "number": 1},
        ],
    }
    assert parse_episodes(data, "sub") == {12: "a", 13: "b"}


def test_repeated_numbers_fall_back_to_list_order():
    data = {
        "episodes": [{"id": "a", "season": 1, "number": 1}, {"id": "b", "season": 2, "number": 1}]
    }
    assert parse_episodes(data, "sub") == {1: "a", 2: "b"}


def test_pick_stream_skips_offline_and_other_audio():
    data = {
        "streams": [
            track("dublado", is_offline=True),
            track("legendado"),
            {"audio": "dublado", "url": None},
        ]
    }
    assert pick_stream(data, "dub") == []
    assert len(pick_stream(data, "sub")) == 1


@respx.mock
async def test_sub_stream_and_machine_translation_flag():
    mock_site(respx, episode(track("legendado", is_mtl=True)))
    respx.get(MASTER).respond(text="#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n")
    source = AnimeFireSource()
    listed = await source.episodes(ANIME, "sub")
    assert listed and listed.episodes == [1, 2]
    stream = await source.stream(ANIME, 1, "sub")
    assert stream and stream.kind == "hls" and stream.machine_translated
    assert stream.upstream_headers["Referer"].startswith("https://animefire.one")


@respx.mock
async def test_dub_needs_a_dubbed_title():
    mock_site(respx, episode(track("dublado")))
    assert (
        await AnimeFireSource().episodes({**ANIME, "title": "Sousou no Frieren 2nd Season"}, "dub")
        is None
    )


@respx.mock
async def test_dead_playlist_host_gives_nothing_and_is_skipped_afterwards():
    mock_site(respx, episode(track("legendado")))
    playlist = respx.get(MASTER).respond(404)
    source = AnimeFireSource()
    assert await source.stream(ANIME, 1, "sub") is None
    # Another episode on the same host is not even asked.
    source._recent.clear()
    assert await source.stream(ANIME, 1, "sub") is None
    assert playlist.call_count == 1


@respx.mock
async def test_html_instead_of_playlist_counts_as_dead():
    mock_site(respx, episode(track("legendado")))
    respx.get(MASTER).respond(text="<html>nope</html>")
    assert await AnimeFireSource().stream(ANIME, 1, "sub") is None


@respx.mock
async def test_playlist_error_keeps_the_stream_unverified():
    mock_site(respx, episode(track("legendado")))
    respx.get(MASTER).mock(side_effect=httpx.ConnectTimeout("slow"))
    assert await AnimeFireSource().stream(ANIME, 1, "sub") is not None


def test_machine_translated_ranks_below_everything():
    traits = Traits(hard_sub_lang="pt-BR", dub_audio_lang="pt-BR")
    from app.sources.base import Stream

    def offer(name, order, mtl, res):
        s = Stream("u", "hls", res, {}, machine_translated=mtl)
        return build_offer(name, order, "sub", s, None, traits)

    mtl, plain = offer("animefire", 0, True, 1080), offer("other", 1, False, 360)
    assert rank([mtl, plain], Prefs())[0].source == "other"


def test_registry_loads_animefire():
    assert isinstance(load_sources(["animefire"])["animefire"], AnimeFireSource)
