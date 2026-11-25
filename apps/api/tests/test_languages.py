import asyncio
from typing import Any

import httpx
import pytest
import respx

from app import hls
from app.languages import LanguageChecks, choose, fits
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.probes import Master, StreamProbes
from app.ranking import Offer, Prefs
from app.sharedcache import SharedCache
from app.sources.base import EpisodeList, Stream, Subtitle, Traits
from tests.conftest import make_user

ANIME = {"id": 7, "title": "Show", "num_episodes": 12}

MASTER_DUBS = """#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="jpn",URI="j.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Portuguese",LANGUAGE="por",URI="p.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="a"
v.m3u8
"""
MASTER_720 = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nv.m3u8\n"


class Source:
    def __init__(self, name, *, langs=("sub",), fail=False, traits=None, **stream):
        self.name = name
        self._langs = langs
        self._fail = fail
        self._stream = stream
        self.calls = 0
        if traits:
            self.traits = traits

    async def episodes(self, anime, lang):
        self.calls += 1
        if self._fail:
            raise RuntimeError("down")
        return EpisodeList([1, 2], anime["title"]) if lang in self._langs else None

    async def stream(self, anime, episode, lang):
        if lang not in self._langs:
            return None
        return Stream(
            url=f"https://{self.name}.example/{lang}/{episode}.m3u8",
            kind="hls",
            resolution=None,
            upstream_headers={},
            **self._stream,
        )


class Probes:
    """Masters by host; hosts in `refused` serve the playlist but not the picture."""

    def __init__(self, masters, refused=()):
        self._masters = masters
        self._refused = refused

    def _host(self, url):
        return url.split("/")[2].split(".")[0]

    async def check(self, stream):
        return self._host(stream.url) in self._masters

    async def plays(self, stream):
        return self._host(stream.url) not in self._refused

    def peek(self, url, referer):
        text = self._masters.get(self._host(url))
        return Master(url, text) if text else None

    def forget(self, url, referer):
        pass


def pt_subs():
    return {"subtitles": (Subtitle("pt-BR", "Portuguese", "https://s/pt.vtt"),)}


def en_subs():
    return {"subtitles": (Subtitle("en", "English", "https://s/en.vtt"),)}


async def menu(sources, masters, prefs=None, refused=()):
    checks = LanguageChecks(SharedCache())
    table: Any = {s.name: s for s in sources}
    probes: Any = Probes(masters, refused)
    found = await checks.choices(table, probes, ANIME, 1, prefs or Prefs())
    return {(c.language, c.kind): (c.state, c.source, c.lang) for c in found}


async def test_every_language_gets_its_best_working_source() -> None:
    found = await menu(
        [
            Source("zoko", langs=("sub", "dub"), **en_subs()),
            Source("digital", traits=Traits(hard_sub_lang="pt-BR", dub_audio_lang=None)),
            Source("zone", **pt_subs()),
        ],
        {"zoko": MASTER_720, "digital": MASTER_720, "zone": MASTER_DUBS},
    )
    # Soft Portuguese subtitles at 1080p beat burned-in ones at 720p.
    assert found[("pt", "sub")] == ("ready", "zone", "sub")
    # AniZone's subbed copy also carries the Portuguese dub track.
    assert found[("pt", "dub")] == ("ready", "zone", "sub")
    assert found[("en", "sub")] == ("ready", "zoko", "sub")
    assert found[("en", "dub")] == ("ready", "zoko", "dub")


async def test_a_listed_episode_that_does_not_play_is_not_offered() -> None:
    found = await menu(
        [
            Source("digital", traits=Traits(hard_sub_lang="pt-BR", dub_audio_lang=None)),
            Source("zoko", **en_subs()),
        ],
        {"digital": MASTER_720, "zoko": MASTER_720},
        refused=("digital",),
    )
    assert found[("pt", "sub")] == ("none", None, None)
    assert found[("en", "sub")] == ("ready", "zoko", "sub")


async def test_english_subtitles_are_not_offered_as_portuguese() -> None:
    found = await menu([Source("zoko", **en_subs())], {"zoko": MASTER_720})
    assert found[("pt", "sub")][0] == "none"


async def test_answers_are_cached() -> None:
    zoko = Source("zoko", **en_subs())
    checks = LanguageChecks(SharedCache())
    table: Any = {"zoko": zoko}
    probes: Any = Probes({"zoko": MASTER_720})
    await checks.choices(table, probes, ANIME, 1, Prefs())
    await checks.choices(table, probes, ANIME, 1, Prefs())
    # Sub and dub, once.
    assert zoko.calls == 2


async def test_one_check_at_a_time_per_episode() -> None:
    zoko = Source("zoko", **en_subs())
    checks = LanguageChecks(SharedCache())
    table: Any = {"zoko": zoko}
    probes: Any = Probes({"zoko": MASTER_720})
    await asyncio.gather(*(checks.choices(table, probes, ANIME, 1, Prefs()) for _ in range(4)))
    assert zoko.calls == 2


async def test_a_failing_source_is_left_out() -> None:
    found = await menu(
        [Source("broken", fail=True), Source("zoko", **en_subs())], {"zoko": MASTER_720}
    )
    assert found[("en", "sub")] == ("ready", "zoko", "sub")


def test_dub_fits_by_audio_and_sub_needs_the_original_audio() -> None:
    dub = Offer("s", "dub", 0, audio=frozenset({"pt"}), original_audio=False)
    sub = Offer("s", "sub", 0, soft_subs=frozenset({"pt"}))
    assert fits(dub, "pt", "dub") and not fits(dub, "pt", "sub")
    assert fits(sub, "pt", "sub") and not fits(sub, "en", "sub")


def test_unchecked_host_is_offered_but_marked() -> None:
    offer = Offer("s", "sub", 0, hard_sub="pt", verified=False)
    found = {(c.language, c.kind): c.state for c in choose([offer], Prefs())}
    assert found[("pt", "sub")] == "unverified"


def test_first_variant_and_segment() -> None:
    assert hls.first_variant(MASTER_720) == "v.m3u8"
    assert hls.first_variant("#EXTM3U\n#EXTINF:4,\nseg0.ts\n") is None
    assert hls.first_segment("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n") == "seg0.ts"


async def test_plays_fetches_the_first_segment_and_refusal_counts_as_dead() -> None:
    asked: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        asked.append(request.url.path)
        if request.url.path.endswith("master.m3u8"):
            return httpx.Response(200, text=MASTER_720)
        if request.url.path.endswith("v.m3u8"):
            return httpx.Response(200, text="#EXTM3U\n#EXTINF:4,\nseg0.ts\n")
        return httpx.Response(403)

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as http:
        probes = StreamProbes(http)
        stream = Stream("https://host.example/p/master.m3u8", "hls", None, {})
        assert await probes.plays(stream) is False
        # Kept: no second round of requests.
        assert await probes.plays(stream) is False
    assert asked == ["/p/master.m3u8", "/p/v.m3u8", "/p/seg0.ts"]


async def test_plays_accepts_a_partial_answer() -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        assert request.headers["Range"] == "bytes=0-1023"
        return httpx.Response(206, content=b"x")

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as http:
        probes = StreamProbes(http)
        assert await probes.plays(Stream("https://host.example/a.mp4", "mp4", None, {})) is True


@respx.mock
async def test_endpoint_lists_the_four_choices(client, session) -> None:
    respx.get(f"{API_BASE}/anime/21").mock(
        return_value=httpx.Response(200, json={"id": 21, "title": "One Piece"})
    )
    fastapi_app.state.sources = {"zoko": Source("zoko", **en_subs())}
    fastapi_app.state.probes = Probes({"zoko": MASTER_720})
    _, headers = await make_user(session, "kafka")

    r = await client.get("/watch/languages/21/1", headers=headers)

    assert r.status_code == 200
    assert [(c["language"], c["kind"], c["state"]) for c in r.json()] == [
        ("pt", "sub", "none"),
        ("pt", "dub", "none"),
        ("en", "sub", "ready"),
        ("en", "dub", "none"),
    ]
    assert r.json()[2]["source"] == "zoko"


class DubTracks:
    name = "zone"

    async def episodes(self, anime, lang):
        return EpisodeList([1], anime["title"])

    async def stream(self, anime, episode, lang):
        return Stream("https://zone.example/m.m3u8", "hls", None, {}, default_audio="jpn")


@respx.mock
@pytest.mark.parametrize(("audio", "starts"), [("pt", "por"), ("original", "jpn")])
async def test_play_starts_on_the_audio_asked_for(client, session, audio, starts) -> None:
    respx.get(f"{API_BASE}/anime/21").mock(
        return_value=httpx.Response(200, json={"id": 21, "title": "One Piece"})
    )
    respx.get("https://zone.example/m.m3u8").mock(
        return_value=httpx.Response(200, text=MASTER_DUBS)
    )
    fastapi_app.state.sources = {"zone": DubTracks()}
    fastapi_app.state.probes = StreamProbes(fastapi_app.state.http)
    _, headers = await make_user(session, "kafka")

    r = await client.post(f"/watch/zone/21/episodes/1/play?audio={audio}", headers=headers)

    assert r.status_code == 200
    assert r.json()["default_audio"] == starts


async def test_play_refuses_an_unknown_audio(client, session) -> None:
    _, headers = await make_user(session, "kafka")
    r = await client.post("/watch/zone/21/episodes/1/play?audio=12", headers=headers)
    assert r.status_code == 422


def test_soft_portuguese_on_a_sharp_stream_beats_burned_in_and_machine_subs_are_left_out() -> None:
    burned = Offer("digital", "sub", 0, hard_sub="pt", resolution=480)
    soft = Offer("zoko", "sub", 1, soft_subs=frozenset({"pt", "en"}), resolution=1080)
    machine = Offer("fire", "sub", 2, soft_subs=frozenset({"pt"}), machine_translated=True)
    found = {(c.language, c.kind): c.source for c in choose([burned, soft, machine], Prefs())}
    assert found[("pt", "sub")] == "zoko"
    only_machine = {(c.language, c.kind): c.state for c in choose([machine], Prefs())}
    assert only_machine[("pt", "sub")] == "none"


async def test_plays_sends_the_origin_segment_hosts_need() -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".m3u8"):
            text = MASTER_720 if "master" in request.url.path else "#EXTM3U\n#EXTINF:4,\nseg0.ts\n"
            return httpx.Response(200, text=text)
        # Like AnimeStream's segment host: 403 without an Origin next to the Referer.
        ok = request.headers.get("Origin") == "https://ref.example"
        return httpx.Response(206 if ok else 403, content=b"x")

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as http:
        probes = StreamProbes(http)
        stream = Stream(
            "https://host.example/p/master.m3u8", "hls", None, {"Referer": "https://ref.example/w"}
        )
        assert await probes.plays(stream) is True
