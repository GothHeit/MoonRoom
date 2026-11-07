"""add tv pin

Revision ID: f2c4e6a8b013
Revises: e1a3c5b7d9f2
Create Date: 2026-11-07 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f2c4e6a8b013"
down_revision: str | Sequence[str] | None = "e1a3c5b7d9f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("pin_hash", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("pin_set_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "refresh_tokens",
        sa.Column("is_tv", sa.Boolean(), server_default="false", nullable=False),
    )
    # TVs that signed in before this existed are recognised by their browser.
    op.execute(
        "UPDATE refresh_tokens SET is_tv = true WHERE user_agent ILIKE '%Tizen%' "
        "OR user_agent ILIKE '%SMART-TV%' OR user_agent ILIKE '%Web0S%' "
        "OR user_agent ILIKE '%webOS%'"
    )
    op.create_table(
        "session_unlocks",
        sa.Column("family_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("unlocked_until", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("family_id"),
    )
    op.create_index("ix_session_unlocks_user_id", "session_unlocks", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_session_unlocks_user_id", table_name="session_unlocks")
    op.drop_table("session_unlocks")
    op.drop_column("refresh_tokens", "is_tv")
    op.drop_column("users", "pin_set_at")
    op.drop_column("users", "pin_hash")
