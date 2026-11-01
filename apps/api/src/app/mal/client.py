"""MyAnimeList API client.

Every response is status-checked: a bad client ID, a rate limit or an outage becomes a
clear `mal_unavailable` error instead of a KeyError on an error body.
"""

import asyncio
from datetime import date
from typing import Any

import httpx
from cachetools import TTLCache
from rapidfuzz import fuzz

from app.errors import ApiError
from app.singleflight import SingleFlight

API_BASE = "https://api.myanimelist.net/v2"

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

LIST_TTL = 600  # seconds
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
    def __init__(self, client_id: str, http: httpx.AsyncClient):
        self._headers = {"X-MAL-CLIENT-ID": client_id}
        self._http = http
        # Cold-cache bursts (home, profiles) would otherwise fire dozens of calls at once and
        # get answered with 429/403.
        self._slots = asyncio.Semaphore(MAX_CONCURRENT_CALLS)
        self._details: TTLCache[int, dict] = TTLCache(maxsize=2048, ttl=1800)
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
            data = await self._fetch(path, params)
            self._pages[key] = data
            return data

        return await self._flights.run(key, load)

    async def _fetch(self, path: str, params: dict[str, Any]) -> dict:
        try:
            async with self._slots:
                response = await self._http.get(
                    f"{API_BASE}{path}", headers=self._headers, params=params, timeout=15
                )
        except httpx.HTTPError as exc:
            raise ApiError(502, "mal_unavailable", f"MyAnimeList request failed: {exc}") from exc
        if response.status_code == 404:
            raise ApiError(404, "anime_not_found", "Anime not found")
        if response.status_code != 200:
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
            data = await self._fetch(f"/anime/{anime_id}", {"fields": DETAIL_FIELDS})
            self._details[anime_id] = data
            return data

        return await self._flights.run(("details", anime_id), load)
