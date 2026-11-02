"""PRIVATE ONLY: episodes from KickAssAnime.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=kaa).
The site's JSON API (no key, no login):

    POST /api/fsearch {"query"}                          -> {"result": [show, ...]}
    GET  /api/show/{slug}/episodes?ep=N&lang=ja-JP       -> the page of episodes holding N, and
                                                            the episode numbers of every page
    GET  /api/show/{slug}/episode/ep-{N}-{episode slug}  -> {"servers": [{"name", "src"}]}

The "VidStreaming" server is a player page whose Astro island props carry the HLS master and
every subtitle track unencrypted. The master holds every audio language the release has (the
Portuguese dub among them) as separate tracks, so one stream serves the original audio and all
dubs; the player's audio menu switches between them, and so "dub" listings are not offered.
The HLS and subtitle hosts demand the player's site as Referer.

Shows carry no MAL id: they are matched by title and start year.
"""

import asyncio
import html
import json
import re
from typing import cast

import httpx
from cachetools import TTLCache

from app.ranking import base_lang
from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Stream, Subtitle, Traits
from app.sources.matching import Candidate, match, normalize, same_season, search_queries

BASE = "https://kaa.lt"
PLAYER_REFERER = "https://krussdomi.com/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ORIGINAL_LOCALE = "ja-JP"
CACHE_TTL = 1800
# Misses expire sooner: a just-aired episode or a show that is added a little later.
MISS_TTL = 120
# A show's start year may differ by one between catalogs (late-season starts, simulcast dates).
YEAR_SLACK = 1
ISLAND = re.compile(r'<astro-island[^>]*\sprops="([^"]*)"')


def decode_props(value: object) -> object:
    """Astro serialises island props as [0, value] for plain values, [1, [items]] for lists
    and [0, {key: [type, value]}] for objects; this turns that back into plain JSON."""
    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], int):
        kind, inner = value
        if kind == 1 and isinstance(inner, list):
            return [decode_props(item) for item in inner]
        if isinstance(inner, dict):
            return {k: decode_props(v) for k, v in inner.items()}
        return inner
    return value


def parse_player(page: str) -> dict | None:
    """The props of the page's player island: {"manifest": url, "subtitles": [...]}."""
    for match_ in ISLAND.finditer(page):
        try:
            props = json.loads(html.unescape(match_.group(1)))
        except ValueError:
            continue
        if isinstance(props, dict) and "manifest" in props:
            decoded = decode_props([0, props])
            return decoded if isinstance(decoded, dict) else None
    return None


def parse_subtitles(raw: object) -> tuple[Subtitle, ...]:
    """Tracks the player lists. A bare "pt" is the Brazilian track on these sites."""
    if not isinstance(raw, list):
        return ()
    tracks = []
    for item in raw:
        if not isinstance(item, dict) or not str(item.get("src", "")).startswith("https://"):
            continue
        code = str(item.get("language") or "")
        base = base_lang(code)
        lang = "pt-BR" if base == "pt" else base if base != "und" else code or "und"
        tracks.append(Subtitle(lang=lang, label=str(item.get("name") or code), url=item["src"]))
    return tuple(tracks)


def pick_server(servers: object) -> str | None:
    """The VidStreaming player page: the other server is DASH."""
    if not isinstance(servers, list):
        return None
    for server in servers:
        if not isinstance(server, dict):
            continue
        src = str(server.get("src", ""))
        if str(server.get("name", "")).lower() == "vidstreaming" and src.startswith("https://"):
            return src
    return None


def year_of(date: object) -> int | None:
    return int(str(date)[:4]) if isinstance(date, str) and str(date)[:4].isdigit() else None


class KaaSource:
    name = "kaa"
    # Soft subtitles, and every dub as an audio track of the same stream.
    traits = Traits(hard_sub_lang=None, dub_audio_lang=None)

    def __init__(self, client: httpx.AsyncClient | None = None, base: str = BASE) -> None:
        self._base = base.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        self._slugs: TTLCache[int, str | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._misses: TTLCache[int, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._episodes: TTLCache[str, EpisodeList | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._recent: TTLCache[tuple, object] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._flights: SingleFlight[tuple, object] = SingleFlight()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _json(self, method: str, path: str, **kwargs) -> dict | None:
        response = await self._client.request(method, f"{self._base}{path}", **kwargs)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else None

    async def _search(self, query: str) -> list[dict]:
        data = await self._json("POST", "/api/fsearch", json={"query": query})
        found = data.get("result") if data else None
        return [r for r in found if isinstance(r, dict)] if isinstance(found, list) else []

    async def _show(self, anime: dict) -> str | None:
        """The site's slug for this MAL entry, or None when the site doesn't have it."""
        key = anime["id"]
        if key in self._slugs:
            return self._slugs[key]
        if key in self._misses:
            return None
        slug = cast(str | None, await self._flights.run(("show", key), lambda: self._match(anime)))
        if slug is None:
            self._misses[key] = None
        else:
            self._slugs[key] = slug
        return slug

    async def _match(self, anime: dict) -> str | None:
        results: dict[str, dict] = {}
        # The queries are independent: ask for them together.
        for hits in await asyncio.gather(*(self._search(q) for q in search_queries(anime))):
            for result in hits:
                if isinstance(result.get("slug"), str):
                    results.setdefault(result["slug"], result)
        in_season = same_season(anime)
        year = year_of(anime.get("start_date"))

        def usable(result: dict) -> bool:
            seen = result.get("year")
            if year is not None and isinstance(seen, int) and abs(seen - year) > YEAR_SLACK:
                return False
            return any(in_season(normalize(name)) for name in _names(result))

        pool = {slug: r for slug, r in results.items() if usable(r)}
        found = match(
            anime,
            lambda _query: [Candidate(slug, _name(r)) for slug, r in pool.items()],
            lambda slug: _alternatives(pool[slug]),
        )
        return found.identifier if found else None

    async def _page(self, slug: str, episode: int) -> dict | None:
        """The page of the show's episode list that holds `episode`."""
        return await self._json(
            "GET", f"/api/show/{slug}/episodes", params={"ep": episode, "lang": ORIGINAL_LOCALE}
        )

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        # Dubs are audio tracks of the one stream, not separate listings.
        if lang == "dub":
            return None
        slug = await self._show(anime)
        if slug is None:
            return None
        if slug in self._episodes:
            return self._episodes[slug]
        if ("episodes", slug) in self._recent:
            return cast(EpisodeList | None, self._recent[("episodes", slug)])
        page = await self._page(slug, 1)
        numbers = _episode_numbers(page)
        found = EpisodeList(numbers, anime["title"]) if numbers else None
        known = anime.get("num_episodes") or 0
        # A finished show's list stays; one that may still gain episodes is checked again soon.
        if found is not None and known and len(numbers) >= known:
            self._episodes[slug] = found
        else:
            self._recent[("episodes", slug)] = found
        return found

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        if lang == "dub":
            return None
        slug = await self._show(anime)
        if slug is None:
            return None
        key = (slug, episode)
        if key in self._streams:
            return self._streams[key]
        if ("stream", *key) in self._recent:
            return cast(Stream | None, self._recent[("stream", *key)])
        found = cast(
            Stream | None,
            await self._flights.run(("stream", *key), lambda: self._resolve(slug, episode)),
        )
        if found is None:
            self._recent[("stream", *key)] = None
        else:
            self._streams[key] = found
        return found

    async def _resolve(self, slug: str, episode: int) -> Stream | None:
        page = await self._page(slug, episode)
        entry = next(
            (
                e
                for e in (page or {}).get("result", [])
                if isinstance(e, dict) and e.get("episode_number") == episode
            ),
            None,
        )
        if entry is None or not isinstance(entry.get("slug"), str):
            return None
        detail = await self._json("GET", f"/api/show/{slug}/episode/ep-{episode}-{entry['slug']}")
        player_url = pick_server((detail or {}).get("servers"))
        if player_url is None:
            return None
        response = await self._client.get(player_url, headers={"Referer": f"{self._base}/"})
        if response.status_code >= 400:
            return None
        props = parse_player(response.text)
        manifest = props.get("manifest") if props else None
        if not isinstance(manifest, str) or not manifest.startswith("https://"):
            return None
        return Stream(
            url=manifest,
            kind="hls",
            # Read from the master when playback checks it, so it is fetched only once.
            resolution=None,
            upstream_headers={"Referer": PLAYER_REFERER},
            subtitles=parse_subtitles(props.get("subtitles") if props else None),
        )


def _name(result: dict) -> str:
    return str(result.get("title") or result.get("title_en") or "")


def _names(result: dict) -> list[str]:
    return [n for n in (result.get("title"), result.get("title_en")) if isinstance(n, str) and n]


def _alternatives(result: dict) -> list[str]:
    other = result.get("title_en")
    return [other] if isinstance(other, str) and other else []


def _episode_numbers(page: dict | None) -> list[int]:
    numbers: set[int] = set()
    for chunk in (page or {}).get("pages", []):
        if isinstance(chunk, dict) and isinstance(chunk.get("eps"), list):
            numbers.update(n for n in chunk["eps"] if isinstance(n, int) and n > 0)
    return sorted(numbers)
