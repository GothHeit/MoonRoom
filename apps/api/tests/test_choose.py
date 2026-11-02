import asyncio
from typing import Any, cast

from app.choose import build_offer, resolve_auto, union_episodes
from app.probes import Master
from app.ranking import Prefs
from app.sources.base import EpisodeList, Stream, Subtitle, Traits

ANIME = {"id": 1, "title": "Show", "num_episodes": 12}

MASTER_DUBS = """#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="jpn",URI="j.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Portuguese",LANGUAGE="por",URI="p.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Portuguese",LANGUAGE="por",URI="p2.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="a"
v.m3u8
"""
MASTER_PLAIN = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nv.m3u8\n"


class Source:
    def __init__(self, name, *, episodes=(1, 2, 3), delay=0.0, fail=False, traits=None, **stream):
        self.name = name
        self._episodes = list(episodes)
        self._delay = delay
        self._fail = fail
        self._stream = stream
        if traits:
            self.traits = traits

    async def episodes(self, anime, lang):
        await asyncio.sleep(self._delay)
        if self._fail:
            raise RuntimeError("down")
        return EpisodeList(self._episodes, anime["title"])

    async def stream(self, anime, episode, lang):
        return Stream(
            url=f"https://{self.name}.example/{lang}/{episode}.m3u8",
            kind="hls",
            resolution=None,
            upstream_headers={},
            **self._stream,
        )


class Probes:
    """Answers from a table of masters keyed by host; a host not in it is gone."""

    def __init__(self, masters, unknown=()):
        self._masters = masters
        self._unknown = unknown

    async def check(self, stream):
        host = stream.url.split("/")[2].split(".")[0]
        if host in self._unknown:
            return None
        return host in self._masters

    def peek(self, url, referer):
        text = self._masters.get(url.split("/")[2].split(".")[0])
        return Master(url, text) if text else None

    def forget(self, url, referer):
        pass


def pt_subs():
    return {"subtitles": (Subtitle("pt-BR", "Portuguese", "https://s/pt.vtt"),)}


async def pick(sources, masters, prefs=None, **kw):
    prefs = prefs or Prefs()
    table: Any = {s.name: s for s in sources}
    return await resolve_auto(
        table, cast(Any, Probes(masters, kw.pop("unknown", ()))), ANIME, 2, prefs, **kw
    )


async def test_best_language_wins_over_a_faster_better_looking_source() -> None:
    sources = [
        Source("hd", subtitles=(Subtitle("en", "English", "https://s/en.vtt"),)),
        Source("pt", **pt_subs()),
    ]
    outcome = await pick(sources, {"hd": MASTER_PLAIN.replace("720", "1080"), "pt": MASTER_PLAIN})
    assert outcome.picked and outcome.picked.source == "pt"


async def test_wanted_dub_is_picked_and_its_track_started() -> None:
    sources = [Source("first", **pt_subs()), Source("dubs", **pt_subs())]
    masters = {"first": MASTER_PLAIN, "dubs": MASTER_DUBS}
    outcome = await pick(sources, masters, Prefs(audio="pt-BR"))
    assert outcome.picked
    assert outcome.picked.source == "dubs"
    assert outcome.picked.default_audio == "por"


async def test_original_audio_starts_no_special_track() -> None:
    outcome = await pick([Source("dubs", **pt_subs())], {"dubs": MASTER_DUBS})
    assert outcome.picked and outcome.picked.default_audio is None


async def test_dead_and_failing_sources_are_skipped() -> None:
    sources = [Source("gone"), Source("broken", fail=True), Source("ok")]
    outcome = await pick(sources, {"ok": MASTER_PLAIN})
    assert outcome.picked and outcome.picked.source == "ok"


async def test_only_failures_is_reported_as_failed_not_missing() -> None:
    outcome = await pick([Source("broken", fail=True)], {})
    assert outcome.picked is None and outcome.failed
    missing = await pick([Source("none", episodes=(9,))], {})
    assert missing.picked is None and not missing.failed


async def test_unchecked_stream_is_used_only_when_nothing_else_plays() -> None:
    sources = [Source("slow"), Source("ok")]
    masters = {"slow": MASTER_PLAIN, "ok": MASTER_PLAIN}
    outcome = await pick(sources, masters, unknown=("slow",))
    assert outcome.picked and outcome.picked.source == "ok"
    only = await pick([Source("slow")], {"slow": MASTER_PLAIN}, unknown=("slow",))
    assert only.picked and only.picked.source == "slow"


async def test_a_source_with_more_episodes_than_the_show_is_another_season() -> None:
    sources = [Source("wrong", episodes=range(1, 40)), Source("right")]
    outcome = await pick(sources, {"wrong": MASTER_PLAIN, "right": MASTER_PLAIN})
    assert outcome.picked and outcome.picked.source == "right"


async def test_ideal_offer_does_not_wait_for_slower_later_sources() -> None:
    sources = [Source("fast", **pt_subs()), Source("slow", delay=30)]
    masters = {"fast": MASTER_PLAIN.replace("720", "1080"), "slow": MASTER_PLAIN}
    started = asyncio.get_running_loop().time()
    outcome = await pick(sources, masters)
    assert outcome.picked and outcome.picked.source == "fast"
    assert asyncio.get_running_loop().time() - started < 5


async def test_an_earlier_source_still_pending_is_waited_for_on_a_tie() -> None:
    sources = [Source("first", delay=0.2, **pt_subs()), Source("second", **pt_subs())]
    masters = {s: MASTER_PLAIN.replace("720", "1080") for s in ("first", "second")}
    outcome = await pick(sources, masters)
    assert outcome.picked and outcome.picked.source == "first"


async def test_deadline_picks_from_whoever_answered() -> None:
    sources = [Source("hangs", delay=30), Source("ok")]
    outcome = await pick(sources, {"ok": MASTER_PLAIN}, deadline=0.3)
    assert outcome.picked and outcome.picked.source == "ok"


def test_offer_reads_audio_and_quality_from_the_master() -> None:
    stream = Stream("https://x/m.m3u8", "hls", None, {}, **pt_subs())
    offer = build_offer("kaa", 0, "sub", stream, MASTER_DUBS, Traits())
    assert offer.audio == {"ja", "pt"} and offer.original_audio
    assert offer.resolution == 1080 and offer.soft_subs == {"pt"}


def test_offer_without_audio_tracks_uses_what_the_source_says() -> None:
    stream = Stream("https://x/e.m3u8", "hls", None, {})
    dub = build_offer("d", 0, "dub", stream, MASTER_PLAIN, Traits(dub_audio_lang="pt-BR"))
    assert dub.audio == {"pt"} and not dub.original_audio
    sub = build_offer("d", 0, "sub", stream, None, Traits(hard_sub_lang="pt-BR"))
    assert sub.original_audio and sub.hard_sub == "pt" and sub.resolution is None


async def test_union_lists_every_episode_any_source_has() -> None:
    sources = {
        "a": Source("a", episodes=(1, 2)),
        "b": Source("b", episodes=(2, 3)),
        "bad": Source("bad", fail=True),
        "wrong": Source("wrong", episodes=range(1, 40)),
    }
    listed = await union_episodes(cast(Any, sources), ANIME, 1.0)
    assert listed and listed.episodes == [1, 2, 3] and listed.source_title == "Show"
    assert await union_episodes(cast(Any, {"bad": sources["bad"]}), ANIME, 1.0) is None
