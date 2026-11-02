"""PRIVATE ONLY: Portuguese episodes from AnimeFire, matched to a MAL entry by title.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=...,animefire).
The site is read through the JSON API its app uses (api.animefire.one): search
`/animes/pesquisar?q=`, the title `/anime/{id}` (episodes, numbered per season) and the episode
`/episode/{id}` (one entry per audio track: "dublado" or "legendado"). A stream URL looks like a
picture and is an HLS master playlist. Subtitles are burned into the video in Portuguese.

The video host is unreliable: for stretches it answers 404 for every playlist while the API still
says the episode is online. A stream is only offered when its playlist exists, and a host that
just failed is skipped for a while, so a dead AnimeFire costs the other sources nothing.
Tracks flagged `is_mtl` are machine-translated; they are offered but rank below any other version.
"""

import asyncio
import html
import time
from dataclasses import dataclass
from urllib.parse import quote, urlparse

import httpx
from cachetools import TTLCache

from app import hls
from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Stream, Traits
from app.sources.matching import Candidate, match, same_season, search_queries

API = "https://api.animefire.one"
SITE = "https://animefire.one"
API_VERSION = "3"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
REFERER = f"{SITE}/"
CACHE_TTL = 1800
# A title or episode that is not there yet may appear soon, so misses expire sooner.
MISS_TTL = 300
# How long a video host that answered "no playlist" is not asked again.
HOST_DOWN_TTL = 300
TITLE_KEYS = ("BR", "US", "JP")
AUDIO = {"sub": "legendado", "dub": "dublado"}


def titles(entry: dict) -> list[str]:
    """Every name the API has for a title, the Brazilian one first."""
    names = entry.get("titles") or {}
    ordered = [names.get(k) for k in TITLE_KEYS] + [
        v for k, v in names.items() if k not in TITLE_KEYS
    ]
    seen: list[str] = []
    for name in ordered:
        name = html.unescape(name).strip() if isinstance(name, str) else ""
        if name and name not in seen:
            seen.append(name)
    return seen


def has_audio(entry: dict, lang: Lang) -> bool:
    """Whether a search result or an episode is offered in the language. An entry that doesn't
    say is given the benefit of the doubt."""
    audio = entry.get("audio")
    if not isinstance(audio, str) or not audio.strip():
        return True
    return AUDIO[lang] in audio.lower()


async def find(detail: dict, search, lang: Lang) -> Candidate | None:
    """The site's title for a MAL entry. `search` maps a query to the API's result list."""
    pages = await asyncio.gather(*(search(q) for q in search_queries(detail)))
    season = same_season(detail)
    results: dict[str, list[str]] = {}
    for page in pages:
        for entry in page:
            names = titles(entry)
            ident = entry.get("id")
            if isinstance(ident, str) and ident and names and has_audio(entry, lang):
                if any(season(n) for n in names):
                    results.setdefault(ident, names)
    candidates = [Candidate(ident, names[0]) for ident, names in results.items()]
    return match(detail, lambda _q: candidates, lambda ident: results[ident][1:])


@dataclass(frozen=True)
class Listing:
    source_title: str
    # Episode number across the whole run -> the API's episode id.
    ids: dict[int, str]


def parse_episodes(data: dict, lang: Lang) -> dict[int, str]:
    """Episode number -> id. The API numbers episodes within their season; a season's
    `first_episode_number` places it in the whole run."""
    first = {
        s.get("number"): s["first_episode_number"]
        for s in data.get("seasons") or []
        if isinstance(s.get("first_episode_number"), int) and s["first_episode_number"] > 0
    }
    found: dict[int, str] = {}
    for entry in data.get("episodes") or []:
        ident, number = entry.get("id"), entry.get("number")
        if not isinstance(ident, str) or not ident or not has_audio(entry, lang):
            continue
        if not isinstance(number, int) or number < 1:
            continue
        start = first.get(entry.get("season"))
        found.setdefault(start + number - 1 if start else number, ident)
    # Numbers that repeat (a season the list doesn't describe): fall back to the list order.
    listed = [e for e in data.get("episodes") or [] if isinstance(e.get("id"), str)]
    if len(found) < len([e for e in listed if has_audio(e, lang)]):
        found = {
            i: e["id"] for i, e in enumerate((e for e in listed if has_audio(e, lang)), start=1)
        }
    return dict(sorted(found.items()))


def pick_stream(data: dict, lang: Lang) -> list[dict]:
    """The episode's online tracks in the wanted audio, as the API lists them."""
    streams = data.get("streams") or []
    return [
        s
        for s in streams
        if isinstance(s, dict)
        and not s.get("is_offline")
        and isinstance(s.get("url"), str)
        and s["url"].startswith("https://")
        and str(s.get("audio") or "").strip().lower() == AUDIO[lang]
    ]


class AnimeFireSource:
    name = "animefire"
    traits = Traits(hard_sub_lang="pt-BR", dub_audio_lang="pt-BR")

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        self._listings: TTLCache[tuple, Listing | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._recent: TTLCache[tuple, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._flights: SingleFlight[tuple, Listing | None] = SingleFlight()
        # Video host -> when to ask it again, after it had no playlist.
        self._down: dict[str, float] = {}

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _api(self, path: str) -> dict | list:
        sep = "&" if "?" in path else "?"
        response = await self._client.get(
            f"{API}{path}{sep}v={API_VERSION}",
            headers={"Accept": "application/json", "Origin": SITE, "Referer": REFERER},
        )
        response.raise_for_status()
        body = response.json()
        data = body.get("data") if isinstance(body, dict) else None
        return data if isinstance(data, (dict, list)) else {}

    async def _search(self, query: str) -> list[dict]:
        data = await self._api(f"/animes/pesquisar?q={quote(query)}")
        return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []

    async def _playlist_exists(self, url: str) -> bool | None:
        """Whether the video host has the playlist; None when it couldn't say. The host has
        answered 404 for everything for days at a time, while the API called it online."""
        host = urlparse(url).hostname or ""
        if self._down.get(host, 0) > time.monotonic():
            return False
        if not await hls.is_public_target(url):
            return False
        try:
            response = await self._client.get(
                url, headers={"Referer": REFERER, "Origin": SITE}, follow_redirects=False
            )
        except httpx.HTTPError:
            return None
        if response.status_code in (404, 410) or (
            response.status_code < 300 and not response.text.lstrip("﻿ \t\r\n").startswith("#EXTM3U")
        ):
            self._down[host] = time.monotonic() + HOST_DOWN_TTL
            return False
        return True if response.status_code < 300 else None

    async def _listing(self, anime: dict, lang: Lang) -> Listing | None:
        key = (anime["id"], lang)
        if key in self._listings:
            return self._listings[key]
        if key in self._recent:
            return None
        return await self._flights.run(key, lambda: self._read_listing(key, anime))

    async def _read_listing(self, key: tuple, anime: dict) -> Listing | None:
        lang: Lang = key[1]
        listing = None
        if found := await find(anime, self._search, lang):
            data = await self._api(f"/anime/{quote(found.identifier, safe='')}")
            if isinstance(data, dict) and (ids := parse_episodes(data, lang)):
                listing = Listing(found.name, ids)
        if listing is None:
            self._recent[key] = None
        else:
            self._listings[key] = listing
        return listing

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        listing = await self._listing(anime, lang)
        return EpisodeList(list(listing.ids), listing.source_title) if listing else None

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        key = (anime["id"], episode, lang)
        if key in self._streams:
            return self._streams[key]
        if key in self._recent:
            return None
        listing = await self._listing(anime, lang)
        ident = listing.ids.get(episode) if listing else None
        result = None
        if ident:
            data = await self._api(f"/episode/{quote(ident, safe='')}")
            tracks = pick_stream(data, lang) if isinstance(data, dict) else []
            chosen = None
            for track in tracks:
                exists = await self._playlist_exists(track["url"])
                if exists:
                    chosen = track
                    break
                if exists is None and chosen is None:
                    chosen = track
            if chosen:
                machine = lang == "sub" and bool(
                    chosen.get("is_mtl") or (isinstance(data, dict) and data.get("is_mtl"))
                )
                result = Stream(
                    url=chosen["url"],
                    kind="hls",
                    resolution=None,
                    upstream_headers={"Referer": REFERER},
                    machine_translated=machine,
                )
        if result is None:
            self._recent[key] = None
        else:
            self._streams[key] = result
        return result
