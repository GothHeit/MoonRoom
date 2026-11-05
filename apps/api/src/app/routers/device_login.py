"""Signing in a TV with a code approved on a phone (the OAuth device flow, RFC 8628, in small).

1. The TV asks for a login: it gets a secret it keeps (`device_token`) and a short code it shows.
2. A signed-in person enters or scans the code on their phone and approves it.
3. The TV, polling with its secret, receives a normal session once, for that person.

Codes live ten minutes, sign in once, and only their hashes are stored. Every step is rate
limited: starting per address, polling per address, and entering codes per person.
"""

import logging
import secrets
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import utcnow
from app.deps import ClientIp, CurrentUser, Session
from app.errors import ApiError
from app.models import DeviceLogin, User
from app.routers.auth import TokensOut, _device, _issue_tokens
from app.security import new_opaque_token, sha256

router = APIRouter(tags=["auth"])
audit = logging.getLogger("app.audit")

LIFETIME = timedelta(minutes=10)
POLL_SECONDS = 5
# Consonants only: no look-alikes (0/O, 1/I) and no accidental words. 20^8 codes.
_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"
CODE_LENGTH = 8


def new_user_code() -> str:
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(CODE_LENGTH))
    return f"{raw[:4]}-{raw[4:]}"


def normalize_code(code: str) -> str:
    """What a person typed, in the form that was hashed: "bcdf ghjk" -> "BCDFGHJK"."""
    return "".join(c for c in code.upper() if c.isalpha())


class DeviceStartOut(BaseModel):
    device_token: str
    user_code: str
    expires_in: int
    interval: int


class DevicePollIn(BaseModel):
    device_token: str = Field(min_length=1, max_length=128)


class DevicePollOut(BaseModel):
    """`approved` carries the session tokens, which this answer hands out exactly once."""

    status: Literal["pending", "approved"]
    tokens: TokensOut | None = None


class DeviceCodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class DeviceInfoOut(BaseModel):
    user_agent: str | None
    ip: str | None
    created_at: datetime
    expires_at: datetime


@router.post("/auth/device", response_model=DeviceStartOut, status_code=201)
async def start_device_login(session: Session, request: Request, ip: ClientIp):
    request.app.state.action_limits.hit("device_start", ip)
    device_token = new_opaque_token()
    for _ in range(3):
        code = new_user_code()
        session.add(
            DeviceLogin(
                device_hash=sha256(device_token),
                code_hash=sha256(normalize_code(code)),
                expires_at=utcnow() + LIFETIME,
                **_device(request, ip),
            )
        )
        try:
            await session.commit()
        except IntegrityError:
            # The same code is already out there (very unlikely): draw another.
            await session.rollback()
            continue
        return DeviceStartOut(
            device_token=device_token,
            user_code=code,
            expires_in=int(LIFETIME.total_seconds()),
            interval=POLL_SECONDS,
        )
    raise ApiError(503, "try_again", "Could not start a login, try again")


@router.post("/auth/device/token", response_model=DevicePollOut)
async def poll_device_login(body: DevicePollIn, session: Session, request: Request, ip: ClientIp):
    request.app.state.action_limits.hit("device_poll", ip)
    # Locked so two polls can't both spend one approval.
    login = await session.scalar(
        select(DeviceLogin)
        .where(DeviceLogin.device_hash == sha256(body.device_token))
        .with_for_update()
    )
    if login is None or login.used_at is not None or login.expires_at < utcnow():
        raise ApiError(410, "device_login_expired", "This code expired, show a new one")
    if login.denied_at is not None:
        raise ApiError(403, "device_login_denied", "The sign-in was declined")
    if login.approved_by is None:
        await session.rollback()
        return DevicePollOut(status="pending")
    user = await session.get(User, login.approved_by)
    if user is None:
        raise ApiError(410, "device_login_expired", "This code expired, show a new one")
    login.used_at = utcnow()
    audit.info("device login user=%s ip=%s", user.id, ip)
    # The session carries the TV's details, so the sessions list names the TV, not the phone.
    tokens = await _issue_tokens(session, user, {"user_agent": login.user_agent, "ip": login.ip})
    return DevicePollOut(status="approved", tokens=tokens)


async def _pending(session: Session, code: str, request: Request, user: User) -> DeviceLogin:
    """The live, undecided login behind `code`, locked. Every attempt counts against the user."""
    request.app.state.action_limits.hit("device_code", str(user.id))
    login = await session.scalar(
        select(DeviceLogin)
        .where(DeviceLogin.code_hash == sha256(normalize_code(code)))
        .with_for_update()
    )
    if (
        login is None
        or login.expires_at < utcnow()
        or login.used_at is not None
        or login.approved_by is not None
        or login.denied_at is not None
    ):
        raise ApiError(404, "device_code_invalid", "That code is wrong or expired")
    return login


@router.post("/auth/device/lookup", response_model=DeviceInfoOut)
async def lookup_device_login(
    body: DeviceCodeIn, user: CurrentUser, session: Session, request: Request
):
    """What the phone shows before asking "Sign in this TV?"."""
    login = await _pending(session, body.code, request, user)
    info = DeviceInfoOut(
        user_agent=login.user_agent,
        ip=login.ip,
        created_at=login.created_at,
        expires_at=login.expires_at,
    )
    await session.rollback()
    return info


@router.post("/auth/device/approve", status_code=204)
async def approve_device_login(
    body: DeviceCodeIn, user: CurrentUser, session: Session, request: Request
):
    login = await _pending(session, body.code, request, user)
    login.approved_by = user.id
    login.approved_at = utcnow()
    await session.commit()
    audit.info("device login approved user=%s device_ip=%s", user.id, login.ip)


@router.post("/auth/device/deny", status_code=204)
async def deny_device_login(
    body: DeviceCodeIn, user: CurrentUser, session: Session, request: Request
):
    login = await _pending(session, body.code, request, user)
    login.denied_at = utcnow()
    await session.commit()
    audit.info("device login declined user=%s device_ip=%s", user.id, login.ip)
