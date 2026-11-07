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


class PinTvSetIn(BaseModel):
    pin: str = Field(pattern=r"^\d{4,6}$")
    # The PIN the TV has now (when there is one), or else the account password.
    current_pin: str | None = Field(default=None, min_length=1, max_length=12)
    password: str | None = Field(default=None, min_length=1, max_length=128)


class PinTvRemoveIn(BaseModel):
    current_pin: str = Field(min_length=1, max_length=12)


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


async def _check_current_pin(user, pin_value: str, request: Request, sid: uuid.UUID) -> None:
    """Same guesses budget as the lock screen: a wrong PIN here counts like a wrong unlock."""
    limits = request.app.state.auth_limits
    session_key, user_key = str(sid), str(user.id)
    limits.pin_session.check(session_key)
    limits.pin_user.check(user_key)
    limits.pin_session.record(session_key)
    limits.pin_user.record(user_key)
    if user.pin_hash is None or not await verify_password_async(pin_value, user.pin_hash):
        audit.info("tv pin wrong (settings) user=%s session=%s", user.id, sid)
        raise ApiError(403, "wrong_pin", "That PIN is wrong")
    limits.pin_session.reset(str(sid))
    limits.pin_user.forgive(user_key)


@router.put("/auth/pin/tv", status_code=204)
async def set_pin_on_tv(
    body: PinTvSetIn, user: CurrentUser, session: Session, request: Request, sid: CurrentSessionId
):
    """Add or change the PIN from a TV. A TV with a PIN must give the current one; a TV with
    none must give the account password, so whoever holds the remote cannot lock the owner out."""
    if not await pin.is_tv_session(session, user.id, sid):
        raise ApiError(403, "pin_only_on_tv", "This is for TVs; use the normal PIN setting")
    if pin.is_enabled(user):
        if body.current_pin is None:
            raise ApiError(422, "current_pin_required", "Enter the current PIN")
        await _check_current_pin(user, body.current_pin, request, sid)
    else:
        if body.password is None:
            raise ApiError(422, "password_required", "Enter your password")
        await _check_password(user, body.password, request)
    user.pin_hash = await hash_password_async(body.pin)
    user.pin_set_at = utcnow()
    # Every other TV asks for the new PIN; this one just proved it knows it.
    await pin.lock_all(session, user.id)
    await pin.unlock(session, user.id, sid)
    audit.info("tv pin set on tv user=%s session=%s", user.id, sid)


@router.post("/auth/pin/tv/remove", status_code=204)
async def remove_pin_on_tv(
    body: PinTvRemoveIn,
    user: CurrentUser,
    session: Session,
    request: Request,
    sid: CurrentSessionId,
):
    if not await pin.is_tv_session(session, user.id, sid):
        raise ApiError(403, "pin_only_on_tv", "This is for TVs; use the normal PIN setting")
    await _check_current_pin(user, body.current_pin, request, sid)
    user.pin_hash = None
    user.pin_set_at = None
    await pin.lock_all(session, user.id)
    await session.commit()
    audit.info("tv pin removed on tv user=%s session=%s", user.id, sid)


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
