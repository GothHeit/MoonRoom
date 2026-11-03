"""add manga lang

Revision ID: b4d6f8a1c3e5
Revises: c9f2a4b6d8e1
Create Date: 2026-11-03 00:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4d6f8a1c3e5"
down_revision: str | Sequence[str] | None = "c9f2a4b6d8e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("manga_lang", sa.String(length=8), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "manga_lang")
