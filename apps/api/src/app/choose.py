"""Picking the best version of an episode across every enabled source ("automatic").

Each source is asked, in parallel, for the versions it has (subbed, and dubbed when the viewer
wants a dub). Each answer becomes an `Offer` (see app.ranking) from what the stream really
carries: the audio and quality come from its master playlist, which playback fetches anyway and
the probes cache, the subtitles from the stream, and the burned-in language from the source.
The ranking then decides.

Waiting for the slowest source would make every play as slow as it, so the pick is made as soon
as an offer nothing could improve has arrived and every source that would win a tie is in; at
the latest when the deadline passes, with whatever has answered.
"""

import asyncio
import logging
from dataclasses import dataclass, replace
from typing import cast

from app import hls
from app.probes import StreamProbes
from app.ranking import (
    ORIGINAL,
    ORIGINAL_AUDIO,
    Lang,
    Offer,
    Prefs,
    base_lang,
    is_ideal,
    sort_key,
)
from app.sources.base import EpisodeList, Stream, Traits, VideoSource

log = logging.getLogger(__name__)

# The longest the pick waits for sources that haven't answered.
AUTO_DEADLINE = 7.0


@dataclass(frozen=True)
class Picked:
    source: str
    lang: Lang
    stream: Stream
    # The audio track to start on: the dub the viewer asked for, when the stream carries it.
    default_audio: str | None


@dataclass(frozen=True)
class Outcome:
    picked: Picked | None
    # Some source raised instead of answering, so "nothing found" may be an outage.
    failed: bool


def langs_to_try(prefs: Prefs) -> tuple[Lang, ...]:
    """A viewer who wants the original audio is never served a dub, so those aren't asked."""
    return ("sub",) if prefs.audio == ORIGINAL else ("sub", "dub")


def build_offer(
    name: str, order: int, lang: Lang, stream: Stream, master: str | None, traits: Traits
) -> Offer:
    """What this stream carries. A master's own audio tracks are the truth; a stream without
    any (a plain media playlist, an MP4) has the one audio its source says."""
    tracks = hls.audio_tracks(master) if master else []
    heard = {base_lang(language or name_) for name_, language in tracks} - {"und"}
    if heard:
        audio, original = frozenset(heard), ORIGINAL_AUDIO in heard
    elif lang == "dub":
        dub = base_lang(stream.dub_audio_lang or traits.dub_audio_lang)
        audio, original = (frozenset({dub}) if dub != "und" else frozenset()), False
    else:
        audio, original = frozenset({ORIGINAL_AUDIO}), True
    soft = frozenset(base_lang(s.lang) for s in stream.subtitles) - {"und"}
    hard = base_lang(traits.hard_sub_lang) if lang == "sub" and traits.hard_sub_lang else None
    resolution = stream.resolution
    if resolution is None and master:
        resolution = hls.top_resolution(master)
    return Offer(
        source=name,
        lang=lang,
        order=order,
        audio=audio,
        original_audio=original,
        soft_subs=soft,
        hard_sub=None if hard == "und" else hard,
        resolution=resolution,
        machine_translated=stream.machine_translated,
    )


def audio_to_start(tracks: list[tuple[str, str]], prefs: Prefs) -> str | None:
    """The `LANGUAGE` of the track to start on when the viewer wants a dub the stream carries.
    The original audio needs no pick: it is the one streams start on."""
    if prefs.audio == ORIGINAL:
        return None
    wanted = base_lang(prefs.audio)
    for name, language in tracks:
        if base_lang(language or name) == wanted:
            return language or name
    return None


async def resolve_auto(
    sources: dict[str, VideoSource],
    probes: StreamProbes,
    anime: dict,
    episode: int,
    prefs: Prefs,
    fresh: bool = False,
    deadline: float = AUTO_DEADLINE,
) -> Outcome:
    failures = 0
    # What each offer was built from, for the one that wins.
    seen: dict[tuple[str, Lang], tuple[Stream, list[tuple[str, str]]]] = {}

    async def consider(name: str, order: int, lang: Lang) -> Offer | None:
        nonlocal failures
        source = sources[name]
        try:
            # Together: a source that lacks the episode wastes one cached call, one that has it
            # saves a whole round trip.
            answers = await asyncio.gather(
                source.episodes(anime, lang),
                source.stream(anime, episode, lang),
                return_exceptions=True,
            )
            for answer in answers:
                if isinstance(answer, BaseException):
                    raise answer
            listed, stream = cast(tuple[EpisodeList | None, Stream | None], tuple(answers))
            if listed is None or episode not in listed.episodes:
                return None
            # A source that lists more episodes than the show has matched another season.
            expected = anime.get("num_episodes") or 0
            if expected and len(listed.episodes) > expected:
                return None
        except Exception:
            log.exception("Source %s failed for MAL %s ep %s", name, anime.get("id"), episode)
            failures += 1
            return None
        if stream is None:
            return None
        referer = stream.upstream_headers.get("Referer", "")
        if fresh:
            probes.forget(stream.url, referer)
        alive = await probes.check(stream)
        if alive is False:
            log.warning(
                "Source %s gave a dead stream for MAL %s ep %s", name, anime.get("id"), episode
            )
            return None
        master = probes.peek(stream.url, referer) if stream.kind == "hls" else None
        traits = getattr(source, "traits", Traits())
        offer = build_offer(name, order, lang, stream, master.text if master else None, traits)
        seen[(name, lang)] = (stream, hls.audio_tracks(master.text) if master else [])
        return offer if alive else _unverified(offer)

    loop = asyncio.get_running_loop()
    started = loop.time()
    pending: dict[asyncio.Task[Offer | None], tuple[int, Lang]] = {}
    for order, name in enumerate(sources):
        for lang in langs_to_try(prefs):
            pending[asyncio.create_task(consider(name, order, lang))] = (order, lang)

    offers: list[Offer] = []
    try:
        while pending:
            remaining = deadline - (loop.time() - started)
            if remaining <= 0:
                break
            done, _ = await asyncio.wait(
                pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
            )
            if not done:
                break
            for task in done:
                pending.pop(task)
                if offer := task.result():
                    offers.append(offer)
            best = max(offers, key=lambda o: sort_key(o, prefs), default=None)
            if (
                best
                and is_ideal(best, prefs)
                and not any(_could_tie(best, order, lang) for order, lang in pending.values())
            ):
                break
    finally:
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    best = max(offers, key=lambda o: sort_key(o, prefs), default=None)
    if best is None:
        return Outcome(None, failures > 0)
    stream, tracks = seen[(best.source, best.lang)]
    return Outcome(Picked(best.source, best.lang, stream, audio_to_start(tracks, prefs)), False)


def _unverified(offer: Offer) -> Offer:
    return replace(offer, verified=False)


def _could_tie(best: Offer, order: int, lang: Lang) -> bool:
    """Whether a source still pending could win a tie against the ideal offer."""
    return order < best.order or (order == best.order and best.lang == "dub" and lang == "sub")


async def union_episodes(
    sources: dict[str, VideoSource], anime: dict, wait: float
) -> EpisodeList | None:
    """The episodes any source has (subbed), for the automatic choice: playing an episode asks
    every source, so one that only some sources list is still playable. Sources are asked at
    once and a slow or failing one is left out. Earlier sources win the title and the art."""
    expected = anime.get("num_episodes") or 0

    async def listing(name: str) -> EpisodeList | None:
        try:
            return await asyncio.wait_for(sources[name].episodes(anime, "sub"), wait)
        except Exception:
            return None

    found = await asyncio.gather(*(listing(name) for name in sources))
    episodes: set[int] = set()
    thumbnails: dict[int, str] = {}
    title = ""
    for listed in found:
        # More episodes than the show has: that source matched another season.
        if listed is None or (expected and len(listed.episodes) > expected):
            continue
        title = title or listed.source_title
        episodes.update(listed.episodes)
        for episode, url in listed.thumbnails.items():
            thumbnails.setdefault(episode, url)
    return EpisodeList(sorted(episodes), title, thumbnails) if episodes else None
