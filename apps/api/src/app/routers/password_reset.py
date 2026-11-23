"""Forgotten passwords. There is no email service, so the owner makes a one-time link for a
friend and sends it by hand. The link holds a random token; only its hash is stored."""

import logging
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app import two_factor
from app.db import utcnow
from app.deps import ClientIp, CurrentAdmin, Session, session_check
from app.errors import ApiError
from app.models import PasswordReset, User
from app.ratelimit import hit
from app.routers.auth import _revoke
from app.security import hash_password_async, new_opaque_token, sha256

router = APIRouter(tags=["password-reset"])
audit = logging.getLogger("app.audit")


class AdminUserOut(BaseModel):
    id: str
    username: str
    locale: str
    is_admin: bool
    two_factor: bool
    created_at: datetime


class ResetLinkIn(BaseModel):
    hours_valid: int = Field(default=1, ge=1, le=24)


class ResetLinkOut(BaseModel):
    token: str
    locale: str
    expires_at: datetime


class ResetTokenIn(BaseModel):
    token: str = Field(min_length=1, max_length=128)


class ResetCheckOut(BaseModel):
    username: str
    expires_at: datetime


class ResetPasswordIn(ResetTokenIn):
    new_password: str = Field(min_length=8, max_length=128)


def _invalid() -> ApiError:
    # One answer for unknown, expired and already used, so a link says nothing about why.
    return ApiError(400, "invalid_reset_link", "This reset link is invalid, expired or used")


@router.get("/admin/users", response_model=list[AdminUserOut])
async def list_users(admin: CurrentAdmin, session: Session):
    rows = await session.scalars(select(User).order_by(User.username))
    return [
        AdminUserOut(
            id=str(u.id),
            username=u.username,
            locale=u.locale,
            is_admin=u.is_admin,
            two_factor=two_factor.is_enabled(u),
            created_at=u.created_at,
        )
        for u in rows
    ]


@router.post("/admin/users/{user_id}/password-reset", response_model=ResetLinkOut, status_code=201)
async def create_reset_link(
    user_id: uuid.UUID, body: ResetLinkIn, admin: CurrentAdmin, session: Session
):
    user = await session.get(User, user_id)
    if user is None:
        raise ApiError(404, "user_not_found", "No such user")
    now = utcnow()
    # A new link replaces the one before it: only the latest works.
    await session.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
        .values(used_at=now)
    )
    token = new_opaque_token()
    expires_at = now + timedelta(hours=body.hours_valid)
    session.add(
        PasswordReset(
            user_id=user.id,
            token_hash=sha256(token),
            created_by=admin.id,
            expires_at=expires_at,
        )
    )
    await session.commit()
    audit.info(
        "password reset link made user=%s by=%s hours=%s", user.id, admin.id, body.hours_valid
    )
    return ResetLinkOut(token=token, locale=user.locale, expires_at=expires_at)


async def _usable(session: Session, token: str) -> PasswordReset | None:
    return await session.scalar(
        select(PasswordReset).where(
            PasswordReset.token_hash == sha256(token),
            PasswordReset.used_at.is_(None),
            PasswordReset.expires_at > utcnow(),
        )
    )


@router.post("/auth/password-reset/check", response_model=ResetCheckOut)
async def check_reset_link(body: ResetTokenIn, session: Session, request: Request, ip: ClientIp):
    """Lets the page say right away that a link is dead, and for whom a live one is."""
    limiter = request.app.state.auth_limits.reset_ip
    await hit((limiter, ip))
    reset = await _usable(session, body.token)
    if reset is None:
        raise _invalid()
    await limiter.forgive(ip)
    user = await session.get(User, reset.user_id)
    assert user is not None
    return ResetCheckOut(username=user.username, expires_at=reset.expires_at)


@router.post("/auth/password-reset", status_code=204)
async def reset_password(body: ResetPasswordIn, session: Session, request: Request, ip: ClientIp):
    limiter = request.app.state.auth_limits.reset_ip
    await hit((limiter, ip))
    # Cheap check first: the slow hash is only paid for a live link.
    if await _usable(session, body.token) is None:
        raise _invalid()
    password_hash = await hash_password_async(body.new_password)
    # Spends the link in one statement, so two requests can't both use it.
    user_id = await session.scalar(
        update(PasswordReset)
        .where(
            PasswordReset.token_hash == sha256(body.token),
            PasswordReset.used_at.is_(None),
            PasswordReset.expires_at > utcnow(),
        )
        .values(used_at=utcnow())
        .returning(PasswordReset.user_id)
    )
    if user_id is None:
        await session.rollback()
        raise _invalid()
    user = await session.get(User, user_id, with_for_update=True)
    assert user is not None
    user.password_hash = password_hash
    # Whoever had the old password is out: every device signs in again, and browsers trusted
    # for two-factor are forgotten. Two-factor itself stays on, so the link alone opens nothing.
    await session.execute(_revoke(user))
    await two_factor.forget_devices(session, user.id)
    await session.commit()
    await limiter.forgive(ip)
    session_check(request).closed_for_user(user.id)
    audit.info("password reset user=%s ip=%s", user.id, ip)
