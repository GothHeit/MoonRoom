"""PRIVATE ONLY: Portuguese episodes from AnimesDrive (also served as AnimeQ), matched to a MAL
entry by title.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=...,animedrive).
Subtitles are burned into the video in Portuguese, and dubbed versions are mostly separate
titles named "... Dublado". The chain is: WordPress search `/?s=`, the title page
`/anime/{slug}` (every episode inline, numbered), then each episode page
`/episodio/{slug}-episodio-NN`, whose player lists servers. Only the direct MP4 servers are
used; Blogger and third-party embeds are skipped. Server labels ("SD", "FullHD") are not to be
trusted (a "FullHD" file measured 720p), so no resolution is reported.
"""

import asyncio
import html
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import quote_plus, urljoin

import httpx
from cachetools import TTLCache

from app import hls
from app.sources.base import EpisodeList, Lang, Stream
from app.sources.matching import Candidate, match, same_season, search_queries

BASE = "https://animesdrive.cloud"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
# The video hosts are the site's own; sent like the site's player would.
REFERER = f"{BASE}/"
CACHE_TTL = 1800
# A title or episode that is not there yet may appear soon, so misses expire sooner.
MISS_TTL = 300
REDIRECTS = (301, 302, 303, 307, 308)

RESULT = re.compile(r'<div class="result-item">(.*?)</article>', re.DOTALL)
RESULT_LINK = re.compile(
    r'<div class="title"><a href="' + re.escape(BASE) + r'/anime/([^"/]+)/?">([^<]*)</a>'
)
# "Título Alternativo: A , B , C Sinopse: ..."
ALTERNATIVES = re.compile(
    r"T[ií]tulo Alternativo:(.*?)(?:Sinopse:|</p>)", re.DOTALL | re.IGNORECASE
)
# Dubbed titles end in "Dublado"; complete ones may also say "– Todos os Episódios".
SUFFIX = re.compile(r"\s*(?:[-–]\s*todos os epis[oó]dios)?\s*$", re.IGNORECASE)
DUB_SUFFIX = re.compile(r"\s+dublado\s*$", re.IGNORECASE)
EPISODE = re.compile(
    r"""class=['"]episode-card['"]\s+data-episode-number=['"]([^'"]*)['"][^>]*>\s*"""
    r"""<a href=['"]([^'"]+)['"]>\s*(?:<img src=['"]([^'"]*)['"])?"""
)
SERVER = re.compile(r"<button[^>]*\bdata-animeq-switch=[^>]*>")
ATTR = r"""\b{}=['"]([^'"]*)['"]"""
SOURCE_BLOCK = re.compile(r'<div class="animeq-player__source[\s"]')
# A direct video, as a <source>, a <video src> or a video.js host.
DIRECT = re.compile(
    r"""<source[^>]+\bsrc=['"]([^'"]+)['"]"""
    r"""|<video[^>]+\bsrc=['"]([^'"]+)['"]"""
    r"""|\bdata-video-src=['"]([^'"]+)['"]"""
)


def _attr(tag: str, name: str) -> str | None:
    found = re.search(ATTR.format(re.escape(name)), tag)
    return html.unescape(found.group(1)) if found else None


def clean_title(name: str) -> str:
    return SUFFIX.sub("", html.unescape(name).strip())


def is_dub(name: str) -> bool:
    return bool(DUB_SUFFIX.search(clean_title(name)))


@dataclass(frozen=True)
class Result:
    slug: str
    name: str
    alternatives: tuple[str, ...]


def parse_results(page: str) -> list[Result]:
    """Series results only: films live under /filme/ and have no episode list."""
    found = []
    for block in RESULT.findall(page):
        if not (link := RESULT_LINK.search(block)):
            continue
        alt = ALTERNATIVES.search(html.unescape(block))
        names = alt.group(1).split(",") if alt else []
        found.append(
            Result(
                link.group(1),
                clean_title(link.group(2)),
                tuple(n.strip() for n in names if n.strip()),
            )
        )
    return found


async def find(
    detail: dict, fetch: Callable[[str], Awaitable[str]], lang: Lang
) -> Candidate | None:
    """The site's title for a MAL entry, in the subtitled or the dubbed version."""
    queries = search_queries(detail)
    pages = await asyncio.gather(*(fetch(f"{BASE}/?s={quote_plus(q)}") for q in queries))
    dub = lang == "dub"
    season = same_season(detail)
    # Compared without the dub suffix, so both versions score like the original title.
    results = {
        r.slug: r
        for page in pages
        for r in parse_results(page)
        if is_dub(r.name) == dub and season(r.name)
    }
    candidates = [Candidate(r.slug, DUB_SUFFIX.sub("", r.name)) for r in results.values()]
    return match(detail, lambda _q: candidates, lambda slug: list(results[slug].alternatives))


@dataclass(frozen=True)
class Listing:
    source_title: str
    # Episode number -> episode page.
    pages: dict[int, str]
    thumbnails: dict[int, str]
    # Whether the title itself is the dubbed version, so its unlabelled servers are dubbed.
    dubbed: bool


def parse_episodes(page: str, dubbed: bool) -> list[tuple[int, str, str]]:
    """(number, episode page, image) for each whole-numbered episode, first one per number.
    Subtitled titles sometimes list a stray dubbed episode, which is left out."""
    found: dict[int, tuple[int, str, str]] = {}
    for number, url, image in EPISODE.findall(page):
        url = html.unescape(url)
        if not number.isdigit() or not url.startswith(f"{BASE}/episodio/"):
            continue
        if not dubbed and "-dublado-" in url:
            continue
        found.setdefault(int(number), (int(number), url, html.unescape(image)))
    return sorted(found.values())


@dataclass(frozen=True)
class Server:
    label: str
    url: str
    lang: Lang


def quality_rank(label: str) -> int:
    lower = label.lower()
    if any(k in lower for k in ("4k", "2160", "fhd", "fullhd", "full-hd", "1080")):
        return 4
    if "hd" in lower or "720" in lower:
        return 3
    if any(k in lower for k in ("sd", "480", "360")):
        return 2
    return 1


def parse_servers(page: str, dubbed: bool) -> list[Server]:
    """The episode's direct videos, best labelled first. A server labelled "Dublado" or
    "Legendado" says its version; any other one has the title's."""
    names = {
        _attr(tag, "data-animeq-switch"): _attr(tag, "data-source-name") or ""
        for tag in SERVER.findall(page)
    }
    blocks = SOURCE_BLOCK.split(page)[1:]
    servers = []
    for block in blocks:
        number = _attr(block[:200], "data-animeq-source")
        # The block ends where the next server, or the player's button row, begins.
        block = block.split('<div class="animeq-player__meta', 1)[0]
        video = DIRECT.search(block)
        url = html.unescape(next(g for g in video.groups() if g)).strip() if video else ""
        if not url.startswith("https://"):
            continue
        label = names.get(number, "")
        lower = label.lower()
        dub = "dublado" in lower or (dubbed and "legendado" not in lower)
        servers.append(Server(label, url, "dub" if dub else "sub"))
    return sorted(servers, key=lambda s: -quality_rank(s.label))


class AnimeDriveSource:
    name = "animedrive"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        self._listings: TTLCache[tuple, Listing | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        # Misses (no match, no playable server) live here instead, since they may change soon.
        self._recent: TTLCache[tuple, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        # Listings being read, so concurrent callers (a title page, a fallback) share the work.
        self._inflight: dict[tuple, asyncio.Future[Listing | None]] = {}

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get(self, url: str) -> str:
        response = await self._client.get(url)
        response.raise_for_status()
        return response.text

    async def _alive(self, url: str) -> bool:
        """The site leaves dead links behind, so a server is tried before it is offered.
        Streamed, so a host that ignores the Range header isn't downloaded whole. The links
        come from scraped pages, so every hop (redirects included) must be a public address."""
        headers = {"Range": "bytes=0-0", "Referer": REFERER}
        try:
            for _ in range(hls.MAX_REDIRECTS + 1):
                if not await hls.is_public_target(url):
                    return False
                async with self._client.stream(
                    "GET", url, headers=headers, follow_redirects=False
                ) as response:
                    location = response.headers.get("location")
                    if response.status_code not in REDIRECTS or not location:
                        return 200 <= response.status_code < 300
                url = urljoin(url, location)
        except httpx.HTTPError:
            return False
        return False

    async def _listing(self, anime: dict, lang: Lang) -> Listing | None:
        key = (anime["id"], lang)
        if key in self._listings:
            return self._listings[key]
        if key in self._recent:
            return None
        task = self._inflight.get(key)
        if task is None:
            task = self._inflight[key] = asyncio.ensure_future(self._read_listing(key, anime))
            task.add_done_callback(lambda t: self._settle(key, t))
        # Shielded: one caller giving up must not cancel the read the others wait on.
        return await asyncio.shield(task)

    def _settle(self, key: tuple, task: asyncio.Future[Listing | None]) -> None:
        self._inflight.pop(key, None)
        if not task.cancelled():
            task.exception()  # read it, so a read nobody waits on isn't left unretrieved

    async def _read_listing(self, key: tuple, anime: dict) -> Listing | None:
        lang: Lang = key[1]
        listing = None
        if found := await find(anime, self._get, lang):
            page = await self._get(f"{BASE}/anime/{found.identifier}")
            entries = parse_episodes(page, dubbed=lang == "dub")
            images = {number: image for number, _url, image in entries}
            # Some titles reuse their cover for every episode: only real stills are kept.
            distinct = len(set(images.values())) > 1
            if entries:
                listing = Listing(
                    source_title=found.name,
                    pages={number: url for number, url, _image in entries},
                    thumbnails={
                        n: i for n, i in images.items() if distinct and i.startswith("https://")
                    },
                    dubbed=lang == "dub",
                )
        elif lang == "dub":
            listing = await self._dub_servers(anime)
        if listing is None:
            self._recent[key] = None
        else:
            self._listings[key] = listing
        return listing

    async def _dub_servers(self, anime: dict) -> Listing | None:
        """Some titles have no "Dublado" version but carry a dubbed server on each episode.
        The first episode tells whether this one does."""
        sub = await self._listing(anime, "sub")
        if sub is None:
            return None
        first = await self._get(sub.pages[min(sub.pages)])
        if not any(s.lang == "dub" for s in parse_servers(first, dubbed=False)):
            return None
        return sub

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
        result = None
        if listing and page:
            for server in parse_servers(await self._get(page), listing.dubbed):
                if server.lang == lang and await self._alive(server.url):
                    result = Stream(
                        url=server.url,
                        kind="mp4",
                        resolution=None,
                        upstream_headers={"Referer": REFERER},
                    )
                    break
        if result is None:
            self._recent[key] = None
        else:
            self._streams[key] = result
        return result
