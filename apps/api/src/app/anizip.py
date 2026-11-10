"""Episode stills, episode titles and wide title art from ani.zip, keyed by MyAnimeList id.

ani.zip maps MAL ids to TheTVDB and serves its art. Best effort: any failure gives no art, and
answers are cached in memory per title.
"""

import asyncio
import io
import logging
from dataclasses import dataclass, field, replace
from typing import Literal

import httpx
from cachetools import TLRUCache
from PIL import Image

from app.sharedcache import SharedCache
from app.singleflight import SingleFlight

log = logging.getLogger(__name__)

API = "https://api.ani.zip/mappings"
TIMEOUT = 5.0
FOUND_TTL = 86400
MISS_TTL = 6 * 3600
ERROR_TTL = 300
# Shared cache namespace. Answers stored before wide art was checked live under the old name.
CACHE = "anizip-art"
# How long this process trusts an answer another worker stored; its own ttl lives in Redis.
SHARED_LOCAL_TTL = 600
# Wide art is looked at once, before it is cached, and only when it comes from here.
ART_HOST = "https://artworks.thetvdb.com/"
ART_TIMEOUT = 4.0
ART_MAX_BYTES = 8 * 1024 * 1024
# Refuses decompression bombs before the pixels are decoded.
ART_MAX_PIXELS = 40_000_000
# The picture is shrunk to this size and the outer ring of that is read.
SAMPLE = (64, 36)
RING = 3
# A pixel this light on every channel, or see-through, counts as blank.
BLANK_LEVEL = 232
BLANK_ALPHA = 32
# Art whose ring is blank this far is a cut-out on white: a bright hole in the dark page.
BLANK_RING_SHARE = 0.6
# Title languages tried in order for each site language: the romanized Japanese one is last.
TITLE_LANGS: dict[str, tuple[str, ...]] = {"pt": ("pt", "en", "x-jat"), "en": ("en", "x-jat")}


@dataclass(frozen=True)
class EpisodeArt:
    # Episode title per language code, as ani.zip names them ("en", "pt", "x-jat", ...).
    titles: dict[str, str] = field(default_factory=dict)
    image: str | None = None

    def title(self, lang: Literal["en", "pt"]) -> str | None:
        return next((self.titles[code] for code in TITLE_LANGS[lang] if code in self.titles), None)


@dataclass(frozen=True)
class TitleArt:
    # A wide picture of the show: TheTVDB's fanart, else its banner.
    backdrop: str | None = None
    episodes: dict[int, EpisodeArt] = field(default_factory=dict)


NO_ART = TitleArt()


def to_json(art: TitleArt) -> dict:
    return {
        "backdrop": art.backdrop,
        "episodes": {
            str(n): {"titles": e.titles, "image": e.image} for n, e in art.episodes.items()
        },
    }


def from_json(data: dict) -> TitleArt:
    return TitleArt(
        backdrop=data.get("backdrop"),
        episodes={
            int(n): EpisodeArt(titles=e.get("titles") or {}, image=e.get("image"))
            for n, e in (data.get("episodes") or {}).items()
        },
    )


def _link(value: object) -> str | None:
    return value if isinstance(value, str) and value.startswith("https://") else None


def parse(body: dict) -> TitleArt:
    """The art in an ani.zip answer. Specials ("S1", ...) are left out: sources number regular
    episodes only."""
    covers = {
        c.get("coverType"): _link(c.get("url"))
        for c in body.get("images") or []
        if isinstance(c, dict)
    }
    episodes: dict[int, EpisodeArt] = {}
    raw = body.get("episodes")
    for key, item in raw.items() if isinstance(raw, dict) else []:
        if not key.isdigit() or not isinstance(item, dict):
            continue
        names = item.get("title")
        if not isinstance(names, dict):
            names = {}
        # ani.zip writes apostrophes as backticks ("She`d").
        titles = {
            code: text.strip().replace("`", "\u2019")
            for code, text in names.items()
            if isinstance(text, str) and text.strip()
        }
        art = EpisodeArt(titles=titles, image=_link(item.get("image")))
        if art.titles or art.image:
            episodes[int(key)] = art
    return TitleArt(backdrop=covers.get("Fanart") or covers.get("Banner"), episodes=episodes)


def on_blank_background(data: bytes) -> bool:
    """Whether a picture is drawn on white or on nothing, judged by its outer ring."""
    image = Image.open(io.BytesIO(data))
    if image.width * image.height > ART_MAX_PIXELS:
        return False
    image.draft("RGB", (SAMPLE[0] * 4, SAMPLE[1] * 4))  # decodes a large JPEG at a fraction
    width, height = SAMPLE
    pixels = image.convert("RGBA").resize(SAMPLE).tobytes()
    ring = blank = 0
    for y in range(height):
        for x in range(width):
            if RING <= x < width - RING and RING <= y < height - RING:
                continue
            r, g, b, a = pixels[(y * width + x) * 4 : (y * width + x) * 4 + 4]
            ring += 1
            blank += a < BLANK_ALPHA or min(r, g, b) >= BLANK_LEVEL
    return blank / ring >= BLANK_RING_SHARE


class AniZip:
    def __init__(self, http: httpx.AsyncClient, shared: SharedCache | None = None) -> None:
        self._http = http
        self._shared = shared or SharedCache()
        self._flights: SingleFlight[int, TitleArt] = SingleFlight()
        # Values are (art, ttl).
        self._cache: TLRUCache[int, tuple[TitleArt, float]] = TLRUCache(
            maxsize=4096, ttu=lambda _key, value, now: now + value[1]
        )

    async def art(self, mal_id: int) -> TitleArt:
        if (hit := self._cache.get(mal_id)) is not None:
            return hit[0]
        return await self._flights.run(mal_id, lambda: self._fetch(mal_id))

    async def _usable_backdrop(self, url: str | None) -> str | None:
        """The wide picture, unless it sits on a blank background. A failed look keeps it."""
        if url is None or not url.startswith(ART_HOST):
            return url
        try:
            data = bytearray()
            async with self._http.stream("GET", url, timeout=ART_TIMEOUT) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    data += chunk
                    if len(data) > ART_MAX_BYTES:
                        return url
            blank = await asyncio.to_thread(on_blank_background, bytes(data))
        except Exception as exc:  # best effort: unreadable art is shown as before
            log.info("Wide art %s not checked: %s", url, exc)
            return url
        return None if blank else url

    async def _fetch(self, mal_id: int) -> TitleArt:
        if (shared := await self._shared.get(CACHE, mal_id)) is not None:
            art = from_json(shared)
            self._cache[mal_id] = (art, SHARED_LOCAL_TTL)
            return art
        try:
            response = await self._http.get(API, params={"mal_id": mal_id}, timeout=TIMEOUT)
            if response.status_code == 404:  # a title ani.zip doesn't map
                self._cache[mal_id] = (NO_ART, MISS_TTL)
                await self._shared.set(CACHE, mal_id, to_json(NO_ART), MISS_TTL)
                return NO_ART
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, dict):
                raise ValueError("answer is not an object")
            art = parse(body)
            art = replace(art, backdrop=await self._usable_backdrop(art.backdrop))
        except Exception as exc:  # best effort: never let a lookup failure break the page
            log.warning("ani.zip for MAL %s unavailable: %s", mal_id, exc)
            self._cache[mal_id] = (NO_ART, ERROR_TTL)
            return NO_ART
        found = art.backdrop is not None or bool(art.episodes)
        ttl = FOUND_TTL if found else MISS_TTL
        self._cache[mal_id] = (art, ttl)
        await self._shared.set(CACHE, mal_id, to_json(art), ttl)
        return art
