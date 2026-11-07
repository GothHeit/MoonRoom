"""leituramanga.net: a Portuguese catalog read from its public JSON API and reader pages.

Search and the chapter list are JSON. The page images of a chapter sit in the reader page's
own payload, as paths under the site's image host. That host turns away a foreign Referer, so
the site's own travels with the signed page link.
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

SITE = "https://leituramanga.net"
API = "https://api.leituramanga.net/api"
IMAGES = "https://cdn.leituramanga.net"
MATCH_TTL = 24 * 3600
CHAPTERS_TTL = 3600
_MISSING = {"missing": True}
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_MANGA_ID = re.compile(r"^[0-9a-f]{24}$")
_NUMBER = re.compile(r"^\d+(?:\.\d+)?$")
# Older chapters name their pages with an extension; newer ones leave it off (the host still
# serves them as images), so a path is also a page when it is a numbered one.
_IMAGE = re.compile(r'"url":"([A-Za-z0-9][A-Za-z0-9/_.-]*)"')
_IMAGE_FILE = re.compile(r"\.(?:webp|jpe?g|png|avif)$|/page-\d+(?:-\d+)?$")


class LeituramangaSource:
    name = "leituramanga"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        site: str = SITE,
        api: str = API,
        images: str = IMAGES,
        shared: SharedCache | None = None,
    ) -> None:
        self._site = site
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

    async def _get(self, url: str) -> httpx.Response | None:
        async with self._slots:
            response = await self._client.get(url)
        if response.status_code in (400, 404):
            return None
        response.raise_for_status()
        return response

    async def _find(self, manga: dict) -> dict | None:
        mal_id = int(manga["id"])
        if (hit := self._matches.get(mal_id)) is not None:
            return None if hit.get("missing") else hit
        shared = await self._shared.get("leituramanga-match", mal_id)
        if shared is not None:
            self._matches[mal_id] = shared
            return None if shared.get("missing") else shared
        # Keyed by the site's own id, which the chapter list needs; slug is the public name.
        candidates: dict[str, list[str]] = {}
        slugs: dict[str, str] = {}
        for query in search_queries(manga):
            response = await self._get(
                f"{self._api}/search/manga?q={quote(query)}&page=1&limit=20&includeAdult=true"
            )
            items = ((response.json() if response else {}).get("data") or {}).get("data") or []
            for item in items:
                key, slug, title = item.get("_id"), item.get("slug"), item.get("title")
                access = (item.get("readerAccessRule") or {}).get("type")
                # Licensed titles are not readable there, so they are not offered.
                if (
                    access == "public"
                    and isinstance(key, str)
                    and _MANGA_ID.match(key)
                    and isinstance(slug, str)
                    and _SLUG.match(slug)
                    and title
                ):
                    slugs[key] = slug
                    candidates.setdefault(key, []).append(text(title))
        best = best_match(manga, list(candidates.items()))
        if best is None:
            self._matches[mal_id] = _MISSING
            await self._shared.set("leituramanga-match", mal_id, _MISSING, MATCH_TTL / 4)
            return None
        kept = {"id": best, "slug": slugs[best], "title": candidates[best][0]}
        self._matches[mal_id] = kept
        await self._shared.set("leituramanga-match", mal_id, kept, MATCH_TTL)
        return kept

    async def _numbers(self, key: str) -> dict[str, dict]:
        response = await self._get(f"{self._api}/chapter/get-by-manga-id?mangaId={key}&all=true")
        rows = ((response.json() if response else {}).get("data") or {}).get("data") or []
        found: dict[str, dict] = {}
        for row in rows:
            number = row.get("chapterNumber")
            label = f"{number:g}" if isinstance(number, (int, float)) else ""
            if _NUMBER.match(label):
                found.setdefault(label, row)
        return found

    async def chapters(self, manga: dict, lang: str | None) -> ChapterList | None:
        try:
            found = await self._find(manga)
            if found is None:
                return None
            if (listed := self._chapters.get(found["id"])) is None:
                rows = await self._numbers(found["id"])
                items = [
                    Chapter(
                        id=f"{found['slug']}~{number}",
                        number=number,
                        volume=None,
                        title=None,
                        lang="pt-br",
                        published_at=row.get("releaseDate"),
                    )
                    for number, row in rows.items()
                ]
                items.sort(key=lambda c: (sort_key(c.number), c.id))
                listed = ChapterList(found["slug"], found["title"], ["pt-br"], items)
                self._chapters[found["id"]] = listed
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("leituramanga: failed for %s: %s", manga.get("id"), exc)
            return None
        return listed

    async def pages(self, manga: dict, chapter_id: str) -> Pages | None:
        slug, _, number = chapter_id.partition("~")
        if not _SLUG.match(slug) or not _NUMBER.match(number):
            return None
        try:
            found = await self._find(manga)
            # A chapter of another title is not served.
            if found is None or found["slug"] != slug:
                return None
            if number not in await self._numbers(found["id"]):
                return None
            response = await self._get(f"{self._site}/manga/{slug}/chapter/{number}")
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("leituramanga: pages failed for %s: %s", chapter_id, exc)
            return None
        # The payload is JSON inside script strings, so its quotes arrive escaped.
        body = (response.text if response else "").replace('\\"', '"')
        urls: list[str] = []
        for path in _IMAGE.findall(body):
            # Only this title's own pages; covers and other titles' art share the markup.
            if path.startswith(f"{slug}/") and "/cover" not in path and _IMAGE_FILE.search(path):
                url = f"{self._images}/{path}"
                if url not in urls:
                    urls.append(url)
        if not urls:
            return None
        return Pages(urls=urls, upstream_headers={"Referer": f"{self._site}/"})


_: type[MangaSource] = LeituramangaSource
