"""add episode comments, replies and reactions

Revision ID: b5d7f9a1c246
Revises: a3c5e7f9b124
Create Date: 2026-11-23 22:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b5d7f9a1c246"
down_revision: str | Sequence[str] | None = "a3c5e7f9b124"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("title_comments", sa.Column("episode", sa.Integer(), nullable=True))
    op.add_column("title_comments", sa.Column("chapter", sa.String(length=16), nullable=True))
    op.add_column("title_comments", sa.Column("parent_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_title_comments_parent",
        "title_comments",
        "title_comments",
        ["parent_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_title_comments_parent", "title_comments", ["parent_id"])
    op.create_check_constraint(
        "ck_title_comments_episode_anime",
        "title_comments",
        "episode IS NULL OR anime_id IS NOT NULL",
    )
    op.create_check_constraint(
        "ck_title_comments_chapter_manga",
        "title_comments",
        "chapter IS NULL OR manga_id IS NOT NULL",
    )
    op.create_table(
        "comment_reactions",
        sa.Column("comment_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["comment_id"], ["title_comments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("comment_id", "user_id", "kind"),
    )
    op.add_column("notifications", sa.Column("chapter", sa.String(length=16), nullable=True))
    op.add_column("notifications", sa.Column("comment_id", sa.Uuid(), nullable=True))
    op.add_column("notifications", sa.Column("excerpt", sa.String(length=160), nullable=True))


def downgrade() -> None:
    op.drop_column("notifications", "excerpt")
    op.drop_column("notifications", "comment_id")
    op.drop_column("notifications", "chapter")
    op.drop_table("comment_reactions")
    op.drop_constraint("ck_title_comments_chapter_manga", "title_comments", type_="check")
    op.drop_constraint("ck_title_comments_episode_anime", "title_comments", type_="check")
    op.drop_index("ix_title_comments_parent", table_name="title_comments")
    op.drop_constraint("fk_title_comments_parent", "title_comments", type_="foreignkey")
    op.drop_column("title_comments", "parent_id")
    op.drop_column("title_comments", "chapter")
    op.drop_column("title_comments", "episode")
