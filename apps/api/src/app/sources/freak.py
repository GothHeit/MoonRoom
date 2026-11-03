"""PRIVATE ONLY: English adult-genre episodes from an adult English site (named neutrally),
matched to a MAL entry by title.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=...,freak). Answers only for
titles in MAL's adult genre. The site has one post per episode and no title pages: the search
`/search/{query}/` lists posts named "{title} Episode {n}", "{title} Subbed Episode {n}" or
"{title} Dubbed Episode {n}", and a post's player is a plain `<source>` MP4 on the site's own
media host (no Referer or token needed). Subtitled copies carry English burned into the picture.
"""

import html
import re
from dataclasses import dataclass
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from cachetools import TTLCache

from app import hls
from app.singleflight import SingleFlight
from app.sources.adult import is_adult
from app.sources.base import EpisodeList, Lang, Stream, Traits
from app.sources.matching import (
    STRICT_MIN_RATIO,
    Candidate,
    fallback_query,
    match,
    search_queries,
)

BASE = "https://hentaifreak.org"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
CACHE_TTL = 1800
MISS_TTL = 300

RESULT = re.compile(r'<h2[^>]*>\s*<a href="' + re.escape(BASE) + r'/([^"]+)"[^>]*>([^<]+)</a>')
EPISODE = re.compile(r"\s+Episode\s+(\d+)\s*$", re.IGNORECASE)
VERSION = re.compile(r"\s+(Subbed|Dubbed)\b", re.IGNORECASE)
SOURCE = re.compile(r"<source[^>]+src=[\"']([^\"']+\.mp4)[\"']", re.IGNORECASE)
HEIGHT = re.compile(r"(?:\d{3,4}x(\d{3,4})|\b(\d{3,4})p\b)", re.IGNORECASE)


@dataclass(frozen=True)
class Post:
    path: str
    title: str
    episode: int
    # "dub", "sub" (named Subbed) or None (no version named; the site's usual subtitled copy).
    version: str | None


def parse_results(page: str) -> list[Post]:
    posts = []
    for path, raw in RESULT.findall(page):
        name = " ".join(html.unescape(raw).split())
        number = EPISODE.search(name)
        episode = int(number.group(1)) if number else 1
        name = EPISODE.sub("", name)
        version = VERSION.search(name)
        title = VERSION.sub("", name).strip()
        posts.append(Post(path, title, episode, version.group(1).lower()[:3] if version else None))
    return posts


def episodes_for(posts: list[Post], title: str, lang: Lang) -> dict[int, str]:
    """Episode number -> post path for one title and language. A post named Subbed wins over an
    unnamed one for the same episode."""
    chosen: dict[int, Post] = {}
    for post in posts:
        if post.title != title:
            continue
        if lang == "dub" and post.version != "dub":
            continue
        if lang == "sub" and post.version == "dub":
            continue
        current = chosen.get(post.episode)
        if current is None or (current.version is None and post.version == "sub"):
            chosen[post.episode] = post
    return {n: chosen[n].path for n in sorted(chosen)}


def titles_of(posts: list[Post]) -> list[Candidate]:
    return [Candidate(t, t) for t in sorted({p.title for p in posts})]


def parse_video(page: str) -> tuple[str, int | None] | None:
    found = SOURCE.search(page)
    if not found:
        return None
    raw = html.unescape(found.group(1))
    parts = urlsplit(raw)
    url = urlunsplit(parts._replace(path=quote(parts.path, safe="/%")))
    height = HEIGHT.search(raw)
    return url, int(next(g for g in height.groups() if g)) if height else None


class FreakSource:
    name = "freak"
    traits = Traits(hard_sub_lang="en", dub_audio_lang="en")

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        self._listings: TTLCache[tuple, tuple[str, dict[int, str]] | None] = TTLCache(
            maxsize=4096, ttl=CACHE_TTL
        )
        self._streams: TTLCache[tuple, Stream] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._recent: TTLCache[tuple, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._flights: SingleFlight[tuple, tuple[str, dict[int, str]] | None] = SingleFlight()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get(self, url: str) -> str:
        response = await self._client.get(url, headers={"Referer": f"{BASE}/"})
        response.raise_for_status()
        return response.text

    async def _listing(self, anime: dict, lang: Lang):
        key = (anime["id"], lang)
        if key in self._listings:
            return self._listings[key]
        if key in self._recent:
            return None
        return await self._flights.run(key, lambda: self._read_listing(key, anime))

    async def _read_listing(self, key: tuple, anime: dict):
        lang: Lang = key[1]
        posts: list[Post] = []
        queries = search_queries(anime)
        for query in queries:
            posts += parse_results(await self._get(f"{BASE}/search/{quote(query)}/"))
        found = match(anime, lambda _q: titles_of(posts), lambda _t: [], STRICT_MIN_RATIO)
        # The site searches the exact phrase, so a title spelled a little differently is looked
        # for by one of its words.
        if found is None and (word := fallback_query(anime)) and word not in queries:
            posts += parse_results(await self._get(f"{BASE}/search/{quote(word)}/"))
            found = match(anime, lambda _q: titles_of(posts), lambda _t: [], STRICT_MIN_RATIO)
        listing = None
        if found:
            if episodes := episodes_for(posts, found.name, lang):
                listing = (found.name, episodes)
        if listing is None:
            self._recent[key] = None
        else:
            self._listings[key] = listing
        return listing

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        if not is_adult(anime):
            return None
        listing = await self._listing(anime, lang)
        return EpisodeList(list(listing[1]), listing[0]) if listing else None

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        if not is_adult(anime):
            return None
        key = (anime["id"], episode, lang)
        if key in self._streams:
            return self._streams[key]
        if key in self._recent:
            return None
        listing = await self._listing(anime, lang)
        path = listing[1].get(episode) if listing else None
        result = None
        if path and (video := parse_video(await self._get(f"{BASE}/{path}"))):
            url, height = video
            if await hls.is_public_target(url):
                result = Stream(url, "mp4", height, {})
        if result is None:
            self._recent[key] = None
        else:
            self._streams[key] = result
        return result
