"""MyAnimeList API client.

Every response is status-checked: a bad client ID, a rate limit or an outage becomes a
clear `mal_unavailable` error instead of a KeyError on an error body.
"""

import asyncio
import logging
from datetime import date
from typing import Any

import httpx
from cachetools import TTLCache
from rapidfuzz import fuzz

from app.errors import ApiError
from app.sharedcache import SharedCache
from app.singleflight import SingleFlight

API_BASE = "https://api.myanimelist.net/v2"
log = logging.getLogger(__name__)
RETRIES = 1  # one quick retry for MAL hiccups
_RETRY_STATUSES = {429, 500, 502, 503, 504}

LIST_FIELDS = (
    "alternative_titles,main_picture,mean,media_type,num_episodes,start_season,rating,"
    "genres,num_list_users"
)
DETAIL_FIELDS = (
    "title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,rank,popularity,"
    "num_list_users,num_scoring_users,nsfw,media_type,status,genres,num_episodes,start_season,"
    "broadcast,source,average_episode_duration,rating,pictures,background,related_anime,"
    "recommendations,studios,statistics"
)

MANGA_LIST_FIELDS = (
    "alternative_titles,main_picture,mean,media_type,num_chapters,num_volumes,status,"
    "start_date,genres,num_list_users"
)
MANGA_DETAIL_FIELDS = (
    "title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,rank,popularity,"
    "num_list_users,num_scoring_users,nsfw,media_type,status,genres,num_volumes,num_chapters,"
    "authors{first_name,last_name},pictures,background,related_manga,recommendations,"
    "serialization{name}"
)
# What MAL calls its manga rankings, by the row the app shows them in.
MANGA_RANKINGS = {
    "top": "manga",
    "popular": "bypopularity",
    "manhwa": "manhwa",
    "manhua": "manhua",
    "oneshots": "oneshots",
    "favorites": "favorite",
}

LIST_TTL = 600  # seconds
DETAILS_TTL = 1800
MAX_CONCURRENT_CALLS = 8  # in-flight calls to MAL across all requests
POOL_SIZE = 500  # the most MAL returns for one season or ranking request

DEEP_POOL_PAGES = 6  # ranking pages scanned when browsing a genre without a year

_NSFW_RATINGS = {"r+", "rx"}
_NSFW_GENRES = {"ecchi", "erotica", "hentai"}
_SEASONS = ("winter", "spring", "summer", "fall")


def current_season(today: date | None = None) -> tuple[int, str]:
    today = today or date.today()
    return today.year, _SEASONS[(today.month - 1) // 3]


def is_safe(node: dict) -> bool:
    if (node.get("rating") or "") in _NSFW_RATINGS:
        return False
    genres = {g.get("name", "").lower() for g in node.get("genres") or []}
    return not genres & _NSFW_GENRES


def filter_nsfw(items: list[dict], allow_nsfw: bool) -> list[dict]:
    if allow_nsfw:
        return items
    return [i for i in items if is_safe(i.get("node") or {})]


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


def search_relevance(query: str, node: dict) -> float:
    q = _norm(query)
    alt = node.get("alternative_titles") or {}
    title = node.get("title", "")
    en = alt.get("en", "")
    if (title and _norm(title) == q) or (en and _norm(en) == q):
        return 130
    titles = [title, en, alt.get("ja", ""), *(alt.get("synonyms") or [])]
    return max((fuzz.WRatio(q, _norm(t)) for t in titles if t), default=0)


def rank_search_results(query: str, items: list[dict], limit: int = 8) -> list[dict]:
    def score(item: dict) -> float:
        node = item["node"]
        popularity = min(node.get("num_list_users", 0) / 50000, 1.0) * 10
        return search_relevance(query, node) + popularity

    return sorted(items, key=score, reverse=True)[:limit]


class MalClient:
    def __init__(
        self,
        client_id: str,
        http: httpx.AsyncClient,
        api_base: str = API_BASE,
        shared: SharedCache | None = None,
    ):
        self._shared = shared or SharedCache()
        self._api_base = api_base
        self._headers = {"X-MAL-CLIENT-ID": client_id}
        self._http = http
        # Cold-cache bursts (home, profiles) would otherwise fire dozens of calls at once and
        # get answered with 429/403.
        self._slots = asyncio.Semaphore(MAX_CONCURRENT_CALLS)
        # Keyed by anime id; manga details share the cache under ("manga", id).
        self._details: TTLCache[Any, dict] = TTLCache(maxsize=2048, ttl=DETAILS_TTL)
        # Listing pages (seasonal, top, search, browse pools) change slowly: a short TTL keeps
        # the home page from hitting MAL on every load.
        self._pages: TTLCache[tuple, dict] = TTLCache(maxsize=512, ttl=LIST_TTL)
        # Concurrent cold callers for the same page share one call.
        self._flights: SingleFlight[tuple, dict] = SingleFlight()

    async def _get(self, path: str, params: dict[str, Any]) -> dict:
        key = (path, tuple(sorted(params.items())))
        cached = self._pages.get(key)
        if cached is not None:
            return cached

        async def load() -> dict:
            shared = await self._shared.get("mal-page", key)
            if shared is not None:
                self._pages[key] = shared
                return shared
            data = await self._fetch(path, params)
            self._pages[key] = data
            await self._shared.set("mal-page", key, data, LIST_TTL)
            return data

        return await self._flights.run(key, load)

    async def _fetch(
        self, path: str, params: dict[str, Any], not_found: str = "anime_not_found"
    ) -> dict:
        response = None
        for attempt in range(RETRIES + 1):
            try:
                async with self._slots:
                    response = await self._http.get(
                        f"{self._api_base}{path}",
                        headers=self._headers,
                        params=params,
                        timeout=15,
                    )
            except httpx.HTTPError as exc:
                log.warning("MAL %s failed (attempt %d): %r", path, attempt + 1, exc)
                if attempt == RETRIES:
                    raise ApiError(
                        502, "mal_unavailable", f"MyAnimeList request failed: {exc}"
                    ) from exc
            else:
                if response.status_code not in _RETRY_STATUSES or attempt == RETRIES:
                    break
                status = response.status_code
                log.warning("MAL %s answered %d (attempt %d)", path, status, attempt + 1)
            await asyncio.sleep(0.4 * (attempt + 1))
        assert response is not None
        if response.status_code == 404:
            raise ApiError(404, not_found, "Title not found")
        if response.status_code != 200:
            log.warning("MAL %s gave up with %d", path, response.status_code)
            raise ApiError(502, "mal_unavailable", f"MyAnimeList answered {response.status_code}")
        return response.json()

    async def seasonal(self, page: int, allow_nsfw: bool, page_size: int = 20) -> dict:
        year, season = current_season()
        data = await self._get(
            f"/anime/season/{year}/{season}",
            {
                "limit": page_size,
                "offset": (page - 1) * page_size,
                "sort": "anime_num_list_users",
                "fields": LIST_FIELDS,
                "nsfw": str(allow_nsfw).lower(),
            },
        )
        return {
            "year": year,
            "season": season,
            "data": filter_nsfw(data.get("data", []), allow_nsfw),
            "has_next": bool((data.get("paging") or {}).get("next")),
        }

    async def search(self, query: str, allow_nsfw: bool) -> dict:
        data = await self._get(
            "/anime",
            {"q": query, "limit": 20, "fields": LIST_FIELDS, "nsfw": str(allow_nsfw).lower()},
        )
        items = filter_nsfw(data.get("data", []), allow_nsfw)
        return {"data": rank_search_results(query, items)}

    async def top(self, allow_nsfw: bool, limit: int = 20) -> dict:
        data = await self._get(
            "/anime/ranking",
            {
                "ranking_type": "all",
                "limit": limit,
                "fields": LIST_FIELDS,
                "nsfw": str(allow_nsfw).lower(),
            },
        )
        return {"data": filter_nsfw(data.get("data", []), allow_nsfw)}

    async def season_pool(self, year: int, season: str, allow_nsfw: bool) -> list[dict]:
        """Up to POOL_SIZE nodes of one season, most followed first."""
        data = await self._get(
            f"/anime/season/{year}/{season}",
            {
                "limit": POOL_SIZE,
                "sort": "anime_num_list_users",
                "fields": LIST_FIELDS,
                "nsfw": str(allow_nsfw).lower(),
            },
        )
        return [i["node"] for i in filter_nsfw(data.get("data", []), allow_nsfw)]

    async def ranking_pool(
        self, allow_nsfw: bool, ranking_type: str = "all", offset: int = 0
    ) -> list[dict]:
        params: dict[str, Any] = {
            "ranking_type": ranking_type,
            "limit": POOL_SIZE,
            "fields": LIST_FIELDS,
            "nsfw": str(allow_nsfw).lower(),
        }
        if offset:
            params["offset"] = offset
        data = await self._get("/anime/ranking", params)
        return [i["node"] for i in filter_nsfw(data.get("data", []), allow_nsfw)]

    async def deep_ranking_pool(self, allow_nsfw: bool) -> list[dict]:
        """Several ranking pages by popularity. Niche genres rarely reach the top 500, so a
        genre filter needs a deeper pool to find anything. A failed page is skipped; only when
        every page fails does the error surface."""
        pages = await asyncio.gather(
            *(
                self.ranking_pool(allow_nsfw, "bypopularity", i * POOL_SIZE)
                for i in range(DEEP_POOL_PAGES)
            ),
            return_exceptions=True,
        )
        ok = [p for p in pages if not isinstance(p, BaseException)]
        if not ok:
            first = pages[0]
            assert isinstance(first, BaseException)
            raise first
        merged = {n["id"]: n for p in ok for n in p}
        return list(merged.values())

    async def browse(
        self,
        genre: int | None,
        year: int | None,
        season: str | None,
        page: int,
        allow_nsfw: bool,
        page_size: int = 24,
    ) -> tuple[list[dict], bool]:
        """Filter by genre, year and season. MAL's API can't filter by genre, so the pool for
        the chosen season (or ranking) is fetched once, cached, and filtered here."""
        if year is None:
            if genre is None:
                pool = await self.ranking_pool(allow_nsfw)
            else:
                pool = await self.deep_ranking_pool(allow_nsfw)
        else:
            seasons = [season] if season else list(_SEASONS)
            pools = await asyncio.gather(*(self.season_pool(year, s, allow_nsfw) for s in seasons))
            merged = {n["id"]: n for p in pools for n in p}
            pool = sorted(merged.values(), key=lambda n: n.get("num_list_users", 0), reverse=True)
        if genre is not None:
            pool = [n for n in pool if any(g.get("id") == genre for g in n.get("genres") or [])]
        start = (page - 1) * page_size
        return pool[start : start + page_size], len(pool) > start + page_size

    # Manga: the same catalog, read through MAL's /manga endpoints.

    async def manga_search(self, query: str, allow_nsfw: bool) -> list[dict]:
        data = await self._get(
            "/manga",
            {
                "q": query,
                "limit": 20,
                "fields": MANGA_LIST_FIELDS,
                "nsfw": str(allow_nsfw).lower(),
            },
        )
        items = filter_nsfw(data.get("data", []), allow_nsfw)
        return [i["node"] for i in rank_search_results(query, items, limit=20)]

    async def manga_ranking(
        self, row: str, allow_nsfw: bool, limit: int = 20, offset: int = 0
    ) -> tuple[list[dict], bool]:
        data = await self._get(
            "/manga/ranking",
            {
                "ranking_type": MANGA_RANKINGS[row],
                "limit": limit,
                "offset": offset,
                "fields": MANGA_LIST_FIELDS,
                "nsfw": str(allow_nsfw).lower(),
            },
        )
        nodes = [i["node"] for i in filter_nsfw(data.get("data", []), allow_nsfw)]
        return nodes, bool((data.get("paging") or {}).get("next"))

    async def manga_pool(
        self, row: str, allow_nsfw: bool, offset: int = 0, size: int = POOL_SIZE
    ) -> list[dict]:
        """One big page of a manga ranking: the pool that genre rows and filters draw from."""
        nodes, _ = await self.manga_ranking(row, allow_nsfw, size, offset)
        return nodes

    async def manga_deep_pool(self, row: str, allow_nsfw: bool) -> list[dict]:
        """Several pages of a manga ranking, merged. Like `deep_ranking_pool`: a genre filter
        needs depth to find anything, a failed page is skipped, and only when every page fails
        does the error surface."""
        pages = await asyncio.gather(
            *(self.manga_pool(row, allow_nsfw, i * POOL_SIZE) for i in range(DEEP_POOL_PAGES)),
            return_exceptions=True,
        )
        ok = [p for p in pages if not isinstance(p, BaseException)]
        if not ok:
            first = pages[0]
            assert isinstance(first, BaseException)
            raise first
        merged = {n["id"]: n for p in ok for n in p}
        return list(merged.values())

    async def manga_browse(
        self, row: str, genre: int | None, page: int, allow_nsfw: bool, page_size: int = 20
    ) -> tuple[list[dict], bool]:
        """A ranking's page, or, with a genre, that ranking's deep pool filtered by it. MAL's
        API can't filter manga by genre either, so the pool is fetched once, cached, and sifted."""
        if genre is None:
            return await self.manga_ranking(row, allow_nsfw, page_size, (page - 1) * page_size)
        pool = await self.manga_deep_pool(row, allow_nsfw)
        pool = [n for n in pool if any(g.get("id") == genre for g in n.get("genres") or [])]
        start = (page - 1) * page_size
        return pool[start : start + page_size], len(pool) > start + page_size

    async def manga_details(self, manga_id: int) -> dict:
        cached = self._details.get(("manga", manga_id))
        if cached is not None:
            return cached

        async def load() -> dict:
            shared = await self._shared.get("mal-manga", manga_id)
            if shared is not None:
                self._details[("manga", manga_id)] = shared
                return shared
            data = await self._fetch(
                f"/manga/{manga_id}", {"fields": MANGA_DETAIL_FIELDS}, "manga_not_found"
            )
            self._details[("manga", manga_id)] = data
            await self._shared.set("mal-manga", manga_id, data, DETAILS_TTL)
            return data

        return await self._flights.run(("manga", manga_id), load)

    async def visible_manga(self, manga_id: int, allow_nsfw: bool) -> dict:
        raw = await self.manga_details(manga_id)
        if not allow_nsfw and not is_safe(raw):
            raise ApiError(404, "manga_not_found", "Manga not found")
        return raw

    async def visible_details(self, anime_id: int, allow_nsfw: bool) -> dict:
        """Details of a title the user may see: NSFW ones look like they don't exist."""
        raw = await self.details(anime_id)
        if not allow_nsfw and not is_safe(raw):
            raise ApiError(404, "anime_not_found", "Anime not found")
        return raw

    async def details(self, anime_id: int) -> dict:
        cached = self._details.get(anime_id)
        if cached is not None:
            return cached

        async def load() -> dict:
            shared = await self._shared.get("mal-details", anime_id)
            if shared is not None:
                self._details[anime_id] = shared
                return shared
            data = await self._fetch(f"/anime/{anime_id}", {"fields": DETAIL_FIELDS})
            self._details[anime_id] = data
            await self._shared.set("mal-details", anime_id, data, DETAILS_TTL)
            return data

        return await self._flights.run(("details", anime_id), load)
