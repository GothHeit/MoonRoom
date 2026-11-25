"""The player's Language menu: which of Portuguese and English, subtitled or dubbed, this
episode plays in, and the version that plays each (see app.languages)."""

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.deps import CurrentUser, Session, throttle
from app.ids import AnimeId, PlayableEpisode
from app.languages import LanguageChecks
from app.routers.watch import load_prefs
from app.sources.base import Lang

router = APIRouter(prefix="/watch", tags=["watch"])


class LanguageOut(BaseModel):
    language: Literal["pt", "en"]
    kind: Literal["sub", "dub"]
    # "ready": checked and plays; "unverified": the host couldn't be checked; "none": no source
    # has it.
    state: Literal["ready", "unverified", "none"]
    source: str | None = None
    lang: Lang | None = None
    resolution: int | None = None


@router.get(
    "/languages/{anime_id}/{episode}",
    response_model=list[LanguageOut],
    dependencies=[throttle("languages")],
)
async def languages(
    request: Request,
    anime_id: AnimeId,
    episode: PlayableEpisode,
    user: CurrentUser,
    session: Session,
):
    anime = await request.app.state.mal.visible_details(anime_id, user.show_nsfw)
    prefs = await load_prefs(session, user.id, user.subtitle_lang)
    await session.commit()  # checking can take seconds: don't hold a connection
    checks: LanguageChecks = request.app.state.language_checks
    state = request.app.state
    found = await checks.choices(state.sources, state.probes, anime, episode, prefs)
    return [LanguageOut(**vars(choice)) for choice in found]
