"""add playback preferences

Revision ID: a7d1c3e5f902
Revises: b7d1e3f5a921
Create Date: 2026-11-02 03:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7d1c3e5f902"
down_revision: str | Sequence[str] | None = "b7d1e3f5a921"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "player_preferences",
        sa.Column("audio_lang", sa.String(length=8), nullable=False, server_default="original"),
    )
    op.add_column(
        "player_preferences",
        sa.Column("prefer_soft_subs", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column("player_preferences", sa.Column("max_resolution", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("player_preferences", "max_resolution")
    op.drop_column("player_preferences", "prefer_soft_subs")
    op.drop_column("player_preferences", "audio_lang")
