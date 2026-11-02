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
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    playback_token_minutes: int = 360
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

    # Private deployments only: Portuguese synopses from an unlicensed site. Off in public builds.
    pt_synopsis_scrape: bool = False

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

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def library_roots(self) -> list[str]:
        roots = [self.local_library_dir, *self.local_library_dirs.split(",")]
        return list(dict.fromkeys(r.strip() for r in roots if r.strip()))

    @property
    def video_source_names(self) -> list[str]:
        return [s.strip() for s in self.video_sources.split(",") if s.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
