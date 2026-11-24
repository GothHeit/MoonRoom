"""link reply notifications to the reply

Revision ID: d3f5a7c9e1b4
Revises: c7e9a1b3d5f8
Create Date: 2026-11-24 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3f5a7c9e1b4"
down_revision: str | Sequence[str] | None = "c7e9a1b3d5f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("notifications", sa.Column("reply_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_notifications_reply_id"), "notifications", ["reply_id"])
    op.create_foreign_key(
        "fk_notifications_reply_id_title_comments",
        "notifications",
        "title_comments",
        ["reply_id"],
        ["id"],
        ondelete="CASCADE",
    )
    # Reply notices made before this can't be tied to their reply; they are at most 30 days old.


def downgrade() -> None:
    op.drop_constraint(
        "fk_notifications_reply_id_title_comments", "notifications", type_="foreignkey"
    )
    op.drop_index(op.f("ix_notifications_reply_id"), table_name="notifications")
    op.drop_column("notifications", "reply_id")
