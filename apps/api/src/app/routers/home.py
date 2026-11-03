import asyncio
import logging
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import APIRouter, Query, Request
from sqlalchemy import func, select

from app.db import utcnow
from app.deps import CurrentUser, Session
from app.errors import ApiError
from app.mal.client import MalClient, is_safe
from app.mal.genres import GENRE_IDS
from app.models import ContinueHidden, MalLink, WatchProgress
from app.routers.anime import only_safe
from app.routers.friends import sharing_friend_ids
from app.routers.progress import latest_per_anime, to_out
from app.schemas import AnimeCard, GenreOut, HomeHero, HomeItem, HomeOut, HomeRow
from app.soft import soft

if TYPE_CHECKING:
    from app.anizip import AniZip
    from app.synopsis import PtSynopses

router = APIRouter(tags=["home"])
log = logging.getLogger(__name__)

ROW_SIZE = 20
HERO_COUNT = 5
# The home page waits this long for a hero's wide art. A slower lookup keeps going and fills the
# cache for the next visit.
WIDE_ART_BUDGET = 1.5
# A shorter row looks broken, so genre and friends rows below this size are left out.
MIN_ROW = 8
GENRE_ROWS = 4
# Broad, family-safe genres, rotated by day so the home page isn't the same every visit.
GENRE_POOL = (1, 2, 4, 8, 10, 22, 24, 36, 30, 37, 7, 41)
# A MAL "Watching" entry untouched for this long is probably abandoned.
MAL_STALE_AFTER = timedelta(days=60)


def _items(nodes: list[dict]) -> list[HomeItem]:
    return [HomeItem(anime=AnimeCard.from_node(n)) for n in nodes[:ROW_SIZE]]


async def _continue_row(
    mal: MalClient, rows: list[WatchProgress], allow_nsfw: bool
) -> list[HomeItem]:
    async def one(row: WatchProgress) -> HomeItem | None:
        anime = await soft(mal.details(row.anime_id), f"details {row.anime_id}")
        if anime is None or (not allow_nsfw and not is_safe(anime)):
            return None
        card = AnimeCard.from_node(anime)
        if row.completed and card.num_episodes and row.episode >= card.num_episodes:
            return None  # finished the series
        return HomeItem(
            anime=card,
            progress=to_out(row),
            resume_episode=row.episode + 1 if row.completed else row.episode,
        )

    items = await asyncio.gather(*(one(r) for r in rows))
    return [i for i in items if i is not None]


def _mal_updated(entry: dict) -> datetime | None:
    raw = (entry.get("list_status") or {}).get("updated_at")
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")) if raw else None
    except ValueError:
        return None


def _mal_continue(
    watching: list[dict], skip: set[int], hidden: dict[int, datetime], allow_nsfw: bool
) -> list[HomeItem]:
    """MAL Watching titles, resumed at the next episode (MAL keeps no minutes)."""
    cutoff = utcnow() - MAL_STALE_AFTER
    items: list[HomeItem] = []
    for entry in watching:
        node = entry["node"]
        status = entry.get("list_status") or {}
        updated = _mal_updated(entry)
        if (
            (not allow_nsfw and not is_safe(node))
            or node["id"] in skip
            or (updated is not None and updated < cutoff)
        ):
            continue
        removed = hidden.get(node["id"])
        if removed is not None and (updated is None or updated <= removed):
            continue
        watched = status.get("num_episodes_watched") or 0
        total = node.get("num_episodes") or 0
        if total and watched >= total:
            continue
        items.append(
            HomeItem(anime=AnimeCard.from_node(node), resume_episode=watched + 1, from_mal=True)
        )
    return items


async def _mal_rows(
    request: Request,
    user: CurrentUser,
    session: Session,
    skip: set[int],
    hidden: dict[int, datetime],
) -> tuple[list[HomeItem], list[HomeItem]]:
    """The "my list" row, and the MAL titles that fill Continue watching."""
    if await session.get(MalLink, user.id) is None:
        return [], []
    accounts = request.app.state.mal_accounts
    watching = (await accounts.animelist(session, user, "watching"))["data"]
    planned = (await accounts.animelist(session, user, "plan_to_watch"))["data"]
    nodes = [i["node"] for i in (*watching, *planned)]
    return _items(nodes), _mal_continue(watching, skip, hidden, user.show_nsfw)


def todays_genres(today: date, count: int = GENRE_ROWS) -> list[int]:
    start = (today.toordinal() * count) % len(GENRE_POOL)
    return [GENRE_POOL[(start + i) % len(GENRE_POOL)] for i in range(count)]


async def _genre_rows(mal: MalClient, allow_nsfw: bool) -> list[HomeRow]:
    """Most-followed titles of a few genres, drawn from the cached ranking pool."""
    pool = await mal.ranking_pool(allow_nsfw)
    rows = []
    for genre_id in todays_genres(date.today()):
        nodes = [n for n in pool if any(g.get("id") == genre_id for g in n.get("genres") or [])]
        info = GENRE_IDS[genre_id]
        if len(nodes) >= MIN_ROW:
            rows.append(
                HomeRow(
                    id="genre",
                    genre=GenreOut(id=info.id, name=info.name, kind=info.kind, nsfw=info.nsfw),
                    items=_items(nodes),
                )
            )
    return rows


async def _friends_popular_ids(session: Session, user: CurrentUser) -> list[int]:
    """Titles that friends who share their activity are watching, most friends first."""
    friends = await sharing_friend_ids(session, user.id)
    if not friends:
        return []
    watchers = func.count(func.distinct(WatchProgress.user_id))
    rows = await session.execute(
        select(WatchProgress.anime_id)
        .where(WatchProgress.user_id.in_(friends))
        .group_by(WatchProgress.anime_id)
        .order_by(watchers.desc(), func.max(WatchProgress.updated_at).desc())
        .limit(ROW_SIZE * 2)
    )
    return [r[0] for r in rows]


async def _friends_popular_row(mal: MalClient, ids: list[int], show_nsfw: bool) -> list[HomeItem]:
    async def card(anime_id: int) -> HomeItem | None:
        node = await soft(mal.details(anime_id), f"details {anime_id}")
        if node is None or (not show_nsfw and not is_safe(node)):
            return None
        return HomeItem(anime=AnimeCard.from_node(node))

    items = [i for i in await asyncio.gather(*(card(a) for a in ids)) if i is not None]
    return items[:ROW_SIZE] if len(items) >= MIN_ROW else []


async def _wide_art(anizip: "AniZip | None", anime_id: int) -> str | None:
    if anizip is None:
        return None
    try:
        art = await asyncio.wait_for(asyncio.shield(anizip.art(anime_id)), WIDE_ART_BUDGET)
    except TimeoutError:
        return None
    return art.backdrop


async def _heroes(
    mal: MalClient,
    seasonal: list[dict],
    synopses: "PtSynopses | None" = None,
    anizip: "AniZip | None" = None,
) -> list[HomeHero]:
    """The best-scored titles of the season that have a large picture."""
    candidates = [n for n in seasonal if (n.get("main_picture") or {}).get("large")]
    picks = sorted(candidates, key=lambda n: n.get("mean") or 0, reverse=True)[:HERO_COUNT]

    async def one(pick: dict) -> HomeHero:
        details, wide_art = await asyncio.gather(
            soft(mal.details(pick["id"]), "hero details"), _wide_art(anizip, pick["id"])
        )
        pictures = [p.get("large") for p in (details or {}).get("pictures") or [] if p.get("large")]
        synopsis, synopsis_lang = (details or {}).get("synopsis"), None
        if synopsis:
            synopsis_lang = "en"
        if details and synopses and (pt := await synopses.get(details)):
            synopsis, synopsis_lang = pt, "pt"
        return HomeHero(
            anime=AnimeCard.from_node(pick),
            synopsis=synopsis,
            synopsis_lang=synopsis_lang,
            backdrop=pictures[0] if pictures else pick["main_picture"]["large"],
            wide_art=wide_art,
        )

    return list(await asyncio.gather(*(one(p) for p in picks)))


async def _similar_row(
    mal: MalClient, watched: list[WatchProgress], allow_nsfw: bool
) -> HomeRow | None:
    """What viewers of the title watched last also recommend, from its (cached) details."""
    for row in watched:
        about = await mal.details(row.anime_id)
        if not allow_nsfw and not is_safe(about):
            continue
        recommended = about.get("recommendations") or []
        if not allow_nsfw:
            (recommended,) = await only_safe(mal, recommended)
        nodes = [r["node"] for r in recommended]
        if len(nodes) < MIN_ROW // 2:
            return None
        return HomeRow(id="similar", items=_items(nodes), about=AnimeCard.from_node(about))
    return None


@router.get("/home", response_model=HomeOut)
async def home(
    request: Request,
    user: CurrentUser,
    session: Session,
    lang: Annotated[Literal["en", "pt"], Query()] = "en",
):
    mal: MalClient = request.app.state.mal
    # The session isn't safe to share between tasks: read what the database holds first.
    progress = await latest_per_anime(session, user.id, ROW_SIZE)
    hidden_rows = await session.scalars(
        select(ContinueHidden).where(ContinueHidden.user_id == user.id)
    )
    hidden = {h.anime_id: h.hidden_at for h in hidden_rows}
    await session.commit()  # the MAL calls below can be slow: give the connection back

    friend_ids = await _friends_popular_ids(session, user)
    await session.commit()
    pt_synopses = request.app.state.pt_synopses if lang == "pt" else None
    anizip = request.app.state.anizip

    async def seasonal_with_heroes():
        seasonal = await soft(mal.seasonal(1, user.show_nsfw), "seasonal")
        nodes = [i["node"] for i in (seasonal or {}).get("data", [])]
        return seasonal, await _heroes(mal, nodes, pt_synopses, anizip)

    (
        seasonal_and_heroes,
        friends_popular,
        top,
        continuing,
        mal_rows,
        genre_rows,
        similar,
    ) = await asyncio.gather(
        seasonal_with_heroes(),
        _friends_popular_row(mal, friend_ids, user.show_nsfw),
        soft(mal.top(user.show_nsfw), "top"),
        _continue_row(mal, progress, user.show_nsfw),
        soft(
            _mal_rows(request, user, session, {p.anime_id for p in progress}, hidden), "MAL lists"
        ),
        soft(_genre_rows(mal, user.show_nsfw), "genre rows"),
        soft(_similar_row(mal, progress, user.show_nsfw), "similar row"),
    )
    seasonal, heroes = seasonal_and_heroes
    my_list, from_mal = mal_rows or ([], [])
    # What was watched here comes first; MAL's Watching list fills the rest.
    continuing = [*continuing, *from_mal][:ROW_SIZE]
    if seasonal is None and top is None:
        raise ApiError(502, "mal_unavailable", "MyAnimeList is unavailable")

    seasonal_nodes = [i["node"] for i in (seasonal or {}).get("data", [])]
    top_nodes = [i["node"] for i in (top or {}).get("data", [])]
    rows = [
        HomeRow(id="continue_watching", items=continuing),
        HomeRow(id="my_list", items=my_list),
        *([similar] if similar else []),
        HomeRow(id="seasonal", items=_items(seasonal_nodes)),
        HomeRow(id="friends_popular", items=friends_popular),
        HomeRow(id="top", items=_items(top_nodes)),
        *(genre_rows or []),
    ]
    return HomeOut(
        heroes=heroes,
        rows=[r for r in rows if r.items],
    )
