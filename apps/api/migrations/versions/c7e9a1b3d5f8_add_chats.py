"""add chats, chat members and chat messages

Revision ID: c7e9a1b3d5f8
Revises: b5d7f9a1c246
Create Date: 2026-11-24 03:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7e9a1b3d5f8"
down_revision: str | Sequence[str] | None = "b5d7f9a1c246"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chats",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("direct_key", sa.String(length=80), nullable=True),
        sa.Column("name", sa.String(length=60), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('direct', 'group')", name="ck_chats_kind"),
        sa.CheckConstraint(
            "(kind = 'direct') = (direct_key IS NOT NULL)", name="ck_chats_direct_key"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("direct_key"),
    )
    op.create_table(
        "chat_members",
        sa.Column("chat_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("muted", sa.Boolean(), server_default="false", nullable=False),
        sa.ForeignKeyConstraint(["chat_id"], ["chats.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("chat_id", "user_id"),
    )
    op.create_index("ix_chat_members_user_id", "chat_members", ["user_id"])
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("chat_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("body", sa.String(length=2000), nullable=True),
        sa.Column("anime_id", sa.Integer(), nullable=True),
        sa.Column("manga_id", sa.Integer(), nullable=True),
        sa.Column("episode", sa.Integer(), nullable=True),
        sa.Column("chapter", sa.String(length=16), nullable=True),
        sa.Column("share_title", sa.String(length=300), nullable=True),
        sa.Column("share_image", sa.String(length=500), nullable=True),
        sa.Column("share_poster", sa.String(length=500), nullable=True),
        sa.Column("share_adult", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "body IS NOT NULL OR anime_id IS NOT NULL OR manga_id IS NOT NULL",
            name="ck_chat_messages_not_empty",
        ),
        sa.CheckConstraint(
            "anime_id IS NULL OR manga_id IS NULL", name="ck_chat_messages_one_title"
        ),
        sa.ForeignKeyConstraint(["chat_id"], ["chats.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_chat_messages_chat_created", "chat_messages", ["chat_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_chat_messages_chat_created", table_name="chat_messages")
    op.drop_table("chat_messages")
    op.drop_index("ix_chat_members_user_id", table_name="chat_members")
    op.drop_table("chat_members")
    op.drop_table("chats")
