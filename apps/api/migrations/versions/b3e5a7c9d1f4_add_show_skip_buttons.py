"""add show skip buttons

Revision ID: b3e5a7c9d1f4
Revises: a7d1c3e5f902
Create Date: 2026-11-02 14:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3e5a7c9d1f4"
down_revision: str | Sequence[str] | None = "a7d1c3e5f902"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "player_preferences",
        sa.Column("show_skip_buttons", sa.Boolean(), nullable=False, server_default="true"),
    )


def downgrade() -> None:
    op.drop_column("player_preferences", "show_skip_buttons")
