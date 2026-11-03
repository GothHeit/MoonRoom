"""ToonBR (toonbr.com): a Portuguese catalog read from its public JSON API.

Search takes a title, a title carries its chapter list, and a chapter carries its page paths
under the site's image host, which needs no Referer.
"""

import asyncio
import logging
import re

import httpx
from cachetools import TTLCache

from app.manga.base import Chapter, ChapterList, MangaSource, Pages
from app.manga.scrape import best_match, new_client, search_queries, sort_key, text
from app.sharedcache import SharedCache

log = logging.getLogger(__name__)

API = "https://api.toonbr.com/api"
IMAGES = "https://cdn2.toonbr.com"
MATCH_TTL = 24 * 3600
CHAPTERS_TTL = 3600
_MISSING = {"missing": True}
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
_PAGE = re.compile(r"^/[A-Za-z0-9/_.-]+$")


def _number(value: object) -> str:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return ""
    return str(int(number)) if number == int(number) else str(number)


class ToonbrSource:
    name = "toonbr"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        api: str = API,
        images: str = IMAGES,
        shared: SharedCache | None = None,
    ) -> None:
        self._api = api
        self._images = images
        self._own_client = client is None
        self._client = client or new_client()
        self._shared = shared or SharedCache()
        self._slots = asyncio.Semaphore(3)
        self._matches: TTLCache[int, dict] = TTLCache(maxsize=2048, ttl=MATCH_TTL)
        self._chapters: TTLCache[str, ChapterList] = TTLCache(maxsize=512, ttl=CHAPTERS_TTL)

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()

    async def _json(self, path: str, params: dict | None = None) -> dict | None:
        async with self._slots:
            response = await self._client.get(f"{self._api}{path}", params=params)
        if response.status_code in (400, 404):
            return None
        response.raise_for_status()
        return response.json()

    async def _find(self, manga: dict) -> dict | None:
        mal_id = int(manga["id"])
        if (hit := self._matches.get(mal_id)) is not None:
            return None if hit.get("missing") else hit
        shared = await self._shared.get("toonbr-match", mal_id)
        if shared is not None:
            self._matches[mal_id] = shared
            return None if shared.get("missing") else shared
        candidates: dict[str, list[str]] = {}
        for query in search_queries(manga):
            found = await self._json("/manga", {"search": query, "limit": 20})
            for item in (found or {}).get("data", []):
                slug, title = item.get("slug"), item.get("title")
                if isinstance(slug, str) and _SLUG.match(slug) and title:
                    candidates.setdefault(slug, []).append(text(title))
        best = best_match(manga, list(candidates.items()))
        if best is None:
            self._matches[mal_id] = _MISSING
            await self._shared.set("toonbr-match", mal_id, _MISSING, MATCH_TTL / 4)
            return None
        kept = {"id": best, "title": candidates[best][0]}
        self._matches[mal_id] = kept
        await self._shared.set("toonbr-match", mal_id, kept, MATCH_TTL)
        return kept

    async def _title_chapters(self, slug: str) -> list[dict] | None:
        detail = await self._json(f"/manga/{slug}")
        if detail is None:
            return None
        return [c for c in detail.get("chapters") or [] if isinstance(c, dict)]

    async def chapters(self, manga: dict, lang: str | None) -> ChapterList | None:
        try:
            found = await self._find(manga)
            if found is None:
                return None
            slug = found["id"]
            if (listed := self._chapters.get(slug)) is None:
                raw = await self._title_chapters(slug)
                if raw is None:
                    return None
                items = [
                    Chapter(
                        id=f"{slug}~{c['id']}",
                        number=_number(c.get("chapterNumber")),
                        volume=None,
                        title=None,
                        lang="pt-br",
                        published_at=c.get("publishedAt"),
                    )
                    for c in raw
                    if isinstance(c.get("id"), str) and _UUID.match(c["id"])
                ]
                items.sort(key=lambda c: (sort_key(c.number), c.id))
                listed = ChapterList(slug, found["title"], ["pt-br"], items)
                self._chapters[slug] = listed
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("toonbr: failed for %s: %s", manga.get("id"), exc)
            return None
        return listed

    async def pages(self, manga: dict, chapter_id: str) -> Pages | None:
        slug, _, uuid = chapter_id.partition("~")
        if not _SLUG.match(slug) or not _UUID.match(uuid):
            return None
        found = await self._find(manga)
        # A chapter of another title is not served.
        if found is None or found["id"] != slug:
            return None
        try:
            owned = {c.get("id") for c in await self._title_chapters(slug) or []}
            if uuid not in owned:
                return None
            chapter = await self._json(f"/chapter/{uuid}")
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("toonbr: pages failed for %s: %s", chapter_id, exc)
            return None
        raw = sorted(
            (p for p in (chapter or {}).get("pages") or [] if isinstance(p, dict)),
            key=lambda p: p.get("pageNumber") or 0,
        )
        urls = [
            f"{self._images}{p['imageUrl']}"
            for p in raw
            if isinstance(p.get("imageUrl"), str) and _PAGE.match(p["imageUrl"])
        ]
        return Pages(urls=urls) if urls else None


_: type[MangaSource] = ToonbrSource
