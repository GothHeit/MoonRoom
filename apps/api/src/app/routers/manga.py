"""The manga section: catalog from MyAnimeList, chapters and pages from the MangaSources."""

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Query, Request, Response
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import distinct_on, insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import hls
from app.db import utcnow
from app.deps import CurrentSessionId, CurrentUser, Session
from app.errors import ApiError
from app.mal.client import MANGA_RANKINGS, MalClient, is_safe
from app.manga.base import Chapter, ChapterList, MangaSource
from app.manga.pagecache import MAX_PAGE_BYTES, PageCache
from app.models import MangaProgress
from app.routers.anime import only_safe
from app.routers.watch import session_open
from app.schemas import (
    ChapterOut,
    ChaptersOut,
    MangaBrowseOut,
    MangaCard,
    MangaDetailsOut,
    MangaHomeItem,
    MangaHomeOut,
    MangaHomeRow,
    MangaListOut,
    MangaProgressIn,
    MangaProgressOut,
    PagesOut,
)
from app.upstream import open_upstream

router = APIRouter(prefix="/manga", tags=["manga"])
log = logging.getLogger(__name__)

Row = Literal["top", "popular", "manhwa", "manhua", "oneshots"]

SOURCE_TIMEOUT = 12.0
# Titles on the continue-reading row.
CONTINUE_LIMIT = 12
HOME_ROWS: tuple[Literal["top", "popular", "manhwa", "manhua"], ...] = (
    "top",
    "popular",
    "manhwa",
    "manhua",
)
# A page link lives this long: a chapter is read in one sitting, and the reader asks again.
PAGE_LINK_LIFETIME = 6 * 3600
PAGE_CACHE_CONTROL = "private, max-age=86400, immutable"
# Languages the reader prefers, by the user's locale, when the user hasn't picked one.
LOCALE_LANGS = {"pt": ("pt-br", "en"), "en": ("en",)}


def _mal(request: Request) -> MalClient:
    return request.app.state.mal


def _sources(request: Request) -> dict[str, MangaSource]:
    return request.app.state.manga_sources


def _cards(nodes: list[dict]) -> list[MangaCard]:
    return [MangaCard.from_node(n) for n in nodes]


def progress_out(row: MangaProgress) -> MangaProgressOut:
    return MangaProgressOut(
        manga_id=row.manga_id,
        chapter=row.chapter,
        page=row.page,
        pages=row.pages,
        completed=row.completed,
        updated_at=row.updated_at,
    )


def progress_key(chapter: Chapter) -> str:
    """What progress in a chapter is filed under: its number, or its id for an unnumbered one.
    The web computes the same key (see lib/manga.ts)."""
    return (chapter.number or chapter.id)[:16]


def chapter_out(chapter: Chapter) -> ChapterOut:
    return ChapterOut(
        id=chapter.id,
        number=chapter.number,
        volume=chapter.volume,
        title=chapter.title,
        lang=chapter.lang,
        group=chapter.group,
        published_at=chapter.published_at,
        pages=chapter.pages,
    )


async def latest_per_manga(
    session: AsyncSession, user_id: uuid.UUID, limit: int
) -> list[MangaProgress]:
    """The chapter last read of each manga, most recently read manga first."""
    latest = (
        select(MangaProgress)
        .where(MangaProgress.user_id == user_id)
        .ext(distinct_on(MangaProgress.manga_id))
        .order_by(MangaProgress.manga_id, MangaProgress.updated_at.desc())
        .subquery()
    )
    rows = await session.execute(select(latest).order_by(latest.c.updated_at.desc()).limit(limit))
    return [
        MangaProgress(
            user_id=r.user_id,
            manga_id=r.manga_id,
            chapter=r.chapter,
            page=r.page,
            pages=r.pages,
            completed=r.completed,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


# The page proxy comes before /{manga_id} so "page" is never read as a title id.
@router.get("/page")
async def page(
    request: Request,
    session: Session,
    u: Annotated[str, Query()],
    v: Annotated[str, Query()],
    e: Annotated[int, Query()],
    s: Annotated[str, Query()],
    r: Annotated[str, Query()] = "",
    i: Annotated[str, Query()] = "",
    k: Annotated[str, Query()] = "img",
):
    """One page image, by a link that `pages` signed. The link names the reader and their
    login session and expires, like a stream link; the picture is kept on disk for the next
    reader. Only public hosts are fetched (never anything on our own network)."""
    viewer = hls.Viewer(v, i)
    if k != "img" or not hls.verify_link(u, r, k, viewer, e, s):
        raise ApiError(403, "invalid_link", "Invalid or expired page link")
    if not await session_open(request, session, v, i):
        raise ApiError(403, "invalid_link", "This session was signed out")
    await session.commit()  # the fetch below may take a while: don't hold a connection

    cache: PageCache = request.app.state.page_cache
    headers = {"cache-control": PAGE_CACHE_CONTROL, "x-content-type-options": "nosniff"}
    hit = await asyncio.to_thread(cache.get, u)
    if hit is not None:
        path, media_type = hit
        return FileResponse(path, media_type=media_type, headers=headers)

    http: httpx.AsyncClient = request.app.state.http
    try:
        upstream, final_url = await open_upstream(http, u, {"Referer": r} if r else {})
    except httpx.HTTPError as exc:
        raise ApiError(502, "upstream_failed", "The page host did not answer") from exc
    try:
        if upstream.status_code != 200:
            raise ApiError(502, "upstream_failed", f"Page host answered {upstream.status_code}")
        chunks: list[bytes] = []
        size = 0
        try:
            async for chunk in upstream.aiter_bytes():
                size += len(chunk)
                if size > MAX_PAGE_BYTES:
                    raise ApiError(502, "upstream_failed", "Page is too large")
                chunks.append(chunk)
        except httpx.HTTPError as exc:
            raise ApiError(502, "upstream_failed", "The page host dropped the image") from exc
    finally:
        await upstream.aclose()
    data = b"".join(chunks)
    # Only a picture is served and kept: an error page sent as 200 must not be stored as one.
    media_type = upstream.headers.get("content-type", "").split(";")[0].strip().lower()
    if media_type not in hls.SAFE_IMAGES:
        raise ApiError(502, "upstream_failed", "The page host did not send a picture")
    await asyncio.to_thread(cache.put, u, media_type, data)
    return Response(data, media_type=media_type, headers=headers)


@router.get("/home", response_model=MangaHomeOut)
async def home(request: Request, user: CurrentUser, session: Session):
    mal = _mal(request)
    reading = await latest_per_manga(session, user.id, CONTINUE_LIMIT)
    await session.commit()

    async def card(row: MangaProgress) -> MangaHomeItem | None:
        try:
            node = await mal.manga_details(row.manga_id)
        except ApiError:
            return None
        if not user.show_nsfw and not is_safe(node):
            return None
        return MangaHomeItem(manga=MangaCard.from_node(node), progress=progress_out(row))

    continue_items, *rankings = await asyncio.gather(
        asyncio.gather(*(card(r) for r in reading)),
        *(mal.manga_ranking(row, user.show_nsfw) for row in HOME_ROWS),
        return_exceptions=True,
    )
    rows: list[MangaHomeRow] = []
    if isinstance(continue_items, list):
        items = [item for item in continue_items if item is not None]
        if items:
            rows.append(MangaHomeRow(id="continue_reading", items=items))
    for row_id, ranking in zip(HOME_ROWS, rankings, strict=True):
        if isinstance(ranking, BaseException):
            log.warning("manga home: %s row failed: %s", row_id, ranking)
            continue
        nodes, _ = ranking
        if nodes:
            rows.append(
                MangaHomeRow(id=row_id, items=[MangaHomeItem(manga=c) for c in _cards(nodes)])
            )
    if not rows:
        raise ApiError(502, "mal_unavailable", "MyAnimeList did not answer")
    return MangaHomeOut(rows=rows)


@router.get("/search", response_model=MangaListOut)
async def search(
    request: Request, user: CurrentUser, q: Annotated[str, Query(min_length=1, max_length=100)]
):
    return MangaListOut(data=_cards(await _mal(request).manga_search(q, user.show_nsfw)))


@router.get("/browse", response_model=MangaBrowseOut)
async def browse(
    request: Request,
    user: CurrentUser,
    row: Row = "top",
    page: Annotated[int, Query(ge=1, le=25)] = 1,
):
    assert row in MANGA_RANKINGS
    page_size = 20
    nodes, has_next = await _mal(request).manga_ranking(
        row, user.show_nsfw, page_size, (page - 1) * page_size
    )
    return MangaBrowseOut(data=_cards(nodes), page=page, has_next=has_next)


@router.get("/{manga_id}", response_model=MangaDetailsOut)
async def details(request: Request, manga_id: int, user: CurrentUser):
    mal = _mal(request)
    raw = await mal.visible_manga(manga_id, user.show_nsfw)
    related = raw.get("related_manga") or []
    recommended = raw.get("recommendations") or []
    if not user.show_nsfw:
        related, recommended = await only_safe(mal, related, recommended, fetch=mal.manga_details)
    return MangaDetailsOut.model_validate(
        {
            **raw,
            "related_manga": [{**r, "manga": r["node"]} for r in related],
            "recommendations": [{**r, "manga": r["node"]} for r in recommended],
        }
    )


async def _first_listing(
    request: Request, manga: dict, lang: str | None
) -> tuple[str, ChapterList] | None:
    """The chapters from the first enabled source that has the title (fallback, in order)."""
    # A source that knows the title but has no readable chapters (licensed ones are pulled from
    # MangaDex, for one) must not stop the next source from being tried; it is only the answer
    # when nobody has chapters.
    empty: tuple[str, ChapterList] | None = None
    for name, source in _sources(request).items():
        try:
            listed = await asyncio.wait_for(source.chapters(manga, lang), SOURCE_TIMEOUT)
        except Exception as exc:  # a broken source is skipped, the next one is tried
            log.warning("manga: source %s failed for %s: %s", name, manga.get("id"), exc)
            continue
        if listed is None:
            continue
        if listed.chapters:
            return name, listed
        if empty is None and listed.languages:
            empty = (name, listed)
    return empty


def _wanted_lang(user_locale: str, lang: str | None, available: list[str]) -> str | None:
    if lang:
        return lang
    for candidate in LOCALE_LANGS.get(user_locale, ("en",)):
        if candidate in available:
            return candidate
    return None


@router.get("/{manga_id}/chapters", response_model=ChaptersOut)
async def chapters(
    request: Request,
    manga_id: int,
    user: CurrentUser,
    session: Session,
    lang: Annotated[str | None, Query(max_length=10)] = None,
):
    """The chapter list, with where the user is in each chapter. Separate from the details so
    a slow source never holds the title page back."""
    manga = await _mal(request).visible_manga(manga_id, user.show_nsfw)
    found = await _first_listing(request, manga, lang)
    if found is None:
        raise ApiError(404, "not_available", "No source has this title")
    name, listed = found
    # The user's language when the source has it and no language was asked for; the source
    # already answered in its own best language, so only re-ask when that differs.
    wanted = _wanted_lang(user.locale, lang, listed.languages)
    if wanted and listed.chapters and listed.chapters[0].lang != wanted:
        relisted = await _first_listing(request, manga, wanted)
        if relisted is not None:
            name, listed = relisted
    rows = await session.scalars(
        select(MangaProgress).where(
            MangaProgress.user_id == user.id, MangaProgress.manga_id == manga_id
        )
    )
    progress = {row.chapter: progress_out(row) for row in rows}
    await session.commit()
    return ChaptersOut(
        source=name,
        source_id=listed.source_id,
        source_title=listed.source_title,
        lang=listed.chapters[0].lang if listed.chapters else None,
        languages=listed.languages,
        chapters=[chapter_out(c) for c in listed.chapters],
        progress=progress,
    )


@router.get("/{manga_id}/read/{source}/{chapter_id}", response_model=PagesOut)
async def pages(
    request: Request,
    manga_id: int,
    source: str,
    chapter_id: str,
    user: CurrentUser,
    sid: CurrentSessionId,
    session: Session,
    lang: Annotated[str | None, Query(max_length=10)] = None,
):
    """The page links of one chapter, plus its neighbours in the same language. The source's
    page links are short-lived, so they are resolved here, when the reader opens the chapter."""
    src = _sources(request).get(source)
    if src is None:
        raise ApiError(404, "not_available", "Unknown manga source")
    manga = await _mal(request).visible_manga(manga_id, user.show_nsfw)
    try:
        listed, found = await asyncio.gather(
            asyncio.wait_for(src.chapters(manga, lang), SOURCE_TIMEOUT),
            asyncio.wait_for(src.pages(manga, chapter_id), SOURCE_TIMEOUT),
        )
    except Exception as exc:
        raise ApiError(502, "upstream_failed", "The manga source did not answer") from exc
    if found is None or not found.urls:
        raise ApiError(404, "not_available", "This chapter isn't available any more")
    chapter_list = listed.chapters if listed is not None else []
    index = next((n for n, c in enumerate(chapter_list) if c.id == chapter_id), None)
    if index is None:
        # The list is in another language than the chapter: the reader still gets its pages.
        current = Chapter(id=chapter_id, number="", volume=None, title=None, lang=lang or "")
        previous = following = None
    else:
        current = chapter_list[index]
        previous = chapter_list[index - 1] if index > 0 else None
        following = chapter_list[index + 1] if index + 1 < len(chapter_list) else None
    saved = await session.get(MangaProgress, (user.id, manga_id, progress_key(current)))
    await session.commit()
    viewer = hls.Viewer(str(user.id), str(sid))
    referer = found.upstream_headers.get("Referer", "")
    return PagesOut(
        source=source,
        chapter=chapter_out(current),
        pages=[
            "/manga/"
            + hls.signed_link(url, referer, viewer, "img", PAGE_LINK_LIFETIME, endpoint="page")
            for url in found.urls
        ],
        previous=chapter_out(previous) if previous else None,
        next=chapter_out(following) if following else None,
        progress=progress_out(saved) if saved else None,
    )


@router.put("/{manga_id}/progress/{chapter}", response_model=MangaProgressOut)
async def put_progress(
    manga_id: int,
    chapter: Annotated[str, PathParam(min_length=1, max_length=16)],
    body: MangaProgressIn,
    user: CurrentUser,
    session: Session,
):
    page_index = min(body.page, body.pages - 1)
    completed = body.completed or page_index >= body.pages - 1
    values = {
        "page": page_index,
        "pages": body.pages,
        "completed": completed,
        "updated_at": utcnow(),
    }
    statement = insert(MangaProgress).values(
        user_id=user.id, manga_id=manga_id, chapter=chapter, **values
    )
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=["user_id", "manga_id", "chapter"], set_=values
        )
    )
    await session.commit()
    row = await session.get(MangaProgress, (user.id, manga_id, chapter))
    assert row is not None
    return progress_out(row)


def new_page_cache(directory: str, max_mb: int) -> PageCache:
    return PageCache(Path(directory), max_mb * 1024 * 1024)
