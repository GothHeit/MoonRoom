"""Sites on the WordPress "Madara" theme (mangalivre.to and many more), scraped from HTML.

One class serves them all: a site is a name, an address and a language. Chapter ids are
"<title slug>~<chapter path>", so the title a chapter belongs to is checked from the id itself.
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

MATCH_TTL = 24 * 3600
CHAPTERS_TTL = 3600
_MISSING = {"missing": True}

# Sites by source name: address, language of their chapters and the path their titles live
# under ("manga" unless the site renamed it).
SITES: dict[str, tuple[str, str, str]] = {
    "mangalivre": ("https://mangalivre.to", "pt-br", "manga"),
    # Adult pt-BR site, named neutrally.
    "teca": ("https://hentaiteca.net", "pt-br", "obra"),
}

_SLUG = r"[A-Za-z0-9][A-Za-z0-9._%-]*"
_ID_RE = re.compile(rf"^({_SLUG})~({_SLUG}(?:~{_SLUG})*)$")
_IMG = re.compile(r"<img\b[^>]*\bwp-manga-chapter-img\b[^>]*>")
_SRC = re.compile(r'\b(?:data-src|src)="\s*([^"]+?)\s*"')


class MadaraSource:
    def __init__(
        self,
        name: str,
        base: str,
        lang: str,
        client: httpx.AsyncClient | None = None,
        prefix: str = "manga",
        shared: SharedCache | None = None,
    ) -> None:
        self.name = name
        self._base = base.rstrip("/")
        self._lang = lang
        self._prefix = prefix
        self._result = re.compile(
            rf'<div class="row c-tabs-item__content">.*?<a href="[^"]*/{prefix}/({_SLUG})/"[^>]*'
            r'title="([^"]*)"',
            re.S,
        )
        self._chapter = re.compile(
            rf'<li class="wp-manga-chapter[^>]*>\s*<a href="[^"]*?/{prefix}/'
            rf"({_SLUG})/((?:{_SLUG}/)+)\"[^>]*>(.*?)</a>",
            re.S,
        )
        self._own_client = client is None
        self._client = client or new_client()
        self._shared = shared or SharedCache()
        self._slots = asyncio.Semaphore(3)
        self._matches: TTLCache[int, dict] = TTLCache(maxsize=2048, ttl=MATCH_TTL)
        self._chapters: TTLCache[str, ChapterList] = TTLCache(maxsize=512, ttl=CHAPTERS_TTL)

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()

    async def _get(self, path: str) -> str | None:
        async with self._slots:
            response = await self._client.get(f"{self._base}{path}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.text

    async def _find(self, manga: dict) -> dict | None:
        mal_id = int(manga["id"])
        ns = f"{self.name}-match"
        if (hit := self._matches.get(mal_id)) is not None:
            return None if hit.get("missing") else hit
        shared = await self._shared.get(ns, mal_id)
        if shared is not None:
            self._matches[mal_id] = shared
            return None if shared.get("missing") else shared
        candidates: dict[str, list[str]] = {}
        for query in search_queries(manga):
            page = await self._get(f"/?s={quote(query)}&post_type=wp-manga")
            for slug, title in self._result.findall(page or ""):
                candidates.setdefault(slug, []).append(text(title))
        found = best_match(manga, list(candidates.items()))
        if found is None:
            self._matches[mal_id] = _MISSING
            await self._shared.set(ns, mal_id, _MISSING, MATCH_TTL / 4)
            return None
        kept = {"id": found, "title": candidates[found][0]}
        self._matches[mal_id] = kept
        await self._shared.set(ns, mal_id, kept, MATCH_TTL)
        return kept

    async def _chapter_html(self, slug: str) -> str:
        """Newer Madara serves the list from an ajax address, older ones inline in the page."""
        async with self._slots:
            response = await self._client.post(
                f"{self._base}/{self._prefix}/{slug}/ajax/chapters/",
                headers={"X-Requested-With": "XMLHttpRequest"},
            )
        if response.status_code == 200 and "wp-manga-chapter" in response.text:
            return response.text
        return await self._get(f"/{self._prefix}/{slug}/") or ""

    async def chapters(self, manga: dict, lang: str | None) -> ChapterList | None:
        try:
            found = await self._find(manga)
            if found is None:
                return None
            slug = found["id"]
            if (listed := self._chapters.get(slug)) is None:
                seen: dict[str, Chapter] = {}
                for owner, path, label in self._chapter.findall(await self._chapter_html(slug)):
                    if owner != slug:
                        continue
                    cid = f"{slug}~{path.strip('/').replace('/', '~')}"
                    seen.setdefault(
                        cid,
                        Chapter(
                            id=cid,
                            number=chapter_number(text(label)),
                            volume=None,
                            title=None,
                            lang=self._lang,
                        ),
                    )
                ordered = sorted(seen.values(), key=lambda c: (sort_key(c.number), c.id))
                listed = ChapterList(slug, found["title"], [self._lang], ordered)
                self._chapters[slug] = listed
        except httpx.HTTPError as exc:
            log.warning("%s: failed for %s: %s", self.name, manga.get("id"), exc)
            return None
        return listed

    async def pages(self, manga: dict, chapter_id: str) -> Pages | None:
        parsed = _ID_RE.match(chapter_id)
        if parsed is None:
            return None
        found = await self._find(manga)
        # A chapter of another title is not served.
        if found is None or found["id"] != parsed.group(1):
            return None
        path = parsed.group(2).replace("~", "/")
        page = await self._get(f"/{self._prefix}/{parsed.group(1)}/{path}/")
        urls: list[str] = []
        for tag in _IMG.findall(page or ""):
            if (src := _SRC.search(tag)) and src.group(1).startswith("https://"):
                urls.append(src.group(1))
        if not urls:
            return None
        return Pages(urls=urls, upstream_headers={"Referer": f"{self._base}/"})


_: type[MangaSource] = MadaraSource
