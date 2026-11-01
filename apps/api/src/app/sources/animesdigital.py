"""PRIVATE ONLY: Portuguese episodes from AnimesDigital, matched to a MAL entry by title.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=zoko,animesdigital).
Subtitles are burned into the video in Portuguese, and dubbed versions are separate titles
named "... Dublado". The chain is: search `/pesquisa/{query}/`, the title page
`/anime/a/{slug}` (episodes newest first, 50 per page), then each episode page
`/video/a/{id}`, whose player iframe is `api.anivideo.net/videohls.php?d=<HLS playlist>`.
The playlist hosts need no Referer.
"""

import asyncio
import html
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import parse_qs, quote, urlparse

import httpx
from cachetools import TTLCache

from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Stream
from app.sources.matching import Candidate, match, same_season, search_queries

BASE = "https://animesdigital.org"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
CACHE_TTL = 1800
# A title or episode that is not there yet may appear soon, so misses expire sooner.
MISS_TTL = 300
# Title list pages fetched at once for long shows.
PAGE_WIDTH = 6
# Upper bound on list pages, against a broken or hostile pagination.
MAX_PAGES = 60

RESULT = re.compile(
    r'<a href="'
    + re.escape(BASE)
    + r'/anime/a/([^"/]+)"[^>]*>.*?<span class="title_anime">([^<]*)</span>',
    re.DOTALL,
)
EPISODE = re.compile(
    r'<a href="(' + re.escape(BASE) + r'/video/a/[^"]+)"[^>]*>.*?'
    r'<img src="([^"]*)".*?<div class="title_anime">([^<]*)</div>',
    re.DOTALL,
)
# "Clannad Episódio 24"; specials and half episodes ("12.5") have no place in the numbering.
EPISODE_NUMBER = re.compile(r"\bepis[oó]dio\s+0*(\d+)\s*$", re.IGNORECASE)
PAGE_LINK = re.compile(r'href="([^"]+/page/)(\d+)/"')
PLAYER = re.compile(r'<iframe[^>]+src="\s*(https://api\.anivideo\.net/videohls\.php\?[^"]+)"')
# Dubbed titles end in "Dublado", sometimes after "PT-BR".
DUB_SUFFIX = re.compile(r"(?:\s+pt-br)?\s+dublado\s*$", re.IGNORECASE)


def parse_results(page: str) -> list[Candidate]:
    return [Candidate(slug, html.unescape(name).strip()) for slug, name in RESULT.findall(page)]


def is_dub(name: str) -> bool:
    return bool(DUB_SUFFIX.search(name))


async def find(
    detail: dict, fetch: Callable[[str], Awaitable[str]], lang: Lang
) -> Candidate | None:
    """The site's title for a MAL entry, in the subtitled or the dubbed version."""
    queries = search_queries(detail)
    pages = await asyncio.gather(*(fetch(f"{BASE}/pesquisa/{quote(q)}/") for q in queries))
    dub = lang == "dub"
    season = same_season(detail)
    # Pooled, since the stem query is not one of the MAL titles the matcher searches with.
    # Compared without the dub suffix, so both versions score like the original title.
    candidates = [
        Candidate(c.identifier, DUB_SUFFIX.sub("", c.name))
        for page in pages
        for c in parse_results(page)
        if is_dub(c.name) == dub and season(c.name)
    ]
    return match(detail, lambda _query: candidates, lambda _slug: [])


@dataclass(frozen=True)
class Listing:
    source_title: str
    # Episode number -> episode page.
    pages: dict[int, str]
    thumbnails: dict[int, str]


def parse_episodes(page: str) -> list[tuple[int, str, str]]:
    """(number, episode page, image) for each numbered episode on one list page."""
    found = []
    for url, image, title in EPISODE.findall(page):
        if number := EPISODE_NUMBER.search(html.unescape(title).strip()):
            found.append((int(number.group(1)), url, image))
    return found


def page_links(page: str) -> list[str]:
    """Links to list pages 2..N, from the pagination's highest page number."""
    numbers = [(prefix, int(n)) for prefix, n in PAGE_LINK.findall(page)]
    if not numbers:
        return []
    prefix = numbers[0][0]
    last = min(max(n for _p, n in numbers), MAX_PAGES)
    return [f"{prefix}{n}/" for n in range(2, last + 1)]


def parse_player(page: str) -> str | None:
    """The HLS playlist the episode's player loads, or None when it only has other players."""
    if not (iframe := PLAYER.search(page)):
        return None
    target = parse_qs(urlparse(html.unescape(iframe.group(1))).query).get("d", [""])[0]
    return target if target.startswith("https://") else None


class AnimesDigitalSource:
    name = "animesdigital"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        self._listings: TTLCache[tuple, Listing | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        # Misses (no match, no HLS player) live here instead, since they may change soon.
        self._recent: TTLCache[tuple, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        # Concurrent callers (a title page, a fallback) share the work.
        self._flights: SingleFlight[tuple, Listing | None] = SingleFlight()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get(self, url: str) -> str:
        response = await self._client.get(url)
        response.raise_for_status()
        return response.text

    async def _listing(self, anime: dict, lang: Lang) -> Listing | None:
        key = (anime["id"], lang)
        if key in self._listings:
            return self._listings[key]
        if key in self._recent:
            return None
        return await self._flights.run(key, lambda: self._read_listing(key, anime))

    async def _read_listing(self, key: tuple, anime: dict) -> Listing | None:
        listing = None
        if found := await find(anime, self._get, key[1]):
            first = await self._get(f"{BASE}/anime/a/{found.identifier}")
            limit = asyncio.Semaphore(PAGE_WIDTH)

            async def page(url: str) -> str:
                async with limit:
                    return await self._get(url)

            rest = await asyncio.gather(*(page(u) for u in page_links(first)))
            entries = [e for p in (first, *rest) for e in parse_episodes(p)]
            pages = {number: url for number, url, _image in reversed(entries)}
            # Most titles reuse their cover for every episode: only real stills are kept.
            images = {number: image for number, _url, image in entries}
            distinct = len(set(images.values())) > 1
            if pages:
                listing = Listing(
                    source_title=found.name,
                    pages=dict(sorted(pages.items())),
                    thumbnails={
                        n: i for n, i in images.items() if distinct and i.startswith("https://")
                    },
                )
        if listing is None:
            self._recent[key] = None
        else:
            self._listings[key] = listing
        return listing

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        listing = await self._listing(anime, lang)
        if listing is None:
            return None
        return EpisodeList(list(listing.pages), listing.source_title, listing.thumbnails)

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        key = (anime["id"], episode, lang)
        if key in self._streams:
            return self._streams[key]
        if key in self._recent:
            return None
        listing = await self._listing(anime, lang)
        page = listing.pages.get(episode) if listing else None
        url = parse_player(await self._get(page)) if page else None
        result = Stream(url=url, kind="hls", resolution=None, upstream_headers={}) if url else None
        if result is None:
            self._recent[key] = None
        else:
            self._streams[key] = result
        return result
