import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://app:app@localhost:5432/app_test")
os.environ.setdefault("JWT_SECRET", "test-secret-that-is-at-least-32-characters")
os.environ.setdefault("MAL_CLIENT_ID", "test-client-id")
os.environ.setdefault("TOKEN_ENCRYPTION_KEY", "U7IyWg9977JGpiW4T6DkGZvteDb8a_l1bU8cy-JhLmc=")

from pathlib import Path  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import db, hls  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402
from app.models import User  # noqa: E402
from app.routers.invites import new_invite  # noqa: E402
from app.security import create_access_token  # noqa: E402

API_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def public_hosts(monkeypatch):
    """Tests never reach real DNS: every host a test names resolves to a public address.
    A test about private addresses patches `hls.resolve_host` itself."""

    async def resolve(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    hls._public_hosts.clear()


@pytest.fixture(scope="session", autouse=True)
def migrated_database():
    # Build the schema through the real migrations, so they are tested too.
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")


@pytest.fixture
async def client():
    async with fastapi_app.router.lifespan_context(fastapi_app):
        async for session in db.get_session():
            await session.execute(
                text(
                    "TRUNCATE users, invites, refresh_tokens, mal_links, mal_oauth_states,"
                    " device_logins CASCADE"
                )
            )
            await session.commit()
        transport = httpx.ASGITransport(app=fastapi_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest.fixture
async def session(client):
    async for s in db.get_session():
        yield s


@pytest.fixture
async def invite_code(session):
    invite = new_invite(7)
    session.add(invite)
    await session.commit()
    return invite.code


async def make_user(
    session, username="kafka", admin=False, nsfw=False, login=True
) -> tuple[User, dict]:
    """A user and, unless `login` is False, bearer headers for a fresh login session."""
    from app.security import hash_password

    user = User(
        username=username,
        password_hash=hash_password("password123"),
        is_admin=admin,
        show_nsfw=nsfw,
    )
    session.add(user)
    await session.commit()
    if not login:
        return user, {}
    return user, {"Authorization": f"Bearer {await login_token(session, user)}"}


async def login_token(session, user: User) -> str:
    """An access token for a fresh login session, as /auth/login would issue."""
    import uuid
    from datetime import timedelta

    from app.db import utcnow
    from app.models import RefreshToken
    from app.security import new_opaque_token, sha256

    family = uuid.uuid4()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=sha256(new_opaque_token()),
            expires_at=utcnow() + timedelta(days=1),
            family_id=family,
            started_at=utcnow(),
        )
    )
    await session.commit()
    return create_access_token(user.id, family)


def viewer_of(headers: dict):
    """Who stream links made for these bearer headers belong to."""
    from app import hls
    from app.security import decode_access_token

    decoded = decode_access_token(headers["Authorization"].removeprefix("Bearer "))
    assert decoded is not None
    return hls.Viewer(str(decoded[0]), str(decoded[1]))
