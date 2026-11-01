"""PRIVATE ONLY: episodes from the ZokoAnime embed player, addressed by MAL id.

Unlicensed: enable only on an invite-only deployment (VIDEO_SOURCES=zoko).
Same chain as ani-cli's HiAnime provider, minus the title search: the embed URL is
`/stream/mal/{mal_id}/{episode}/{sub|dub}`, so no fuzzy matching is needed. The page ships
its config as `window.__P`, base64 of JSON XOR-ed with a fixed key, whose `src` is an HLS
master playlist. The playlist hosts demand the embed site as Referer.
"""

import asyncio
import base64
import json
import re
from typing import Literal, cast

import httpx
from cachetools import TTLCache

from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Skip, Stream, Subtitle

EMBED = "https://zokoanime.video"
KEY = b"otaku-embed-v1"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
BLOB = re.compile(r'window\.__P="([^"]*)"')
RESOLUTION = re.compile(r"RESOLUTION=\d+x(\d+)")
CACHE_TTL = 1800
# A page that is not there yet may appear soon (a just-aired episode), so misses expire sooner.
MISS_TTL = 120
# Upper bound when MAL doesn't know the episode count (long-running shows).
MAX_EPISODES = 2000
# Embed pages fetched at once while counting episodes.
PROBE_WIDTH = 8


# The embed tags every track "en" in `lang`; the label is the only reliable hint. Labels look
# like "English" or "Portuguese (Portuguese - Brazilian [Full])": the first word names it.
LABEL_LANGS = {
    "english": "en",
    "portuguese": "pt",
    "spanish": "es",
    "french": "fr",
    "german": "de",
    "italian": "it",
    "arabic": "ar",
    "russian": "ru",
    "indonesian": "id",
    "japanese": "ja",
    "korean": "ko",
    "chinese": "zh",
    "dutch": "nl",
    "danish": "da",
    "finnish": "fi",
    "norwegian": "no",
    "polish": "pl",
    "swedish": "sv",
    "turkish": "tr",
}
WORD = re.compile(r"[a-z]+")
SKIP_KINDS: tuple[Literal["intro", "outro"], ...] = ("intro", "outro")


def label_lang(label: str) -> str:
    words = WORD.findall(label.lower())
    lang = LABEL_LANGS.get(words[0], "und") if words else "und"
    # A bare "Portuguese" is the Brazilian track on these sites; Portugal's is spelled out.
    if lang == "pt" and (len(words) == 1 or {"brazilian", "brazil", "brasil"} & set(words)):
        return "pt-BR"
    return lang


def parse_subtitles(raw: object) -> tuple[Subtitle, ...]:
    if not isinstance(raw, list):
        return ()
    tracks = []
    for item in raw:
        if not isinstance(item, dict) or not str(item.get("src", "")).startswith("https://"):
            continue
        label = str(item.get("label") or item.get("lang") or "")
        tracks.append(Subtitle(lang=label_lang(label), label=label, url=item["src"]))
    return tuple(tracks)


def _seconds(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) and value >= 0 else None


def parse_skips(skip: object, chapters: object) -> tuple[Skip, ...]:
    """Intro/outro times from `skip` ({"intro": {"start", "end"}}), else from chapters
    titled like an opening or ending."""
    found: dict[str, Skip] = {}

    def add(kind: Literal["intro", "outro"], part: dict) -> None:
        start, end = _seconds(part.get("start")), _seconds(part.get("end"))
        if kind not in found and start is not None and end is not None and end > start:
            found[kind] = Skip(kind=kind, start=start, end=end)

    if isinstance(skip, dict):
        for kind in SKIP_KINDS:
            if isinstance(part := skip.get(kind), dict):
                add(kind, part)
    for chapter in chapters if isinstance(chapters, list) else []:
        if not isinstance(chapter, dict):
            continue
        words = set(WORD.findall(str(chapter.get("title") or chapter.get("name") or "").lower()))
        if words & {"intro", "opening", "op"}:
            add("intro", chapter)
        elif words & {"outro", "ending", "ed", "credits"}:
            add("outro", chapter)
    return tuple(found[k] for k in SKIP_KINDS if k in found)


def decode_blob(blob: str) -> dict | None:
    try:
        raw = base64.b64decode(blob)
        text = bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(raw))
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


class ZokoSource:
    name = "zoko"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=15.0
        )
        # Every embed page read, misses included, so probing and playback share the work.
        self._configs: TTLCache[tuple, dict | None] = TTLCache(maxsize=16384, ttl=CACHE_TTL)
        self._misses: TTLCache[tuple, None] = TTLCache(maxsize=16384, ttl=MISS_TTL)
        # Concurrent callers (a title page, a fallback) share one request.
        self._flights: SingleFlight[tuple, dict | None] = SingleFlight()
        self._streams: TTLCache[tuple, Stream | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        self._episodes: TTLCache[tuple, EpisodeList | None] = TTLCache(maxsize=4096, ttl=CACHE_TTL)
        # Results that may change soon (no episodes yet, a still-airing show) live here instead.
        self._recent: TTLCache[tuple, object] = TTLCache(maxsize=4096, ttl=MISS_TTL)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _config(self, mal_id: int, episode: int, lang: Lang) -> dict | None:
        key = (mal_id, episode, lang)
        if key in self._configs:
            return self._configs[key]
        if key in self._misses:
            return None
        return await self._flights.run(key, lambda: self._fetch_config(key))

    async def _fetch_config(self, key: tuple) -> dict | None:
        mal_id, episode, lang = key
        response = await self._client.get(f"{EMBED}/stream/mal/{mal_id}/{episode}/{lang}")
        if response.status_code == 404:
            config = None
        else:
            response.raise_for_status()
            match = BLOB.search(response.text)
            # An unknown id or episode still answers 200, just without the config blob.
            config = decode_blob(match.group(1)) if match else None
        if config is None:
            self._misses[key] = None
        else:
            self._configs[key] = config
        return config

    async def _exists(self, mal_id: int, episode: int, lang: Lang) -> bool:
        config = await self._config(mal_id, episode, lang)
        return bool(config and config.get("src"))

    async def _probe(self, mal_id: int, lang: Lang, episodes: list[int]) -> list[bool]:
        return list(await asyncio.gather(*(self._exists(mal_id, e, lang) for e in episodes)))

    async def _last_episode(self, mal_id: int, lang: Lang, known: int) -> int:
        """Highest episode the player has. Episodes are contiguous, so search for the first
        miss, probing several points of the remaining range at once."""
        found = await self._probe(mal_id, lang, [1, known] if known > 1 else [1])
        if not found[0]:
            return 0
        if known and found[-1]:
            return known
        low, high = 1, known
        if not known:
            # Unknown length: one parallel round over powers of two brackets the end.
            powers = [2**i for i in range(1, MAX_EPISODES.bit_length() + 1)]
            found = await self._probe(mal_id, lang, powers)
            misses = [p for p, ok in zip(powers, found, strict=True) if not ok]
            high = misses[0] if misses else MAX_EPISODES + 1
            low = max([p for p in powers if p < high], default=1)
        while high - low > 1:
            step = max((high - low) // (PROBE_WIDTH + 1), 1)
            points = list(range(low + step, high, step))[:PROBE_WIDTH]
            found = await self._probe(mal_id, lang, points)
            for point, ok in zip(points, found, strict=True):
                if ok:
                    low = point
                else:
                    high = point
                    break
        return low

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        key = (anime["id"], lang)
        if key in self._episodes:
            found = self._episodes[key]
        elif ("episodes", *key) in self._recent:
            found = cast(EpisodeList | None, self._recent[("episodes", *key)])
        else:
            known = anime.get("num_episodes") or 0
            last = await self._last_episode(anime["id"], lang, known)
            found = (
                EpisodeList(episodes=list(range(1, last + 1)), source_title=anime["title"])
                if last
                else None
            )
            # A complete list stays; an empty or short one may grow when the next episode airs.
            if found is not None and known and last >= known:
                self._episodes[key] = found
            else:
                self._recent[("episodes", *key)] = found
        if found is None:
            return None
        # Art only exists for pages already read; probing and playback fill it in over time.
        thumbnails = {}
        for episode in found.episodes:
            config = self._configs.get((anime["id"], episode, lang))
            poster = config.get("poster") if config else None
            if isinstance(poster, str) and poster.startswith("https://"):
                thumbnails[episode] = poster
        return EpisodeList(found.episodes, found.source_title, thumbnails)

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        key = (anime["id"], episode, lang)
        if key in self._streams:
            return self._streams[key]
        if ("stream", *key) in self._recent:
            return cast(Stream | None, self._recent[("stream", *key)])
        config = await self._config(anime["id"], episode, lang)
        src = config.get("src") if config else None
        result = None
        if config and isinstance(src, str) and src.startswith("https://"):
            audio = config.get("default_audio")
            result = Stream(
                url=src,
                kind="hls",
                resolution=await self._top_resolution(src),
                upstream_headers={"Referer": f"{EMBED}/"},
                subtitles=parse_subtitles(config.get("subtitles")),
                skips=parse_skips(config.get("skip"), config.get("chapters")),
                default_audio=audio if isinstance(audio, str) and audio else None,
            )
        if result is None:
            self._recent[("stream", *key)] = None
        else:
            self._streams[key] = result
        return result

    async def _top_resolution(self, master: str) -> int | None:
        try:
            response = await self._client.get(master, headers={"Referer": f"{EMBED}/"})
            heights = [int(h) for h in RESOLUTION.findall(response.text)]
        except httpx.HTTPError:
            return None
        return max(heights, default=None)
