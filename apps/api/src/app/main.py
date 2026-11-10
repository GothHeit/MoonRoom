import asyncio
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import db
from app import push as phone_push
from app.aniskip import AniSkip
from app.anizip import AniZip
from app.cleanup import prune
from app.config import get_settings
from app.errors import install_error_handlers
from app.logs import install_logging
from app.mal.account import MalAccounts
from app.mal.client import MalClient
from app.manga import load_manga_sources
from app.notifications import check_new_chapters, check_new_episodes
from app.probes import StreamProbes
from app.ratelimit import ActionLimits, AuthLimits
from app.room_store import RoomStore, keep_saved, restore
from app.rooms import Rooms
from app.routers import (
    anime,
    auth,
    avatars,
    device_login,
    diagnostics,
    friends,
    home,
    invites,
    mal,
    manga,
    notifications,
    pin,
    progress,
    push,
    rooms,
    watch,
)
from app.sessions import SessionCheck
from app.sharedcache import SharedCache
from app.source_hints import new_source_hints
from app.sources import load_sources

log = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 300
EPISODE_CHECK_FIRST_RUN_SECONDS = 120
PRUNE_INTERVAL_SECONDS = 6 * 3600


async def _sweep(
    limits: AuthLimits, actions: ActionLimits, sessions: SessionCheck, rooms: Rooms
) -> None:
    # Idle rate-limit keys are otherwise only dropped when the same key is seen again.
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
        limits.sweep()
        actions.sweep()
        sessions.sweep()
        rooms.sweep()


async def _prune() -> None:
    while True:
        try:
            tokens, states = await prune()
            log.info("pruned %d refresh tokens and %d OAuth states", tokens, states)
        except Exception:
            log.exception("database cleanup failed")
        await asyncio.sleep(PRUNE_INTERVAL_SECONDS)


async def _episode_checks(app: FastAPI, hours: int) -> None:
    # Let the app settle after a start before the first round of lookups.
    await asyncio.sleep(EPISODE_CHECK_FIRST_RUN_SECONDS)
    while True:
        try:
            await check_new_episodes(app.state.mal, app.state.sources)
        except Exception:
            log.exception("new-episode check failed")
        try:
            await check_new_chapters(app.state.mal, app.state.manga_sources)
        except Exception:
            log.exception("new-chapter check failed")
        await asyncio.sleep(hours * 3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    db.init_engine(settings.database_url)
    async with httpx.AsyncClient(follow_redirects=True) as http:
        app.state.http = http
        app.state.shared_cache = SharedCache(settings.redis_url)
        app.state.mal = MalClient(
            settings.mal_client_id, http, settings.mal_api_base, app.state.shared_cache
        )
        app.state.mal_accounts = MalAccounts(settings, http)
        app.state.aniskip = AniSkip(http)
        app.state.anizip = AniZip(http, app.state.shared_cache)
        app.state.pt_synopses = None
        if settings.pt_synopsis_scrape:
            from app.synopsis import PtSynopses

            app.state.pt_synopses = PtSynopses(http)
        app.state.auth_limits = AuthLimits(settings)
        app.state.action_limits = ActionLimits()
        app.state.session_check = SessionCheck()
        app.state.rooms = Rooms(settings.max_rooms_per_host)
        app.state.room_store = RoomStore(settings.redis_url)
        await restore(app.state.rooms, app.state.room_store)
        app.state.source_hints = new_source_hints()
        app.state.probes = StreamProbes(http)
        app.state.watch = watch.WatchCaches()
        app.state.sources = load_sources(settings.video_source_names)
        app.state.manga_sources = load_manga_sources(
            settings.manga_source_names, app.state.shared_cache
        )
        app.state.page_cache = manga.new_page_cache(
            settings.manga_cache_dir, settings.manga_cache_max_mb
        )
        sweeper = asyncio.create_task(
            _sweep(
                app.state.auth_limits,
                app.state.action_limits,
                app.state.session_check,
                app.state.rooms,
            )
        )
        pruner = asyncio.create_task(_prune())
        room_saver = asyncio.create_task(keep_saved(app.state.rooms, app.state.room_store))
        checker = (
            asyncio.create_task(_episode_checks(app, settings.episode_check_hours))
            if settings.episode_check_hours > 0
            else None
        )
        pusher = (
            asyncio.create_task(phone_push.run(http, settings))
            if settings.vapid_private_key
            else None
        )
        try:
            yield
        finally:
            if pusher is not None:
                pusher.cancel()
            sweeper.cancel()
            pruner.cancel()
            room_saver.cancel()
            for task in list(app.state.watch.tasks):
                task.cancel()
            if checker is not None:
                checker.cancel()
            for source in (*app.state.sources.values(), *app.state.manga_sources.values()):
                if hasattr(source, "aclose"):
                    await source.aclose()
            await app.state.shared_cache.aclose()
            await app.state.room_store.aclose()
            await app.state.auth_limits.store.aclose()
    await db.dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    install_logging()
    # The interactive docs map every route; a public deployment has no use for them.
    docs = settings.api_docs
    app = FastAPI(
        title=f"{settings.app_name} API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_error_handlers(app)

    @app.get("/health", tags=["meta"])
    async def health():
        return {"status": "ok"}

    # rooms before watch: /watch/rooms/... must not be read as /watch/{source}/....
    for module in (
        auth,
        device_login,
        pin,
        avatars,
        friends,
        invites,
        anime,
        manga,
        mal,
        rooms,
        watch,
        progress,
        home,
        notifications,
        push,
        diagnostics,
    ):
        app.include_router(module.router)
    return app


app = create_app()
