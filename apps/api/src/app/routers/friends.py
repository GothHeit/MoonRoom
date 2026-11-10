import asyncio
import logging
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased

from app.avatars import AvatarOut, avatar_out
from app.db import utcnow
from app.deps import CurrentUser, Session, throttle
from app.errors import ApiError
from app.mal.client import MalClient, is_safe
from app.models import Friendship, MalLink, MangaProgress, User, WatchProgress
from app.notifications import forget_pair, notify, withdraw
from app.routers.progress import latest_per_anime
from app.schemas import AnimeCard, Genre, MangaCard
from app.soft import soft

router = APIRouter(tags=["friends"])
log = logging.getLogger(__name__)

MAX_PENDING_SENT = 50
MAX_FEED = 40

Relation = Literal["self", "none", "friends", "outgoing", "incoming"]


class UserSummary(BaseModel):
    """Enough to tell who someone is: shown to anyone signed in, friend or not."""

    id: str
    username: str
    avatar: AvatarOut


class LookupOut(BaseModel):
    user: UserSummary
    relation: Relation


class FriendOut(BaseModel):
    user: UserSummary
    since: datetime


class RequestOut(BaseModel):
    user: UserSummary
    sent_at: datetime


class RequestsOut(BaseModel):
    incoming: list[RequestOut]
    outgoing: list[RequestOut]


# Looked up with the surrounding spaces trimmed; the characters are the registration alphabet.
LOOKUP_NAME = r"^\s*[A-Za-z0-9_]{1,32}\s*$"


class RequestIn(BaseModel):
    username: str = Field(pattern=LOOKUP_NAME, max_length=64)


class ActivityOut(BaseModel):
    """A friend's latest finished episode of one title."""

    user: UserSummary
    anime: AnimeCard
    episode: int
    at: datetime


class ProfileTitle(BaseModel):
    anime: AnimeCard
    episode: int
    completed: bool


class ProfileStats(BaseModel):
    titles: int
    episodes: int
    friends: int


class ProfileMangaTitle(BaseModel):
    manga: MangaCard
    chapter: str
    page: int
    pages: int
    completed: bool
    at: datetime


class ProfileMangaStats(BaseModel):
    titles: int
    chapters: int


class ProfileOut(BaseModel):
    user: UserSummary
    relation: Literal["self", "friends"]
    joined_at: datetime
    friends_since: datetime | None
    # The four below are None when the user chose not to share their activity.
    friends: int | None
    activity_shared: bool
    stats: ProfileStats | None
    watching: list[ProfileTitle] | None
    recent: list[ActivityOut] | None
    # Manga, same rules: None when activity is private. `manga_genres` are the most common
    # genres among the titles shown above, most common first.
    manga_stats: ProfileMangaStats | None = None
    reading: list[ProfileMangaTitle] | None = None
    recent_manga: list[ProfileMangaTitle] | None = None
    manga_genres: list[Genre] | None = None


# ---------------------------------------------------------------- helpers


def _pair(a: uuid.UUID, b: uuid.UUID):
    return or_(
        and_(Friendship.requester_id == a, Friendship.addressee_id == b),
        and_(Friendship.requester_id == b, Friendship.addressee_id == a),
    )


async def _friendship(session: Session, a: uuid.UUID, b: uuid.UUID) -> Friendship | None:
    return await session.scalar(select(Friendship).where(_pair(a, b)))


def _relation(me: uuid.UUID, row: Friendship | None) -> Relation:
    if row is None:
        return "none"
    if row.accepted:
        return "friends"
    return "outgoing" if row.requester_id == me else "incoming"


async def friend_ids(session: Session, user_id: uuid.UUID) -> list[uuid.UUID]:
    rows = await session.execute(
        select(Friendship.requester_id, Friendship.addressee_id).where(
            Friendship.accepted.is_(True),
            or_(Friendship.requester_id == user_id, Friendship.addressee_id == user_id),
        )
    )
    return [b if a == user_id else a for a, b in rows]


async def sharing_friend_ids(session: Session, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Friends who let others see what they watch."""
    ids = await friend_ids(session, user_id)
    if not ids:
        return []
    return list(
        await session.scalars(
            select(User.id).where(User.id.in_(ids), User.share_activity.is_(True))
        )
    )


async def summaries(session: Session, ids: list[uuid.UUID]) -> dict[uuid.UUID, UserSummary]:
    if not ids:
        return {}
    rows = await session.execute(
        select(User, MalLink.mal_picture)
        .outerjoin(MalLink, MalLink.user_id == User.id)
        .where(User.id.in_(ids))
    )
    return {u.id: user_summary(u, picture) for u, picture in rows}


def user_summary(user: User, mal_picture: str | None = None) -> UserSummary:
    return UserSummary(
        id=str(user.id), username=user.username, avatar=avatar_out(user, mal_picture)
    )


async def _cards(mal: MalClient, ids: list[int], allow_nsfw: bool) -> dict[int, AnimeCard]:
    """Cards for the titles MAL can describe, leaving out adult ones for a viewer who hides them."""
    found = await asyncio.gather(*(soft(mal.details(i), "friends: details") for i in ids))
    return {
        i: AnimeCard.from_node(node)
        for i, node in zip(ids, found, strict=True)
        if node is not None and (allow_nsfw or is_safe(node))
    }


async def _activity(
    request: Request, viewer: User, session: Session, authors: list[uuid.UUID], limit: int
) -> list[ActivityOut]:
    """The latest finished episode of each title, per author, newest first."""
    if not authors:
        return []
    newest = (
        select(WatchProgress)
        .where(WatchProgress.user_id.in_(authors), WatchProgress.completed.is_(True))
        .ext(distinct_on(WatchProgress.user_id, WatchProgress.anime_id))
        .order_by(WatchProgress.user_id, WatchProgress.anime_id, WatchProgress.updated_at.desc())
        .subquery()
    )
    row = aliased(WatchProgress, newest)
    # Twice the limit, so titles dropped for the viewer's adult filter don't leave the feed short.
    candidates = list(
        await session.scalars(select(row).order_by(row.updated_at.desc()).limit(limit * 2))
    )
    people = await summaries(session, list({r.user_id for r in candidates}))
    await session.commit()  # MAL lookups below: don't hold a connection through them
    cards = await _cards(
        request.app.state.mal, list({r.anime_id for r in candidates}), viewer.show_nsfw
    )
    return [
        ActivityOut(
            user=people[r.user_id], anime=cards[r.anime_id], episode=r.episode, at=r.updated_at
        )
        for r in candidates
        if r.anime_id in cards and r.user_id in people
    ][:limit]


# ---------------------------------------------------------------- lookup and requests


@router.get("/users/lookup", response_model=LookupOut, dependencies=[throttle("user_lookup")])
async def lookup(
    username: Annotated[str, Query(pattern=LOOKUP_NAME, max_length=64)],
    user: CurrentUser,
    session: Session,
):
    """Finds someone by exact username. Name and picture are public to members, so a request can
    go to the right person."""
    found = await session.scalar(select(User).where(User.username == username.strip().lower()))
    if found is None:
        raise ApiError(404, "user_not_found", "No user with that name")
    picture = await session.scalar(select(MalLink.mal_picture).where(MalLink.user_id == found.id))
    row = None if found.id == user.id else await _friendship(session, user.id, found.id)
    relation: Relation = "self" if found.id == user.id else _relation(user.id, row)
    return LookupOut(user=user_summary(found, picture), relation=relation)


async def _ask(session: Session, user: User, target: User) -> None:
    existing = await _friendship(session, user.id, target.id)
    if existing is not None:
        if existing.accepted:
            raise ApiError(409, "already_friends", "You are already friends")
        if existing.requester_id == user.id:
            raise ApiError(409, "already_requested", "You already asked this person")
        existing.accepted = True
        existing.accepted_at = utcnow()
        await withdraw(session, user.id, "friend_request", target.id)
        await notify(session, target.id, "friend_accepted", actor_id=user.id)
        return
    pending = await session.scalar(
        select(func.count())
        .select_from(Friendship)
        .where(Friendship.requester_id == user.id, Friendship.accepted.is_(False))
    )
    if (pending or 0) >= MAX_PENDING_SENT:
        raise ApiError(429, "too_many_requests", "Too many pending requests")
    session.add(Friendship(requester_id=user.id, addressee_id=target.id))
    await notify(session, target.id, "friend_request", actor_id=user.id)


@router.post(
    "/friends/requests",
    response_model=LookupOut,
    status_code=201,
    dependencies=[throttle("friend_request")],
)
async def send_request(body: RequestIn, user: CurrentUser, session: Session):
    """Asks to be friends. If they already asked you, this accepts their request."""
    target = await session.scalar(
        select(User).where(User.username == body.username.strip().lower())
    )
    if target is None:
        raise ApiError(404, "user_not_found", "No user with that name")
    if target.id == user.id:
        raise ApiError(422, "friend_self", "You can't add yourself")
    for attempt in range(2):
        try:
            await _ask(session, user, target)
            await session.commit()
            break
        except IntegrityError:
            # The other side asked at the same moment. Go again, so their request is accepted.
            await session.rollback()
            if attempt:
                raise ApiError(409, "already_requested", "A request already exists") from None
            # A rollback expires everything the session holds.
            await session.refresh(user)
            await session.refresh(target)
    row = await _friendship(session, user.id, target.id)
    picture = await session.scalar(select(MalLink.mal_picture).where(MalLink.user_id == target.id))
    return LookupOut(user=user_summary(target, picture), relation=_relation(user.id, row))


@router.get("/friends/requests", response_model=RequestsOut)
async def list_requests(user: CurrentUser, session: Session):
    rows = list(
        await session.scalars(
            select(Friendship)
            .where(
                Friendship.accepted.is_(False),
                or_(Friendship.requester_id == user.id, Friendship.addressee_id == user.id),
            )
            .order_by(Friendship.created_at.desc())
        )
    )
    people = await summaries(
        session, [r.addressee_id if r.requester_id == user.id else r.requester_id for r in rows]
    )
    incoming = [
        RequestOut(user=people[r.requester_id], sent_at=r.created_at)
        for r in rows
        if r.addressee_id == user.id
    ]
    outgoing = [
        RequestOut(user=people[r.addressee_id], sent_at=r.created_at)
        for r in rows
        if r.requester_id == user.id
    ]
    return RequestsOut(incoming=incoming, outgoing=outgoing)


@router.post("/friends/requests/{user_id}/accept", response_model=FriendOut)
async def accept_request(user_id: uuid.UUID, user: CurrentUser, session: Session):
    row = await session.get(Friendship, (user_id, user.id))
    if row is None:
        raise ApiError(404, "request_not_found", "No request from this person")
    if not row.accepted:
        row.accepted = True
        row.accepted_at = utcnow()
        await withdraw(session, user.id, "friend_request", user_id)
        await notify(session, user_id, "friend_accepted", actor_id=user.id)
        await session.commit()
    people = await summaries(session, [user_id])
    return FriendOut(user=people[user_id], since=row.accepted_at or row.created_at)


@router.delete("/friends/requests/{user_id}", status_code=204)
async def remove_request(user_id: uuid.UUID, user: CurrentUser, session: Session):
    """Declines a request sent to you, or takes back one you sent."""
    row = await _friendship(session, user.id, user_id)
    if row is None or row.accepted:
        raise ApiError(404, "request_not_found", "No pending request")
    # Whoever the request was for no longer needs to hear about it.
    await withdraw(session, row.addressee_id, "friend_request", row.requester_id)
    await session.delete(row)
    await session.commit()


# ---------------------------------------------------------------- friends


@router.get("/friends", response_model=list[FriendOut])
async def list_friends(user: CurrentUser, session: Session):
    rows = list(
        await session.scalars(
            select(Friendship).where(
                Friendship.accepted.is_(True),
                or_(Friendship.requester_id == user.id, Friendship.addressee_id == user.id),
            )
        )
    )
    other = {r: r.addressee_id if r.requester_id == user.id else r.requester_id for r in rows}
    people = await summaries(session, list(other.values()))
    out = [
        FriendOut(user=people[other[r]], since=r.accepted_at or r.created_at)
        for r in rows
        if other[r] in people
    ]
    return sorted(out, key=lambda f: f.user.username)


@router.delete("/friends/{user_id}", status_code=204)
async def unfriend(user_id: uuid.UUID, user: CurrentUser, session: Session):
    row = await _friendship(session, user.id, user_id)
    if row is None or not row.accepted:
        raise ApiError(404, "friend_not_found", "Not your friend")
    await session.delete(row)
    await forget_pair(session, user.id, user_id)
    await session.commit()


@router.get("/friends/activity", response_model=list[ActivityOut])
async def friends_activity(
    request: Request,
    user: CurrentUser,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=MAX_FEED)] = 20,
):
    """What friends finished watching lately; friends who keep it private are left out."""
    sharing = await sharing_friend_ids(session, user.id)
    return await _activity(request, user, session, sharing, limit)


# ---------------------------------------------------------------- profiles


@router.get("/users/{user_id}/profile", response_model=ProfileOut)
async def profile(
    request: Request, user_id: Annotated[uuid.UUID, Path()], user: CurrentUser, session: Session
):
    """A profile is for the person and their friends only; anyone else gets a 403."""
    target = user if user_id == user.id else await session.get(User, user_id)
    if target is None:
        raise ApiError(404, "user_not_found", "No such user")
    relation: Literal["self", "friends"] = "self"
    since = None
    if target.id != user.id:
        row = await _friendship(session, user.id, target.id)
        if row is None or not row.accepted:
            raise ApiError(403, "not_friends", "Only friends can see this profile")
        relation = "friends"
        since = row.accepted_at or row.created_at
    picture = await session.scalar(select(MalLink.mal_picture).where(MalLink.user_id == target.id))
    friend_count = len(await friend_ids(session, target.id))
    shared = target.share_activity or relation == "self"
    out = ProfileOut(
        user=user_summary(target, picture),
        relation=relation,
        joined_at=target.created_at,
        friends_since=since,
        friends=None,
        activity_shared=target.share_activity,
        stats=None,
        watching=None,
        recent=None,
    )
    if not shared:
        return out
    titles, episodes = (
        await session.execute(
            select(
                func.count(func.distinct(WatchProgress.anime_id)),
                func.count().filter(WatchProgress.completed.is_(True)),
            ).where(WatchProgress.user_id == target.id)
        )
    ).one()
    out.friends = friend_count
    out.stats = ProfileStats(titles=titles, episodes=episodes, friends=friend_count)
    progress = await latest_per_anime(session, target.id, 8)
    await session.commit()  # MAL lookups below: don't hold a connection through them
    cards = await _cards(
        request.app.state.mal, list({p.anime_id for p in progress}), user.show_nsfw
    )
    out.watching = [
        ProfileTitle(anime=cards[p.anime_id], episode=p.episode, completed=p.completed)
        for p in progress
        if p.anime_id in cards
    ]
    out.recent = await _activity(request, user, session, [target.id], 10)
    await _manga_profile(request, user, session, target.id, out)
    return out


async def _manga_profile(
    request: Request, viewer: User, session: Session, target_id: uuid.UUID, out: ProfileOut
) -> None:
    """The manga half of a profile: totals, what they are reading, the last chapter finished."""
    from app.routers.manga import latest_per_manga  # manga -> home -> friends: import late

    titles, chapters = (
        await session.execute(
            select(
                func.count(func.distinct(MangaProgress.manga_id)),
                func.count().filter(MangaProgress.completed.is_(True)),
            ).where(MangaProgress.user_id == target_id)
        )
    ).one()
    out.manga_stats = ProfileMangaStats(titles=titles, chapters=chapters)
    reading = await latest_per_manga(session, target_id, 8)
    finished = (
        select(MangaProgress)
        .where(MangaProgress.user_id == target_id, MangaProgress.completed.is_(True))
        .ext(distinct_on(MangaProgress.manga_id))
        .order_by(MangaProgress.manga_id, MangaProgress.updated_at.desc())
        .subquery()
    )
    recent_rows = (
        await session.execute(select(finished).order_by(finished.c.updated_at.desc()).limit(10))
    ).all()
    await session.commit()  # MAL lookups below: don't hold a connection through them
    ids = list({*(r.manga_id for r in reading), *(r.manga_id for r in recent_rows)})
    mal = request.app.state.mal
    found = await asyncio.gather(*(soft(mal.manga_details(i), "profile: manga") for i in ids))
    cards = {
        i: MangaCard.from_node(node)
        for i, node in zip(ids, found, strict=True)
        if node is not None and (viewer.show_nsfw or is_safe(node))
    }

    def title(r) -> ProfileMangaTitle:
        return ProfileMangaTitle(
            manga=cards[r.manga_id],
            chapter=r.chapter,
            page=r.page,
            pages=r.pages,
            completed=r.completed,
            at=r.updated_at,
        )

    out.reading = [title(r) for r in reading if r.manga_id in cards]
    out.recent_manga = [title(r) for r in recent_rows if r.manga_id in cards]
    counts: dict[int, tuple[Genre, int]] = {}
    for card in cards.values():
        for g in card.genres:
            counts[g.id] = (g, counts.get(g.id, (g, 0))[1] + 1)
    ranked = sorted(counts.values(), key=lambda gc: (-gc[1], gc[0].name))
    out.manga_genres = [g for g, _ in ranked[:4]]
