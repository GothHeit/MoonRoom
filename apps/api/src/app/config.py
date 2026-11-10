import hashlib
import hmac
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Product name in one place: it may still change.
    app_name: str = "MoonRoom"

    database_url: str = "postgresql+asyncpg://app:app@localhost:5432/app"
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_pool_timeout_seconds: int = 10
    # Recycle connections before an idle-timeout on the way to Postgres can cut them.
    db_pool_recycle_seconds: int = 1800

    # Required: the app refuses to start without it, instead of failing at first login.
    jwt_secret: str = Field(min_length=32)
    # Comma-separated secrets that signed tokens before the last rotation. Tokens they signed
    # are still accepted (never issued) until they expire, so rotating JWT_SECRET signs nobody
    # out: move the old value here, set a new JWT_SECRET, and drop it after a day.
    jwt_previous_secrets: str = ""
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    # Stream links (the master playlist link and every segment link) are signed with a key of
    # their own, so a leaked one can never help forge a login token. Unset, it is derived from
    # JWT_SECRET; set it to rotate the two independently. Links signed with an old value stay
    # valid while it is listed in STREAM_LINK_PREVIOUS_SECRETS (links live four hours at most).
    stream_link_secret: str = ""
    stream_link_previous_secrets: str = ""
    # How long the link that starts a playback lives. It works without a login (a TV or AirPlay
    # receiver can't send one), so it is short; every later link is re-signed as the player goes.
    playback_token_minutes: int = 10
    # How long the link of an MP4 episode lives. It is the stream itself, asked again on every
    # seek and after every pause, so it lives as long as an HLS segment link (four hours).
    mp4_link_minutes: int = 240
    # A refresh token that was just rotated is still accepted for this long, so a device whose
    # answer got lost can retry without it reading as a stolen token.
    refresh_grace_seconds: int = 60

    # Fernet key that encrypts MAL tokens at rest. Generate one with
    # `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
    token_encryption_key: str = Field(min_length=32)

    # Failed attempts allowed per window before /auth answers 429.
    login_ip_limit: int = 30
    login_user_limit: int = 8
    login_window_seconds: int = 900
    register_ip_limit: int = 10
    register_user_limit: int = 5
    register_window_seconds: int = 3600
    # Read the client address from X-Forwarded-For. Only enable behind a trusted reverse proxy.
    trust_proxy_headers: bool = False

    # Shared cache for MAL and ani.zip answers, e.g. redis://redis:6379/0. Empty keeps the cache
    # in each process; an unreachable server falls back to that too.
    redis_url: str = ""

    # Private deployments only: Portuguese synopses from an unlicensed site. Off in public builds.
    pt_synopsis_scrape: bool = False

    # Serve /docs, /redoc and /openapi.json. Off in production.
    api_docs: bool = True

    # Comma-separated list of browser origins allowed to call the API.
    cors_origins: str = "http://localhost:3000"
    web_url: str = "http://localhost:3000"

    mal_client_id: str = ""
    # Where public MAL data is read from. Only the end-to-end tests point it elsewhere.
    mal_api_base: str = "https://api.myanimelist.net/v2"
    mal_client_secret: str = ""
    mal_redirect_uri: str = "http://localhost:8000/mal/callback"

    # Where uploaded profile pictures are stored. Mount a volume here to keep them.
    avatar_dir: str = "data/avatars"

    # How often to look for new episodes of airing titles people are watching. 0 turns it off.
    episode_check_hours: int = 6

    # Phone notifications (Web Push). The signing key is made with `python -m app.webpush`; with
    # it unset, the feature is off. VAPID_SUBJECT is how push services can reach the operator.
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:admin@moonroom.stream"

    # Open watch-together rooms one person may host.
    max_rooms_per_host: int = 3

    # Video sources to enable, by name. Empty in a public deployment.
    video_sources: str = ""
    # Converted copies of the owner's own files, for the `local` source, made by
    # `python -m app.library ingest` or `scan`; the API only reads them. A comma-separated list
    # of folders: a title is served from the first one that holds it, and files may be symlinks
    # into any of them (say, D: plus a NAS share).
    local_library_dirs: str = ""
    # The single-folder form of the same setting, still read (listed first).
    local_library_dir: str = ""

    # Manga sources to enable, by name and in order of preference (e.g. "mangadex").
    manga_sources: str = ""
    # Chapter pages fetched once are kept here, up to MANGA_CACHE_MAX_MB, oldest-read first out.
    # Mount a volume (a data disk, never the system one) to keep them across restarts.
    manga_cache_dir: str = "data/manga-pages"
    manga_cache_max_mb: int = 2048

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def library_roots(self) -> list[str]:
        roots = [self.local_library_dir, *self.local_library_dirs.split(",")]
        return list(dict.fromkeys(r.strip() for r in roots if r.strip()))

    @property
    def jwt_verification_secrets(self) -> list[str]:
        previous = [s.strip() for s in self.jwt_previous_secrets.split(",") if s.strip()]
        return [self.jwt_secret, *previous]

    @property
    def stream_link_keys(self) -> list[bytes]:
        """Keys that sign stream links, newest first. Each is derived from a secret for this one
        purpose, so no secret is ever used raw for two things."""
        if self.stream_link_secret:
            previous = [
                s.strip() for s in self.stream_link_previous_secrets.split(",") if s.strip()
            ]
            secrets = [self.stream_link_secret, *previous]
        else:
            secrets = self.jwt_verification_secrets
        return [
            hmac.new(s.encode(), b"moonroom stream links", hashlib.sha256).digest() for s in secrets
        ]

    @property
    def video_source_names(self) -> list[str]:
        return [s.strip() for s in self.video_sources.split(",") if s.strip()]

    @property
    def manga_source_names(self) -> list[str]:
        return [s.strip() for s in self.manga_sources.split(",") if s.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
