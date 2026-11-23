"""add title comments

Revision ID: a3c5e7f9b124
Revises: a4c6e8b0d135
Create Date: 2026-11-23 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a3c5e7f9b124"
down_revision: str | Sequence[str] | None = "a4c6e8b0d135"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "title_comments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("anime_id", sa.Integer(), nullable=True),
        sa.Column("manga_id", sa.Integer(), nullable=True),
        sa.Column("body", sa.String(length=1000), nullable=False),
        sa.Column("spoiler", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(anime_id IS NULL) <> (manga_id IS NULL)", name="ck_title_comments_one_title"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_title_comments_user_id", "title_comments", ["user_id"])
    op.create_index("ix_title_comments_anime_created", "title_comments", ["anime_id", "created_at"])
    op.create_index("ix_title_comments_manga_created", "title_comments", ["manga_id", "created_at"])


def downgrade() -> None:
    op.drop_table("title_comments")
