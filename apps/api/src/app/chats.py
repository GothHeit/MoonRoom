"""Live updates and phone notifications for Messages.

Live updates: each open Messages tab keeps one server-sent events stream (`/chats/events`), and
this hub hands every event to the streams of the people it concerns. The hub lives in this
process, which is enough while the API runs as one process; with several, it would publish
through Redis instead (the same shape: a channel per user).

Phone notifications don't go through the bell: a chat would bury everything else there. A message
is pushed a few seconds after it is sent, and only to members who haven't read it by then, so
someone with the chat open on their screen gets no notification for it."""

import asyncio
import logging
import uuid
from collections.abc import Iterable
from typing import Any

import httpx
from sqlalchemy import select

from app import push
from app.config import Settings
from app.db import new_session
from app.models import Chat, ChatMember, ChatMessage, PushSubscription, User

log = logging.getLogger(__name__)

# Events a slow stream may hold before it is told to load everything again instead.
QUEUE_SIZE = 200
PUSH_DELAY_SECONDS = 4.0
EXCERPT = 140

Event = tuple[str, dict[str, Any]]


class ChatHub:
    def __init__(self) -> None:
        self._streams: dict[uuid.UUID, set[asyncio.Queue[Event | None]]] = {}

    def subscribe(self, user_id: uuid.UUID) -> asyncio.Queue[Event | None]:
        queue: asyncio.Queue[Event | None] = asyncio.Queue(QUEUE_SIZE)
        self._streams.setdefault(user_id, set()).add(queue)
        return queue

    def unsubscribe(self, user_id: uuid.UUID, queue: asyncio.Queue[Event | None]) -> None:
        streams = self._streams.get(user_id)
        if streams is None:
            return
        streams.discard(queue)
        if not streams:
            del self._streams[user_id]

    def publish(self, user_ids: Iterable[uuid.UUID], kind: str, data: dict[str, Any]) -> None:
        for user_id in set(user_ids):
            for queue in self._streams.get(user_id, ()):
                try:
                    queue.put_nowait((kind, data))
                except asyncio.QueueFull:
                    # Too far behind to catch up event by event: start over from a clean list.
                    while not queue.empty():
                        queue.get_nowait()
                    queue.put_nowait(("resync", {}))

    def close_all(self) -> None:
        for streams in self._streams.values():
            for queue in streams:
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(None)
        self._streams.clear()


# ---------------------------------------------------------------- phone notifications

_SHARED = {
    "en": ("Sent you {title}", "Sent {title}"),
    "pt": ("Te mandou {title}", "Mandou {title}"),
}
_ADULT = {"en": "a +18 title", "pt": "um título +18"}
_PART = {"en": ("Ep {n}", "Ch. {n}"), "pt": ("Ep. {n}", "Cap. {n}")}


def excerpt(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= EXCERPT else flat[: EXCERPT - 1].rstrip() + "…"


def share_label(message: ChatMessage, lang: str) -> str:
    """ "Frieren · Ep 4", "Dandadan · Ch. 112" or the title alone."""
    ep, ch = _PART[lang]
    part = (
        ep.format(n=message.episode)
        if message.episode is not None
        else ch.format(n=message.chapter)
        if message.chapter is not None
        else None
    )
    return " · ".join(p for p in (message.share_title or "", part) if p)


def compose(
    message: ChatMessage, chat_name: str | None, sender: str, locale: str, show_adult: bool = True
) -> push.Message:
    """What the phone shows: the friend (or the group) as the title, the message as the body.
    An adult title isn't named to someone who hides adult titles."""
    lang = locale if locale in _SHARED else "pt"
    direct, group = _SHARED[lang]
    if message.body:
        text = excerpt(message.body)
    else:
        label = (
            _ADULT[lang] if message.share_adult and not show_adult else share_label(message, lang)
        )
        text = (direct if chat_name is None else group).format(title=label)
    if chat_name is None:
        title, body = sender, text
    else:
        title, body = chat_name, f"{sender}: {text}"
    return push.Message(
        title=title,
        body=body,
        url=f"/{lang}/messages/{message.chat_id}",
        # Newer messages in the same chat replace the earlier notification.
        tag=f"chat:{message.chat_id}",
    )


def group_title(chat: Chat, names: list[str]) -> str:
    return chat.name or ", ".join(sorted(names))


async def push_message(
    http: httpx.AsyncClient, settings: Settings, message_id: uuid.UUID, delay: float
) -> None:
    await asyncio.sleep(delay)
    async with new_session() as session:
        message = await session.get(ChatMessage, message_id)
        if message is None:
            return
        chat = await session.get(Chat, message.chat_id)
        if chat is None:
            return
        members = list(
            (
                await session.execute(
                    select(ChatMember, User)
                    .join(User, User.id == ChatMember.user_id)
                    .where(ChatMember.chat_id == chat.id)
                )
            ).all()
        )
        sender = next((u.username for m, u in members if u.id == message.user_id), None)
        if sender is None:
            sender = await session.scalar(select(User.username).where(User.id == message.user_id))
        others = [
            (m, u)
            for m, u in members
            if u.id != message.user_id and not m.muted and m.last_read_at < message.created_at
        ]
        if not others:
            return
        subs: dict[uuid.UUID, list[PushSubscription]] = {}
        for sub in await session.scalars(
            select(PushSubscription).where(PushSubscription.user_id.in_([u.id for _, u in others]))
        ):
            subs.setdefault(sub.user_id, []).append(sub)
        names = {u.id: u.username for _, u in members}
        session.expunge_all()
    for _, user in others:
        user_subs = subs.get(user.id)
        if not user_subs:
            continue
        chat_name = (
            None
            if chat.kind == "direct"
            else group_title(chat, [n for i, n in names.items() if i != user.id])
        )
        note = compose(message, chat_name, sender or "", user.locale, user.show_nsfw)
        await push.deliver(http, settings, user_subs, note)


class ChatPusher:
    """Runs the delayed pushes and keeps hold of them so none is dropped half way."""

    def __init__(self, http: httpx.AsyncClient, settings: Settings) -> None:
        self._http = http
        self._settings = settings
        self._tasks: set[asyncio.Task[None]] = set()
        self.delay = PUSH_DELAY_SECONDS

    @property
    def enabled(self) -> bool:
        return bool(self._settings.vapid_private_key)

    def schedule(self, message_id: uuid.UUID) -> None:
        if not self.enabled:
            return
        task = asyncio.create_task(self._run(message_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, message_id: uuid.UUID) -> None:
        try:
            await push_message(self._http, self._settings, message_id, self.delay)
        except Exception:
            log.exception("chat push failed")

    async def drain(self) -> None:
        """Waits for the scheduled pushes (tests)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    def cancel(self) -> None:
        for task in list(self._tasks):
            task.cancel()
