"""add manga continue hidden

Revision ID: c5e7a9b1d3f6
Revises: b4d6f8a1c3e5
Create Date: 2026-11-03 04:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c5e7a9b1d3f6"
down_revision: str | Sequence[str] | None = "b4d6f8a1c3e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "manga_continue_hidden",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("manga_id", sa.Integer(), nullable=False),
        sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "manga_id"),
    )


def downgrade() -> None:
    op.drop_table("manga_continue_hidden")
