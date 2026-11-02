import asyncio
import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Path, Query, Request, Response
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import distinct_on, insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db import new_session, utcnow
from app.deps import CurrentUser, Session
from app.models import ContinueHidden, User, WatchProgress
from app.schemas import ProgressIn, ProgressOut

router = APIRouter(prefix="/me/progress", tags=["progress"])
logger = logging.getLogger(__name__)

# Past this share of the episode it counts as watched, whatever the client says.
COMPLETED_RATIO = 0.9


def to_out(row: WatchProgress) -> ProgressOut:
    return ProgressOut(
        anime_id=row.anime_id,
        episode=row.episode,
        position_seconds=row.position_seconds,
        duration_seconds=row.duration_seconds,
        completed=row.completed,
        updated_at=row.updated_at,
    )


async def latest_per_anime(
    session: AsyncSession, user_id: uuid.UUID, limit: int
) -> list[WatchProgress]:
    """The furthest episode of each anime, most recently watched anime first.

    Furthest rather than latest, so rewatching episode 1 of a finished show doesn't move its
    resume point back to the start."""
    furthest = (
        select(WatchProgress)
        .where(WatchProgress.user_id == user_id)
        .ext(distinct_on(WatchProgress.anime_id))
        .order_by(WatchProgress.anime_id, WatchProgress.episode.desc())
        .subquery()
    )
    seen = (
        select(WatchProgress.anime_id, func.max(WatchProgress.updated_at).label("seen"))
        .where(WatchProgress.user_id == user_id)
        .group_by(WatchProgress.anime_id)
        .subquery()
    )
    row = aliased(WatchProgress, furthest)
    result = await session.scalars(
        select(row)
        .join(seen, seen.c.anime_id == row.anime_id)
        .outerjoin(
            ContinueHidden,
            (ContinueHidden.user_id == user_id) & (ContinueHidden.anime_id == row.anime_id),
        )
        # Removed from Continue watching, and not watched since.
        .where(or_(ContinueHidden.hidden_at.is_(None), seen.c.seen > ContinueHidden.hidden_at))
        .order_by(seen.c.seen.desc())
        .limit(limit)
    )
    return list(result)


@router.get("", response_model=list[ProgressOut])
async def continue_watching(
    user: CurrentUser, session: Session, limit: Annotated[int, Query(ge=1, le=100)] = 20
):
    return [to_out(r) for r in await latest_per_anime(session, user.id, limit)]


@router.delete("/{anime_id}/continue", status_code=204)
async def remove_from_continue_watching(
    anime_id: Annotated[int, Path(ge=1)], user: CurrentUser, session: Session
):
    """Hide a title from Continue watching. Progress is kept; watching it again brings it back."""
    stmt = insert(ContinueHidden).values(user_id=user.id, anime_id=anime_id, hidden_at=utcnow())
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=["user_id", "anime_id"], set_={"hidden_at": stmt.excluded.hidden_at}
        )
    )
    await session.commit()
    return Response(status_code=204)


@router.get("/{anime_id}", response_model=list[ProgressOut])
async def anime_progress(anime_id: int, user: CurrentUser, session: Session):
    rows = await session.scalars(
        select(WatchProgress)
        .where(WatchProgress.user_id == user.id, WatchProgress.anime_id == anime_id)
        .order_by(WatchProgress.episode)
    )
    return [to_out(r) for r in rows]


async def _sync_mal(request: Request, user_id: uuid.UUID, anime_id: int, episode: int) -> None:
    """Best effort: a MAL hiccup must never affect watching."""
    try:
        total = int((await request.app.state.mal.details(anime_id)).get("num_episodes") or 0)
        async with new_session() as session:
            user = await session.get(User, user_id)
            if user is not None:
                await request.app.state.mal_accounts.sync_finished_episode(
                    session, user, anime_id, episode, total
                )
    except Exception:
        logger.warning("MAL sync failed for %s ep %s", anime_id, episode, exc_info=True)


@router.put("/{anime_id}/{episode}", response_model=ProgressOut)
async def save_progress(
    request: Request,
    anime_id: Annotated[int, Path(ge=1)],
    episode: Annotated[int, Path(ge=0)],
    body: ProgressIn,
    user: CurrentUser,
    session: Session,
):
    finished = body.completed or bool(
        body.duration_seconds and body.position_seconds >= COMPLETED_RATIO * body.duration_seconds
    )
    was_done = await session.scalar(
        select(WatchProgress.completed).where(
            WatchProgress.user_id == user.id,
            WatchProgress.anime_id == anime_id,
            WatchProgress.episode == episode,
        )
    )
    insert_stmt = insert(WatchProgress).values(
        user_id=user.id,
        anime_id=anime_id,
        episode=episode,
        position_seconds=body.position_seconds,
        duration_seconds=body.duration_seconds,
        completed=finished,
        updated_at=utcnow(),
    )
    stmt = insert_stmt.on_conflict_do_update(
        index_elements=["user_id", "anime_id", "episode"],
        set_={
            "position_seconds": insert_stmt.excluded.position_seconds,
            # A save without a duration keeps the one already known.
            "duration_seconds": func.coalesce(
                insert_stmt.excluded.duration_seconds, WatchProgress.duration_seconds
            ),
            # Sticky: rewatching or scrubbing back doesn't un-watch an episode.
            "completed": or_(WatchProgress.completed, insert_stmt.excluded.completed),
            "updated_at": insert_stmt.excluded.updated_at,
        },
    ).returning(WatchProgress)
    row = (await session.scalars(stmt)).one()
    await session.commit()
    if row.completed and not was_done:
        tasks: set = request.app.state.__dict__.setdefault("mal_sync_tasks", set())
        task = asyncio.create_task(_sync_mal(request, user.id, anime_id, episode))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    return to_out(row)
