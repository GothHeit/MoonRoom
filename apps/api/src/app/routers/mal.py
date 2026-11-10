from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.deps import ClientIp, CurrentUser, Session, browser_user_id, throttle
from app.errors import ApiError
from app.ids import AnimeId, MangaId
from app.mal.account import MalAccounts
from app.schemas import AnimeCard, MangaCard

router = APIRouter(tags=["mal"])

ListStatus = Literal["watching", "completed", "on_hold", "dropped", "plan_to_watch"]
MangaListStatus = Literal["reading", "completed", "on_hold", "dropped", "plan_to_read"]


class ListUpdate(BaseModel):
    status: ListStatus | None = None
    score: int | None = Field(default=None, ge=0, le=10)
    num_watched_episodes: int | None = Field(default=None, ge=0)


class ListEntryOut(BaseModel):
    linked: bool
    # None when the title isn't on the user's list.
    status: ListStatus | None = None
    score: int = 0
    num_episodes_watched: int = 0


class LinkOut(BaseModel):
    auth_url: str


class MalStatistics(BaseModel):
    num_items_watching: int | None = None
    num_items_completed: int | None = None
    num_items_on_hold: int | None = None
    num_items_dropped: int | None = None
    num_items_plan_to_watch: int | None = None


class MalStatusOut(BaseModel):
    connected: bool
    mal_username: str | None = None
    mal_picture: str | None = None
    statistics: MalStatistics | None = None


class ListStatusOut(BaseModel):
    status: ListStatus
    score: int = 0
    num_episodes_watched: int = 0


class ListItemOut(BaseModel):
    node: AnimeCard
    list_status: ListStatusOut


class MalListOut(BaseModel):
    data: list[ListItemOut]


class ListUpdated(BaseModel):
    status: ListStatus | None = None
    score: int = 0
    num_episodes_watched: int = 0


# The manga list: the same shape, with chapters and volumes in place of episodes.


class MangaListUpdate(BaseModel):
    status: MangaListStatus | None = None
    score: int | None = Field(default=None, ge=0, le=10)
    num_chapters_read: int | None = Field(default=None, ge=0)
    num_volumes_read: int | None = Field(default=None, ge=0)


class MangaListEntryOut(BaseModel):
    linked: bool
    # None when the title isn't on the user's list.
    status: MangaListStatus | None = None
    score: int = 0
    num_chapters_read: int = 0
    num_volumes_read: int = 0


class MangaListStatusOut(BaseModel):
    status: MangaListStatus
    score: int = 0
    num_chapters_read: int = 0
    num_volumes_read: int = 0


class MangaListItemOut(BaseModel):
    node: MangaCard
    list_status: MangaListStatusOut


class MalMangaListOut(BaseModel):
    data: list[MangaListItemOut]


class MangaListUpdated(BaseModel):
    status: MangaListStatus | None = None
    score: int = 0
    num_chapters_read: int = 0
    num_volumes_read: int = 0


def _accounts(request: Request) -> MalAccounts:
    return request.app.state.mal_accounts


@router.get("/mal/link", response_model=LinkOut, dependencies=[throttle("mal_link")])
async def start_link(request: Request, user: CurrentUser, session: Session):
    return {"auth_url": await _accounts(request).authorize_url(session, user)}


@router.get("/mal/callback", include_in_schema=False)
async def callback(
    request: Request,
    session: Session,
    ip: ClientIp,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    # Reached straight from the browser, with no session required: cap it per address so a
    # flood can't turn into database work.
    request.app.state.action_limits.hit("mal_callback", ip)
    # MAL sends `error` and no `code` when the user denies access.
    # The state row remembers the user's language, so they land back on their own locale.
    locale = (await _accounts(request).state_locale(session, state)) if state else None
    target = f"{get_settings().web_url}/{locale or 'pt'}/settings"
    if error or not code or not state:
        return RedirectResponse(f"{target}?mal=denied")
    try:
        browser_user = await browser_user_id(request, session)
        await _accounts(request).complete(session, code, state, browser_user)
    except ApiError:
        return RedirectResponse(f"{target}?mal=failed")
    return RedirectResponse(f"{target}?mal=linked")


@router.get("/me/mal", response_model=MalStatusOut)
async def status(request: Request, user: CurrentUser, session: Session):
    return await _accounts(request).status(session, user)


@router.delete("/me/mal", status_code=204)
async def unlink(request: Request, user: CurrentUser, session: Session):
    await _accounts(request).disconnect(session, user)


@router.get("/me/animelist", response_model=MalListOut)
async def animelist(
    request: Request, user: CurrentUser, session: Session, status: ListStatus | None = None
):
    return await _accounts(request).animelist(session, user, status)


@router.get("/me/animelist/{anime_id}", response_model=ListEntryOut)
async def get_entry(request: Request, anime_id: AnimeId, user: CurrentUser, session: Session):
    accounts = _accounts(request)
    if not await accounts.is_linked(session, user):
        return ListEntryOut(linked=False)
    entry = await accounts.entry(session, user, anime_id) or {}
    return ListEntryOut(
        linked=True,
        status=entry.get("status"),
        score=entry.get("score") or 0,
        num_episodes_watched=entry.get("num_episodes_watched") or 0,
    )


@router.patch(
    "/me/animelist/{anime_id}",
    response_model=ListUpdated,
    dependencies=[throttle("mal_list_write")],
)
async def update_entry(
    request: Request, anime_id: AnimeId, body: ListUpdate, user: CurrentUser, session: Session
):
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise ApiError(422, "validation_failed", "Nothing to update")
    return await _accounts(request).update_entry(session, user, anime_id, changes)


@router.delete(
    "/me/animelist/{anime_id}", status_code=204, dependencies=[throttle("mal_list_write")]
)
async def remove_entry(request: Request, anime_id: AnimeId, user: CurrentUser, session: Session):
    await _accounts(request).remove_entry(session, user, anime_id)


@router.get("/me/mangalist", response_model=MalMangaListOut)
async def mangalist(
    request: Request, user: CurrentUser, session: Session, status: MangaListStatus | None = None
):
    return await _accounts(request).mangalist(session, user, status)


@router.get("/me/mangalist/{manga_id}", response_model=MangaListEntryOut)
async def get_manga_entry(request: Request, manga_id: MangaId, user: CurrentUser, session: Session):
    accounts = _accounts(request)
    if not await accounts.is_linked(session, user):
        return MangaListEntryOut(linked=False)
    entry = await accounts.entry(session, user, manga_id, "manga") or {}
    return MangaListEntryOut(
        linked=True,
        status=entry.get("status"),
        score=entry.get("score") or 0,
        num_chapters_read=entry.get("num_chapters_read") or 0,
        num_volumes_read=entry.get("num_volumes_read") or 0,
    )


@router.patch(
    "/me/mangalist/{manga_id}",
    response_model=MangaListUpdated,
    dependencies=[throttle("mal_list_write")],
)
async def update_manga_entry(
    request: Request, manga_id: MangaId, body: MangaListUpdate, user: CurrentUser, session: Session
):
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise ApiError(422, "validation_failed", "Nothing to update")
    return await _accounts(request).update_entry(session, user, manga_id, changes, "manga")


@router.delete(
    "/me/mangalist/{manga_id}", status_code=204, dependencies=[throttle("mal_list_write")]
)
async def remove_manga_entry(
    request: Request, manga_id: MangaId, user: CurrentUser, session: Session
):
    await _accounts(request).remove_entry(session, user, manga_id, "manga")
