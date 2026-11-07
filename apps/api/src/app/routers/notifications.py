import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert

from app.db import utcnow
from app.deps import CurrentUser, Session
from app.errors import ApiError
from app.models import Notification, NotificationMute
from app.notifications import KINDS, RETENTION
from app.rooms import Rooms
from app.routers.friends import UserSummary, summaries

router = APIRouter(prefix="/notifications", tags=["notifications"])

MAX_LIST = 50


class NotificationOut(BaseModel):
    id: str
    kind: str
    created_at: datetime
    read: bool
    actor: UserSummary | None
    anime_id: int | None
    manga_id: int | None
    episode: int | None
    title: str | None
    room_code: str | None
    # For room invites: whether the room is still open to join.
    room_active: bool | None


class NotificationsOut(BaseModel):
    items: list[NotificationOut]
    unread: int


class SettingsOut(BaseModel):
    muted: list[str]


class SettingsIn(BaseModel):
    muted: list[str]


def _recent():
    return Notification.created_at > utcnow() - RETENTION


@router.get("", response_model=NotificationsOut)
async def list_notifications(
    request: Request,
    user: CurrentUser,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=MAX_LIST)] = 20,
):
    rows = list(
        await session.scalars(
            select(Notification)
            .where(Notification.user_id == user.id, _recent())
            .order_by(Notification.created_at.desc())
            .limit(limit)
        )
    )
    unread = await session.scalar(
        select(func.count())
        .select_from(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None), _recent())
    )
    people = await summaries(session, list({r.actor_id for r in rows if r.actor_id}))
    rooms: Rooms = request.app.state.rooms

    def room_open(code: str) -> bool:
        try:
            rooms.get(code)
        except ApiError:
            return False
        return True

    return NotificationsOut(
        items=[
            NotificationOut(
                id=str(r.id),
                kind=r.kind,
                created_at=r.created_at,
                read=r.read_at is not None,
                actor=people.get(r.actor_id) if r.actor_id else None,
                anime_id=r.anime_id,
                manga_id=r.manga_id,
                episode=r.episode,
                title=r.title,
                room_code=r.room_code,
                room_active=room_open(r.room_code)
                if r.kind == "room_invite" and r.room_code
                else None,
            )
            for r in rows
        ],
        unread=unread or 0,
    )


@router.get("/settings", response_model=SettingsOut)
async def get_settings(user: CurrentUser, session: Session):
    muted = await session.scalars(
        select(NotificationMute.kind).where(NotificationMute.user_id == user.id)
    )
    return SettingsOut(muted=sorted(muted))


@router.put("/settings", response_model=SettingsOut)
async def put_settings(body: SettingsIn, user: CurrentUser, session: Session):
    """Replaces the list of kinds the user does not want."""
    unknown = set(body.muted) - set(KINDS)
    if unknown:
        raise ApiError(422, "unknown_kind", f"Unknown notification kind: {sorted(unknown)[0]}")
    await session.execute(delete(NotificationMute).where(NotificationMute.user_id == user.id))
    if body.muted:
        # Two tabs saving at once must not trip over each other's rows.
        await session.execute(
            insert(NotificationMute)
            .values([{"user_id": user.id, "kind": k} for k in set(body.muted)])
            .on_conflict_do_nothing()
        )
    await session.commit()
    return SettingsOut(muted=sorted(set(body.muted)))


@router.post("/read", status_code=204)
async def read_all(user: CurrentUser, session: Session):
    await session.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=utcnow())
    )
    await session.commit()


@router.post("/{notification_id}/read", status_code=204)
async def read_one(notification_id: uuid.UUID, user: CurrentUser, session: Session):
    await session.execute(
        update(Notification)
        .where(
            Notification.id == notification_id,
            Notification.user_id == user.id,
            Notification.read_at.is_(None),
        )
        .values(read_at=utcnow())
    )
    await session.commit()


@router.delete("/{notification_id}", status_code=204)
async def dismiss(notification_id: uuid.UUID, user: CurrentUser, session: Session):
    await session.execute(
        delete(Notification).where(
            Notification.id == notification_id, Notification.user_id == user.id
        )
    )
    await session.commit()
