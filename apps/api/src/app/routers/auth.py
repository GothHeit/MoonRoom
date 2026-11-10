import logging
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app import two_factor
from app.avatars import AvatarOut, avatar_out
from app.config import get_settings
from app.db import utcnow
from app.deps import ClientIp, CurrentSessionId, CurrentUser, Session, session_check
from app.errors import ApiError
from app.models import Invite, MalLink, RefreshToken, User
from app.ratelimit import hit
from app.security import (
    DUMMY_PASSWORD_HASH,
    create_access_token,
    create_mfa_token,
    decode_mfa_token,
    hash_password_async,
    new_opaque_token,
    sha256,
    verify_password_async,
)

router = APIRouter(tags=["auth"])

# Security events, one line each, never with a password or token.
audit = logging.getLogger("app.audit")

Locale = Literal["pt", "en"]
# "auto" clears the preference (pt-BR, then English); "off" hides subtitles.
MangaLang = Annotated[str, StringConstraints(pattern=r"^(auto|pt-br|en)$")]
SubtitleLang = Annotated[str, StringConstraints(pattern=r"^(auto|off|[a-z]{2,3}(-[A-Z]{2})?)$")]


class RegisterIn(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_]{3,32}$")
    password: str = Field(min_length=8, max_length=128)
    invite_code: str = Field(min_length=1, max_length=64)
    locale: Locale = "pt"


class LoginIn(BaseModel):
    # Same alphabet as registration: anything else can't be an account, and a NUL character
    # would only be refused by the database as a 500.
    username: str = Field(pattern=r"^[A-Za-z0-9_]{1,32}$")
    password: str = Field(min_length=1, max_length=128)
    # The token a browser got when it was trusted; it skips the second step.
    trusted_device: str | None = Field(default=None, max_length=128)


class MfaLoginIn(BaseModel):
    mfa_token: str = Field(max_length=2048)
    # A 6-digit authenticator code or a backup code (xxxxx-xxxxx).
    code: str = Field(min_length=1, max_length=32)
    trust_device: bool = False


class MfaChallengeOut(BaseModel):
    """The password was right but the account has two-factor login: send the code next."""

    mfa_required: Literal[True] = True
    mfa_token: str


class RefreshIn(BaseModel):
    refresh_token: str


class TokensOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class MfaTokensOut(TokensOut):
    # Set when the user asked to trust this browser. The web app keeps it in a cookie.
    trusted_device: str | None = None


class MeOut(BaseModel):
    id: str
    username: str
    locale: Locale
    show_nsfw: bool
    subtitle_lang: str | None
    manga_lang: str | None
    is_admin: bool
    avatar: AvatarOut
    share_activity: bool
    pin_enabled: bool


class MeUpdate(BaseModel):
    locale: Locale | None = None
    show_nsfw: bool | None = None
    subtitle_lang: SubtitleLang | None = None
    manga_lang: MangaLang | None = None
    share_activity: bool | None = None


class PasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class SessionOut(BaseModel):
    id: str
    user_agent: str | None
    ip: str | None
    started_at: datetime
    last_active_at: datetime
    current: bool


def _device(request: Request, ip: str) -> dict:
    agent = request.headers.get("user-agent")
    return {"user_agent": agent[:255] if agent else None, "ip": ip[:64]}


async def _issue_tokens(
    session: Session,
    user: User,
    device: dict,
    family: tuple[uuid.UUID, datetime] | None = None,
    *,
    tv: bool = False,
) -> TokensOut:
    """Starts a session, or with `family` (id, started_at) continues one after a rotation."""
    settings = get_settings()
    refresh = new_opaque_token()
    family_id, started_at = family or (uuid.uuid4(), utcnow())
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=sha256(refresh),
            expires_at=utcnow() + timedelta(days=settings.refresh_token_days),
            family_id=family_id,
            started_at=started_at,
            is_tv=tv,
            **device,
        )
    )
    await session.commit()
    return TokensOut(
        access_token=create_access_token(user.id, family_id),
        refresh_token=refresh,
        expires_in=settings.access_token_minutes * 60,
    )


async def build_me(user: User, session: Session) -> MeOut:
    link = await session.get(MalLink, user.id)
    return MeOut(
        id=str(user.id),
        username=user.username,
        locale=user.locale,
        show_nsfw=user.show_nsfw,
        subtitle_lang=user.subtitle_lang,
        manga_lang=user.manga_lang,
        is_admin=user.is_admin,
        avatar=avatar_out(user, link.mal_picture if link else None),
        share_activity=user.share_activity,
        pin_enabled=user.pin_hash is not None,
    )


@router.post("/auth/register", response_model=TokensOut, status_code=201)
async def register(body: RegisterIn, session: Session, request: Request, ip: ClientIp):
    limits = request.app.state.auth_limits
    username = body.username.lower()
    await hit((limits.register_ip, ip), (limits.register_user, username))
    invite = await session.scalar(
        select(Invite).where(Invite.code == body.invite_code).with_for_update()
    )
    if invite is None or invite.used_at is not None or invite.expires_at < utcnow():
        raise ApiError(400, "invalid_invite", "Invite code is invalid, used or expired")

    if await session.scalar(select(User.id).where(User.username == username)):
        raise ApiError(409, "username_taken", "Username already taken")

    user = User(
        username=username,
        password_hash=await hash_password_async(body.password),
        locale=body.locale,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        # Another request registered the same username between the check and the insert.
        await session.rollback()
        raise ApiError(409, "username_taken", "Username already taken") from None
    invite.used_by = user.id
    invite.used_at = utcnow()
    audit.info("register user=%s ip=%s", user.id, ip)
    return await _issue_tokens(session, user, _device(request, ip))


@router.post("/auth/login", response_model=TokensOut | MfaChallengeOut)
async def login(body: LoginIn, session: Session, request: Request, ip: ClientIp):
    limits = request.app.state.auth_limits
    username = body.username.lower()
    # Keyed on (ip, username), so a stranger's bad guesses can't lock a friend out of their own
    # account from another address.
    attempt = f"{ip}|{username}"
    # Counted before the slow checks so a burst of concurrent guesses is counted; a
    # successful login takes its hit back, so friends who log in normally are never throttled.
    await hit((limits.login_ip, ip), (limits.login_user, attempt))
    user = await session.scalar(select(User).where(User.username == body.username.lower()))
    password_hash = user.password_hash if user else DUMMY_PASSWORD_HASH
    if not await verify_password_async(body.password, password_hash) or user is None:
        audit.info("login failed username=%r ip=%s", username, ip)
        raise ApiError(401, "invalid_credentials", "Wrong username or password")
    await limits.login_ip.forgive(ip)
    await limits.login_user.reset(attempt)
    if two_factor.is_enabled(user) and not await two_factor.is_trusted(
        session, user, body.trusted_device
    ):
        audit.info("login password ok, second step needed user=%s ip=%s", user.id, ip)
        return MfaChallengeOut(mfa_token=create_mfa_token(user.id))
    audit.info("login user=%s ip=%s", user.id, ip)
    return await _issue_tokens(session, user, _device(request, ip))


@router.post("/auth/login/2fa", response_model=MfaTokensOut)
async def login_second_step(body: MfaLoginIn, session: Session, request: Request, ip: ClientIp):
    limits = request.app.state.auth_limits
    user_id = decode_mfa_token(body.mfa_token)
    if user_id is None:
        raise ApiError(401, "invalid_mfa_token", "Sign in again")
    key = str(user_id)
    await hit((limits.mfa_ip, ip), (limits.mfa_user, key))
    # Locked so two requests can't spend the same code.
    user = await session.scalar(select(User).where(User.id == user_id).with_for_update())
    if user is None or not two_factor.is_enabled(user):
        raise ApiError(401, "invalid_mfa_token", "Sign in again")
    kind = await two_factor.check_code(session, user, body.code)
    if kind is None:
        await session.rollback()
        audit.info("second step failed user=%s ip=%s", user_id, ip)
        raise ApiError(401, "invalid_code", "That code is wrong or already used")
    await limits.mfa_ip.forgive(ip)
    await limits.mfa_user.reset(key)
    trusted = await two_factor.trust_device(session, user) if body.trust_device else None
    # Committed with the tokens below.
    audit.info("login user=%s ip=%s second_step=%s trusted=%s", user.id, ip, kind, bool(trusted))
    tokens = await _issue_tokens(session, user, _device(request, ip))
    return MfaTokensOut(**tokens.model_dump(), trusted_device=trusted)


@router.post("/auth/refresh", response_model=TokensOut)
async def refresh(body: RefreshIn, session: Session, request: Request, ip: ClientIp):
    token = await session.scalar(
        select(RefreshToken)
        .where(RefreshToken.token_hash == sha256(body.refresh_token))
        # Row lock: a concurrent refresh with the same token waits here, then sees it revoked.
        .with_for_update()
    )
    if token is None or token.expires_at < utcnow():
        raise ApiError(401, "invalid_refresh_token", "Refresh token is invalid or expired")

    if token.revoked_at is not None and token.revoked_at > utcnow() - timedelta(
        seconds=get_settings().refresh_grace_seconds
    ):
        # Just rotated: the answer probably never reached the device (it slept, the connection
        # dropped). Hand it a fresh token of the same session, and retire the one it never got.
        # Only while the session lives: a logout or revoke expires the family's live token.
        alive = await session.scalar(
            select(RefreshToken.id)
            .where(
                RefreshToken.family_id == token.family_id,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > utcnow(),
            )
            .limit(1)
        )
        if alive is None:
            raise ApiError(401, "invalid_refresh_token", "Refresh token is invalid or expired")
        await session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.family_id == token.family_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=utcnow())
        )
        user = await session.get(User, token.user_id)
        if user is None:
            raise ApiError(401, "invalid_refresh_token", "User no longer exists")
        return await _issue_tokens(
            session, user, _device(request, ip), (token.family_id, token.started_at), tv=token.is_tv
        )

    if token.revoked_at is not None:
        # A revoked token being reused long after its rotation means it leaked: end every
        # session for this user.
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == token.user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=utcnow(), expires_at=utcnow())
        )
        await session.commit()
        session_check(request).closed_for_user(token.user_id)
        audit.warning("refresh token replayed, all sessions ended user=%s ip=%s", token.user_id, ip)
        raise ApiError(401, "invalid_refresh_token", "Refresh token was already used")

    token.revoked_at = utcnow()
    user = await session.get(User, token.user_id)
    if user is None:
        raise ApiError(401, "invalid_refresh_token", "User no longer exists")
    return await _issue_tokens(
        session, user, _device(request, ip), (token.family_id, token.started_at), tv=token.is_tv
    )


@router.post("/auth/logout", status_code=204)
async def logout(body: RefreshIn, session: Session, request: Request):
    family = await session.scalar(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == sha256(body.refresh_token),
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow(), expires_at=utcnow())
        .returning(RefreshToken.family_id)
    )
    await session.commit()
    if family is not None:
        session_check(request).closed(family)


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser, session: Session):
    return await build_me(user, session)


@router.patch("/me", response_model=MeOut)
async def update_me(body: MeUpdate, user: CurrentUser, session: Session):
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(user, field, None if value == "auto" else value)
    await session.commit()
    return await build_me(user, session)


def _revoke(user: User, *, keep: uuid.UUID | None = None, only: uuid.UUID | None = None):
    statement = update(RefreshToken).where(
        RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None)
    )
    if keep is not None:
        statement = statement.where(RefreshToken.family_id != keep)
    if only is not None:
        statement = statement.where(RefreshToken.family_id == only)
    # Expiring the token too makes a later refresh with it a plain 401. A token merely marked
    # revoked reads as a replayed (stolen) one and would end every session.
    return statement.values(revoked_at=utcnow(), expires_at=utcnow())


@router.get("/me/sessions", response_model=list[SessionOut])
async def list_sessions(user: CurrentUser, session: Session, current: CurrentSessionId):
    tokens = await session.scalars(
        select(RefreshToken)
        .where(
            RefreshToken.user_id == user.id,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > utcnow(),
        )
        .order_by(RefreshToken.created_at.desc())
    )
    return [
        SessionOut(
            id=str(t.family_id),
            user_agent=t.user_agent,
            ip=t.ip,
            started_at=t.started_at,
            last_active_at=t.created_at,
            current=t.family_id == current,
        )
        for t in tokens
    ]


@router.delete("/me/sessions/{session_id}", status_code=204)
async def revoke_session(
    session_id: uuid.UUID, user: CurrentUser, session: Session, request: Request
):
    result = await session.execute(_revoke(user, only=session_id))
    await session.commit()
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise ApiError(404, "session_not_found", "No such session")
    session_check(request).closed(session_id)
    audit.info("session revoked user=%s session=%s", user.id, session_id)


@router.delete("/me/sessions", status_code=204)
async def revoke_all_sessions(user: CurrentUser, session: Session, request: Request):
    """Signs the user out everywhere, this device included."""
    await session.execute(_revoke(user))
    await session.commit()
    session_check(request).closed_for_user(user.id)
    audit.info("all sessions revoked user=%s", user.id)


@router.post("/me/password", status_code=204)
async def change_password(
    body: PasswordIn,
    user: CurrentUser,
    session: Session,
    request: Request,
    current: CurrentSessionId,
):
    limiter = request.app.state.auth_limits.password_user
    key = str(user.id)
    await hit((limiter, key))
    if not await verify_password_async(body.current_password, user.password_hash):
        audit.info("password change refused user=%s", user.id)
        raise ApiError(403, "wrong_password", "Current password is wrong")
    await limiter.reset(key)
    user.password_hash = await hash_password_async(body.new_password)
    # Every other device must sign in again; this one keeps its session.
    await session.execute(_revoke(user, keep=current))
    await two_factor.forget_devices(session, user.id)
    await session.commit()
    session_check(request).closed_for_user(user.id, keep=current)
    audit.info("password changed user=%s", user.id)


class TwoFactorOut(BaseModel):
    enabled: bool
    backup_codes_left: int


class TwoFactorSetupIn(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class TwoFactorSetupOut(BaseModel):
    secret: str
    otpauth_uri: str


class TwoFactorEnableIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class TwoFactorConfirmIn(BaseModel):
    """Changing two-factor settings needs the password and a current code."""

    password: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=1, max_length=32)


class BackupCodesOut(BaseModel):
    backup_codes: list[str]


async def _check_password(user: User, password: str, request: Request) -> None:
    limiter = request.app.state.auth_limits.password_user
    key = str(user.id)
    await hit((limiter, key))
    if not await verify_password_async(password, user.password_hash):
        audit.info("two-factor change refused, wrong password user=%s", user.id)
        raise ApiError(403, "wrong_password", "Password is wrong")
    await limiter.reset(key)


async def _check_second_step(user: User, code: str, session: Session, request: Request) -> str:
    limiter = request.app.state.auth_limits.mfa_user
    key = str(user.id)
    await hit((limiter, key))
    user_id = user.id
    kind = await two_factor.check_code(session, user, code)
    if kind is None:
        await session.rollback()
        audit.info("two-factor change refused, wrong code user=%s", user_id)
        raise ApiError(403, "invalid_code", "That code is wrong or already used")
    await limiter.reset(key)
    return kind


@router.get("/me/2fa", response_model=TwoFactorOut)
async def two_factor_status(user: CurrentUser, session: Session):
    enabled = two_factor.is_enabled(user)
    left = await two_factor.backup_codes_left(session, user) if enabled else 0
    return TwoFactorOut(enabled=enabled, backup_codes_left=left)


@router.post("/me/2fa/setup", response_model=TwoFactorSetupOut)
async def two_factor_setup(
    body: TwoFactorSetupIn, user: CurrentUser, session: Session, request: Request
):
    """Starts enrolment with a fresh secret. Nothing changes for logins until /enable."""
    if two_factor.is_enabled(user):
        raise ApiError(409, "two_factor_enabled", "Two-factor login is already on")
    await _check_password(user, body.password, request)
    user.totp_secret = two_factor.new_secret()
    user.totp_last_step = None
    await session.commit()
    return TwoFactorSetupOut(
        secret=user.totp_secret,
        otpauth_uri=two_factor.provisioning_uri(user.totp_secret, user.username),
    )


@router.post("/me/2fa/enable", response_model=BackupCodesOut)
async def two_factor_enable(
    body: TwoFactorEnableIn, user: CurrentUser, session: Session, request: Request
):
    if two_factor.is_enabled(user):
        raise ApiError(409, "two_factor_enabled", "Two-factor login is already on")
    if user.totp_secret is None:
        raise ApiError(409, "two_factor_not_started", "Start the setup first")
    limiter = request.app.state.auth_limits.mfa_user
    key = str(user.id)
    await hit((limiter, key))
    step = two_factor.matching_step(user.totp_secret, body.code, None)
    if step is None:
        raise ApiError(400, "invalid_code", "That code is wrong, check your authenticator app")
    await limiter.reset(key)
    user.totp_last_step = step
    user.two_factor_at = utcnow()
    codes = await two_factor.replace_backup_codes(session, user)
    await session.commit()
    audit.info("two-factor turned on user=%s", user.id)
    return BackupCodesOut(backup_codes=codes)


@router.post("/me/2fa/disable", status_code=204)
async def two_factor_disable(
    body: TwoFactorConfirmIn, user: CurrentUser, session: Session, request: Request
):
    if not two_factor.is_enabled(user):
        raise ApiError(409, "two_factor_disabled", "Two-factor login is off")
    await _check_password(user, body.password, request)
    await _check_second_step(user, body.code, session, request)
    await two_factor.turn_off(session, user)
    await session.commit()
    audit.info("two-factor turned off user=%s", user.id)


@router.post("/me/2fa/backup-codes", response_model=BackupCodesOut)
async def two_factor_new_backup_codes(
    body: TwoFactorConfirmIn, user: CurrentUser, session: Session, request: Request
):
    """Replaces all backup codes, used or not."""
    if not two_factor.is_enabled(user):
        raise ApiError(409, "two_factor_disabled", "Two-factor login is off")
    await _check_password(user, body.password, request)
    await _check_second_step(user, body.code, session, request)
    codes = await two_factor.replace_backup_codes(session, user)
    await session.commit()
    audit.info("backup codes replaced user=%s", user.id)
    return BackupCodesOut(backup_codes=codes)
