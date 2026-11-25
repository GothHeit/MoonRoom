"""Which languages an episode plays in, for the player's Language menu.

The menu lists four choices, Portuguese and English, each subtitled or dubbed, and plays the best
working version of the one picked whatever source has it. To know which choices work, every
enabled source is asked for its subbed and dubbed copy of the episode and each copy is checked
the way playing it would: the master playlist must load, and the first piece of the picture must
come back (a host that lists a file but refuses its segments fails here, not in the player).

What each source offers doesn't depend on who asks, so the offers are kept in the shared cache:
half an hour when every source answered, two minutes when one failed (it may be back soon). Only
one check of an episode runs at a time, and each source gets at most a couple of requests at once
from these checks, so opening a title doesn't fire a burst at every site.

Which offer wins a choice does depend on the viewer (soft subtitles first, a quality limit), so
that is worked out per request from the cached offers with the same ranking as playback.
"""

import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass, replace
from typing import Literal

from app.choose import probe_offer
from app.probes import StreamProbes
from app.ranking import ORIGINAL, Lang, Offer, Prefs, rank
from app.sharedcache import SharedCache
from app.singleflight import SingleFlight
from app.sources.base import VideoSource

log = logging.getLogger(__name__)

Language = Literal["pt", "en"]
State = Literal["ready", "unverified", "none"]

# The menu, in the order it shows them.
CHOICES: tuple[tuple[Language, Lang], ...] = (
    ("pt", "sub"),
    ("pt", "dub"),
    ("en", "sub"),
    ("en", "dub"),
)
# How long a complete answer is kept, and one where some source failed.
OFFERS_TTL = 1800
PARTIAL_TTL = 120
# The longest a check waits for slow sources; what hasn't answered by then counts as failed.
CHECK_DEADLINE = 12.0
# Requests at once to one source from these checks.
PER_SOURCE = 2
# Versioned: a change to what is stored gets a new name, so old entries are never misread.
NAMESPACE = "episode-offers-v1"


@dataclass(frozen=True)
class Choice:
    language: Language
    kind: Lang
    state: State
    # The version that plays it, when there is one.
    source: str | None = None
    lang: Lang | None = None
    resolution: int | None = None


def _encode(offer: Offer) -> dict:
    return {
        "source": offer.source,
        "lang": offer.lang,
        "audio": sorted(offer.audio),
        "original_audio": offer.original_audio,
        "soft_subs": sorted(offer.soft_subs),
        "hard_sub": offer.hard_sub,
        "resolution": offer.resolution,
        "verified": offer.verified,
        "machine_translated": offer.machine_translated,
    }


def _decode(data: dict, order: int) -> Offer:
    return Offer(
        source=data["source"],
        lang=data["lang"],
        order=order,
        audio=frozenset(data["audio"]),
        original_audio=data["original_audio"],
        soft_subs=frozenset(data["soft_subs"]),
        hard_sub=data["hard_sub"],
        resolution=data["resolution"],
        verified=data["verified"],
        machine_translated=data["machine_translated"],
    )


def fits(offer: Offer, language: str, kind: Lang) -> bool:
    """Whether this version is the choice: a dub speaks the language; a subtitled copy keeps the
    original audio and shows that language, switchable or burned in. Among those that fit, the
    ranking puts a switchable track first whatever its quality, then the sharper picture."""
    # Machine-translated subtitles are never offered (kafka turned them down).
    if offer.machine_translated and kind == "sub":
        return False
    if kind == "dub":
        return language in offer.audio
    return offer.original_audio and (language in offer.soft_subs or offer.hard_sub == language)


def choose(offers: list[Offer], prefs: Prefs) -> list[Choice]:
    """The best version of every menu choice for this viewer."""
    found: list[Choice] = []
    for language, kind in CHOICES:
        wants = (
            replace(prefs, audio=language, subtitle="off")
            if kind == "dub"
            else replace(prefs, audio=ORIGINAL, subtitle=language)
        )
        ranked = rank([o for o in offers if fits(o, language, kind)], wants)
        if not ranked:
            found.append(Choice(language, kind, "none"))
            continue
        best = ranked[0]
        state: State = "ready" if best.verified else "unverified"
        found.append(Choice(language, kind, state, best.source, best.lang, best.resolution))
    return found


class LanguageChecks:
    def __init__(self, cache: SharedCache) -> None:
        self._cache = cache
        self._gates: defaultdict[str, asyncio.Semaphore] = defaultdict(
            lambda: asyncio.Semaphore(PER_SOURCE)
        )
        self._flights: SingleFlight[tuple[int, int], list[dict]] = SingleFlight()

    async def choices(
        self,
        sources: dict[str, VideoSource],
        probes: StreamProbes,
        anime: dict,
        episode: int,
        prefs: Prefs,
    ) -> list[Choice]:
        return choose(await self.offers(sources, probes, anime, episode), prefs)

    async def offers(
        self, sources: dict[str, VideoSource], probes: StreamProbes, anime: dict, episode: int
    ) -> list[Offer]:
        """Every version of the episode that plays, from the cache when it has them. A source
        disabled since they were cached is left out; the rest take their current order."""
        key = (int(anime["id"]), episode)
        stored = await self._cache.get(NAMESPACE, list(key))
        if stored is None:
            stored = await self._flights.run(
                key, lambda: self._check(sources, probes, anime, episode)
            )
        order = {name: index for index, name in enumerate(sources)}
        return [_decode(o, order[o["source"]]) for o in stored if o["source"] in order]

    async def _check(
        self, sources: dict[str, VideoSource], probes: StreamProbes, anime: dict, episode: int
    ) -> list[dict]:
        failed = False

        async def one(name: str, order: int, lang: Lang) -> Offer | None:
            nonlocal failed
            async with self._gates[name]:
                try:
                    found = await probe_offer(
                        sources[name], name, order, lang, anime, episode, probes
                    )
                except Exception as exc:
                    log.info(
                        "Language check: %s failed for MAL %s ep %s: %r",
                        name,
                        anime.get("id"),
                        episode,
                        exc,
                    )
                    failed = True
                    return None
                if found is None:
                    return None
                plays = await probes.plays(found.stream)
            if plays is False:
                log.info(
                    "Language check: %s %s for MAL %s ep %s doesn't play",
                    name,
                    lang,
                    anime.get("id"),
                    episode,
                )
                return None
            return found.offer

        tasks = [
            asyncio.create_task(one(name, order, lang))
            for order, name in enumerate(sources)
            for lang in ("sub", "dub")
        ]
        done, pending = await asyncio.wait(tasks, timeout=CHECK_DEADLINE)
        for task in pending:
            task.cancel()
        if pending:
            failed = True
            await asyncio.gather(*pending, return_exceptions=True)
        offers = [o for task in done if (o := task.result()) is not None]
        stored = [_encode(o) for o in offers]
        await self._cache.set(
            NAMESPACE, [int(anime["id"]), episode], stored, PARTIAL_TTL if failed else OFFERS_TTL
        )
        return stored
