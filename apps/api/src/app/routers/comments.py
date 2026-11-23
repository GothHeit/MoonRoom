"""Comments on title pages, and which friends are watching or reading a title.

A comment is seen by its author and the author's friends only, so two people looking at the
same title can see different comments."""

import re
import unicodedata
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, func, select, tuple_
from sqlalchemy.dialects.postgresql import distinct_on

from app.db import utcnow
from app.deps import CurrentUser, Session, throttle
from app.errors import ApiError
from app.ids import AnimeId, MangaId
from app.models import MangaProgress, TitleComment, User, WatchProgress
from app.routers.friends import UserSummary, friend_ids, sharing_friend_ids, summaries

router = APIRouter(tags=["comments"])

MAX_BODY = 1000
MAX_PAGE = 50
# A title page shows at most this many friends' progress.
MAX_FRIENDS = 12


class CommentOut(BaseModel):
    id: str
    user: UserSummary
    body: str
    spoiler: bool
    created_at: datetime
    edited_at: datetime | None
    mine: bool


class CommentsPage(BaseModel):
    items: list[CommentOut]
    # Every comment the viewer can see on this title, not only this page.
    total: int
    # Pass as `before` to get the next, older page; None when there is none.
    next: str | None


class CommentIn(BaseModel):
    body: str = Field(max_length=MAX_BODY * 2)
    spoiler: bool = False


class CommentEdit(BaseModel):
    body: str | None = Field(default=None, max_length=MAX_BODY * 2)
    spoiler: bool | None = None


class FriendWatching(BaseModel):
    user: UserSummary
    # The episode they were on last, and whether they finished it.
    episode: int
    completed: bool
    at: datetime


class FriendReading(BaseModel):
    user: UserSummary
    chapter: str
    completed: bool
    at: datetime


_BLANK_RUNS = re.compile(r"\n{3,}")
# Control, format (bidi marks, zero-width spaces) and lone surrogate characters are dropped,
# except line breaks and the zero-width joiner that glues emoji such as families together.
_DROP = ("Cc", "Cf", "Cs")
_KEEP = ("\n", "\u200d")


def encode_cursor(row: TitleComment) -> str:
    return f"{row.created_at.isoformat()}_{row.id}"


def decode_cursor(raw: str) -> tuple[datetime, uuid.UUID]:
    """The position after which the next page starts. It doesn't need the comment to still
    exist, so a page keeps working after a deletion or an unfriending."""
    stamp, _, ident = raw.rpartition("_")
    try:
        at = datetime.fromisoformat(stamp)
        if at.tzinfo is None:
            raise ValueError
        return at, uuid.UUID(ident)
    except ValueError:
        raise ApiError(422, "validation_failed", "Bad page cursor") from None


def clean_body(raw: str) -> str:
    """Drops control and format characters (keeping line breaks), at most one blank line in a
    row, and the spaces around. Raises when nothing is left or it is too long."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch for ch in text if ch in _KEEP or unicodedata.category(ch) not in _DROP)
    text = _BLANK_RUNS.sub("\n\n", text).strip()
    if not text:
        raise ApiError(422, "comment_empty", "Write something first")
    if len(text) > MAX_BODY:
        raise ApiError(422, "comment_too_long", f"Keep it under {MAX_BODY} characters")
    return text


async def _visible_authors(session: Session, user: User) -> list[uuid.UUID]:
    return [user.id, *await friend_ids(session, user.id)]


async def _page(
    session: Session,
    user: User,
    title: ColumnElement[bool],
    before: str | None,
    limit: int,
) -> CommentsPage:
    authors = await _visible_authors(session, user)
    visible = [title, TitleComment.user_id.in_(authors)]
    total = await session.scalar(select(func.count()).select_from(TitleComment).where(*visible))
    query = select(TitleComment).where(*visible)
    if before is not None:
        at, ident = decode_cursor(before)
        query = query.where(tuple_(TitleComment.created_at, TitleComment.id) < (at, ident))
    rows = list(
        await session.scalars(
            query.order_by(TitleComment.created_at.desc(), TitleComment.id.desc()).limit(limit + 1)
        )
    )
    more = len(rows) > limit
    rows = rows[:limit]
    people = await summaries(session, list({r.user_id for r in rows}))
    return CommentsPage(
        items=[_out(r, people[r.user_id], user) for r in rows if r.user_id in people],
        total=total or 0,
        next=encode_cursor(rows[-1]) if more and rows else None,
    )


def _out(row: TitleComment, author: UserSummary, viewer: User) -> CommentOut:
    return CommentOut(
        id=str(row.id),
        user=author,
        body=row.body,
        spoiler=row.spoiler,
        created_at=row.created_at,
        edited_at=row.edited_at,
        mine=row.user_id == viewer.id,
    )


async def _create(
    session: Session, user: User, body: CommentIn, anime_id: int | None, manga_id: int | None
) -> CommentOut:
    row = TitleComment(
        user_id=user.id,
        anime_id=anime_id,
        manga_id=manga_id,
        body=clean_body(body.body),
        spoiler=body.spoiler,
    )
    session.add(row)
    await session.commit()
    people = await summaries(session, [user.id])
    return _out(row, people[user.id], user)


async def _own(session: Session, user: User, comment_id: uuid.UUID) -> TitleComment:
    row = await session.get(TitleComment, comment_id)
    # Someone else's comment looks the same as a missing one: no hint it exists.
    if row is None or row.user_id != user.id:
        raise ApiError(404, "comment_not_found", "No such comment")
    return row


Before = Annotated[str | None, Query(max_length=100)]
Limit = Annotated[int, Query(ge=1, le=MAX_PAGE)]


@router.get("/anime/{anime_id}/comments", response_model=CommentsPage)
async def anime_comments(
    anime_id: AnimeId, user: CurrentUser, session: Session, before: Before = None, limit: Limit = 3
):
    """Newest first. Only comments by you and your friends."""
    return await _page(session, user, TitleComment.anime_id == anime_id, before, limit)


@router.get("/manga/{manga_id}/comments", response_model=CommentsPage)
async def manga_comments(
    manga_id: MangaId, user: CurrentUser, session: Session, before: Before = None, limit: Limit = 3
):
    """Newest first. Only comments by you and your friends."""
    return await _page(session, user, TitleComment.manga_id == manga_id, before, limit)


@router.post(
    "/anime/{anime_id}/comments",
    response_model=CommentOut,
    status_code=201,
    dependencies=[throttle("comment")],
)
async def comment_on_anime(anime_id: AnimeId, body: CommentIn, user: CurrentUser, session: Session):
    return await _create(session, user, body, anime_id, None)


@router.post(
    "/manga/{manga_id}/comments",
    response_model=CommentOut,
    status_code=201,
    dependencies=[throttle("comment")],
)
async def comment_on_manga(manga_id: MangaId, body: CommentIn, user: CurrentUser, session: Session):
    return await _create(session, user, body, None, manga_id)


@router.patch(
    "/comments/{comment_id}", response_model=CommentOut, dependencies=[throttle("comment")]
)
async def edit_comment(
    comment_id: uuid.UUID, body: CommentEdit, user: CurrentUser, session: Session
):
    """Changes your own comment's text or spoiler mark."""
    row = await _own(session, user, comment_id)
    changed = False
    if body.body is not None:
        text = clean_body(body.body)
        changed = text != row.body
        row.body = text
    if body.spoiler is not None:
        row.spoiler = body.spoiler
    # Only a new text counts as an edit; marking a spoiler afterwards doesn't.
    if changed:
        row.edited_at = utcnow()
    await session.commit()
    people = await summaries(session, [user.id])
    return _out(row, people[user.id], user)


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(comment_id: uuid.UUID, user: CurrentUser, session: Session):
    row = await _own(session, user, comment_id)
    await session.delete(row)
    await session.commit()


# ---------------------------------------------------------------- friends on a title


@router.get("/anime/{anime_id}/friends", response_model=list[FriendWatching])
async def anime_friends(anime_id: AnimeId, user: CurrentUser, session: Session):
    """Where each friend who shares their activity is in this title, most recent first."""
    sharing = await sharing_friend_ids(session, user.id)
    if not sharing:
        return []
    latest = (
        select(WatchProgress)
        .where(WatchProgress.anime_id == anime_id, WatchProgress.user_id.in_(sharing))
        .ext(distinct_on(WatchProgress.user_id))
        .order_by(WatchProgress.user_id, WatchProgress.updated_at.desc())
        .subquery()
    )
    rows = (
        await session.execute(
            select(latest).order_by(latest.c.updated_at.desc()).limit(MAX_FRIENDS)
        )
    ).all()
    people = await summaries(session, [r.user_id for r in rows])
    return [
        FriendWatching(
            user=people[r.user_id], episode=r.episode, completed=r.completed, at=r.updated_at
        )
        for r in rows
        if r.user_id in people
    ]


@router.get("/manga/{manga_id}/friends", response_model=list[FriendReading])
async def manga_friends(manga_id: MangaId, user: CurrentUser, session: Session):
    """Which chapter each friend who shares their activity was on last, most recent first."""
    sharing = await sharing_friend_ids(session, user.id)
    if not sharing:
        return []
    latest = (
        select(MangaProgress)
        .where(MangaProgress.manga_id == manga_id, MangaProgress.user_id.in_(sharing))
        .ext(distinct_on(MangaProgress.user_id))
        .order_by(MangaProgress.user_id, MangaProgress.updated_at.desc())
        .subquery()
    )
    rows = (
        await session.execute(
            select(latest).order_by(latest.c.updated_at.desc()).limit(MAX_FRIENDS)
        )
    ).all()
    people = await summaries(session, [r.user_id for r in rows])
    return [
        FriendReading(
            user=people[r.user_id], chapter=r.chapter, completed=r.completed, at=r.updated_at
        )
        for r in rows
        if r.user_id in people
    ]
