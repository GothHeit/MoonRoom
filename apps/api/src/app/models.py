import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Float, ForeignKey, Index, String, column, func
from sqlalchemy.orm import Mapped, mapped_column

from app.crypto import EncryptedString
from app.db import Base, TimestampMixin, utcnow

LOCALES = ("pt", "en")


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    # Stored lower-cased so "Kafka" and "kafka" can't both register.
    username: Mapped[str] = mapped_column(String(32), unique=True)
    password_hash: Mapped[str]
    locale: Mapped[str] = mapped_column(String(5), default="pt")
    show_nsfw: Mapped[bool] = mapped_column(default=True)
    # None means automatic (pt-BR, then English); "off" hides subtitles.
    subtitle_lang: Mapped[str | None] = mapped_column(String(8), default=None)
    is_admin: Mapped[bool] = mapped_column(default=False)
    # A preset artwork key, or None. An uploaded picture wins over it when avatar_uploaded.
    avatar_preset: Mapped[str | None] = mapped_column(String(16), default=None)
    avatar_uploaded: Mapped[bool] = mapped_column(default=False, server_default="false")
    # Counts uploads and never goes down, so a new picture always gets a new URL and a cache
    # can't serve an old one.
    avatar_version: Mapped[int] = mapped_column(default=0, server_default="0")
    # False hides what the user is watching from their friends' view of their profile and feed.
    share_activity: Mapped[bool] = mapped_column(default=True, server_default="true")
    # Two-factor login. The secret is stored (encrypted) from the moment enrolment starts;
    # two_factor_at is set once the user proved the app works, and that is what turns it on.
    totp_secret: Mapped[str | None] = mapped_column(EncryptedString, default=None)
    two_factor_at: Mapped[datetime | None] = mapped_column(default=None)
    # The last accepted 30 s step, so a code can't be used twice.
    totp_last_step: Mapped[int | None] = mapped_column(BigInteger, default=None)


class Invite(TimestampMixin, Base):
    __tablename__ = "invites"

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    used_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    used_at: Mapped[datetime | None]
    expires_at: Mapped[datetime]


class RefreshToken(TimestampMixin, Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # Only a SHA-256 of the token is stored, so a database leak can't be replayed.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
    # One login = one family: rotation keeps the family, so a family is a "session" the user can
    # see and revoke. The device details are refreshed on every rotation.
    family_id: Mapped[uuid.UUID] = mapped_column(index=True)
    started_at: Mapped[datetime]
    user_agent: Mapped[str | None] = mapped_column(String(255))
    ip: Mapped[str | None] = mapped_column(String(64))


class MalLink(TimestampMixin, Base):
    __tablename__ = "mal_links"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # Encrypted at rest with TOKEN_ENCRYPTION_KEY.
    access_token: Mapped[str] = mapped_column(EncryptedString)
    refresh_token: Mapped[str] = mapped_column(EncryptedString)
    expires_at: Mapped[datetime]
    mal_username: Mapped[str | None]
    mal_picture: Mapped[str | None]


class MalOAuthState(TimestampMixin, Base):
    __tablename__ = "mal_oauth_states"

    state: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    verifier: Mapped[str] = mapped_column(String(128))
    # The user's language when linking started, so the callback can send them back to it.
    locale: Mapped[str | None] = mapped_column(String(5))


class WatchProgress(Base):
    """Where a user stopped in one episode. Keyed by MAL anime id, so it is source-agnostic."""

    __tablename__ = "watch_progress"
    __table_args__ = (Index("ix_watch_progress_user_updated", "user_id", "updated_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    anime_id: Mapped[int] = mapped_column(primary_key=True)
    episode: Mapped[int] = mapped_column(primary_key=True)
    position_seconds: Mapped[float] = mapped_column(Float)
    duration_seconds: Mapped[float | None] = mapped_column(Float)
    completed: Mapped[bool] = mapped_column(default=False)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class MangaProgress(Base):
    """Where a user stopped in one chapter. Keyed by MAL manga id and the chapter's number as
    the source writes it ("12", "12.5"), so it survives a change of source."""

    __tablename__ = "manga_progress"
    __table_args__ = (Index("ix_manga_progress_user_updated", "user_id", "updated_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    manga_id: Mapped[int] = mapped_column(primary_key=True)
    chapter: Mapped[str] = mapped_column(String(16), primary_key=True)
    # Zero-based page the reader was on, and how many the chapter has.
    page: Mapped[int]
    pages: Mapped[int]
    completed: Mapped[bool] = mapped_column(default=False)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class ContinueHidden(Base):
    """A title the user removed from Continue watching. Their watch history is left alone.

    The title comes back once they watch something of it after `hidden_at`."""

    __tablename__ = "continue_hidden"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    anime_id: Mapped[int] = mapped_column(primary_key=True)
    hidden_at: Mapped[datetime] = mapped_column(default=utcnow)


class PlayerPreferences(Base):
    """How a user likes the player. One row per user, created on first save."""

    __tablename__ = "player_preferences"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    subtitle_size: Mapped[str] = mapped_column(String(16), default="medium")
    subtitle_color: Mapped[str] = mapped_column(String(16), default="white")
    subtitle_background: Mapped[str] = mapped_column(String(16), default="outline")
    subtitle_position: Mapped[str] = mapped_column(String(16), default="bottom")
    # What the automatic source choice looks for (see app.ranking): "original" audio or the
    # language of a dub, soft subtitles over burned-in ones, and an optional height limit.
    audio_lang: Mapped[str] = mapped_column(
        String(8), default="original", server_default="original"
    )
    prefer_soft_subs: Mapped[bool] = mapped_column(default=True, server_default="true")
    show_skip_buttons: Mapped[bool] = mapped_column(default=True, server_default="true")
    max_resolution: Mapped[int | None] = mapped_column(default=None)


class Friendship(Base):
    """A friend request, which becomes a friendship once the addressee accepts it.

    One row per pair: the unique index below treats (a, b) and (b, a) as the same pair."""

    __tablename__ = "friendships"
    __table_args__ = (
        Index(
            "ix_friendships_pair",
            func.least(column("requester_id"), column("addressee_id")),
            func.greatest(column("requester_id"), column("addressee_id")),
            unique=True,
        ),
    )

    requester_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    addressee_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    accepted: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    accepted_at: Mapped[datetime | None]


class Notification(Base):
    """One entry in a user's bell. Only the facts needed to show it are kept, so it still reads
    right after the thing it was about is gone."""

    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_created", "user_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # friend_request, friend_accepted, room_invite or new_episode.
    kind: Mapped[str] = mapped_column(String(24))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    anime_id: Mapped[int | None]
    episode: Mapped[int | None]
    title: Mapped[str | None] = mapped_column(String(300))
    room_code: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    read_at: Mapped[datetime | None]


class NotificationMute(Base):
    """A kind of notification the user turned off."""

    __tablename__ = "notification_mutes"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(24), primary_key=True)


class EpisodeSeen(Base):
    """The newest episode a video source had for an airing title when it was last checked."""

    __tablename__ = "episode_seen"

    anime_id: Mapped[int] = mapped_column(primary_key=True)
    latest_episode: Mapped[int]
    checked_at: Mapped[datetime] = mapped_column(default=utcnow)


class SourceChoice(Base):
    """The source and sub/dub a user picked in the player for one title, so it plays from
    there next time. Only explicit picks are kept, never a fallback that happened to answer."""

    __tablename__ = "source_choices"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    anime_id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(40))
    lang: Mapped[str] = mapped_column(String(3))
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class BackupCode(TimestampMixin, Base):
    """A one-time code that replaces an authenticator code. Only a hash is stored."""

    __tablename__ = "backup_codes"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    code_hash: Mapped[str] = mapped_column(String(64))
    used_at: Mapped[datetime | None]


class TrustedDevice(TimestampMixin, Base):
    """A browser that skips the second step until `expires_at`. Only a hash of its token is
    stored, like refresh tokens."""

    __tablename__ = "trusted_devices"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime]
