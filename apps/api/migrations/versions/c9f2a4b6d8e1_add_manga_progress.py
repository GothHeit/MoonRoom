"""add manga progress

Revision ID: c9f2a4b6d8e1
Revises: b3e5a7c9d1f4
Create Date: 2026-11-02 22:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c9f2a4b6d8e1"
down_revision: str | Sequence[str] | None = "b3e5a7c9d1f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "manga_progress",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("manga_id", sa.Integer(), nullable=False),
        sa.Column("chapter", sa.String(length=16), nullable=False),
        sa.Column("page", sa.Integer(), nullable=False),
        sa.Column("pages", sa.Integer(), nullable=False),
        sa.Column("completed", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "manga_id", "chapter"),
    )
    op.create_index(
        "ix_manga_progress_user_updated", "manga_progress", ["user_id", "updated_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_manga_progress_user_updated", table_name="manga_progress")
    op.drop_table("manga_progress")
