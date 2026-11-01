"""Episode stills, episode titles and wide title art from ani.zip, keyed by MyAnimeList id.

ani.zip maps MAL ids to TheTVDB and serves its art. Best effort: any failure gives no art, and
answers are cached in memory per title.
"""

import logging
from dataclasses import dataclass, field
from typing import Literal

import httpx
from cachetools import TLRUCache

from app.singleflight import SingleFlight

log = logging.getLogger(__name__)

API = "https://api.ani.zip/mappings"
TIMEOUT = 5.0
FOUND_TTL = 86400
MISS_TTL = 6 * 3600
ERROR_TTL = 300
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


class AniZip:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._flights: SingleFlight[int, TitleArt] = SingleFlight()
        # Values are (art, ttl).
        self._cache: TLRUCache[int, tuple[TitleArt, float]] = TLRUCache(
            maxsize=4096, ttu=lambda _key, value, now: now + value[1]
        )

    async def art(self, mal_id: int) -> TitleArt:
        if (hit := self._cache.get(mal_id)) is not None:
            return hit[0]
        return await self._flights.run(mal_id, lambda: self._fetch(mal_id))

    async def _fetch(self, mal_id: int) -> TitleArt:
        try:
            response = await self._http.get(API, params={"mal_id": mal_id}, timeout=TIMEOUT)
            if response.status_code == 404:  # a title ani.zip doesn't map
                self._cache[mal_id] = (NO_ART, MISS_TTL)
                return NO_ART
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, dict):
                raise ValueError("answer is not an object")
            art = parse(body)
        except Exception as exc:  # best effort: never let a lookup failure break the page
            log.warning("ani.zip for MAL %s unavailable: %s", mal_id, exc)
            self._cache[mal_id] = (NO_ART, ERROR_TTL)
            return NO_ART
        found = art.backdrop is not None or bool(art.episodes)
        self._cache[mal_id] = (art, FOUND_TTL if found else MISS_TTL)
        return art
