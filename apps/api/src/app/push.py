"""Sends phone notifications for what lands in the bell.

Every bell entry is created through `notifications.notify`, so the sender works from the table
instead of hooking each call site: a loop picks up entries nobody has pushed yet, which also
makes new kinds work without changes here (they only need a line in `_TEXT`)."""

import asyncio
import json
import logging
from dataclasses import dataclass

import httpx
from sqlalchemy import delete, select, update

from app import webpush
from app.config import Settings
from app.db import new_session, utcnow
from app.models import Notification, PushSubscription, User

log = logging.getLogger(__name__)

POLL_SECONDS = 10
# An entry older than this when the sender finds it (say, after downtime) is stale news.
MAX_AGE_SECONDS = 600
BATCH = 100
# Pushes in a row a push service may refuse before the subscription is dropped.
MAX_FAILURES = 5
MAX_PER_USER = 10

# kind -> locale -> (title or None for the app name, body). {name} is the person, {title} the
# anime or manga, {episode} the episode or chapter number.
_TEXT: dict[str, dict[str, tuple[str | None, str]]] = {
    "friend_request": {
        "en": (None, "{name} wants to be your friend"),
        "pt": (None, "{name} quer ser seu amigo"),
    },
    "friend_accepted": {
        "en": (None, "{name} accepted your friend request"),
        "pt": (None, "{name} aceitou seu pedido de amizade"),
    },
    "room_invite": {
        "en": (None, "{name} invited you to watch {title} together"),
        "pt": (None, "{name} convidou você para assistir {title} junto"),
    },
    "new_episode": {
        "en": ("{title}", "Episode {episode} is out"),
        "pt": ("{title}", "O episódio {episode} saiu"),
    },
    "new_chapter": {
        "en": ("{title}", "Chapter {episode} is out"),
        "pt": ("{title}", "O capítulo {episode} saiu"),
    },
}
_TEST = {
    "en": ("Notifications are on", "You'll hear about new episodes and friends here."),
    "pt": ("Notificações ativadas", "Você vai receber avisos de novos episódios e amigos aqui."),
}


@dataclass
class Message:
    title: str
    body: str
    url: str
    tag: str


def _path(n: Notification) -> str:
    match n.kind:
        case "friend_request":
            return "/friends"
        case "friend_accepted":
            return f"/u/{n.actor_id}" if n.actor_id else "/friends"
        case "room_invite":
            return f"/room/{n.room_code}" if n.room_code else "/"
        case "new_chapter":
            return f"/manga/{n.manga_id}" if n.manga_id else "/"
        case _:
            return f"/anime/{n.anime_id}" if n.anime_id else "/"


def compose(n: Notification, actor: str, locale: str, app_name: str) -> Message | None:
    """What to show for a bell entry, in the user's language; None for a kind with no text."""
    lang = locale if locale in ("en", "pt") else "pt"
    texts = _TEXT.get(n.kind)
    if texts is None:
        return None
    title, body = texts[lang]
    values = {
        "name": actor,
        "title": n.title or "",
        "episode": n.episode if n.episode is not None else "",
    }
    return Message(
        title=(title or app_name).format(**values),
        body=body.format(**values),
        url=f"/{lang}{_path(n)}",
        # A newer message of the same kind about the same thing replaces the earlier one.
        tag=f"{n.kind}:{n.anime_id or n.manga_id or n.room_code or n.actor_id or ''}",
    )


def test_message(locale: str, app_name: str) -> Message:
    title, body = _TEST[locale if locale in _TEST else "pt"]
    lang = locale if locale in _TEST else "pt"
    return Message(title=title, body=body, url=f"/{lang}/settings", tag=f"test:{app_name}")


def payload(message: Message) -> bytes:
    return json.dumps(
        {"title": message.title, "body": message.body, "url": message.url, "tag": message.tag},
        ensure_ascii=False,
    ).encode()


async def deliver(
    http: httpx.AsyncClient,
    settings: Settings,
    subscriptions: list[PushSubscription],
    message: Message,
) -> int:
    """Sends to each subscription, forgetting the dead ones. Returns how many were accepted."""
    body = payload(message)
    sent = 0
    for sub in subscriptions:
        status = await webpush.send(
            http,
            endpoint=sub.endpoint,
            p256dh=sub.p256dh,
            auth=sub.auth,
            payload=body,
            vapid_secret=settings.vapid_private_key,
            vapid_subject=settings.vapid_subject,
        )
        async with new_session() as session:
            if status in (404, 410):
                await session.execute(delete(PushSubscription).where(PushSubscription.id == sub.id))
            elif 200 <= status < 300:
                sent += 1
                await session.execute(
                    update(PushSubscription).where(PushSubscription.id == sub.id).values(failures=0)
                )
            else:
                log.warning("push: %s answered %s", _host(sub.endpoint), status)
                failed = sub.failures + 1
                if failed >= MAX_FAILURES:
                    await session.execute(
                        delete(PushSubscription).where(PushSubscription.id == sub.id)
                    )
                else:
                    await session.execute(
                        update(PushSubscription)
                        .where(PushSubscription.id == sub.id)
                        .values(failures=failed)
                    )
            await session.commit()
    return sent


def _host(endpoint: str) -> str:
    return endpoint.split("/")[2] if endpoint.count("/") >= 2 else "?"


async def push_pending(http: httpx.AsyncClient, settings: Settings) -> int:
    """One round: claims bell entries not pushed yet and sends them. Returns entries handled."""
    async with new_session() as session:
        rows = list(
            await session.scalars(
                select(Notification)
                .where(Notification.pushed_at.is_(None))
                .order_by(Notification.created_at)
                .limit(BATCH)
                # Another API process may be running this loop too.
                .with_for_update(skip_locked=True)
            )
        )
        if not rows:
            return 0
        now = utcnow()
        for row in rows:
            row.pushed_at = now
        await session.commit()
        # Claimed: a crash from here on loses a push rather than sending it twice.
        todo = [
            r
            for r in rows
            if r.read_at is None and (now - r.created_at).total_seconds() < MAX_AGE_SECONDS
        ]
        user_ids = {r.user_id for r in todo}
        actor_ids = {r.actor_id for r in todo if r.actor_id}
        locales = (
            dict(
                (
                    await session.execute(select(User.id, User.locale).where(User.id.in_(user_ids)))
                ).all()
            )
            if user_ids
            else {}
        )
        names = (
            dict(
                (
                    await session.execute(
                        select(User.id, User.username).where(User.id.in_(actor_ids))
                    )
                ).all()
            )
            if actor_ids
            else {}
        )
        subs: dict = {}
        if user_ids:
            for sub in await session.scalars(
                select(PushSubscription).where(PushSubscription.user_id.in_(user_ids))
            ):
                subs.setdefault(sub.user_id, []).append(sub)
        session.expunge_all()
    for row in todo:
        user_subs = subs.get(row.user_id)
        if not user_subs:
            continue
        message = compose(
            row,
            names.get(row.actor_id, "") if row.actor_id else "",
            locales.get(row.user_id, "pt"),
            settings.app_name,
        )
        if message is not None:
            await deliver(http, settings, user_subs, message)
    return len(rows)


async def run(http: httpx.AsyncClient, settings: Settings) -> None:
    while True:
        try:
            await push_pending(http, settings)
        except Exception:
            log.exception("phone notifications failed")
        await asyncio.sleep(POLL_SECONDS)
