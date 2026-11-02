import asyncio
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import db
from app.aniskip import AniSkip
from app.anizip import AniZip
from app.cleanup import prune
from app.config import get_settings
from app.errors import install_error_handlers
from app.logs import install_logging
from app.mal.account import MalAccounts
from app.mal.client import MalClient
from app.notifications import check_new_episodes
from app.probes import StreamProbes
from app.ratelimit import ActionLimits, AuthLimits
from app.rooms import Rooms
from app.routers import (
    anime,
    auth,
    avatars,
    friends,
    home,
    invites,
    mal,
    notifications,
    progress,
    rooms,
    watch,
)
from app.source_hints import new_source_hints
from app.sources import load_sources

log = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 300
EPISODE_CHECK_FIRST_RUN_SECONDS = 120
PRUNE_INTERVAL_SECONDS = 6 * 3600


async def _sweep(limits: AuthLimits, actions: ActionLimits, rooms: Rooms) -> None:
    # Idle rate-limit keys are otherwise only dropped when the same key is seen again.
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
        limits.sweep()
        actions.sweep()
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
        await asyncio.sleep(hours * 3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    db.init_engine(settings.database_url)
    async with httpx.AsyncClient(follow_redirects=True) as http:
        app.state.http = http
        app.state.mal = MalClient(settings.mal_client_id, http, settings.mal_api_base)
        app.state.mal_accounts = MalAccounts(settings, http)
        app.state.aniskip = AniSkip(http)
        app.state.anizip = AniZip(http)
        app.state.pt_synopses = None
        if settings.pt_synopsis_scrape:
            from app.synopsis import PtSynopses

            app.state.pt_synopses = PtSynopses(http)
        app.state.auth_limits = AuthLimits(settings)
        app.state.action_limits = ActionLimits()
        app.state.rooms = Rooms(settings.max_rooms_per_host)
        app.state.source_hints = new_source_hints()
        app.state.probes = StreamProbes(http)
        app.state.watch = watch.WatchCaches()
        app.state.sources = load_sources(settings.video_source_names)
        sweeper = asyncio.create_task(
            _sweep(app.state.auth_limits, app.state.action_limits, app.state.rooms)
        )
        pruner = asyncio.create_task(_prune())
        checker = (
            asyncio.create_task(_episode_checks(app, settings.episode_check_hours))
            if settings.episode_check_hours > 0
            else None
        )
        try:
            yield
        finally:
            sweeper.cancel()
            pruner.cancel()
            for task in list(app.state.watch.tasks):
                task.cancel()
            if checker is not None:
                checker.cancel()
            for source in app.state.sources.values():
                if hasattr(source, "aclose"):
                    await source.aclose()
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
        avatars,
        friends,
        invites,
        anime,
        mal,
        rooms,
        watch,
        progress,
        home,
        notifications,
    ):
        app.include_router(module.router)
    return app


app = create_app()
