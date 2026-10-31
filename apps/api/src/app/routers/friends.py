import asyncio
import logging
import uuid
from collections.abc import Awaitable
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
from app.deps import CurrentUser, Session
from app.errors import ApiError
from app.mal.client import MalClient, is_safe
from app.models import Friendship, MalLink, User, WatchProgress
from app.notifications import forget_pair, notify, withdraw
from app.routers.progress import latest_per_anime
from app.schemas import AnimeCard

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


class RequestIn(BaseModel):
    username: str = Field(min_length=1, max_length=32)


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


async def _soft[T](work: Awaitable[T]) -> T | None:
    try:
        return await work
    except (ApiError, ValueError) as exc:
        log.warning("friends: details unavailable: %s", exc)
        return None


async def _cards(mal: MalClient, ids: list[int], allow_nsfw: bool) -> dict[int, AnimeCard]:
    """Cards for the titles MAL can describe, leaving out adult ones for a viewer who hides them."""
    found = await asyncio.gather(*(_soft(mal.details(i)) for i in ids))
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


@router.get("/users/lookup", response_model=LookupOut)
async def lookup(
    username: Annotated[str, Query(min_length=1, max_length=32)],
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


@router.post("/friends/requests", response_model=LookupOut, status_code=201)
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
    return out
