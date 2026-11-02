"""MangaDex, through its public API (https://api.mangadex.org/docs).

MangaDex hosts fan translations in many languages and flags each title's content rating, so it
is the first manga source. The API asks for a User-Agent, allows about five calls a second and
hands out page images from rotating "MangaDex@Home" hosts whose links expire, so page links are
resolved when the reader opens a chapter, not when the chapters are listed.
"""

import asyncio
import logging
import uuid
from typing import Any

import httpx
from cachetools import TTLCache
from rapidfuzz import fuzz

from app.manga.base import Chapter, ChapterList, MangaSource, Pages
from app.sharedcache import SharedCache
from app.sources.matching import mal_titles, normalize

log = logging.getLogger(__name__)

API = "https://api.mangadex.org"
USER_AGENT = "MoonRoom/0.1 (private library)"
RATINGS = ("safe", "suggestive", "erotica", "pornographic")
# Chapters listed per feed page; MangaDex allows 500.
FEED_PAGE = 500
# Long-running titles can have thousands of chapters: this many feed pages at most.
MAX_FEED_PAGES = 8
# The title match holds a day: it costs a search and the answer hardly changes.
MATCH_TTL = 24 * 3600
# A chapter list changes when a group uploads: refresh every hour.
CHAPTERS_TTL = 3600
# Which title a chapter belongs to never changes: remembered for a day.
OWNER_TTL = 24 * 3600
# How alike a MangaDex title must be to the MAL one when MangaDex has no MAL link for it.
MIN_RATIO = 88
# Languages the app shows first, in order; everything else follows alphabetically.
PREFERRED_LANGS = ("pt-br", "en")

_MISSING = {"missing": True}


def _title_strings(attrs: dict) -> list[str]:
    out: list[str] = []
    for item in (attrs.get("title") or {}, *(attrs.get("altTitles") or [])):
        out.extend(v for v in item.values() if isinstance(v, str) and v)
    return out


def _cover(entry: dict) -> str | None:
    for rel in entry.get("relationships") or []:
        if rel.get("type") == "cover_art" and (
            name := (rel.get("attributes") or {}).get("fileName")
        ):
            return f"https://uploads.mangadex.org/covers/{entry['id']}/{name}.512.jpg"
    return None


def _group(entry: dict) -> str | None:
    for rel in entry.get("relationships") or []:
        if rel.get("type") == "scanlation_group":
            return (rel.get("attributes") or {}).get("name")
    return None


def _chapter_key(chapter: Chapter) -> tuple[float, float, str]:
    def num(value: str | None) -> float:
        try:
            return float(value) if value else float("inf")
        except ValueError:
            return float("inf")

    # One-shots and unnumbered extras go last; ties keep the newest upload.
    return (num(chapter.volume), num(chapter.number), chapter.published_at or "")


def order_languages(available: list[str]) -> list[str]:
    preferred = [lang for lang in PREFERRED_LANGS if lang in available]
    rest = sorted(lang for lang in available if lang not in PREFERRED_LANGS)
    return preferred + rest


def pick_language(available: list[str], wanted: str | None) -> str | None:
    if not available:
        return None
    if wanted and wanted in available:
        return wanted
    return order_languages(available)[0]


def match_entry(detail: dict, entries: list[dict]) -> dict | None:
    """The MangaDex entry for a MAL title: the one that links to its MAL id when there is one,
    else the closest title, if close enough."""
    mal_id = str(detail.get("id") or "")
    for entry in entries:
        links = (entry.get("attributes") or {}).get("links") or {}
        if mal_id and str(links.get("mal") or "") == mal_id:
            return entry
    targets = {normalize(t) for t in mal_titles(detail)}
    best, best_ratio = None, 0.0
    for entry in entries:
        names = _title_strings(entry.get("attributes") or {})
        ratio = max(
            (fuzz.token_sort_ratio(t, normalize(n)) for n in names for t in targets), default=0
        )
        if ratio > best_ratio:
            best, best_ratio = entry, ratio
    return best if best_ratio >= MIN_RATIO else None


class MangaDexSource:
    name = "mangadex"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        base: str = API,
        shared: SharedCache | None = None,
    ) -> None:
        self._base = base
        self._own_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=20.0
        )
        self._shared = shared or SharedCache()
        self._slots = asyncio.Semaphore(4)
        self._matches: TTLCache[int, dict] = TTLCache(maxsize=2048, ttl=MATCH_TTL)
        self._chapters: TTLCache[tuple[str, str], ChapterList] = TTLCache(
            maxsize=512, ttl=CHAPTERS_TTL
        )
        # Chapter id -> the id of the title it belongs to.
        self._owners: TTLCache[str, str] = TTLCache(maxsize=4096, ttl=OWNER_TTL)

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()

    async def _get(self, path: str, params: list[tuple[str, Any]]) -> dict:
        async with self._slots:
            response = await self._client.get(f"{self._base}{path}", params=params)
        response.raise_for_status()
        return response.json()

    async def _search(self, query: str) -> list[dict]:
        data = await self._get(
            "/manga",
            [
                ("title", query),
                ("limit", 10),
                ("includes[]", "cover_art"),
                ("order[relevance]", "desc"),
                *(("contentRating[]", r) for r in RATINGS),
            ],
        )
        return list(data.get("data") or [])

    async def _find(self, manga: dict) -> dict | None:
        """The MangaDex entry for a MAL title, remembered for a day (a miss too)."""
        mal_id = int(manga["id"])
        if (hit := self._matches.get(mal_id)) is not None:
            return None if hit is _MISSING or hit.get("missing") else hit
        shared = await self._shared.get("mangadex-match", mal_id)
        if shared is not None:
            self._matches[mal_id] = shared
            return None if shared.get("missing") else shared
        alt = manga.get("alternative_titles") or {}
        queries: list[str] = []
        for title in (manga.get("title"), alt.get("en"), alt.get("ja")):
            if title and title not in queries:
                queries.append(title)
        seen: dict[str, dict] = {}
        for query in queries[:2]:
            for entry in await self._search(query):
                seen.setdefault(entry["id"], entry)
        found = match_entry(manga, list(seen.values()))
        if found is None:
            self._matches[mal_id] = _MISSING
            await self._shared.set("mangadex-match", mal_id, _MISSING, MATCH_TTL / 4)
            return None
        attrs = found.get("attributes") or {}
        kept = {
            "id": found["id"],
            "title": next(iter(_title_strings(attrs)), manga.get("title") or ""),
            "languages": [lang for lang in attrs.get("availableTranslatedLanguages") or [] if lang],
            "cover": _cover(found),
        }
        self._matches[mal_id] = kept
        await self._shared.set("mangadex-match", mal_id, kept, MATCH_TTL)
        return kept

    async def _feed(self, source_id: str, lang: str) -> list[Chapter]:
        chapters: list[Chapter] = []
        for page in range(MAX_FEED_PAGES):
            data = await self._get(
                f"/manga/{source_id}/feed",
                [
                    ("translatedLanguage[]", lang),
                    ("limit", FEED_PAGE),
                    ("offset", page * FEED_PAGE),
                    ("order[volume]", "asc"),
                    ("order[chapter]", "asc"),
                    ("includes[]", "scanlation_group"),
                    *(("contentRating[]", r) for r in RATINGS),
                ],
            )
            entries = data.get("data") or []
            for entry in entries:
                attrs = entry.get("attributes") or {}
                # Chapters hosted elsewhere (a publisher's own reader) have no pages here.
                if attrs.get("externalUrl") or not attrs.get("pages"):
                    continue
                chapters.append(
                    Chapter(
                        id=entry["id"],
                        number=str(attrs.get("chapter") or ""),
                        volume=str(attrs["volume"]) if attrs.get("volume") else None,
                        title=attrs.get("title") or None,
                        lang=lang,
                        group=_group(entry),
                        published_at=attrs.get("publishAt"),
                        pages=attrs.get("pages"),
                    )
                )
            if len(entries) < FEED_PAGE or page * FEED_PAGE + len(entries) >= int(
                data.get("total") or 0
            ):
                break
        # Several groups translate the same chapter: keep one copy, the earliest upload.
        chapters.sort(key=_chapter_key)
        unique: dict[tuple[str | None, str], Chapter] = {}
        for chapter in chapters:
            unique.setdefault((chapter.volume, chapter.number), chapter)
        return list(unique.values())

    async def chapters(self, manga: dict, lang: str | None) -> ChapterList | None:
        found = await self._find(manga)
        if found is None:
            return None
        languages = order_languages(found["languages"])
        chosen = pick_language(languages, lang)
        if chosen is None:
            return ChapterList(found["id"], found["title"], [], [])
        key = (found["id"], chosen)
        listed = self._chapters.get(key)
        if listed is None:
            try:
                chapters = await self._feed(found["id"], chosen)
            except httpx.HTTPError as exc:
                log.warning("mangadex: chapter feed failed for %s: %s", found["id"], exc)
                return None
            listed = ChapterList(found["id"], found["title"], languages, chapters)
            self._chapters[key] = listed
        return listed

    async def _owner(self, chapter_id: str) -> str | None:
        """The MangaDex title a chapter belongs to, or None for a chapter that doesn't exist."""
        if (known := self._owners.get(chapter_id)) is not None:
            return known
        try:
            data = await self._get(f"/chapter/{chapter_id}", [("includes[]", "manga")])
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            raise
        owner = next(
            (
                rel.get("id")
                for rel in (data.get("data") or {}).get("relationships") or []
                if rel.get("type") == "manga"
            ),
            None,
        )
        if owner:
            self._owners[chapter_id] = owner
        return owner

    async def pages(self, manga: dict, chapter_id: str) -> Pages | None:
        try:
            uuid.UUID(chapter_id)  # the only shape a MangaDex chapter id has
        except ValueError:
            return None
        found = await self._find(manga)
        if found is None:
            return None
        # A chapter of another title (one the user may not be allowed to see) is not served.
        if await self._owner(chapter_id) != found["id"]:
            return None
        try:
            data = await self._get(f"/at-home/server/{chapter_id}", [])
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            raise
        base = data.get("baseUrl")
        chapter = data.get("chapter") or {}
        files = chapter.get("data") or []
        if not base or not chapter.get("hash") or not files:
            return None
        return Pages(urls=[f"{base}/data/{chapter['hash']}/{name}" for name in files])


_: type[MangaSource] = MangaDexSource
