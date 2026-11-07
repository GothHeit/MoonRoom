import uuid
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import pin
from app.config import get_settings
from app.db import get_session, utcnow
from app.errors import ApiError
from app.models import RefreshToken, User
from app.security import decode_access_token, sha256
from app.sessions import SessionCheck

Session = Annotated[AsyncSession, Depends(get_session)]

_bearer = HTTPBearer(auto_error=False)

# The web app's httpOnly session cookies (apps/web/src/lib/cookies.ts).
ACCESS_COOKIE = "mr_access"
REFRESH_COOKIE = "mr_refresh"


def session_check(request: Request) -> SessionCheck:
    return request.app.state.session_check


async def bearer_identity(
    request: Request, db: AsyncSession, credentials: HTTPAuthorizationCredentials | None
) -> tuple[uuid.UUID, uuid.UUID]:
    """(user id, session id) of a valid bearer token whose login session is still open."""
    if credentials is None:
        raise ApiError(401, "not_authenticated", "Missing bearer token")
    decoded = decode_access_token(credentials.credentials)
    if decoded is None:
        raise ApiError(401, "invalid_token", "Invalid or expired token")
    # A signed-out device or revoked session stops here, not when the token expires.
    if not await session_check(request).is_open(db, *decoded):
        raise ApiError(401, "invalid_token", "This session was signed out")
    return decoded


async def _load_user(
    request: Request, session: AsyncSession, credentials: HTTPAuthorizationCredentials | None
) -> tuple[User, uuid.UUID]:
    user_id, sid = await bearer_identity(request, session, credentials)
    user = await session.get(User, user_id)
    if user is None:
        raise ApiError(401, "invalid_token", "User no longer exists")
    return user, sid


async def current_user_even_if_locked(
    request: Request,
    session: Session,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    """Like `current_user`, but also for a TV session that has not entered its PIN. Only the
    PIN endpoints use it."""
    user, _ = await _load_user(request, session, credentials)
    await session.commit()
    return user


async def current_user(
    request: Request,
    session: Session,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    user, sid = await _load_user(request, session, credentials)
    # A TV session whose PIN wasn't entered gets nothing from the account.
    if await pin.is_locked(session, user, sid):
        raise ApiError(403, "pin_required", "Enter the PIN to use this TV")
    # End the read transaction now: it would otherwise hold a pooled connection until the
    # response is sent, through any scraper or MAL call the endpoint waits on. The user stays
    # usable (expire_on_commit is off) and later queries check a connection out again.
    await session.commit()
    return user


CurrentUser = Annotated[User, Depends(current_user)]
LockedOkUser = Annotated[User, Depends(current_user_even_if_locked)]


async def current_session_id(
    user: CurrentUser,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> uuid.UUID:
    """The login session the request belongs to (current_user already checked the token)."""
    decoded = decode_access_token(credentials.credentials) if credentials else None
    assert decoded is not None
    return decoded[1]


CurrentSessionId = Annotated[uuid.UUID, Depends(current_session_id)]


async def session_id_of(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> uuid.UUID:
    """The session id in a bearer token that `current_user_even_if_locked` already accepted."""
    decoded = decode_access_token(credentials.credentials) if credentials else None
    assert decoded is not None
    return decoded[1]


async def current_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise ApiError(403, "forbidden", "Admins only")
    return user


CurrentAdmin = Annotated[User, Depends(current_admin)]


async def browser_user_id(request: Request, session: AsyncSession) -> uuid.UUID | None:
    """Who the web app's session cookies say a browser is, for the few endpoints the browser
    reaches directly (the MAL callback) instead of through the web server's proxy."""
    access = request.cookies.get(ACCESS_COOKIE)
    decoded = decode_access_token(access) if access else None
    if decoded is not None and await session_check(request).is_open(session, *decoded):
        return decoded[0]
    refresh = request.cookies.get(REFRESH_COOKIE)
    if not refresh:
        return None
    # The access cookie lapses every 15 minutes; the refresh cookie still names the session.
    return await session.scalar(
        select(RefreshToken.user_id).where(
            RefreshToken.token_hash == sha256(refresh),
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > utcnow(),
        )
    )


def client_ip(request: Request) -> str:
    if get_settings().trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            # The last hop is the one our own proxy appended; earlier ones are client-supplied.
            return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


ClientIp = Annotated[str, Depends(client_ip)]


def throttle(action: str):
    """A route dependency counting one `action` (see ratelimit.ACTION_RULES) per user."""

    async def check(request: Request, user: CurrentUser) -> None:
        request.app.state.action_limits.hit(action, str(user.id))

    return Depends(check)
