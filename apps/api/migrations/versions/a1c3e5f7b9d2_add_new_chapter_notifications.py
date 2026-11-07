"""add new chapter notifications

Revision ID: a1c3e5f7b9d2
Revises: d8b2f4a6c071
Create Date: 2026-11-07 01:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1c3e5f7b9d2"
down_revision: str | Sequence[str] | None = "d8b2f4a6c071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("notifications", sa.Column("manga_id", sa.Integer(), nullable=True))
    op.create_table(
        "manga_chapter_seen",
        sa.Column("manga_id", sa.Integer(), nullable=False),
        sa.Column("latest_chapter", sa.Integer(), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("manga_id"),
    )


def downgrade() -> None:
    op.drop_table("manga_chapter_seen")
    op.drop_column("notifications", "manga_id")
