from datetime import timedelta

from sqlalchemy import func, select

from app.cleanup import prune
from app.db import utcnow
from app.models import MalOAuthState, RefreshToken
from tests.conftest import make_user


async def test_prune_drops_only_long_dead_rows(client, session):
    user, _ = await make_user(session, "kafka", login=False)
    now = utcnow()
    for name, expires, revoked in [
        ("live", now + timedelta(days=1), None),
        ("expired-long-ago", now - timedelta(days=30), None),
        ("rotated-recently", now + timedelta(days=1), now - timedelta(hours=1)),
        ("rotated-long-ago", now + timedelta(days=1), now - timedelta(days=30)),
    ]:
        session.add(
            RefreshToken(
                user_id=user.id,
                token_hash=name,
                expires_at=expires,
                revoked_at=revoked,
                family_id=user.id,
                started_at=now,
            )
        )
    session.add(
        MalOAuthState(
            state="old", user_id=user.id, verifier="v", created_at=now - timedelta(days=1)
        )
    )
    session.add(MalOAuthState(state="new", user_id=user.id, verifier="v"))
    await session.commit()

    assert await prune() == (2, 1)
    hashes = set(await session.scalars(select(RefreshToken.token_hash)))
    assert hashes == {"live", "rotated-recently"}
    assert await session.scalar(select(func.count()).select_from(MalOAuthState)) == 1
