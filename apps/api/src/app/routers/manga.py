"""The manga section: catalog from MyAnimeList, chapters and pages from the MangaSources."""

import asyncio
import logging
import uuid
from datetime import date
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
from app.db import new_session, utcnow
from app.deps import CurrentSessionId, CurrentUser, Session
from app.errors import ApiError
from app.mal.client import MANGA_RANKINGS, MalClient, is_safe
from app.mal.genres import GENRE_IDS, GENRES
from app.manga.base import Chapter, ChapterList, MangaSource
from app.manga.pagecache import MAX_PAGE_BYTES, PageCache
from app.models import MalLink, MangaProgress, User
from app.routers.anime import only_safe
from app.routers.home import MIN_ROW, todays_genres
from app.routers.watch import session_open
from app.schemas import (
    ChapterOut,
    ChaptersOut,
    GenreOut,
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

Row = Literal["top", "popular", "manhwa", "manhua", "oneshots", "favorites"]

SOURCE_TIMEOUT = 12.0
# Titles on the continue-reading row.
CONTINUE_LIMIT = 12
RankedRow = Literal["top", "popular", "manhwa", "manhua", "favorites"]
HomeRowId = Literal[RankedRow, "genre", "similar"]
HOME_ROWS: tuple[RankedRow, ...] = ("top", "popular", "manhwa", "manhua", "favorites")
# Titles on a home row.
ROW_SIZE = 20
# Genre rows come from the most-followed manga; this many, rotated by day like the anime home.
GENRE_ROWS = 4
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


def chapter_number(key: str) -> int | None:
    """The whole chapter a progress key stands for ("12.5" counts as 12), or None for an
    unnumbered chapter, which MAL has no place for."""
    try:
        number = int(float(key))
    except ValueError:
        return None
    return number if number >= 1 else None


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


def _row(row_id: HomeRowId, nodes: list[dict], **extra) -> MangaHomeRow:
    return MangaHomeRow(
        id=row_id, items=[MangaHomeItem(manga=c) for c in _cards(nodes[:ROW_SIZE])], **extra
    )


async def _genre_rows(mal: MalClient, allow_nsfw: bool) -> list[MangaHomeRow]:
    """Most-followed manga of a few genres, drawn from the cached popularity pool."""
    pool = await mal.manga_pool("popular", allow_nsfw)
    rows = []
    for genre_id in todays_genres(date.today(), GENRE_ROWS):
        nodes = [n for n in pool if any(g.get("id") == genre_id for g in n.get("genres") or [])]
        info = GENRE_IDS[genre_id]
        if len(nodes) >= MIN_ROW:
            genre = GenreOut(id=info.id, name=info.name, kind=info.kind, nsfw=info.nsfw)
            rows.append(_row("genre", nodes, genre=genre))
    return rows


async def _similar_row(mal: MalClient, about: dict, allow_nsfw: bool) -> MangaHomeRow | None:
    """What readers of the title last opened also recommend, from its (cached) details."""
    recommended = about.get("recommendations") or []
    if not allow_nsfw:
        (recommended,) = await only_safe(mal, recommended, fetch=mal.manga_details)
    nodes = [r["node"] for r in recommended]
    if len(nodes) < MIN_ROW // 2:
        return None
    return _row("similar", nodes, about=MangaCard.from_node(about))


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

    async def similar() -> MangaHomeRow | None:
        for row in reading:
            about = await mal.manga_details(row.manga_id)
            if user.show_nsfw or is_safe(about):
                return await _similar_row(mal, about, user.show_nsfw)
        return None

    continue_items, listed, alike, genre_rows, *rankings = await asyncio.gather(
        asyncio.gather(*(card(r) for r in reading)),
        _my_list(request, user),
        similar(),
        _genre_rows(mal, user.show_nsfw),
        *(mal.manga_ranking(row, user.show_nsfw) for row in HOME_ROWS),
        return_exceptions=True,
    )
    rows: list[MangaHomeRow] = []
    if isinstance(continue_items, list):
        items = [item for item in continue_items if item is not None]
        if items:
            rows.append(MangaHomeRow(id="continue_reading", items=items))
    if isinstance(listed, BaseException):
        log.warning("manga home: my list row failed: %s", listed)
    elif listed:
        rows.append(MangaHomeRow(id="my_list", items=[MangaHomeItem(manga=c) for c in listed]))
    if isinstance(alike, BaseException):
        log.warning("manga home: similar row failed: %s", alike)
    elif alike is not None:
        rows.append(alike)
    ranked: dict[str, MangaHomeRow] = {}
    for row_id, ranking in zip(HOME_ROWS, rankings, strict=True):
        if isinstance(ranking, BaseException):
            log.warning("manga home: %s row failed: %s", row_id, ranking)
            continue
        nodes, _ = ranking
        if nodes:
            ranked[row_id] = _row(row_id, nodes)
    if isinstance(genre_rows, BaseException):
        log.warning("manga home: genre rows failed: %s", genre_rows)
        genre_rows = []
    # The rankings first, then the day's genres between the regional rows and the favorites,
    # so the page changes from one visit to the next without losing its anchors.
    half = len(genre_rows) // 2
    order: list[MangaHomeRow | None] = [
        ranked.get("top"),
        ranked.get("popular"),
        *genre_rows[:half],
        ranked.get("manhwa"),
        ranked.get("manhua"),
        *genre_rows[half:],
        ranked.get("favorites"),
    ]
    rows.extend(row for row in order if row is not None)
    if not rows:
        raise ApiError(502, "mal_unavailable", "MyAnimeList did not answer")
    return MangaHomeOut(rows=rows)


async def _my_list(request: Request, user: User) -> list[MangaCard]:
    """What the user is reading and plans to read, from their MAL manga list, when linked."""
    async with new_session() as session:
        if await session.get(MalLink, user.id) is None:
            return []
        accounts = request.app.state.mal_accounts
        reading = (await accounts.mangalist(session, user, "reading"))["data"]
        planned = (await accounts.mangalist(session, user, "plan_to_read"))["data"]
    return _cards([i["node"] for i in (*reading, *planned)])


@router.get("/search", response_model=MangaListOut)
async def search(
    request: Request, user: CurrentUser, q: Annotated[str, Query(min_length=1, max_length=100)]
):
    return MangaListOut(data=_cards(await _mal(request).manga_search(q, user.show_nsfw)))


@router.get("/genres", response_model=list[GenreOut])
async def genres(user: CurrentUser):
    """MAL's genres are shared by anime and manga, ids included."""
    return [
        GenreOut(id=g.id, name=g.name, kind=g.kind, nsfw=g.nsfw)
        for g in GENRES
        if user.show_nsfw or not g.nsfw
    ]


@router.get("/browse", response_model=MangaBrowseOut)
async def browse(
    request: Request,
    user: CurrentUser,
    row: Row = "top",
    genre: Annotated[int | None, Query(description="MAL genre id, see /manga/genres")] = None,
    page: Annotated[int, Query(ge=1, le=25)] = 1,
):
    assert row in MANGA_RANKINGS
    if genre is not None:
        known = GENRE_IDS.get(genre)
        if known is None or (known.nsfw and not user.show_nsfw):
            raise ApiError(422, "validation_failed", "Unknown genre")
    nodes, has_next = await _mal(request).manga_browse(row, genre, page, user.show_nsfw)
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
    request: Request,
    manga_id: int,
    chapter: Annotated[str, PathParam(min_length=1, max_length=16)],
    body: MangaProgressIn,
    user: CurrentUser,
    session: Session,
):
    page_index = min(body.page, body.pages - 1)
    completed = body.completed or page_index >= body.pages - 1
    was_done = await session.scalar(
        select(MangaProgress.completed).where(
            MangaProgress.user_id == user.id,
            MangaProgress.manga_id == manga_id,
            MangaProgress.chapter == chapter,
        )
    )
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
    number = chapter_number(chapter)
    if row.completed and not was_done and number is not None:
        tasks: set = request.app.state.__dict__.setdefault("mal_sync_tasks", set())
        task = asyncio.create_task(_sync_mal(request, user.id, manga_id, number))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    return progress_out(row)


async def _sync_mal(request: Request, user_id: uuid.UUID, manga_id: int, chapter: int) -> None:
    """Best effort, after the save has been answered: a MAL hiccup must never affect reading."""
    try:
        total = int((await _mal(request).manga_details(manga_id)).get("num_chapters") or 0)
        async with new_session() as session:
            user = await session.get(User, user_id)
            if user is not None:
                await request.app.state.mal_accounts.sync_finished_chapter(
                    session, user, manga_id, chapter, total
                )
    except Exception:
        log.warning("MAL sync failed for manga %s ch %s", manga_id, chapter, exc_info=True)


def new_page_cache(directory: str, max_mb: int) -> PageCache:
    return PageCache(Path(directory), max_mb * 1024 * 1024)
