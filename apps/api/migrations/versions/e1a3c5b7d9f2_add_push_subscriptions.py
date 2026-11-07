"""add push subscriptions

Revision ID: e1a3c5b7d9f2
Revises: d8b2f4a6c071
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e1a3c5b7d9f2"
down_revision: str | Sequence[str] | None = "a1c3e5f7b9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("endpoint", sa.String(length=1024), nullable=False),
        sa.Column("p256dh", sa.String(length=128), nullable=False),
        sa.Column("auth", sa.String(length=64), nullable=False),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("failures", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("endpoint"),
    )
    op.create_index("ix_push_subscriptions_user", "push_subscriptions", ["user_id"])
    # Notifications that already exist were never meant to be pushed.
    op.add_column(
        "notifications", sa.Column("pushed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute("UPDATE notifications SET pushed_at = now()")
    op.create_index(
        "ix_notifications_unpushed",
        "notifications",
        ["created_at"],
        postgresql_where=sa.text("pushed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_unpushed", table_name="notifications")
    op.drop_column("notifications", "pushed_at")
    op.drop_table("push_subscriptions")
