"""PRIVATE ONLY: Portuguese episodes from AnimesOnlineCC, matched to a MAL entry by title.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=...,animesonlinecc).
Subtitles are burned into the video in Portuguese; dubbed versions are titles named
"... Dublado". The chain is: search `/search/{query}`, the title page `/anime/{slug}/` (every
season and episode inline; later seasons are groups on the same page, not separate titles), then
the episode page `/episodio/{slug}-episodio-{n}/` (`{slug}-2-episodio-{n}/` for season 2), whose
player is a Blogger iframe. The Blogger page lists Google Video MP4 links (itag 22 = 720p,
18 = 360p). Those links are signed for the address that fetched the page, so they are read here,
at play time, and the API itself proxies the video.
"""

import asyncio
import html
import re
import time
from dataclasses import dataclass
from urllib.parse import parse_qs, quote, urlparse

import httpx
from cachetools import TTLCache

from app import hls
from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Stream, Traits
from app.sources.matching import SEASON, Candidate, match, search_queries

BASE = "https://animesonlinecc.to"
# The site refuses non-browser agents.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
REFERER = f"{BASE}/"
CACHE_TTL = 1800
MISS_TTL = 300
# A signed link is dropped from the cache this long before it expires.
EXPIRY_MARGIN = 600
# Google Video itags -> height.
ITAGS = {37: 1080, 22: 720, 59: 480, 35: 480, 18: 360}

ARTICLE = re.compile(r'<article class="item[^"]*"[^>]*>(.*?)</article>', re.DOTALL)
RESULT_LINK = re.compile(
    r'<h3>\s*<a href="' + re.escape(BASE) + r'/anime/([^"/]+)/?"[^>]*>([^<]*)</a>', re.DOTALL
)
SEASON_GROUP = re.compile(r'<div class="se-c">(.*?)(?=<div class="se-c">|$)', re.DOTALL)
SEASON_NUMBER = re.compile(r'<span class="se-t[^"]*">\s*(\d+)\s*</span>')
EPISODE_ITEM = re.compile(
    r'<div class="numerando">\s*(?:[^<]*?)(\d+)\s*</div>.*?'
    r'<a href="(' + re.escape(BASE) + r'/episodio/[^"]+)"',
    re.DOTALL,
)
PLAYER = re.compile(r'<iframe[^>]+src="(https://www\.blogger\.com/video\.g\?[^"]+)"')
VIDEO = re.compile(r"https://[a-z0-9.-]+\.googlevideo\.com/videoplayback\?[^\"'\\\s<>]+")
DUB = re.compile(r"\bdublado\b", re.IGNORECASE)
DUB_SUFFIX = re.compile(r"\s*(?:[-–(]\s*)?dublado\)?\s*$", re.IGNORECASE)


def is_dub(name: str) -> bool:
    return bool(DUB.search(name))


def parse_results(page: str) -> list[Candidate]:
    found = []
    for block in ARTICLE.findall(page):
        if link := RESULT_LINK.search(block):
            found.append(Candidate(link.group(1), html.unescape(link.group(2)).strip()))
    return found


def season_of(detail: dict) -> int | None:
    """The season a sequel's MAL title names; None for a first season."""
    found = SEASON.search(detail.get("title") or "")
    number = next((n for n in found.groups() if n), None) if found else None
    return int(number) if number else None


def parse_episodes(page: str, season: int | None) -> dict[int, str]:
    """Episode number -> page. A sequel takes its own season group; a first season takes the
    first group, or every group when the numbers continue through them."""
    groups: list[tuple[int, dict[int, str]]] = []
    for block in SEASON_GROUP.findall(page):
        number = SEASON_NUMBER.search(block)
        episodes = {int(n): html.unescape(u) for n, u in EPISODE_ITEM.findall(block)}
        groups.append((int(number.group(1)) if number else len(groups) + 1, episodes))
    if season is not None:
        return dict(sorted(next((e for s, e in groups if s == season), {}).items()))
    if not groups:
        return {}
    merged: dict[int, str] = {}
    overlap = False
    for _s, episodes in groups:
        overlap = overlap or bool(merged.keys() & episodes.keys())
        merged.update({n: u for n, u in episodes.items() if n not in merged})
    first = min(groups, key=lambda g: g[0])[1]
    return dict(sorted((first if overlap else merged).items()))


def parse_player(page: str) -> str | None:
    found = PLAYER.search(page)
    return html.unescape(found.group(1)) if found else None


@dataclass(frozen=True)
class Video:
    url: str
    height: int
    expires: float | None


def parse_videos(page: str) -> list[Video]:
    """The MP4 links on a Blogger player page, best first. The page carries them HTML-escaped
    (and may JSON-escape them too)."""
    text = html.unescape(page)
    for raw, plain in (("\\u0026", "&"), ("\\u003d", "="), ("\\/", "/"), ("&amp;", "&")):
        text = text.replace(raw, plain)
    videos: dict[str, Video] = {}
    for url in VIDEO.findall(text):
        query = parse_qs(urlparse(url).query)
        try:
            itag = int(query.get("itag", [""])[0])
        except ValueError:
            continue
        if itag not in ITAGS:
            continue
        expire = query.get("expire", [""])[0]
        videos.setdefault(url, Video(url, ITAGS[itag], float(expire) if expire.isdigit() else None))
    return sorted(videos.values(), key=lambda v: -v.height)


class AnimesOnlineCCSource:
    name = "animesonlinecc"
    traits = Traits(hard_sub_lang="pt-BR", dub_audio_lang="pt-BR")

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        self._listings: TTLCache[tuple, tuple[str, dict[int, str]] | None] = TTLCache(
            maxsize=4096, ttl=CACHE_TTL
        )
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._expiry: dict[tuple, float] = {}
        self._recent: TTLCache[tuple, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._flights: SingleFlight[tuple, tuple[str, dict[int, str]] | None] = SingleFlight()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get(self, url: str) -> str:
        response = await self._client.get(url, headers={"Referer": REFERER})
        response.raise_for_status()
        return response.text

    async def _search(self, query: str) -> str:
        # A path ending in a dot is a 404 on this theme ("Natsuyasumi."), and so is a search
        # that finds nothing on some of its sites.
        try:
            return await self._get(f"{BASE}/search/{quote(query.rstrip('. '))}")
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 404:
                return ""
            raise

    async def _find(self, anime: dict, lang: Lang) -> Candidate | None:
        queries = search_queries(anime)
        pages = await asyncio.gather(*(self._search(q) for q in queries))
        dub = lang == "dub"
        candidates = [
            Candidate(c.identifier, DUB_SUFFIX.sub("", c.name))
            for page in pages
            for c in parse_results(page)
            if is_dub(c.name) == dub
        ]
        # Later seasons are groups of the first season's page: a name carrying the season
        # number is not required, and the stem search finds the page.
        return match(anime, lambda _q: candidates, lambda _slug: [])

    async def _listing(self, anime: dict, lang: Lang):
        key = (anime["id"], lang)
        if key in self._listings:
            return self._listings[key]
        if key in self._recent:
            return None
        return await self._flights.run(key, lambda: self._read_listing(key, anime))

    async def _read_listing(self, key: tuple, anime: dict):
        lang: Lang = key[1]
        listing = None
        if found := await self._find(anime, lang):
            page = await self._get(f"{BASE}/anime/{found.identifier}/")
            if episodes := parse_episodes(page, season_of(anime)):
                listing = (found.name, episodes)
        if listing is None:
            self._recent[key] = None
        else:
            self._listings[key] = listing
        return listing

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        listing = await self._listing(anime, lang)
        return EpisodeList(list(listing[1]), listing[0]) if listing else None

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        key = (anime["id"], episode, lang)
        if key in self._streams:
            if self._expiry.get(key, float("inf")) > time.time():
                return self._streams[key]
            del self._streams[key]
        if key in self._recent:
            return None
        listing = await self._listing(anime, lang)
        page = listing[1].get(episode) if listing else None
        result = None
        if page and (player := parse_player(await self._get(page))):
            for video in parse_videos(await self._get(player)):
                if await hls.is_public_target(video.url):
                    result = Stream(video.url, "mp4", video.height, {"User-Agent": USER_AGENT})
                    if video.expires:
                        self._expiry[key] = video.expires - EXPIRY_MARGIN
                    break
        if result is None:
            self._recent[key] = None
        else:
            self._streams[key] = result
        return result
