"""The plug-in boundary for where manga pages come from.

The catalog (titles, covers, synopses) is MyAnimeList, as for anime. A MangaSource only knows
how to find a title it hosts, list its chapters and hand out the page images of one chapter.
The first implementation is the public MangaDex API; scraped sites would be others, private
and behind flags like the video ones.
"""

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class Chapter:
    # The source's own id for the chapter: what the reader asks pages for.
    id: str
    # "12", "12.5" or "" for a one-shot, as the source numbers it. Progress is keyed by it.
    number: str
    volume: str | None
    title: str | None
    # BCP 47-ish code as the source uses it ("en", "pt-br").
    lang: str
    group: str | None = None
    # ISO 8601 date-time, when the source says.
    published_at: str | None = None
    pages: int | None = None


@dataclass(frozen=True)
class ChapterList:
    # The source's id for the title, so the caller can link back to it.
    source_id: str
    source_title: str
    # Languages the title has chapters in, with the ones the user is likeliest to want first.
    languages: list[str]
    # Chapters in reading order (first chapter first), of one language.
    chapters: list[Chapter]


@dataclass(frozen=True)
class Pages:
    # Page image URLs, in order. Fetched through the proxy, never by the browser.
    urls: list[str]
    # Headers the image host needs, e.g. a Referer for hotlink protection.
    upstream_headers: dict[str, str] = field(default_factory=dict)


class MangaSource(Protocol):
    name: str

    async def chapters(self, manga: dict, lang: str | None) -> ChapterList | None:
        """`manga` is the MAL detail payload; `lang` the language wanted, or None for the
        source's best guess. None means the source doesn't have the title."""
        ...

    async def pages(self, manga: dict, chapter_id: str) -> Pages | None:
        """The pages of one of `manga`'s chapters. None when the chapter is gone, and also when
        it isn't a chapter of this title: the id comes from the address bar, and a title the
        user may see must never open the pages of one they may not."""
        ...
