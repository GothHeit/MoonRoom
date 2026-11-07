from typing import Annotated

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select

from app import push as sender
from app import webpush
from app.config import get_settings
from app.deps import CurrentUser, Session, throttle
from app.errors import ApiError
from app.models import PushSubscription

router = APIRouter(prefix="/push", tags=["push"])


class PushConfig(BaseModel):
    enabled: bool
    # What the browser passes to pushManager.subscribe as applicationServerKey.
    public_key: str | None


class Keys(BaseModel):
    p256dh: str = Field(max_length=128)
    auth: str = Field(max_length=64)

    @field_validator("p256dh")
    @classmethod
    def _point(cls, value: str) -> str:
        try:
            raw = webpush.b64d(value)
        except ValueError as exc:
            raise ValueError("not base64") from exc
        if len(raw) != 65 or raw[0] != 4:
            raise ValueError("not an uncompressed P-256 point")
        return value

    @field_validator("auth")
    @classmethod
    def _secret(cls, value: str) -> str:
        try:
            raw = webpush.b64d(value)
        except ValueError as exc:
            raise ValueError("not base64") from exc
        if len(raw) != 16:
            raise ValueError("auth secret must be 16 bytes")
        return value


class SubscriptionIn(BaseModel):
    endpoint: Annotated[str, Field(max_length=1024)]
    keys: Keys


class EndpointIn(BaseModel):
    endpoint: Annotated[str, Field(max_length=1024)]


def _enabled() -> bool:
    return bool(get_settings().vapid_private_key)


def _require_enabled() -> None:
    if not _enabled():
        raise ApiError(404, "push_disabled", "Phone notifications are not set up on this server")


@router.get("/config", response_model=PushConfig)
async def config(user: CurrentUser):
    key = get_settings().vapid_private_key
    return PushConfig(enabled=bool(key), public_key=webpush.vapid_public_key(key) if key else None)


@router.put("/subscription", status_code=204, dependencies=[throttle("push_subscribe")])
async def subscribe(body: SubscriptionIn, request: Request, user: CurrentUser, session: Session):
    """Registers this device. Sending the same endpoint again updates it, and a device that was
    signed in as someone else moves to the current user."""
    _require_enabled()
    if not webpush.is_push_endpoint(body.endpoint):
        raise ApiError(422, "invalid_endpoint", "Not a supported push service address")
    agent = (request.headers.get("user-agent") or "")[:255] or None
    existing = await session.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == body.endpoint)
    )
    if existing is not None:
        existing.user_id = user.id
        existing.p256dh = body.keys.p256dh
        existing.auth = body.keys.auth
        existing.user_agent = agent
        existing.failures = 0
    else:
        session.add(
            PushSubscription(
                user_id=user.id,
                endpoint=body.endpoint,
                p256dh=body.keys.p256dh,
                auth=body.keys.auth,
                user_agent=agent,
            )
        )
        await session.flush()
        count = await session.scalar(
            select(func.count())
            .select_from(PushSubscription)
            .where(PushSubscription.user_id == user.id)
        )
        if (count or 0) > sender.MAX_PER_USER:
            # Keep the newest devices; browsers that were reinstalled leave stale ones behind.
            oldest = await session.scalars(
                select(PushSubscription.id)
                .where(PushSubscription.user_id == user.id)
                .order_by(PushSubscription.created_at)
                .limit((count or 0) - sender.MAX_PER_USER)
            )
            await session.execute(
                delete(PushSubscription).where(PushSubscription.id.in_(list(oldest)))
            )
    await session.commit()


@router.post("/unsubscribe", status_code=204)
async def unsubscribe(body: EndpointIn, user: CurrentUser, session: Session):
    await session.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == body.endpoint, PushSubscription.user_id == user.id
        )
    )
    await session.commit()


@router.post("/test", status_code=204, dependencies=[throttle("push_test")])
async def test(request: Request, user: CurrentUser, session: Session):
    """Sends a sample message to every device the user registered."""
    _require_enabled()
    subs = list(
        await session.scalars(select(PushSubscription).where(PushSubscription.user_id == user.id))
    )
    if not subs:
        raise ApiError(409, "no_devices", "No device is registered for phone notifications")
    settings = get_settings()
    sent = await sender.deliver(
        request.app.state.http, settings, subs, sender.test_message(user.locale, settings.app_name)
    )
    if sent == 0:
        raise ApiError(502, "push_failed", "The push service did not accept the message")
