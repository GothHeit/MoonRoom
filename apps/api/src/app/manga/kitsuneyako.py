"""kitsuneyako.com: a Portuguese catalog (Boa Noite Punpun and other titles the big sources lack).

A WordPress site with its own theme, scraped from HTML: search cards, the chapter links on a
title page and the page images of a chapter page. Chapter ids are "<slug>~<number>" where the
number is the one in the chapter address ("05", "12-5").
"""

import asyncio
import logging
import re
from urllib.parse import quote

import httpx
from cachetools import TTLCache

from app.manga.base import Chapter, ChapterList, MangaSource, Pages
from app.manga.scrape import best_match, new_client, search_queries, sort_key, text
from app.sharedcache import SharedCache

log = logging.getLogger(__name__)

BASE = "https://kitsuneyako.com"
MATCH_TTL = 24 * 3600
CHAPTERS_TTL = 3600
_MISSING = {"missing": True}
_SLUG = r"[a-z0-9][a-z0-9-]*"
_SLUG_RE = re.compile(rf"^{_SLUG}$")
_NUMBER_RE = re.compile(r"^\d+(?:-\d+)?$")
_CARD = re.compile(
    rf'<a class="inkra-catalog-card__media" href="[^"]*?/manga/({_SLUG})/">\s*'
    r'<img[^>]*\balt="([^"]*)"',
    re.S,
)
_IMG = re.compile(r'<img\s+src="(https://[^"]+\.(?:webp|jpe?g|png|avif))"')


class KitsuneyakoSource:
    name = "kitsuneyako"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        base: str = BASE,
        shared: SharedCache | None = None,
    ) -> None:
        self._base = base.rstrip("/")
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
        shared = await self._shared.get("kitsuneyako-match", mal_id)
        if shared is not None:
            self._matches[mal_id] = shared
            return None if shared.get("missing") else shared
        candidates: dict[str, list[str]] = {}
        for query in _queries(manga):
            page = await self._html(f"/?s={quote(query)}&post_type=wp-manga")
            for slug, title in _CARD.findall(page or ""):
                candidates.setdefault(slug, []).extend(_names(text(title)))
        best = best_match(manga, list(candidates.items()))
        if best is None:
            self._matches[mal_id] = _MISSING
            await self._shared.set("kitsuneyako-match", mal_id, _MISSING, MATCH_TTL / 4)
            return None
        kept = {"id": best, "title": candidates[best][0]}
        self._matches[mal_id] = kept
        await self._shared.set("kitsuneyako-match", mal_id, kept, MATCH_TTL)
        return kept

    async def chapters(self, manga: dict, lang: str | None) -> ChapterList | None:
        try:
            found = await self._find(manga)
            if found is None:
                return None
            slug = found["id"]
            if (listed := self._chapters.get(slug)) is None:
                page = await self._html(f"/manga/{slug}/")
                if page is None:
                    return None
                link = re.compile(
                    rf'href="{re.escape(self._base)}/{re.escape(slug)}-capitulo-(\d+(?:-\d+)?)/"'
                )
                numbers = dict.fromkeys(link.findall(page))
                items = [
                    Chapter(
                        id=f"{slug}~{raw}",
                        number=_clean(raw),
                        volume=None,
                        title=None,
                        lang="pt-br",
                    )
                    for raw in numbers
                ]
                items.sort(key=lambda c: (sort_key(c.number), c.id))
                listed = ChapterList(slug, found["title"], ["pt-br"], items)
                self._chapters[slug] = listed
        except httpx.HTTPError as exc:
            log.warning("kitsuneyako: failed for %s: %s", manga.get("id"), exc)
            return None
        return listed

    async def pages(self, manga: dict, chapter_id: str) -> Pages | None:
        slug, _, raw = chapter_id.partition("~")
        if not _SLUG_RE.match(slug) or not _NUMBER_RE.match(raw):
            return None
        found = await self._find(manga)
        # A chapter of another title is not served.
        if found is None or found["id"] != slug:
            return None
        try:
            page = await self._html(f"/{slug}-capitulo-{raw}/")
        except httpx.HTTPError as exc:
            log.warning("kitsuneyako: pages failed for %s: %s", chapter_id, exc)
            return None
        urls: list[str] = []
        for url in _IMG.findall(page or ""):
            # Only this chapter's pages; the theme's own art uses the same markup.
            if f"/manga/{slug}/" in url and url not in urls:
                urls.append(url)
        return Pages(urls=urls) if urls else None


def _queries(manga: dict) -> list[str]:
    """Its search wants a word of the Portuguese title, so the last word of each name is tried
    too: "Goodnight Punpun" is found as "Boa noite Punpun" by "Punpun"."""
    queries = search_queries(manga)
    for query in list(queries):
        last = query.split()[-1] if query.split() else ""
        if len(last) >= 4 and last not in queries:
            queries.append(last)
    return queries


def _names(title: str) -> list[str]:
    """The title and the English spellings of a Portuguese opening, for matching."""
    names = [title]
    if title.lower().startswith("boa noite "):
        rest = title[len("boa noite ") :]
        names += [f"Goodnight {rest}", f"Good Night {rest}"]
    return names


def _clean(raw: str) -> str:
    whole, _, part = raw.partition("-")
    number = str(int(whole))
    return f"{number}.{part}" if part else number


_: type[MangaSource] = KitsuneyakoSource
