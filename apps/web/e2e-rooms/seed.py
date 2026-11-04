"""Resets the end-to-end database and creates the users the room tests sign in as."""

import asyncio

from sqlalchemy import text

from app import db
from app.config import get_settings
from app.models import User
from app.security import hash_password

USERS = ("alice", "bob", "carol", "dave", "erin")


async def main() -> None:
    db.init_engine(get_settings().database_url)
    async with db.new_session() as session:
        await session.execute(text("TRUNCATE users CASCADE"))
        for name in USERS:
            session.add(User(username=name, password_hash=hash_password("password123")))
        await session.commit()
    await db.dispose_engine()


asyncio.run(main())
