import uuid
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session, utcnow
from app.errors import ApiError
from app.models import RefreshToken, User
from app.security import decode_access_token, sha256

Session = Annotated[AsyncSession, Depends(get_session)]

_bearer = HTTPBearer(auto_error=False)

# The web app's httpOnly session cookies (apps/web/src/lib/cookies.ts).
ACCESS_COOKIE = "mr_access"
REFRESH_COOKIE = "mr_refresh"


async def current_user(
    session: Session,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    if credentials is None:
        raise ApiError(401, "not_authenticated", "Missing bearer token")
    decoded = decode_access_token(credentials.credentials)
    if decoded is None:
        raise ApiError(401, "invalid_token", "Invalid or expired token")
    user = await session.get(User, decoded[0])
    if user is None:
        raise ApiError(401, "invalid_token", "User no longer exists")
    # End the read transaction now: it would otherwise hold a pooled connection until the
    # response is sent, through any scraper or MAL call the endpoint waits on. The user stays
    # usable (expire_on_commit is off) and later queries check a connection out again.
    await session.commit()
    return user


CurrentUser = Annotated[User, Depends(current_user)]


async def current_session_id(
    user: CurrentUser,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> uuid.UUID | None:
    """The login session the request belongs to; None for tokens that predate sessions."""
    decoded = decode_access_token(credentials.credentials) if credentials else None
    return decoded[1] if decoded else None


CurrentSessionId = Annotated[uuid.UUID | None, Depends(current_session_id)]


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
    if decoded is not None:
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
