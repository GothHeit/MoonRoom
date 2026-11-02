"""PRIVATE ONLY: episodes from AniZone.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=anizone).
The site is Laravel Livewire. Its anime index searches by posting the page's component snapshot
back with the new `search` value; the answer's HTML carries the matches as JSON inside an
Alpine `x-data`. An episode page `/anime/{slug}/{n}` carries the player config the same way:
an HLS master (every audio language as a separate track, 360/720/1080), styled ASS subtitles
per language, and a chapters file. No Referer is needed.

Shows carry no MAL id: they are matched by title and start year (the site names later seasons
"Title (2026)").
"""

import asyncio
import html
import json
import re
import time
from typing import cast

import httpx
from cachetools import TTLCache

from app.ranking import base_lang
from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Stream, Subtitle, Traits
from app.sources.matching import Candidate, match, search_queries
from app.sources.zoko import parse_skips

BASE = "https://anizone.to"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
CACHE_TTL = 1800
MISS_TTL = 120
# How long the search page's session token and component snapshot are reused.
SESSION_TTL = 600
YEAR_SLACK = 1
TOKEN = re.compile(r'name="csrf-token" content="([^"]+)"')
SNAPSHOT = re.compile(r'wire:snapshot="([^"]*)"')
ITEMS = re.compile(r"JSON\.parse\('(.*?)'\)", re.S)
PLAYER = re.compile(r"vidstackPlayer\(JSON\.parse\('(.*?)'\)\)", re.S)
CUE = re.compile(r"(\d+):(\d\d):(\d\d)\.(\d+)\s+-->\s+(\d+):(\d\d):(\d\d)\.(\d+)")


def js_json(literal: str) -> object:
    """The value of a `JSON.parse('...')` call in the page: a JS string literal (\\u0022
    escapes, escaped slashes) holding JSON."""
    try:
        return json.loads(json.loads(f'"{literal}"'))
    except ValueError:
        return None


def parse_results(markup: str) -> list[dict]:
    """The shows a search answer lists."""
    found = ITEMS.search(markup)
    items = js_json(found.group(1)) if found else None
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def parse_player(page: str) -> dict | None:
    found = PLAYER.search(page)
    config = js_json(found.group(1)) if found else None
    return config if isinstance(config, dict) else None


def parse_subtitles(raw: object) -> tuple[Subtitle, ...]:
    """ASS tracks. The plain WebVTT copy is made from the same file by the stream proxy."""
    if not isinstance(raw, list):
        return ()
    tracks = []
    for item in raw:
        if not isinstance(item, dict) or not str(item.get("file", "")).startswith("https://"):
            continue
        code = str(item.get("language") or "")
        base = base_lang(code)
        lang = "pt-BR" if base == "pt" else base if base != "und" else code or "und"
        tracks.append(
            Subtitle(
                lang=lang,
                label=str(item.get("title") or code),
                url=item["file"],
                ass_url=item["file"],
            )
        )
    return tuple(tracks)


def parse_chapters(text: str) -> list[dict]:
    """{"title", "start", "end"} for each cue of a chapters WebVTT file."""
    chapters = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        cue = CUE.search(line)
        if not cue or index + 1 >= len(lines):
            continue
        g = cue.groups()
        start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 10 ** len(g[3])
        end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 10 ** len(g[7])
        chapters.append({"title": lines[index + 1].strip(), "start": start, "end": end})
    return chapters


def names_of(item: dict) -> list[str]:
    titles = item.get("title_list")
    found = [t for t in titles.values() if isinstance(t, str)] if isinstance(titles, dict) else []
    main = item.get("main_title")
    return ([main] if isinstance(main, str) else []) + found


def year_of(date: object) -> int | None:
    return int(str(date)[:4]) if isinstance(date, str) and str(date)[:4].isdigit() else None


class AniZoneSource:
    name = "anizone"
    # Soft ASS subtitles, and every dub as an audio track of the same stream.
    traits = Traits(hard_sub_lang=None, dub_audio_lang=None)

    def __init__(self, client: httpx.AsyncClient | None = None, base: str = BASE) -> None:
        self._base = base.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        self._session: tuple[float, str, str] | None = None
        self._shows: TTLCache[int, dict | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._misses: TTLCache[int, None] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._recent: TTLCache[tuple, object] = TTLCache(maxsize=4096, ttl=MISS_TTL)
        self._episodes: TTLCache[str, EpisodeList] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._flights: SingleFlight[tuple, object] = SingleFlight()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _livewire(self) -> tuple[str, str]:
        """The session token and the index component's snapshot to post searches against."""
        if self._session and time.monotonic() - self._session[0] < SESSION_TTL:
            return self._session[1], self._session[2]
        response = await self._client.get(f"{self._base}/anime")
        response.raise_for_status()
        token = TOKEN.search(response.text)
        snapshot = next(
            (
                s
                for raw in SNAPSHOT.findall(response.text)
                if '"search"' in (s := html.unescape(raw)) and '"sort"' in s
            ),
            None,
        )
        if token is None or snapshot is None:
            raise httpx.HTTPError("AniZone's search page has changed")
        self._session = (time.monotonic(), token.group(1), snapshot)
        return token.group(1), snapshot

    async def _search(self, query: str) -> list[dict]:
        for attempt in range(2):
            token, snapshot = await self._livewire()
            response = await self._client.post(
                f"{self._base}/livewire/update",
                json={
                    "_token": token,
                    "components": [
                        {"snapshot": snapshot, "updates": {"search": query}, "calls": []}
                    ],
                },
                headers={"X-Livewire": "", "Referer": f"{self._base}/anime"},
            )
            # An expired session or snapshot: start over once with a fresh page.
            if response.status_code in (419, 422) and attempt == 0:
                self._session = None
                continue
            response.raise_for_status()
            data = response.json()
            components = data.get("components") if isinstance(data, dict) else None
            effects = components[0].get("effects") if components else None
            markup = effects.get("html") if isinstance(effects, dict) else None
            return parse_results(markup) if isinstance(markup, str) else []
        return []

    async def _show(self, anime: dict) -> dict | None:
        key = anime["id"]
        if key in self._shows:
            return self._shows[key]
        if key in self._misses:
            return None
        show = cast(dict | None, await self._flights.run(("show", key), lambda: self._match(anime)))
        if show is None:
            self._misses[key] = None
        else:
            self._shows[key] = show
        return show

    async def _match(self, anime: dict) -> dict | None:
        found: dict[str, dict] = {}
        # One session for all the queries, then the queries together.
        await self._livewire()
        queries = search_queries(anime)
        for items in await asyncio.gather(*(self._search(q) for q in queries)):
            for item in items:
                if isinstance(item.get("slug"), str):
                    found.setdefault(item["slug"], item)
        year = year_of(anime.get("start_date"))
        pool = list(found.values())
        if year is not None:
            near = [
                i
                for i in pool
                if isinstance(i.get("start_year"), int)
                and abs(i["start_year"] - year) <= YEAR_SLACK
            ]
            # The right year wins outright; only without one are the neighbouring years looked at.
            exact = [i for i in near if i["start_year"] == year]
            pool = exact or near
        by_slug = {i["slug"]: i for i in pool}
        best = match(
            anime,
            lambda _query: [
                Candidate(slug, i.get("main_title") or "") for slug, i in by_slug.items()
            ],
            lambda slug: names_of(by_slug[slug]),
        )
        return by_slug[best.identifier] if best else None

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        # Dubs are audio tracks of the one stream, not separate listings.
        if lang == "dub":
            return None
        show = await self._show(anime)
        if show is None:
            return None
        slug = show["slug"]
        if slug in self._episodes:
            return self._episodes[slug]
        count = show.get("episode_count")
        if not isinstance(count, int) or count < 1:
            return None
        found = EpisodeList(list(range(1, count + 1)), anime["title"])
        known = anime.get("num_episodes") or 0
        if known and count >= known and not show.get("is_ongoing"):
            self._episodes[slug] = found
        return found

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        if lang == "dub":
            return None
        show = await self._show(anime)
        if show is None:
            return None
        key = (show["slug"], episode)
        if key in self._streams:
            return self._streams[key]
        if ("stream", *key) in self._recent:
            return cast(Stream | None, self._recent[("stream", *key)])
        found = cast(
            Stream | None,
            await self._flights.run(("stream", *key), lambda: self._resolve(*key)),
        )
        if found is None:
            self._recent[("stream", *key)] = None
        else:
            self._streams[key] = found
        return found

    async def _resolve(self, slug: str, episode: int) -> Stream | None:
        response = await self._client.get(f"{self._base}/anime/{slug}/{episode}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        config = parse_player(response.text)
        src = config.get("src") if config else None
        if config is None or not isinstance(src, str) or not src.startswith("https://"):
            return None
        chapters_url = config.get("chapter")
        chapters: list[dict] = []
        if isinstance(chapters_url, str) and chapters_url.startswith("https://"):
            try:
                reply = await self._client.get(chapters_url)
                chapters = parse_chapters(reply.text) if reply.status_code == 200 else []
            except httpx.HTTPError:
                chapters = []
        return Stream(
            url=src,
            kind="hls",
            # Read from the master when playback checks it, so it is fetched only once.
            resolution=None,
            upstream_headers={},
            subtitles=parse_subtitles(config.get("subtitles")),
            skips=parse_skips(None, chapters),
        )
