"""PRIVATE ONLY: Portuguese adult-genre episodes from an adult pt-BR site (named neutrally),
matched to a MAL entry by title.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=...,animesbiz). Answers only
for titles in MAL's adult genre. Subtitles are burned into the video in Portuguese; the site has
no dubs. It runs the same theme as AnimesOnlineCC: search `/search/{query}`, the title page
`/hentai/{slug}/` lists every episode, and the episode page `/episodio/{slug}-episodio-{n}/`
embeds a Blogger player whose Google Video MP4 links are signed for the address that read them,
so they are read at play time and the API proxies the video.
"""

import asyncio
import html
import re
import time
from urllib.parse import quote

import httpx
from cachetools import TTLCache

from app import hls
from app.singleflight import SingleFlight
from app.sources.adult import is_adult
from app.sources.animesonlinecc import parse_player, parse_videos
from app.sources.base import EpisodeList, Lang, Stream, Traits
from app.sources.matching import (
    STRICT_MIN_RATIO,
    Candidate,
    fallback_query,
    match,
    search_queries,
)

BASE = "https://animeshentai.biz"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
REFERER = f"{BASE}/"
CACHE_TTL = 1800
MISS_TTL = 300
EXPIRY_MARGIN = 600

ARTICLE = re.compile(r'<article class="item[^"]*"[^>]*>(.*?)</article>', re.DOTALL)
RESULT_LINK = re.compile(
    r'<h3>\s*<a href="' + re.escape(BASE) + r'/hentai/([^"/]+)/?"[^>]*>([^<]*)</a>', re.DOTALL
)
EPISODES = re.compile(r'<ul class="episodios">(.*?)</ul>', re.DOTALL)
EPISODE_LINK = re.compile(
    r'<a href="(' + re.escape(BASE) + r'/episodio/[^"]*?-episodio-(\d+)/?)"', re.DOTALL
)


def parse_results(page: str) -> list[Candidate]:
    found = []
    for block in ARTICLE.findall(page):
        if link := RESULT_LINK.search(block):
            found.append(Candidate(link.group(1), html.unescape(link.group(2)).strip()))
    return found


def parse_episodes(page: str) -> dict[int, str]:
    """Episode number -> page, from the title page's episode list."""
    episodes: dict[int, str] = {}
    for block in EPISODES.findall(page):
        for url, number in EPISODE_LINK.findall(block):
            episodes.setdefault(int(number), html.unescape(url))
    return dict(sorted(episodes.items()))


class AnimesBizSource:
    name = "animesbiz"
    traits = Traits(hard_sub_lang="pt-BR", dub_audio_lang=None)

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        self._listings: TTLCache[int, tuple[str, dict[int, str]] | None] = TTLCache(
            maxsize=4096, ttl=CACHE_TTL
        )
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._expiry: dict[tuple, float] = {}
        self._recent: TTLCache[tuple, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._flights: SingleFlight[int, tuple[str, dict[int, str]] | None] = SingleFlight()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get(self, url: str) -> str:
        response = await self._client.get(url, headers={"Referer": REFERER})
        response.raise_for_status()
        return response.text

    async def _search(self, query: str) -> str:
        # A path ending in a dot is a 404 on this site ("Natsuyasumi.").
        try:
            return await self._get(f"{BASE}/search/{quote(query.rstrip('. '))}")
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 404:
                return ""
            raise

    async def _listing(self, anime: dict):
        key = anime["id"]
        if key in self._listings:
            return self._listings[key]
        if (key,) in self._recent:
            return None
        return await self._flights.run(key, lambda: self._read_listing(anime))

    async def _read_listing(self, anime: dict):
        key = anime["id"]
        listing = None
        queries = search_queries(anime)
        pages = await asyncio.gather(*(self._search(q) for q in queries))
        candidates = [c for page in pages for c in parse_results(page)]
        found = match(anime, lambda _q: candidates, lambda _slug: [], STRICT_MIN_RATIO)
        # The site searches the exact phrase, so a title spelled a little differently is looked
        # for by one of its words.
        if found is None and (word := fallback_query(anime)) and word not in queries:
            loose = parse_results(await self._search(word))
            found = match(anime, lambda _q: loose, lambda _slug: [], STRICT_MIN_RATIO)
        if found:
            page = await self._get(f"{BASE}/hentai/{found.identifier}/")
            if episodes := parse_episodes(page):
                listing = (found.name, episodes)
        if listing is None:
            self._recent[(key,)] = None
        else:
            self._listings[key] = listing
        return listing

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        if lang != "sub" or not is_adult(anime):
            return None
        listing = await self._listing(anime)
        return EpisodeList(list(listing[1]), listing[0]) if listing else None

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        if lang != "sub" or not is_adult(anime):
            return None
        key = (anime["id"], episode)
        if key in self._streams:
            if self._expiry.get(key, float("inf")) > time.time():
                return self._streams[key]
            del self._streams[key]
        if key in self._recent:
            return None
        listing = await self._listing(anime)
        page = listing[1].get(episode) if listing else None
        result = None
        if page and (player := parse_player(await self._get(page))):
            for video in parse_videos(await self._get(player)):
                if await hls.is_public_target(video.url):
                    result = Stream(video.url, "mp4", video.height, {})
                    if video.expires:
                        self._expiry[key] = video.expires - EXPIRY_MARGIN
                    break
        if result is None:
            self._recent[key] = None
        else:
            self._streams[key] = result
        return result
