"""Portuguese synopses from AnimesDigital, matched to a MyAnimeList entry by title.

Best effort: any failure, a title the site doesn't carry, or a slow answer gives None and the
caller keeps the English text. Results are cached in memory, misses for a day and errors briefly.
"""

import asyncio
import html
import logging
import re

import httpx
from cachetools import TLRUCache

from app.singleflight import SingleFlight
from app.sources.animesdigital import BASE, USER_AGENT, find

log = logging.getLogger(__name__)

TIMEOUT = 6.0
FOUND_TTL = 7 * 86400
MISS_TTL = 86400
ERROR_TTL = 300
MIN_LENGTH = 40

SYNOPSIS = re.compile(r'<div class="sinopse">(.*?)</div>', re.DOTALL)
TAG = re.compile(r"<[^>]+>")


def parse_synopsis(page: str) -> str | None:
    found = SYNOPSIS.search(page)
    if not found:
        return None
    text = " ".join(html.unescape(TAG.sub(" ", found.group(1))).split())
    return text if len(text) >= MIN_LENGTH else None


class PtSynopses:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._flights: SingleFlight[int, str | None] = SingleFlight()
        # Values are (text or None, ttl).
        self._cache: TLRUCache[int, tuple[str | None, float]] = TLRUCache(
            maxsize=4096, ttu=lambda _key, value, now: now + value[1]
        )

    async def get(self, detail: dict) -> str | None:
        key = detail["id"]
        if (hit := self._cache.get(key)) is not None:
            return hit[0]
        # Concurrent requests for the same title (a cold home page) share one scrape.
        return await self._flights.run(key, lambda: self._fetch(key, detail))

    async def _fetch(self, key: int, detail: dict) -> str | None:
        try:
            async with asyncio.timeout(TIMEOUT):
                text = await self._lookup(detail)
        except Exception as exc:  # best effort: never let a scrape failure break the page
            log.warning("pt synopsis for %s unavailable: %s", key, exc)
            self._cache[key] = (None, ERROR_TTL)
            return None
        self._cache[key] = (text, FOUND_TTL if text else MISS_TTL)
        return text

    async def _get(self, url: str) -> str:
        response = await self._http.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
        response.raise_for_status()
        return response.text

    async def _lookup(self, detail: dict) -> str | None:
        best = await find(detail, self._get, "sub")
        if best is None:
            return None
        return parse_synopsis(await self._get(f"{BASE}/anime/a/{best.identifier}"))
