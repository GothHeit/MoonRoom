"""The optional TV PIN. Set and removed from the phone or website (with the password); entered
on the TV, whose session is locked until then (see app.pin)."""

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app import pin
from app.avatars import AvatarOut, avatar_out
from app.db import utcnow
from app.deps import CurrentSessionId, CurrentUser, LockedOkUser, Session, session_id_of
from app.errors import ApiError
from app.models import MalLink
from app.routers.auth import _check_password
from app.security import hash_password_async, verify_password_async

router = APIRouter(tags=["auth"])
audit = logging.getLogger("app.audit")

LockedOkSessionId = Annotated[uuid.UUID, Depends(session_id_of)]


class PinStatusOut(BaseModel):
    enabled: bool
    # Who the lock screen says it is for (the account the TV signed in as).
    id: str
    username: str
    avatar: AvatarOut
    # This session is a TV one, and the TV page should show the PIN screen.
    locked: bool


class PinSetIn(BaseModel):
    pin: str = Field(pattern=r"^\d{4,6}$")
    password: str = Field(min_length=1, max_length=128)


class PinRemoveIn(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class PinUnlockIn(BaseModel):
    pin: str = Field(min_length=1, max_length=12)


@router.get("/auth/pin", response_model=PinStatusOut)
async def pin_status(user: LockedOkUser, session: Session, sid: LockedOkSessionId):
    """Open to a locked TV: it asks this to know whether to show the PIN screen."""
    link = await session.get(MalLink, user.id)
    return PinStatusOut(
        enabled=pin.is_enabled(user),
        id=str(user.id),
        username=user.username,
        avatar=avatar_out(user, link.mal_picture if link else None),
        locked=await pin.is_locked(session, user, sid),
    )


@router.put("/auth/pin", status_code=204)
async def set_pin(
    body: PinSetIn, user: CurrentUser, session: Session, request: Request, sid: CurrentSessionId
):
    if await pin.is_tv_session(session, user.id, sid):
        raise ApiError(403, "pin_not_on_tv", "Set the PIN from your phone or the website")
    await _check_password(user, body.password, request)
    user.pin_hash = await hash_password_async(body.pin)
    user.pin_set_at = utcnow()
    # Every TV asks for the new PIN from now on.
    await pin.lock_all(session, user.id)
    await session.commit()
    audit.info("tv pin set user=%s", user.id)


@router.post("/auth/pin/remove", status_code=204)
async def remove_pin(
    body: PinRemoveIn, user: CurrentUser, session: Session, request: Request, sid: CurrentSessionId
):
    if await pin.is_tv_session(session, user.id, sid):
        raise ApiError(403, "pin_not_on_tv", "Remove the PIN from your phone or the website")
    await _check_password(user, body.password, request)
    user.pin_hash = None
    user.pin_set_at = None
    await pin.lock_all(session, user.id)
    await session.commit()
    audit.info("tv pin removed user=%s", user.id)


@router.post("/auth/pin/unlock", status_code=204)
async def unlock(
    body: PinUnlockIn,
    user: LockedOkUser,
    session: Session,
    request: Request,
    sid: LockedOkSessionId,
):
    limits = request.app.state.auth_limits
    session_key, user_key = str(sid), str(user.id)
    limits.pin_session.check(session_key)
    limits.pin_user.check(user_key)
    limits.pin_session.record(session_key)
    limits.pin_user.record(user_key)
    if user.pin_hash is None:
        # Nothing to enter: not an error, and not a free guess either.
        return
    if not await verify_password_async(body.pin, user.pin_hash):
        audit.info("tv pin wrong user=%s session=%s", user.id, sid)
        raise ApiError(403, "wrong_pin", "That PIN is wrong")
    limits.pin_session.reset(session_key)
    limits.pin_user.forgive(user_key)
    await pin.unlock(session, user.id, sid)
    audit.info("tv pin unlocked user=%s session=%s", user.id, sid)


@router.post("/auth/pin/lock", status_code=204)
async def lock(user: LockedOkUser, session: Session, sid: LockedOkSessionId):
    """The TV page locks itself when it opens, goes to the background or sits idle."""
    await pin.lock(session, sid)
