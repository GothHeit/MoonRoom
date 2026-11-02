"""PRIVATE ONLY: episodes from AnimeStream (anime.uniquestream.net).

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=uniquestream).
The site's JSON API (no key, no login; it wants the site as Referer and Origin):

    GET /api/v1/search?page=1&query=...                  -> {"series": [{"content_id", "title"}]}
    GET /api/v1/series/{id}                              -> {"seasons": [{"content_id",
                                                            "season_number", "episode_count",
                                                            "mal_id"}]}
    GET /api/v1/season/{id}/episodes?page=N              -> 5 episodes per page, empty past the end
    GET /api/v1/episode/{id}/media/dash/{locale}         -> {"hls": {"playlist", "subtitles"}}

Every audio language is its own locale with its own signed HLS master, so the original audio is
the "ja-JP" copy and the Portuguese dub the "pt-BR" one (English when an episode lacks it). The
subtitles are separate WebVTT files, all soft. The variants are AES-128 encrypted with a key
served next to them, and every child URL carries its own signature; the HLS proxy rewrites key
and segment links like any other, so nothing here needs to know about them.

Seasons carry the MAL id when the site knows it; otherwise a season is told apart by its number,
and only accepted when its episode count agrees with MAL's.

Reachable from a home connection only: datacenter addresses are refused by the media host.
"""

import asyncio
import math
from typing import cast

import httpx
from cachetools import TTLCache

from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Stream, Subtitle, Traits
from app.sources.matching import SEASON, Candidate, match, normalize, search_queries

BASE = "https://anime.uniquestream.net"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ORIGINAL_LOCALE = "ja-JP"
# Dub locales in order of preference; the first one an episode has is its "dub".
DUB_LOCALES = ("pt-BR", "en-US")
PAGE_SIZE = 5
# Safety bound on pages fetched for one season (a 1000-episode show is 200 pages).
MAX_PAGES = 200
CACHE_TTL = 1800
# Misses expire sooner: a just-aired episode or a show that is added a little later.
MISS_TTL = 120
# Candidate series examined for one entry when several share the same title.
MAX_CANDIDATES = 4

# Subtitle locale -> name shown in the player menu.
LABELS = {
    "ar-SA": "Arabic",
    "de-DE": "German",
    "en-US": "English",
    "es-419": "Spanish (Latin America)",
    "es-ES": "Spanish (Spain)",
    "fr-FR": "French",
    "hi-IN": "Hindi",
    "id-ID": "Indonesian",
    "it-IT": "Italian",
    "ms-MY": "Malay",
    "pl-PL": "Polish",
    "pt-BR": "Portuguese (Brazil)",
    "ru-RU": "Russian",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
    "th-TH": "Thai",
    "vi-VN": "Vietnamese",
    "zh-CN": "Chinese (Simplified)",
    "zh-HK": "Chinese (Traditional)",
}


def parse_subtitles(raw: object) -> tuple[Subtitle, ...]:
    if not isinstance(raw, list):
        return ()
    tracks = []
    for item in raw:
        if not isinstance(item, dict) or not str(item.get("url", "")).startswith("https://"):
            continue
        code = str(item.get("language") or "")
        if code:
            tracks.append(Subtitle(lang=code, label=LABELS.get(code, code), url=item["url"]))
    return tuple(sorted(tracks, key=lambda t: t.label))


def whole(value: object) -> int | None:
    """An episode number as a positive int; None for fractions (recaps, 12.5) and junk."""
    if isinstance(value, int | float) and value > 0 and float(value).is_integer():
        return int(value)
    return None


def season_mal_id(season: dict) -> int | None:
    # The API sends the id as text, and the text "None" when it has none.
    value = str(season.get("mal_id") or "")
    return int(value) if value.isdigit() else None


def wanted_season(anime: dict) -> int:
    """The season number a MAL title asks for: "X 2nd Season" is 2, a plain title is 1."""
    found = SEASON.search(anime.get("title") or "")
    number = next((n for n in found.groups() if n), None) if found else None
    return int(number) if number else 1


def pick_season(anime: dict, seasons: object) -> dict | None:
    """The season of one series that is this MAL entry."""
    if not isinstance(seasons, list):
        return None
    usable = [s for s in seasons if isinstance(s, dict) and isinstance(s.get("content_id"), str)]
    for season in usable:
        if season_mal_id(season) == anime["id"]:
            return season
    # No exact id: a season the site hasn't tagged, by its number, if the episodes add up.
    number = wanted_season(anime)
    known = anime.get("num_episodes") or 0
    for season in usable:
        if season_mal_id(season) is not None or season.get("season_number") != number:
            continue
        count = season.get("episode_count")
        if known and isinstance(count, int) and count != known:
            continue
        return season
    return None


class UniqueStreamSource:
    name = "uniquestream"
    # Soft subtitles; the dub is a separate copy in the viewer's language.
    traits = Traits(hard_sub_lang=None, dub_audio_lang="pt")

    def __init__(self, client: httpx.AsyncClient | None = None, base: str = BASE) -> None:
        self._base = base.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={
                "User-Agent": USER_AGENT,
                "Referer": f"{BASE}/",
                "Origin": BASE,
                "Accept": "application/json",
            },
            follow_redirects=True,
            timeout=15.0,
        )
        self._seasons: TTLCache[int, str | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._misses: TTLCache[int, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._listings: TTLCache[str, dict[int, dict]] = TTLCache(maxsize=1024, ttl=CACHE_TTL)
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._recent: TTLCache[tuple, object] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._flights: SingleFlight[tuple, object] = SingleFlight()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _json(self, path: str, **params: str | int) -> object | None:
        response = await self._client.get(f"{self._base}/api/v1{path}", params=params or None)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    async def _search(self, query: str) -> list[dict]:
        data = await self._json("/search", page=1, query=query)
        found = data.get("series") if isinstance(data, dict) else None
        return [r for r in found if isinstance(r, dict)] if isinstance(found, list) else []

    async def _season(self, anime: dict) -> str | None:
        """The site's season id for this MAL entry, or None when the site doesn't have it."""
        key = anime["id"]
        if key in self._seasons:
            return self._seasons[key]
        if key in self._misses:
            return None
        found = cast(
            str | None, await self._flights.run(("season", key), lambda: self._find(anime))
        )
        if found is None:
            self._misses[key] = None
        else:
            self._seasons[key] = found
        return found

    async def _find(self, anime: dict) -> str | None:
        results: dict[str, dict] = {}
        # The queries are independent: ask for them together.
        for hits in await asyncio.gather(*(self._search(q) for q in search_queries(anime))):
            for result in hits:
                if isinstance(result.get("content_id"), str) and isinstance(
                    result.get("title"), str
                ):
                    results.setdefault(result["content_id"], result)
        best = match(
            anime,
            lambda _query: [Candidate(k, str(r["title"])) for k, r in results.items()],
            lambda _id: [],
        )
        if best is None:
            return None
        # Catalogs can list one title twice (other sub languages); the first with the season wins.
        twins = [
            k
            for k, r in results.items()
            if k == best.identifier or normalize(str(r["title"])) == normalize(best.name)
        ]
        twins.sort(key=lambda k: k != best.identifier)
        for series_id in twins[:MAX_CANDIDATES]:
            series = await self._json(f"/series/{series_id}")
            season = pick_season(anime, series.get("seasons") if isinstance(series, dict) else None)
            if season is not None:
                return cast(str, season["content_id"])
        return None

    async def _fetch_listing(self, season: str, count: int) -> dict[int, dict]:
        """Episode number -> the site's entry, for a whole season (five episodes per page)."""
        if count:
            pages = min(math.ceil(count / PAGE_SIZE), MAX_PAGES)
            chunks = await asyncio.gather(
                *(self._json(f"/season/{season}/episodes", page=n) for n in range(1, pages + 1))
            )
        else:
            # Length unknown (still airing): walk the pages until one comes back empty.
            chunks = []
            for page in range(1, MAX_PAGES + 1):
                chunk = await self._json(f"/season/{season}/episodes", page=page)
                if not isinstance(chunk, list) or not chunk:
                    break
                chunks.append(chunk)
        entries: dict[int, dict] = {}
        for chunk in chunks:
            for entry in chunk if isinstance(chunk, list) else []:
                number = whole(entry.get("episode_number")) if isinstance(entry, dict) else None
                if (
                    number is not None
                    and not entry.get("is_clip")
                    and isinstance(entry.get("content_id"), str)
                ):
                    entries.setdefault(number, entry)
        return entries

    async def _entries(self, anime: dict) -> dict[int, dict]:
        """Episode number -> entry for this MAL entry's season; empty when the site lacks it."""
        season = await self._season(anime)
        if season is None:
            return {}
        if season in self._listings:
            return self._listings[season]
        if ("listing", season) in self._recent:
            return cast(dict[int, dict], self._recent[("listing", season)])
        count = cast(int, anime.get("num_episodes") or 0)
        entries = cast(
            dict[int, dict],
            await self._flights.run(
                ("listing", season), lambda: self._fetch_listing(season, count)
            ),
        )
        # A finished season's list stays; one that may still gain episodes is checked again soon.
        if count and len(entries) >= count:
            self._listings[season] = entries
        else:
            self._recent[("listing", season)] = entries
        return entries

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        entries = await self._entries(anime)
        if lang == "dub":
            entries = {n: e for n, e in entries.items() if dub_locale(e) is not None}
        if not entries:
            return None
        thumbnails = {
            n: e["image"]
            for n, e in entries.items()
            if isinstance(e.get("image"), str) and e["image"].startswith("https://")
        }
        return EpisodeList(sorted(entries), anime["title"], thumbnails)

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        key = (anime["id"], episode, lang)
        if key in self._streams:
            return self._streams[key]
        if ("stream", *key) in self._recent:
            return cast(Stream | None, self._recent[("stream", *key)])
        entry = (await self._entries(anime)).get(episode)
        locale = None
        if entry is not None:
            locale = ORIGINAL_LOCALE if lang == "sub" else dub_locale(entry)
        found = None
        if entry is not None and locale is not None:
            found = cast(
                Stream | None,
                await self._flights.run(
                    ("stream", entry["content_id"], locale),
                    lambda: self._resolve(entry["content_id"], locale),
                ),
            )
        if found is None:
            self._recent[("stream", *key)] = None
        else:
            self._streams[key] = found
        return found

    async def _resolve(self, episode_id: str, locale: str) -> Stream | None:
        data = await self._json(f"/episode/{episode_id}/media/dash/{locale}")
        hls = data.get("hls") if isinstance(data, dict) else None
        if not isinstance(hls, dict):
            return None
        playlist = hls.get("playlist")
        if not isinstance(playlist, str) or not playlist.startswith("https://"):
            return None
        return Stream(
            url=playlist,
            kind="hls",
            # Read from the master when playback checks it, so it is fetched only once.
            resolution=None,
            upstream_headers={"Referer": f"{BASE}/"},
            subtitles=parse_subtitles(hls.get("subtitles")),
            # The dub is Portuguese or, for an episode without one, English: say which.
            dub_audio_lang=locale.split("-")[0] if locale != ORIGINAL_LOCALE else None,
        )


def dub_locale(entry: dict) -> str | None:
    """The dub an episode offers: Portuguese when it has it, else English."""
    have = entry.get("audio_locales")
    if not isinstance(have, list):
        return None
    return next((loc for loc in DUB_LOCALES if loc in have), None)
