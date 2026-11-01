"""Opening, ending and recap times from AniSkip, for sources that don't carry their own.

Viewers submit the times against their own copy of an episode, along with its length. Copies
differ (a longer cold open, a cut preview), so an interval is only used when its copy is about
as long as the one playing. Best effort: any failure gives no skips. Answers are cached in
memory per episode, whatever the length asked about.
"""

import logging

import httpx
from cachetools import TLRUCache

from app.singleflight import SingleFlight
from app.sources.base import Skip, SkipKind

log = logging.getLogger(__name__)

API = "https://api.aniskip.com/v2/skip-times"
TIMEOUT = 5.0
FOUND_TTL = 86400
MISS_TTL = 6 * 3600
ERROR_TTL = 300
# How far, in seconds, a submission's episode length may be from the playing copy's.
LENGTH_TOLERANCE = 10.0
KINDS: dict[str, SkipKind] = {"op": "intro", "ed": "outro", "recap": "recap"}


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def pick_skips(results: list[dict], length: float) -> list[Skip]:
    """For each kind, the interval from the copy closest in length to `length`, if close enough."""
    best: dict[SkipKind, tuple[float, Skip]] = {}
    for item in results:
        kind = KINDS.get(item.get("skipType", ""))
        interval = item.get("interval") or {}
        start, end = _number(interval.get("startTime")), _number(interval.get("endTime"))
        their_length = _number(item.get("episodeLength"))
        if kind is None or start is None or end is None or their_length is None:
            continue
        gap = abs(their_length - length)
        if gap > LENGTH_TOLERANCE or not 0 <= start < end <= length + 1:
            continue
        if kind not in best or gap < best[kind][0]:
            best[kind] = (gap, Skip(kind=kind, start=start, end=end))
    return sorted((skip for _, skip in best.values()), key=lambda s: s.start)


class AniSkip:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._flights: SingleFlight[tuple[int, int], list[dict]] = SingleFlight()
        # Values are (results, ttl).
        self._cache: TLRUCache[tuple[int, int], tuple[list[dict], float]] = TLRUCache(
            maxsize=8192, ttu=lambda _key, value, now: now + value[1]
        )

    async def skips(self, mal_id: int, episode: int, length: float) -> list[Skip]:
        return pick_skips(await self._results(mal_id, episode), length)

    async def _results(self, mal_id: int, episode: int) -> list[dict]:
        key = (mal_id, episode)
        if (hit := self._cache.get(key)) is not None:
            return hit[0]
        return await self._flights.run(key, lambda: self._fetch(key))

    async def _fetch(self, key: tuple[int, int]) -> list[dict]:
        mal_id, episode = key
        try:
            response = await self._http.get(
                f"{API}/{mal_id}/{episode}",
                # Length 0: every submission, so one answer serves any copy's length.
                params={"types[]": list(KINDS), "episodeLength": 0},
                timeout=TIMEOUT,
            )
            if response.status_code == 404:  # nobody submitted times for this episode
                self._cache[key] = ([], MISS_TTL)
                return []
            response.raise_for_status()
            results = response.json().get("results") or []
            if not isinstance(results, list):
                raise ValueError("results is not a list")
        except Exception as exc:  # best effort: never let a lookup failure break playback
            log.warning("AniSkip for MAL %s ep %s unavailable: %s", mal_id, episode, exc)
            self._cache[key] = ([], ERROR_TTL)
            return []
        results = [r for r in results if isinstance(r, dict)]
        self._cache[key] = (results, FOUND_TTL if results else MISS_TTL)
        return results
