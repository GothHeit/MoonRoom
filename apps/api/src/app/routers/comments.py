"""Comments on titles, episodes and chapters, their replies and reactions, and which friends are
watching or reading a title.

A comment is seen by its author and the author's friends only, so two people looking at the
same title can see different comments. Comments on an episode or chapter stay hidden until the
viewer has finished it, so nobody reads about a scene they haven't seen."""

import logging
import re
import unicodedata
import uuid
from collections import defaultdict
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, delete, func, select, tuple_, update
from sqlalchemy.dialects.postgresql import distinct_on, insert

from app.db import utcnow
from app.deps import CurrentUser, Session, throttle
from app.errors import ApiError
from app.ids import AnimeId, MangaId, PlayableEpisode
from app.models import (
    CommentReaction,
    MalLink,
    MangaProgress,
    Notification,
    TitleComment,
    User,
    WatchProgress,
)
from app.notifications import notify
from app.routers.friends import UserSummary, friend_ids, sharing_friend_ids, summaries

log = logging.getLogger(__name__)

router = APIRouter(tags=["comments"])

MAX_BODY = 1000
MAX_PAGE = 50
# Replies shown under one comment; a conversation longer than this is cut, oldest kept.
MAX_REPLIES = 100
# A title page shows at most this many friends' progress.
MAX_FRIENDS = 12
# How many of the people who commented a locked episode is named.
MAX_PREVIEW = 3
EXCERPT = 140
# How long a viewer's MAL progress on one title is reused to decide locked or not, in seconds.
MAL_COUNT_TTL = 90

Reaction = Literal["heart", "laugh", "wow", "cry", "fire", "clap"]
REACTIONS: tuple[str, ...] = ("heart", "laugh", "wow", "cry", "fire", "clap")


class ReactionCount(BaseModel):
    kind: Reaction
    count: int
    # Whether the viewer left this one.
    mine: bool


class CommentOut(BaseModel):
    id: str
    user: UserSummary
    body: str
    spoiler: bool
    created_at: datetime
    edited_at: datetime | None
    mine: bool
    reactions: list[ReactionCount] = []
    # Oldest first. Always empty on a reply: replies go one level deep.
    replies: list["CommentOut"] = []


class CommentsPage(BaseModel):
    items: list[CommentOut]
    # Every comment (not reply) the viewer can see here, not only this page.
    total: int
    # Pass as `before` to get the next, older page; None when there is none.
    next: str | None


class PartComments(CommentsPage):
    """Comments on one episode or chapter. While the viewer hasn't finished it they are locked:
    `items` is empty and only how many there are and who wrote some are told."""

    locked: bool
    # The few friends (or you) who commented last, for a "junior and pondofe commented" line.
    people: list[UserSummary]


class CommentIn(BaseModel):
    body: str = Field(max_length=MAX_BODY * 2)
    spoiler: bool = False


class ReplyIn(BaseModel):
    body: str = Field(max_length=MAX_BODY * 2)


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


def clean_body(raw: str, limit: int = MAX_BODY, too_long: str = "comment_too_long") -> str:
    """Drops control and format characters (keeping line breaks), at most one blank line in a
    row, and the spaces around. Raises when nothing is left or it is longer than `limit`."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch for ch in text if ch in _KEEP or unicodedata.category(ch) not in _DROP)
    text = _BLANK_RUNS.sub("\n\n", text).strip()
    if not text:
        raise ApiError(422, "comment_empty", "Write something first")
    if len(text) > limit:
        raise ApiError(422, too_long, f"Keep it under {limit} characters")
    return text


def excerpt(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= EXCERPT else flat[: EXCERPT - 1].rstrip() + "…"


def _number(key: str) -> float | None:
    try:
        return float(key)
    except ValueError:
        return None


async def _visible_authors(session: Session, user: User) -> list[uuid.UUID]:
    return [user.id, *await friend_ids(session, user.id)]


# ---------------------------------------------------------------- finished or not


async def _mal_count(request: Request, session: Session, user: User, kind: str, title: int) -> int:
    """Episodes watched or chapters read on the user's MAL list; 0 when unlinked or MAL fails."""
    cache = request.app.state.shared_cache
    key = [str(user.id), kind, title]
    hit = await cache.get("comments-mal-count", key)
    if hit is not None:
        return int(hit)
    if await session.get(MalLink, user.id) is None:
        return 0
    try:
        entry = await request.app.state.mal_accounts.entry(session, user, title, kind)
    except Exception:
        log.warning("comments: MAL list entry for %s %s unavailable", kind, title)
        return 0
    field = "num_episodes_watched" if kind == "anime" else "num_chapters_read"
    count = int(entry.get(field) or 0) if entry else 0
    # Short, so a user who just updated MAL waits at most this long for a comment to unlock.
    await cache.set("comments-mal-count", key, count, MAL_COUNT_TTL)
    return count


async def finished_episode(
    request: Request, session: Session, user: User, anime_id: int, episode: int
) -> bool:
    """Whether the user is past this episode: finished it here, started a later one, or MAL
    counts it as watched."""
    rows = (
        await session.execute(
            select(WatchProgress.episode, WatchProgress.completed).where(
                WatchProgress.user_id == user.id,
                WatchProgress.anime_id == anime_id,
                WatchProgress.episode >= episode,
            )
        )
    ).all()
    if any(ep > episode or done for ep, done in rows):
        return True
    return await _mal_count(request, session, user, "anime", anime_id) >= episode


async def finished_chapter(
    request: Request, session: Session, user: User, manga_id: int, chapter: str
) -> bool:
    """Whether the user is past this chapter: finished it here, read a later one, or MAL
    counts it as read. Chapter keys are the progress keys ("12", "12.5", or an id)."""
    rows = (
        await session.execute(
            select(MangaProgress.chapter, MangaProgress.completed).where(
                MangaProgress.user_id == user.id, MangaProgress.manga_id == manga_id
            )
        )
    ).all()
    number = _number(chapter)
    for key, done in rows:
        if key == chapter and done:
            return True
        other = _number(key)
        if number is not None and other is not None and other > number:
            return True
    if number is None or number < 1:
        return False
    return await _mal_count(request, session, user, "manga", manga_id) >= int(number)


async def _can_read(request: Request, session: Session, user: User, row: TitleComment) -> bool:
    """Whether the viewer may see this comment and what hangs off it."""
    if row.user_id != user.id and row.user_id not in await friend_ids(session, user.id):
        return False
    if row.episode is not None and row.anime_id is not None:
        return await finished_episode(request, session, user, row.anime_id, row.episode)
    if row.chapter is not None and row.manga_id is not None:
        return await finished_chapter(request, session, user, row.manga_id, row.chapter)
    return True


# ---------------------------------------------------------------- reading


async def _reactions(
    session: Session, user: User, ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[ReactionCount]]:
    if not ids:
        return {}
    rows = (
        await session.execute(
            select(
                CommentReaction.comment_id,
                CommentReaction.kind,
                func.count(),
                func.bool_or(CommentReaction.user_id == user.id),
            )
            .where(CommentReaction.comment_id.in_(ids))
            .group_by(CommentReaction.comment_id, CommentReaction.kind)
        )
    ).all()
    out: dict[uuid.UUID, list[ReactionCount]] = defaultdict(list)
    for comment_id, kind, count, mine in rows:
        if kind in REACTIONS:
            out[comment_id].append(ReactionCount(kind=kind, count=count, mine=bool(mine)))
    for counts in out.values():
        counts.sort(key=lambda r: REACTIONS.index(r.kind))
    return out


async def _render(
    session: Session, user: User, rows: list[TitleComment], authors: list[uuid.UUID]
) -> list[CommentOut]:
    """The comments with their reactions and the replies the viewer can see."""
    replies: dict[uuid.UUID, list[TitleComment]] = defaultdict(list)
    if rows:
        for reply in await session.scalars(
            select(TitleComment)
            .where(
                TitleComment.parent_id.in_([r.id for r in rows]),
                TitleComment.user_id.in_(authors),
            )
            .order_by(TitleComment.created_at, TitleComment.id)
        ):
            if reply.parent_id is not None and len(replies[reply.parent_id]) < MAX_REPLIES:
                replies[reply.parent_id].append(reply)
    every = rows + [r for group in replies.values() for r in group]
    people = await summaries(session, list({r.user_id for r in every}))
    reactions = await _reactions(session, user, [r.id for r in every])

    def one(row: TitleComment, children: list[TitleComment]) -> CommentOut:
        out = _out(row, people[row.user_id], user)
        out.reactions = reactions.get(row.id, [])
        out.replies = [one(c, []) for c in children if c.user_id in people]
        return out

    return [one(r, replies.get(r.id, [])) for r in rows if r.user_id in people]


async def _page(
    session: Session,
    user: User,
    where: list[ColumnElement[bool]],
    before: str | None,
    limit: int,
) -> CommentsPage:
    authors = await _visible_authors(session, user)
    visible = [*where, TitleComment.parent_id.is_(None), TitleComment.user_id.in_(authors)]
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
    return CommentsPage(
        items=await _render(session, user, rows, authors),
        total=total or 0,
        next=encode_cursor(rows[-1]) if more and rows else None,
    )


async def _part_page(
    session: Session,
    user: User,
    where: list[ColumnElement[bool]],
    unlocked: bool,
    before: str | None,
    limit: int,
) -> PartComments:
    authors = await _visible_authors(session, user)
    visible = [*where, TitleComment.parent_id.is_(None), TitleComment.user_id.in_(authors)]
    latest = (
        select(TitleComment.user_id)
        .where(*visible)
        .group_by(TitleComment.user_id)
        .order_by(func.max(TitleComment.created_at).desc())
        .limit(MAX_PREVIEW)
    )
    ids = list(await session.scalars(latest))
    found = await summaries(session, ids)
    people = [found[i] for i in ids if i in found]
    if unlocked:
        page = await _page(session, user, where, before, limit)
        return PartComments(**page.model_dump(), locked=False, people=people)
    total = await session.scalar(select(func.count()).select_from(TitleComment).where(*visible))
    return PartComments(items=[], total=total or 0, next=None, locked=True, people=people)


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
    session: Session,
    user: User,
    body: CommentIn,
    anime_id: int | None,
    manga_id: int | None,
    episode: int | None = None,
    chapter: str | None = None,
) -> CommentOut:
    row = TitleComment(
        user_id=user.id,
        anime_id=anime_id,
        manga_id=manga_id,
        episode=episode,
        chapter=chapter,
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


async def _readable(
    request: Request, session: Session, user: User, comment_id: uuid.UUID
) -> TitleComment:
    row = await session.get(TitleComment, comment_id)
    if row is None or not await _can_read(request, session, user, row):
        raise ApiError(404, "comment_not_found", "No such comment")
    return row


def _locked() -> ApiError:
    return ApiError(403, "comments_locked", "Finish it first to join the conversation")


Before = Annotated[str | None, Query(max_length=100)]
Limit = Annotated[int, Query(ge=1, le=MAX_PAGE)]
ChapterKey = Annotated[str, Path(min_length=1, max_length=16, pattern=r"^[^\x00/]+$")]

_WHOLE_ANIME = [TitleComment.episode.is_(None)]
_WHOLE_MANGA = [TitleComment.chapter.is_(None)]


@router.get("/anime/{anime_id}/comments", response_model=CommentsPage)
async def anime_comments(
    anime_id: AnimeId, user: CurrentUser, session: Session, before: Before = None, limit: Limit = 3
):
    """Comments on the whole title, newest first. Only comments by you and your friends."""
    where = [TitleComment.anime_id == anime_id, *_WHOLE_ANIME]
    return await _page(session, user, where, before, limit)


@router.get("/manga/{manga_id}/comments", response_model=CommentsPage)
async def manga_comments(
    manga_id: MangaId, user: CurrentUser, session: Session, before: Before = None, limit: Limit = 3
):
    """Comments on the whole title, newest first. Only comments by you and your friends."""
    where = [TitleComment.manga_id == manga_id, *_WHOLE_MANGA]
    return await _page(session, user, where, before, limit)


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


@router.get("/anime/{anime_id}/episodes/{episode}/comments", response_model=PartComments)
async def episode_comments(
    request: Request,
    anime_id: AnimeId,
    episode: PlayableEpisode,
    user: CurrentUser,
    session: Session,
    before: Before = None,
    limit: Limit = 20,
):
    """Comments on one episode, newest first, readable once you've finished it."""
    unlocked = await finished_episode(request, session, user, anime_id, episode)
    where = [TitleComment.anime_id == anime_id, TitleComment.episode == episode]
    return await _part_page(session, user, where, unlocked, before, limit)


@router.get("/manga/{manga_id}/chapters/{chapter}/comments", response_model=PartComments)
async def chapter_comments(
    request: Request,
    manga_id: MangaId,
    chapter: ChapterKey,
    user: CurrentUser,
    session: Session,
    before: Before = None,
    limit: Limit = 20,
):
    """Comments on one chapter, newest first, readable once you've finished it."""
    unlocked = await finished_chapter(request, session, user, manga_id, chapter)
    where = [TitleComment.manga_id == manga_id, TitleComment.chapter == chapter]
    return await _part_page(session, user, where, unlocked, before, limit)


@router.post(
    "/anime/{anime_id}/episodes/{episode}/comments",
    response_model=CommentOut,
    status_code=201,
    dependencies=[throttle("comment")],
)
async def comment_on_episode(
    request: Request,
    anime_id: AnimeId,
    episode: PlayableEpisode,
    body: CommentIn,
    user: CurrentUser,
    session: Session,
):
    if not await finished_episode(request, session, user, anime_id, episode):
        raise _locked()
    return await _create(session, user, body, anime_id, None, episode=episode)


@router.post(
    "/manga/{manga_id}/chapters/{chapter}/comments",
    response_model=CommentOut,
    status_code=201,
    dependencies=[throttle("comment")],
)
async def comment_on_chapter(
    request: Request,
    manga_id: MangaId,
    chapter: ChapterKey,
    body: CommentIn,
    user: CurrentUser,
    session: Session,
):
    if not await finished_chapter(request, session, user, manga_id, chapter):
        raise _locked()
    return await _create(session, user, body, None, manga_id, chapter=chapter)


async def _title_name(request: Request, row: TitleComment) -> str | None:
    """The title's name for the bell, or None when MAL can't say right now."""
    mal = request.app.state.mal
    try:
        if row.anime_id is not None:
            return (await mal.details(row.anime_id)).get("title")
        if row.manga_id is not None:
            return (await mal.manga_details(row.manga_id)).get("title")
    except Exception:
        log.warning("comments: no title name for the reply notice")
    return None


@router.post(
    "/comments/{comment_id}/replies",
    response_model=CommentOut,
    status_code=201,
    dependencies=[throttle("comment")],
)
async def reply(
    request: Request, comment_id: uuid.UUID, body: ReplyIn, user: CurrentUser, session: Session
):
    """Answers a comment. A reply to a reply goes under the same comment."""
    parent = await _readable(request, session, user, comment_id)
    if parent.parent_id is not None:
        parent = await _readable(request, session, user, parent.parent_id)
    text = clean_body(body.body)
    # The title's name comes from MAL; end the transaction first so no connection waits on it.
    await session.commit()
    title = ((await _title_name(request, parent) or "")[:300]) or None
    row = TitleComment(
        user_id=user.id,
        anime_id=parent.anime_id,
        manga_id=parent.manga_id,
        episode=parent.episode,
        chapter=parent.chapter,
        parent_id=parent.id,
        body=text,
        spoiler=False,
    )
    session.add(row)
    await session.flush()
    if parent.user_id != user.id:
        await notify(
            session,
            parent.user_id,
            "comment_reply",
            actor_id=user.id,
            anime_id=parent.anime_id,
            manga_id=parent.manga_id,
            episode=parent.episode,
            chapter=parent.chapter,
            comment_id=parent.id,
            reply_id=row.id,
            excerpt=excerpt(text),
            title=title,
        )
    await session.commit()
    people = await summaries(session, [user.id])
    return _out(row, people[user.id], user)


@router.put(
    "/comments/{comment_id}/reactions/{kind}",
    response_model=list[ReactionCount],
    dependencies=[throttle("comment_reaction")],
)
async def react(
    request: Request, comment_id: uuid.UUID, kind: Reaction, user: CurrentUser, session: Session
):
    """Leaves a reaction. Leaving the same one twice changes nothing."""
    row = await _readable(request, session, user, comment_id)
    await session.execute(
        insert(CommentReaction)
        .values(comment_id=row.id, user_id=user.id, kind=kind)
        .on_conflict_do_nothing()
    )
    await session.commit()
    return (await _reactions(session, user, [row.id])).get(row.id, [])


@router.delete(
    "/comments/{comment_id}/reactions/{kind}",
    response_model=list[ReactionCount],
    dependencies=[throttle("comment_reaction")],
)
async def unreact(
    request: Request, comment_id: uuid.UUID, kind: Reaction, user: CurrentUser, session: Session
):
    row = await _readable(request, session, user, comment_id)
    await session.execute(
        delete(CommentReaction).where(
            CommentReaction.comment_id == row.id,
            CommentReaction.user_id == user.id,
            CommentReaction.kind == kind,
        )
    )
    await session.commit()
    return (await _reactions(session, user, [row.id])).get(row.id, [])


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
    if body.spoiler is not None and row.parent_id is None:
        row.spoiler = body.spoiler
    # Only a new text counts as an edit; marking a spoiler afterwards doesn't.
    if changed:
        row.edited_at = utcnow()
        if row.parent_id is not None:
            # The bell quotes the reply: keep it in step with what the reply now says.
            await session.execute(
                update(Notification)
                .where(Notification.reply_id == row.id)
                .values(excerpt=excerpt(row.body))
            )
    await session.commit()
    people = await summaries(session, [user.id])
    out = _out(row, people[user.id], user)
    out.reactions = (await _reactions(session, user, [row.id])).get(row.id, [])
    return out


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(comment_id: uuid.UUID, user: CurrentUser, session: Session):
    """Deletes your own comment, with the replies under it."""
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
