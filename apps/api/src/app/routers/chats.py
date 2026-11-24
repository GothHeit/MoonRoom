"""Messages: chats between friends and small group chats, with titles shared as cards.

A direct chat is between two friends; if they unfriend, its history stays readable but nobody
can write in it until they are friends again. A group is made by someone from their friends,
and any member can add their own friends to it. Everyone sees only the chats they are in."""

import asyncio
import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import and_, delete, func, select, tuple_, update
from sqlalchemy.dialects.postgresql import distinct_on, insert

from app.avatars import AvatarOut
from app.chats import ChatHub, ChatPusher
from app.db import utcnow
from app.deps import CurrentUser, Session, throttle
from app.errors import ApiError
from app.ids import INT_MAX, MAX_EPISODE
from app.mal.client import is_safe
from app.models import Chat, ChatMember, ChatMessage, User
from app.routers.comments import clean_body
from app.routers.friends import UserSummary, friend_ids, summaries
from app.routers.rooms import KEEPALIVE_SECONDS, _frame, _stream_user
from app.soft import soft

router = APIRouter(prefix="/chats", tags=["chats"])

MAX_BODY = 2000
MAX_GROUP = 12
MAX_NAME = 60
MAX_PAGE = 50
# People and chats one share can go to at once.
MAX_TARGETS = 10
# The unread count a chat shows; past it the web shows "99+".
MAX_UNREAD = 99
_CHAPTER = re.compile(r"^\d{1,6}(\.\d{1,3})?$")


# ---------------------------------------------------------------- shapes


class ShareIn(BaseModel):
    """A title to share, or one of its episodes (anime) or chapters (manga)."""

    kind: Literal["anime", "manga"]
    id: int = Field(ge=1, le=INT_MAX)
    episode: int | None = Field(default=None, ge=1, le=MAX_EPISODE)
    chapter: str | None = Field(default=None, max_length=10)

    @model_validator(mode="after")
    def _part_matches_kind(self) -> "ShareIn":
        if self.kind == "anime" and self.chapter is not None:
            raise ValueError("An anime has episodes, not chapters")
        if self.kind == "manga" and self.episode is not None:
            raise ValueError("A manga has chapters, not episodes")
        if self.chapter is not None and not _CHAPTER.fullmatch(self.chapter):
            raise ValueError("Bad chapter number")
        return self


class ShareOut(BaseModel):
    kind: Literal["anime", "manga"]
    id: int
    episode: int | None
    chapter: str | None
    title: str
    # A wide picture (episode still or title art) and the poster; None when there is none or
    # the title is adult and the viewer hides adult titles.
    image: str | None
    poster: str | None
    # An adult title shown to someone who hides adult titles: no name, id or art, only that
    # something was shared.
    hidden: bool = False


class MessageOut(BaseModel):
    id: str
    chat_id: str
    user: UserSummary
    body: str | None
    share: ShareOut | None
    created_at: datetime
    mine: bool


class ChatOut(BaseModel):
    id: str
    kind: Literal["direct", "group"]
    # A group's own name; None for a direct chat or a group nobody named.
    name: str | None
    # Everyone in it but the viewer.
    members: list[UserSummary]
    muted: bool
    # Messages from others the viewer hasn't read, up to 99.
    unread: int
    last: MessageOut | None
    last_message_at: datetime
    # False in a direct chat with someone who is no longer a friend.
    can_send: bool
    # Direct chats: up to when the other person has read, for a "Seen" line.
    read_at: datetime | None


class ChatList(BaseModel):
    items: list[ChatOut]


class UnreadOut(BaseModel):
    # Chats (not muted) with something unread.
    chats: int


class MessagesPage(BaseModel):
    # Oldest first.
    items: list[MessageOut]
    # Pass as `before` to get older messages; None when there are none.
    next: str | None


class DirectIn(BaseModel):
    user_id: uuid.UUID


class GroupIn(BaseModel):
    name: str | None = Field(default=None, max_length=MAX_NAME * 2)
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_GROUP)


class GroupEdit(BaseModel):
    name: str | None = Field(default=None, max_length=MAX_NAME * 2)


class MembersIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_GROUP)


class MuteIn(BaseModel):
    muted: bool


class MessageIn(BaseModel):
    body: str | None = Field(default=None, max_length=MAX_BODY * 2)
    share: ShareIn | None = None


class ShareToIn(BaseModel):
    share: ShareIn
    # An optional note sent with the card.
    body: str | None = Field(default=None, max_length=MAX_BODY * 2)
    chat_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_TARGETS)
    # Friends to send to in their direct chat (made when there is none yet).
    user_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_TARGETS)


class SentOut(BaseModel):
    chat_ids: list[str]


# ---------------------------------------------------------------- helpers


def _hub(request: Request) -> ChatHub:
    return request.app.state.chat_hub


def _pusher(request: Request) -> ChatPusher:
    return request.app.state.chat_pusher


def _direct_key(a: uuid.UUID, b: uuid.UUID) -> str:
    low, high = sorted((str(a), str(b)))
    return f"{low}:{high}"


def _clean_text(raw: str | None) -> str | None:
    """The message text cleaned like a comment, or None when there is no text."""
    if raw is None:
        return None
    try:
        return clean_body(raw, MAX_BODY, "message_too_long")
    except ApiError as exc:
        if exc.code == "comment_empty":
            return None
        raise


def _clean_name(raw: str | None) -> str | None:
    if raw is None:
        return None
    name = " ".join(raw.split())
    if len(name) > MAX_NAME:
        raise ApiError(422, "name_too_long", f"Keep the name under {MAX_NAME} characters")
    return name or None


async def _membership(session: Session, user: User, chat_id: uuid.UUID) -> tuple[Chat, ChatMember]:
    row = (
        await session.execute(
            select(Chat, ChatMember)
            .join(ChatMember, ChatMember.chat_id == Chat.id)
            .where(Chat.id == chat_id, ChatMember.user_id == user.id)
        )
    ).first()
    if row is None:
        raise ApiError(404, "chat_not_found", "Chat not found")
    return row[0], row[1]


async def _member_ids(session: Session, chat_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        await session.scalars(select(ChatMember.user_id).where(ChatMember.chat_id == chat_id))
    )


async def _can_send(session: Session, user: User, chat: Chat, members: list[uuid.UUID]) -> bool:
    if chat.kind == "group":
        return True
    others = [m for m in members if m != user.id]
    return bool(others) and others[0] in await friend_ids(session, user.id)


def _share_out(row: ChatMessage, viewer: User) -> ShareOut | None:
    if row.anime_id is None and row.manga_id is None:
        return None
    hide = row.share_adult and not viewer.show_nsfw
    return ShareOut(
        kind="anime" if row.anime_id is not None else "manga",
        id=0 if hide else row.anime_id if row.anime_id is not None else row.manga_id or 0,
        episode=row.episode,
        chapter=row.chapter,
        title="" if hide else row.share_title or "",
        image=None if hide else row.share_image,
        poster=None if hide else row.share_poster,
        hidden=hide,
    )


def _message_out(row: ChatMessage, author: UserSummary, viewer: User) -> MessageOut:
    return MessageOut(
        id=str(row.id),
        chat_id=str(row.chat_id),
        user=author,
        body=row.body,
        share=_share_out(row, viewer),
        created_at=row.created_at,
        mine=row.user_id == viewer.id,
    )


def _unknown(user_id: uuid.UUID) -> UserSummary:
    return UserSummary(id=str(user_id), username="?", avatar=AvatarOut(kind="none"))


async def _chat_outs(
    session: Session, user: User, chats: list[tuple[Chat, ChatMember]]
) -> list[ChatOut]:
    if not chats:
        return []
    ids = [c.id for c, _ in chats]
    members: dict[uuid.UUID, list[tuple[uuid.UUID, datetime]]] = {}
    for chat_id, member_id, read_at in await session.execute(
        select(ChatMember.chat_id, ChatMember.user_id, ChatMember.last_read_at).where(
            ChatMember.chat_id.in_(ids)
        )
    ):
        members.setdefault(chat_id, []).append((member_id, read_at))
    # The newest message of each chat.
    last_rows = {
        m.chat_id: m
        for m in await session.scalars(
            select(ChatMessage)
            .ext(distinct_on(ChatMessage.chat_id))
            .join(
                ChatMember,
                and_(ChatMember.chat_id == ChatMessage.chat_id, ChatMember.user_id == user.id),
            )
            .where(ChatMessage.chat_id.in_(ids), ChatMessage.created_at >= ChatMember.joined_at)
            .order_by(ChatMessage.chat_id, ChatMessage.created_at.desc(), ChatMessage.id.desc())
        )
    }
    unread_counts: dict[uuid.UUID, int] = {}
    for chat_id, count in await session.execute(
        select(ChatMessage.chat_id, func.count())
        .join(
            ChatMember,
            and_(ChatMember.chat_id == ChatMessage.chat_id, ChatMember.user_id == user.id),
        )
        .where(
            ChatMessage.chat_id.in_(ids),
            ChatMessage.user_id != user.id,
            ChatMessage.created_at > ChatMember.last_read_at,
            ChatMessage.created_at >= ChatMember.joined_at,
        )
        .group_by(ChatMessage.chat_id)
    ):
        unread_counts[chat_id] = count
    people = {m for rows in members.values() for m, _ in rows}
    people |= {m.user_id for m in last_rows.values()}
    names = await summaries(session, list(people))
    friends = set(await friend_ids(session, user.id))
    out = []
    for chat, mine in chats:
        rows = members.get(chat.id, [])
        others = [(m, at) for m, at in rows if m != user.id]
        last = last_rows.get(chat.id)
        can_send = chat.kind == "group" or (bool(others) and others[0][0] in friends)
        out.append(
            ChatOut(
                id=str(chat.id),
                kind="direct" if chat.kind == "direct" else "group",
                name=chat.name,
                members=sorted(
                    (names.get(m) or _unknown(m) for m, _ in others),
                    key=lambda s: s.username,
                ),
                muted=mine.muted,
                unread=min(unread_counts.get(chat.id, 0), MAX_UNREAD),
                last=(
                    _message_out(last, names.get(last.user_id) or _unknown(last.user_id), user)
                    if last is not None
                    else None
                ),
                last_message_at=chat.last_message_at,
                can_send=can_send,
                read_at=others[0][1] if chat.kind == "direct" and others else None,
            )
        )
    return out


async def _chat_out(session: Session, user: User, chat: Chat, member: ChatMember) -> ChatOut:
    return (await _chat_outs(session, user, [(chat, member)]))[0]


def _announce(request: Request, members: list[uuid.UUID], chat_id: uuid.UUID) -> None:
    """Something about the chat other than a new message changed (name, members)."""
    _hub(request).publish(members, "chat", {"chat_id": str(chat_id)})


async def _direct_with(session: Session, user: User, other_id: uuid.UUID) -> tuple[Chat, bool]:
    """The direct chat with a friend, made if needed. The bool says whether it is new."""
    if other_id == user.id:
        raise ApiError(422, "chat_self", "You can't message yourself")
    if other_id not in await friend_ids(session, user.id):
        raise ApiError(403, "not_friends", "You can only message friends")
    key = _direct_key(user.id, other_id)
    chat = await session.scalar(select(Chat).where(Chat.direct_key == key))
    if chat is not None:
        return chat, False
    now = utcnow()
    inserted = await session.scalar(
        insert(Chat)
        .values(
            id=uuid.uuid4(),
            kind="direct",
            direct_key=key,
            created_by=user.id,
            created_at=now,
            last_message_at=now,
        )
        .on_conflict_do_nothing(index_elements=["direct_key"])
        .returning(Chat.id)
    )
    if inserted is None:
        # Made by the other person at the same moment.
        chat = await session.scalar(select(Chat).where(Chat.direct_key == key))
        assert chat is not None
        return chat, False
    for member in (user.id, other_id):
        session.add(ChatMember(chat_id=inserted, user_id=member, joined_at=now, last_read_at=now))
    await session.flush()
    chat = await session.get(Chat, inserted)
    assert chat is not None
    return chat, True


async def _resolve_share(request: Request, share: ShareIn) -> dict:
    """The title's name and art, from MyAnimeList and ani.zip, never from the client."""
    mal = request.app.state.mal
    if share.kind == "anime":
        node = await soft(mal.details(share.id), "chats: anime details")
    else:
        node = await soft(mal.manga_details(share.id), "chats: manga details")
    if not node or not node.get("title"):
        raise ApiError(502, "title_unavailable", "That title can't be shared right now")
    picture = node.get("main_picture") or {}
    poster = picture.get("large") or picture.get("medium")
    image = None
    if share.kind == "anime":
        art = await soft(request.app.state.anizip.art(share.id), "chats: art")
        if art is not None:
            still = art.episodes.get(share.episode) if share.episode is not None else None
            image = (still.image if still else None) or art.backdrop
    return {
        "anime_id": share.id if share.kind == "anime" else None,
        "manga_id": share.id if share.kind == "manga" else None,
        "episode": share.episode,
        "chapter": share.chapter,
        "share_title": str(node["title"])[:300],
        "share_image": image if image and len(image) <= 500 else None,
        "share_poster": poster if poster and len(poster) <= 500 else None,
        "share_adult": not is_safe(node),
    }


async def _post(
    request: Request,
    session: Session,
    user: User,
    chat: Chat,
    body: str | None,
    share: dict | None,
) -> ChatMessage:
    """Saves a message, marks the chat read for its sender and tells everyone in it."""
    now = utcnow()
    row = ChatMessage(chat_id=chat.id, user_id=user.id, body=body, created_at=now, **(share or {}))
    session.add(row)
    chat.last_message_at = now
    await session.execute(
        update(ChatMember)
        .where(ChatMember.chat_id == chat.id, ChatMember.user_id == user.id)
        .values(last_read_at=now)
    )
    await session.flush()
    return row


async def _broadcast(request: Request, session: Session, rows: list[ChatMessage]) -> None:
    """After the commit: live events for everyone in each chat, and the delayed phone push."""
    if not rows:
        return
    chat_ids = {r.chat_id for r in rows}
    members: dict[uuid.UUID, list[uuid.UUID]] = {}
    for chat_id, member in await session.execute(
        select(ChatMember.chat_id, ChatMember.user_id).where(ChatMember.chat_id.in_(chat_ids))
    ):
        members.setdefault(chat_id, []).append(member)
    viewers = {
        u.id: u
        for u in await session.scalars(
            select(User).where(User.id.in_({m for ms in members.values() for m in ms}))
        )
    }
    authors = await summaries(session, list({r.user_id for r in rows}))
    hub = _hub(request)
    for row in rows:
        author = authors.get(row.user_id) or _unknown(row.user_id)
        for member in members.get(row.chat_id, []):
            viewer = viewers.get(member)
            if viewer is None:
                continue
            hub.publish(
                [member], "message", _message_out(row, author, viewer).model_dump(mode="json")
            )
        _pusher(request).schedule(row.id)


def _encode(row: ChatMessage) -> str:
    return f"{row.created_at.isoformat()}_{row.id}"


def _decode(raw: str) -> tuple[datetime, uuid.UUID]:
    stamp, _, ident = raw.rpartition("_")
    try:
        at = datetime.fromisoformat(stamp)
        if at.tzinfo is None:
            raise ValueError
        return at, uuid.UUID(ident)
    except ValueError:
        raise ApiError(422, "validation_failed", "Bad page cursor") from None


# ---------------------------------------------------------------- chats


@router.get("", response_model=ChatList)
async def list_chats(user: CurrentUser, session: Session):
    """The viewer's chats, most recent message first."""
    rows = (
        await session.execute(
            select(Chat, ChatMember)
            .join(ChatMember, ChatMember.chat_id == Chat.id)
            .where(ChatMember.user_id == user.id)
            .order_by(Chat.last_message_at.desc(), Chat.id)
        )
    ).all()
    chats = [(c, m) for c, m in rows]
    return ChatList(items=await _chat_outs(session, user, chats))


@router.get("/unread", response_model=UnreadOut)
async def unread(user: CurrentUser, session: Session):
    """For the badge on the Messages icon."""
    count = await session.scalar(
        select(func.count(func.distinct(ChatMessage.chat_id)))
        .join(
            ChatMember,
            and_(ChatMember.chat_id == ChatMessage.chat_id, ChatMember.user_id == user.id),
        )
        .where(
            ChatMember.muted.is_(False),
            ChatMessage.user_id != user.id,
            ChatMessage.created_at > ChatMember.last_read_at,
            ChatMessage.created_at >= ChatMember.joined_at,
        )
    )
    return UnreadOut(chats=count or 0)


@router.get("/events", response_class=StreamingResponse)
async def events(request: Request, user: Annotated[User, Depends(_stream_user)]):
    """Server-sent events for every chat the viewer is in: `message` (a MessageOut), `deleted`
    ({chat_id, message_id}), `read` ({chat_id, user_id, at}), `chat` ({chat_id}: its name or
    members changed, or it is new), `left` ({chat_id}: the viewer is no longer in it), `resync`
    (load everything again) and `tick` to keep the line open."""
    hub = _hub(request)

    async def stream():
        queue = hub.subscribe(user.id)
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), KEEPALIVE_SECONDS)
                except TimeoutError:
                    yield _frame("tick", {})
                    continue
                if item is None:
                    return
                yield _frame(*item)
        finally:
            hub.unsubscribe(user.id, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.post("/direct", response_model=ChatOut, dependencies=[throttle("chat_create")])
async def open_direct(body: DirectIn, request: Request, user: CurrentUser, session: Session):
    """The chat with a friend, made the first time."""
    chat, new = await _direct_with(session, user, body.user_id)
    await session.commit()
    if new:
        _announce(request, [user.id, body.user_id], chat.id)
    _, member = await _membership(session, user, chat.id)
    return await _chat_out(session, user, chat, member)


@router.post(
    "/groups", response_model=ChatOut, status_code=201, dependencies=[throttle("chat_create")]
)
async def create_group(body: GroupIn, request: Request, user: CurrentUser, session: Session):
    people = {u for u in body.user_ids if u != user.id}
    if not people:
        raise ApiError(422, "group_empty", "Pick at least one friend")
    if len(people) + 1 > MAX_GROUP:
        raise ApiError(422, "group_full", f"A group has at most {MAX_GROUP} people")
    if people - set(await friend_ids(session, user.id)):
        raise ApiError(403, "not_friends", "You can only add friends")
    now = utcnow()
    chat = Chat(
        kind="group",
        name=_clean_name(body.name),
        created_by=user.id,
        created_at=now,
        last_message_at=now,
    )
    session.add(chat)
    await session.flush()
    for person in (user.id, *people):
        session.add(ChatMember(chat_id=chat.id, user_id=person, joined_at=now, last_read_at=now))
    await session.commit()
    _announce(request, [user.id, *people], chat.id)
    _, member = await _membership(session, user, chat.id)
    return await _chat_out(session, user, chat, member)


@router.get("/{chat_id}", response_model=ChatOut)
async def get_chat(chat_id: uuid.UUID, user: CurrentUser, session: Session):
    chat, member = await _membership(session, user, chat_id)
    return await _chat_out(session, user, chat, member)


@router.patch("/{chat_id}", response_model=ChatOut, dependencies=[throttle("chat_create")])
async def rename_group(
    chat_id: uuid.UUID, body: GroupEdit, request: Request, user: CurrentUser, session: Session
):
    """Any member can name a group, or clear its name."""
    chat, member = await _membership(session, user, chat_id)
    if chat.kind != "group":
        raise ApiError(409, "not_a_group", "Only groups have names")
    chat.name = _clean_name(body.name)
    await session.commit()
    _announce(request, await _member_ids(session, chat.id), chat.id)
    return await _chat_out(session, user, chat, member)


@router.post("/{chat_id}/members", response_model=ChatOut, dependencies=[throttle("chat_create")])
async def add_members(
    chat_id: uuid.UUID, body: MembersIn, request: Request, user: CurrentUser, session: Session
):
    """Adds friends of the viewer to a group."""
    chat, member = await _membership(session, user, chat_id)
    if chat.kind != "group":
        raise ApiError(409, "not_a_group", "A direct chat is between two people")
    current = set(await _member_ids(session, chat.id))
    new = set(body.user_ids) - current
    if new - set(await friend_ids(session, user.id)):
        raise ApiError(403, "not_friends", "You can only add friends")
    if len(current | new) > MAX_GROUP:
        raise ApiError(422, "group_full", f"A group has at most {MAX_GROUP} people")
    now = utcnow()
    for person in new:
        session.add(ChatMember(chat_id=chat.id, user_id=person, joined_at=now, last_read_at=now))
    await session.commit()
    _announce(request, list(current | new), chat.id)
    return await _chat_out(session, user, chat, member)


@router.delete("/{chat_id}/members/me", status_code=204, dependencies=[throttle("chat_create")])
async def leave_group(chat_id: uuid.UUID, request: Request, user: CurrentUser, session: Session):
    """Leaves a group; the last one out deletes it. A direct chat can't be left."""
    chat, _ = await _membership(session, user, chat_id)
    if chat.kind != "group":
        raise ApiError(409, "not_a_group", "A direct chat can't be left")
    await session.execute(
        delete(ChatMember).where(ChatMember.chat_id == chat.id, ChatMember.user_id == user.id)
    )
    rest = await _member_ids(session, chat.id)
    if not rest:
        await session.execute(delete(Chat).where(Chat.id == chat.id))
    await session.commit()
    _hub(request).publish([user.id], "left", {"chat_id": str(chat.id)})
    _announce(request, rest, chat.id)


@router.put("/{chat_id}/mute", status_code=204)
async def mute(chat_id: uuid.UUID, body: MuteIn, user: CurrentUser, session: Session):
    _, member = await _membership(session, user, chat_id)
    member.muted = body.muted
    await session.commit()


@router.put("/{chat_id}/read", status_code=204)
async def mark_read(chat_id: uuid.UUID, request: Request, user: CurrentUser, session: Session):
    """Marks everything in the chat read, and tells the others (for the "Seen" line)."""
    _, member = await _membership(session, user, chat_id)
    now = utcnow()
    member.last_read_at = now
    await session.commit()
    _hub(request).publish(
        await _member_ids(session, chat_id),
        "read",
        {"chat_id": str(chat_id), "user_id": str(user.id), "at": now.isoformat()},
    )


# ---------------------------------------------------------------- messages


@router.get("/{chat_id}/messages", response_model=MessagesPage)
async def messages(
    chat_id: uuid.UUID,
    user: CurrentUser,
    session: Session,
    before: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 30,
):
    """The newest messages, or those before `before`; each page is oldest first."""
    # Someone added to a group sees what was said from then on, not what came before.
    _, member = await _membership(session, user, chat_id)
    query = select(ChatMessage).where(
        ChatMessage.chat_id == chat_id, ChatMessage.created_at >= member.joined_at
    )
    if before is not None:
        at, ident = _decode(before)
        query = query.where(tuple_(ChatMessage.created_at, ChatMessage.id) < tuple_(at, ident))
    rows = list(
        await session.scalars(
            query.order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc()).limit(limit + 1)
        )
    )
    more = len(rows) > limit
    rows = rows[:limit]
    authors = await summaries(session, list({r.user_id for r in rows}))
    items = [_message_out(r, authors.get(r.user_id) or _unknown(r.user_id), user) for r in rows]
    items.reverse()
    return MessagesPage(items=items, next=_encode(rows[-1]) if more else None)


@router.post(
    "/{chat_id}/messages",
    response_model=MessageOut,
    status_code=201,
    dependencies=[throttle("chat_message")],
)
async def send(
    chat_id: uuid.UUID, body: MessageIn, request: Request, user: CurrentUser, session: Session
):
    chat, _ = await _membership(session, user, chat_id)
    text = _clean_text(body.body)
    if text is None and body.share is None:
        raise ApiError(422, "message_empty", "Write something first")
    if not await _can_send(session, user, chat, await _member_ids(session, chat.id)):
        raise ApiError(403, "not_friends", "You can only message friends")
    share = await _resolve_share(request, body.share) if body.share is not None else None
    row = await _post(request, session, user, chat, text, share)
    await session.commit()
    await _broadcast(request, session, [row])
    author = (await summaries(session, [user.id]))[user.id]
    return _message_out(row, author, user)


@router.delete("/{chat_id}/messages/{message_id}", status_code=204)
async def unsend(
    chat_id: uuid.UUID,
    message_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    session: Session,
):
    """Takes back one of the viewer's own messages, for everyone."""
    chat, _ = await _membership(session, user, chat_id)
    row = await session.get(ChatMessage, message_id)
    if row is None or row.chat_id != chat.id or row.user_id != user.id:
        raise ApiError(404, "message_not_found", "Message not found")
    await session.delete(row)
    await session.commit()
    _hub(request).publish(
        await _member_ids(session, chat.id),
        "deleted",
        {"chat_id": str(chat.id), "message_id": str(message_id)},
    )


@router.post(
    "/share", response_model=SentOut, status_code=201, dependencies=[throttle("chat_message")]
)
async def share_to(body: ShareToIn, request: Request, user: CurrentUser, session: Session):
    """Sends a title (or an episode or chapter) as a card, with an optional note, to several
    chats and friends at once."""
    chat_ids = list(dict.fromkeys(body.chat_ids))
    user_ids = list(dict.fromkeys(body.user_ids))
    if not chat_ids and not user_ids:
        raise ApiError(422, "no_targets", "Pick at least one friend or group")
    if len(chat_ids) + len(user_ids) > MAX_TARGETS:
        raise ApiError(422, "too_many_targets", f"Send to at most {MAX_TARGETS} at once")
    text = _clean_text(body.body)
    targets: dict[uuid.UUID, Chat] = {}
    created: list[tuple[uuid.UUID, uuid.UUID]] = []
    for chat_id in chat_ids:
        chat, _ = await _membership(session, user, chat_id)
        if not await _can_send(session, user, chat, await _member_ids(session, chat.id)):
            raise ApiError(403, "not_friends", "You can only message friends")
        targets[chat.id] = chat
    for other in user_ids:
        chat, new = await _direct_with(session, user, other)
        targets[chat.id] = chat
        if new:
            created.append((chat.id, other))
    share = await _resolve_share(request, body.share)
    rows = [await _post(request, session, user, chat, text, share) for chat in targets.values()]
    await session.commit()
    for chat_id, other in created:
        _announce(request, [user.id, other], chat_id)
    await _broadcast(request, session, rows)
    return SentOut(chat_ids=[str(c) for c in targets])
