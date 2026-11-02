"""mangapill.com: a large English catalog, scraped from its HTML.

Its image host refuses any request without mangapill as the Referer, which the page proxy
sends because the Referer rides in the signed page link.
"""

import asyncio
import logging
import re
from urllib.parse import quote

import httpx
from cachetools import TTLCache

from app.manga.base import Chapter, ChapterList, MangaSource, Pages
from app.manga.scrape import (
    best_match,
    chapter_number,
    new_client,
    search_queries,
    sort_key,
    text,
)
from app.sharedcache import SharedCache

log = logging.getLogger(__name__)

BASE = "https://mangapill.com"
MATCH_TTL = 24 * 3600
CHAPTERS_TTL = 3600
_MISSING = {"missing": True}

_CARD = re.compile(
    r'href="/manga/(\d+)/[^"]+"\s+class="mb-2">\s*'
    r'<div class="mt-3 font-black[^>]*>(.*?)</div>'
    r'(?:\s*<div class="line-clamp-2 text-xs[^>]*>(.*?)</div>)?',
    re.S,
)
_CHAPTER = re.compile(r'href="/chapters/(\d+-\d+)(?:/[^"]*)?"[^>]*>\s*([^<]+?)\s*</a>')
_PAGE = re.compile(r'<img[^>]+class="[^"]*js-page[^"]*"[^>]*\sdata-src="([^"]+)"')
_CHAPTER_ID = re.compile(r"^(\d+)-\d+$")


class MangapillSource:
    name = "mangapill"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        base: str = BASE,
        shared: SharedCache | None = None,
    ) -> None:
        self._base = base
        self._own_client = client is None
        self._client = client or new_client()
        self._shared = shared or SharedCache()
        self._slots = asyncio.Semaphore(3)
        self._matches: TTLCache[int, dict] = TTLCache(maxsize=2048, ttl=MATCH_TTL)
        self._chapters: TTLCache[str, ChapterList] = TTLCache(maxsize=512, ttl=CHAPTERS_TTL)

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()

    async def _html(self, path: str) -> str | None:
        async with self._slots:
            response = await self._client.get(f"{self._base}{path}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.text

    async def _find(self, manga: dict) -> dict | None:
        mal_id = int(manga["id"])
        if (hit := self._matches.get(mal_id)) is not None:
            return None if hit.get("missing") else hit
        shared = await self._shared.get("mangapill-match", mal_id)
        if shared is not None:
            self._matches[mal_id] = shared
            return None if shared.get("missing") else shared
        candidates: dict[str, list[str]] = {}
        for query in search_queries(manga):
            page = await self._html(f"/search?q={quote(query)}")
            for card in _CARD.finditer(page or ""):
                names = candidates.setdefault(card.group(1), [])
                names.extend(text(g) for g in card.groups()[1:] if g)
        found = best_match(manga, list(candidates.items()))
        if found is None:
            self._matches[mal_id] = _MISSING
            await self._shared.set("mangapill-match", mal_id, _MISSING, MATCH_TTL / 4)
            return None
        kept = {"id": found, "title": candidates[found][0]}
        self._matches[mal_id] = kept
        await self._shared.set("mangapill-match", mal_id, kept, MATCH_TTL)
        return kept

    async def chapters(self, manga: dict, lang: str | None) -> ChapterList | None:
        try:
            found = await self._find(manga)
            if found is None:
                return None
            if (listed := self._chapters.get(found["id"])) is None:
                page = await self._html(f"/manga/{found['id']}/x")
                if page is None:
                    return None
                chapters: dict[str, Chapter] = {}
                for cid, label in _CHAPTER.findall(page):
                    if cid.split("-")[0] != found["id"]:
                        continue
                    chapters.setdefault(
                        cid,
                        Chapter(
                            id=cid,
                            number=chapter_number(label),
                            volume=None,
                            title=None,
                            lang="en",
                        ),
                    )
                ordered = sorted(chapters.values(), key=lambda c: (sort_key(c.number), c.id))
                listed = ChapterList(found["id"], found["title"], ["en"], ordered)
                self._chapters[found["id"]] = listed
        except httpx.HTTPError as exc:
            log.warning("mangapill: failed for %s: %s", manga.get("id"), exc)
            return None
        # English only: for a Portuguese reader the app falls back to this when nobody else has it.
        return listed

    async def pages(self, manga: dict, chapter_id: str) -> Pages | None:
        owner = _CHAPTER_ID.match(chapter_id)
        if owner is None:
            return None
        found = await self._find(manga)
        # A chapter of another title is not served.
        if found is None or found["id"] != owner.group(1):
            return None
        page = await self._html(f"/chapters/{chapter_id}")
        urls = [u for u in _PAGE.findall(page or "") if u.startswith("https://")]
        if not urls:
            return None
        return Pages(urls=urls, upstream_headers={"Referer": f"{self._base}/"})


_: type[MangaSource] = MangapillSource
