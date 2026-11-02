import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request

from app import hls
from app.choose import union_episodes
from app.deps import CurrentSessionId, CurrentUser, Session
from app.errors import ApiError
from app.mal.client import MalClient, is_safe
from app.mal.genres import GENRE_IDS, GENRES
from app.models import SourceChoice
from app.routers.watch import episodes_out
from app.schemas import (
    AnimeCard,
    AnimeDetailsOut,
    AnimeListOut,
    BrowseOut,
    EpisodeArtOut,
    EpisodesOut,
    GenreOut,
    SeasonalOut,
    SourcesOut,
    StreamOption,
    TitleArtOut,
)
from app.source_hints import SOURCE_FAILURE_TTL, SOURCE_HINT_TTL, SourceHints

router = APIRouter(prefix="/anime", tags=["anime"])
log = logging.getLogger(__name__)

Season = Literal["winter", "spring", "summer", "fall"]

SOURCE_PROBE_TIMEOUT = 8.0
# Related and recommended nodes carry no rating or genres: with NSFW off, this many of each are
# checked against their (cached) details before being shown.
SAFE_CHECK_LIMIT = 12
# At most this many details are fetched at once for those checks, and the page waits at most
# SAFE_CHECK_BUDGET seconds for them. Checks still running then keep warming the cache for the
# next visit, but their entries are left out of this response.
SAFE_CHECK_CONCURRENCY = 6
SAFE_CHECK_BUDGET = 4.0


def _mal(request: Request) -> MalClient:
    return request.app.state.mal


def _cards(nodes: list[dict]) -> list[AnimeCard]:
    return [AnimeCard.from_node(n) for n in nodes]


@router.get("/seasonal", response_model=SeasonalOut)
async def seasonal(request: Request, user: CurrentUser, page: Annotated[int, Query(ge=1)] = 1):
    result = await _mal(request).seasonal(page, user.show_nsfw)
    return SeasonalOut(
        year=result["year"],
        season=result["season"],
        has_next=result["has_next"],
        data=_cards([i["node"] for i in result["data"]]),
    )


@router.get("/search", response_model=AnimeListOut)
async def search(
    request: Request, user: CurrentUser, q: Annotated[str, Query(min_length=1, max_length=100)]
):
    result = await _mal(request).search(q, user.show_nsfw)
    return AnimeListOut(data=_cards([i["node"] for i in result["data"]]))


@router.get("/top", response_model=AnimeListOut)
async def top(request: Request, user: CurrentUser):
    result = await _mal(request).top(user.show_nsfw)
    return AnimeListOut(data=_cards([i["node"] for i in result["data"]]))


@router.get("/genres", response_model=list[GenreOut])
async def genres(user: CurrentUser):
    return [
        GenreOut(id=g.id, name=g.name, kind=g.kind, nsfw=g.nsfw)
        for g in GENRES
        if user.show_nsfw or not g.nsfw
    ]


@router.get("/browse", response_model=BrowseOut)
async def browse(
    request: Request,
    user: CurrentUser,
    genre: Annotated[int | None, Query(description="MAL genre id, see /anime/genres")] = None,
    year: Annotated[int | None, Query(ge=1960, le=2100)] = None,
    season: Season | None = None,
    page: Annotated[int, Query(ge=1, le=50)] = 1,
):
    if season is not None and year is None:
        raise ApiError(422, "validation_failed", "season needs a year")
    if genre is not None:
        known = GENRE_IDS.get(genre)
        if known is None or (known.nsfw and not user.show_nsfw):
            raise ApiError(422, "validation_failed", "Unknown genre")
    nodes, has_next = await _mal(request).browse(genre, year, season, page, user.show_nsfw)
    return BrowseOut(data=_cards(nodes), page=page, has_next=has_next)


@router.get("/{anime_id}", response_model=AnimeDetailsOut)
async def details(
    request: Request,
    anime_id: int,
    user: CurrentUser,
    lang: Annotated[Literal["en", "pt"], Query()] = "en",
):
    mal = _mal(request)
    raw = await mal.visible_details(anime_id, user.show_nsfw)
    synopsis, synopsis_lang = raw.get("synopsis"), "en" if raw.get("synopsis") else None
    synopses = request.app.state.pt_synopses
    if lang == "pt" and synopses is not None and (pt := await synopses.get(raw)):
        synopsis, synopsis_lang = pt, "pt"
    related = raw.get("related_anime") or []
    recommended = raw.get("recommendations") or []
    if not user.show_nsfw:
        related, recommended = await only_safe(mal, related, recommended)
    return AnimeDetailsOut.model_validate(
        {
            **raw,
            "synopsis": synopsis,
            "synopsis_lang": synopsis_lang,
            "related_anime": [{**r, "anime": r["node"]} for r in related],
            "recommendations": [{**r, "anime": r["node"]} for r in recommended],
        }
    )


@router.get("/{anime_id}/sources", response_model=SourcesOut)
async def sources(
    request: Request, anime_id: int, user: CurrentUser, sid: CurrentSessionId, session: Session
):
    """Which sources can play this title. Separate from the details so a slow scraper never
    holds the title page back."""
    raw = await _mal(request).visible_details(anime_id, user.show_nsfw)
    available = await _available_sources(request, raw)
    saved = await session.get(SourceChoice, (user.id, anime_id))
    await session.commit()  # the scrapers below can take seconds: don't hold a connection
    choice = None
    if saved is not None and saved.source in available:
        choice = StreamOption(source=saved.source, lang="dub" if saved.lang == "dub" else "sub")
    stream, listing = await _first_listing(
        request, raw, available, choice, hls.Viewer(str(user.id), str(sid))
    )
    return SourcesOut(sources=available, choice=choice, stream=stream, listing=listing)


@router.get("/{anime_id}/art", response_model=TitleArtOut)
async def art(
    request: Request,
    anime_id: int,
    user: CurrentUser,
    lang: Annotated[Literal["en", "pt"], Query()] = "en",
):
    """Episode stills and titles plus a wide picture, from ani.zip. Separate from the details so
    the page never waits on it; empty when ani.zip has nothing or is down."""
    await _mal(request).visible_details(anime_id, user.show_nsfw)
    found = await request.app.state.anizip.art(anime_id)
    return TitleArtOut(
        backdrop=found.backdrop,
        episodes={
            number: EpisodeArtOut(title=episode.title(lang), image=episode.image)
            for number, episode in found.episodes.items()
        },
    )


# Checks left running after the response. The loop only holds tasks weakly, so keep them here
# until they finish, and read their outcome so a failure is not left unretrieved.
_running: set[asyncio.Future] = set()


def _reap(task: asyncio.Future) -> None:
    _running.discard(task)
    if not task.cancelled() and task.exception() is not None:
        log.warning("anime: safety check failed: %s", task.exception())


def _track[T: asyncio.Future](task: T) -> T:
    _running.add(task)
    task.add_done_callback(_reap)
    return task


async def only_safe(
    mal: MalClient,
    *groups: list[dict],
    fetch: Callable[[int], Awaitable[dict]] | None = None,
) -> tuple[list[dict], ...]:
    """Keeps the entries whose details say they are safe. A title that can't be checked, or
    isn't checked within the budget, is dropped rather than shown. `fetch` reads one entry's
    details (anime by default; the manga section passes its own)."""
    gate = asyncio.Semaphore(SAFE_CHECK_CONCURRENCY)
    read = fetch or mal.details

    async def check(entry: dict) -> bool:
        async with gate:
            try:
                return is_safe(await read(entry["node"]["id"]))
            except ApiError:
                return False

    heads = [group[:SAFE_CHECK_LIMIT] for group in groups]
    tasks = [[_track(asyncio.ensure_future(check(e))) for e in head] for head in heads]
    pending = [t for group in tasks for t in group]
    if pending:
        await asyncio.wait(pending, timeout=SAFE_CHECK_BUDGET)

    def kept(head: list[dict], group: Sequence[asyncio.Future[bool]]) -> list[dict]:
        return [e for e, t in zip(head, group, strict=True) if t.done() and t.result()]

    return tuple(kept(head, group) for head, group in zip(heads, tasks, strict=True))


async def _has_episodes(request: Request, name: str, anime: dict) -> bool:
    hints: SourceHints = request.app.state.source_hints
    key = (name, anime["id"])
    if key in hints:
        return hints[key][0]
    found = False
    ttl = SOURCE_HINT_TTL
    try:
        result = await asyncio.wait_for(
            request.app.state.sources[name].episodes(anime, "sub"), SOURCE_PROBE_TIMEOUT
        )
        found = bool(result and result.episodes)
    except Exception:  # a broken source just isn't offered
        ttl = SOURCE_FAILURE_TTL
    hints[key] = (found, ttl)
    return found


async def _first_listing(
    request: Request,
    anime: dict,
    available: list[str],
    choice: StreamOption | None,
    viewer: hls.Viewer,
) -> tuple[StreamOption | None, EpisodesOut | None]:
    """The episodes of the stream the title page plays from: the saved pick, else the automatic
    choice. A pick that lists nothing falls through to the default."""
    candidates = [choice] if choice else []
    if available:
        # Without a pick the API chooses per episode (automatic).
        default = StreamOption(source="auto", lang="sub")
        if default not in candidates:
            candidates.append(default)
    for option in candidates:
        try:
            if option.source == "auto":
                listed = await union_episodes(
                    {n: request.app.state.sources[n] for n in available},
                    anime,
                    SOURCE_PROBE_TIMEOUT,
                )
            else:
                listed = await asyncio.wait_for(
                    request.app.state.sources[option.source].episodes(anime, option.lang),
                    SOURCE_PROBE_TIMEOUT,
                )
        except Exception:  # the page falls back to asking for the episodes itself
            continue
        if listed and listed.episodes:
            return option, episodes_out(option.source, listed, viewer)
    return None, None


async def _available_sources(request: Request, anime: dict) -> list[str]:
    names = list(request.app.state.sources)
    hits = await asyncio.gather(*(_has_episodes(request, n, anime) for n in names))
    return [n for n, hit in zip(names, hits, strict=True) if hit]
