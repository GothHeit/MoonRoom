"""Admin commands: python -m app.cli invite | promote <username> | reset-2fa <username>"""

import argparse
import asyncio

from sqlalchemy import select

from app import db
from app.config import get_settings
from app.models import User
from app.routers.invites import new_invite


async def _invite(days: int) -> None:
    async for session in db.get_session():
        invite = new_invite(days)
        session.add(invite)
        await session.commit()
        print(f"Invite code: {invite.code} (valid {days} days)")


async def _promote(username: str) -> None:
    async for session in db.get_session():
        user = await session.scalar(select(User).where(User.username == username.lower()))
        if user is None:
            raise SystemExit(f"No user named {username}")
        user.is_admin = True
        await session.commit()
        print(f"{user.username} is now an admin")


async def _reset_two_factor(username: str) -> None:
    from app import two_factor

    async for session in db.get_session():
        user = await session.scalar(select(User).where(User.username == username.lower()))
        if user is None:
            raise SystemExit(f"No user named {username}")
        await two_factor.turn_off(session, user)
        await session.commit()
        print(f"Two-factor login is now off for {user.username}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    invite = commands.add_parser("invite", help="create an invite code")
    invite.add_argument("--days", type=int, default=7)
    promote = commands.add_parser("promote", help="make a user an admin")
    promote.add_argument("username")
    reset = commands.add_parser("reset-2fa", help="turn off two-factor login for a locked-out user")
    reset.add_argument("username")
    args = parser.parse_args()

    async def run() -> None:
        db.init_engine(get_settings().database_url)
        try:
            if args.command == "invite":
                await _invite(args.days)
            elif args.command == "reset-2fa":
                await _reset_two_factor(args.username)
            else:
                await _promote(args.username)
        finally:
            await db.dispose_engine()

    asyncio.run(run())


if __name__ == "__main__":
    main()
