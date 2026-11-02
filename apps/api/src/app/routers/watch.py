import asyncio
import logging
import uuid
from collections.abc import Awaitable
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from cachetools import TTLCache
from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app import hls
from app.choose import Picked, audio_to_start, resolve_auto, union_episodes
from app.deps import CurrentSessionId, CurrentUser, Session, session_check, throttle
from app.errors import ApiError
from app.models import PlayerPreferences, SourceChoice
from app.probes import Gone, HostError, Master, StreamProbes
from app.ranking import ORIGINAL, ORIGINAL_AUDIO, Prefs, base_lang
from app.schemas import EpisodesOut, StreamOption
from app.security import create_playback_token, decode_playback_token
from app.singleflight import SingleFlight
from app.source_hints import lacks_subbed
from app.sources.base import EpisodeList, Lang, SkipKind, Stream, VideoSource
from app.subtitles import ass_to_vtt
from app.upstream import open_upstream, read_playlist

logger = logging.getLogger(__name__)


async def _upstream[T](work: Awaitable[T]) -> T:
    """Scraper and video host failures (timeouts, resets, bad statuses) become a clean 502."""
    try:
        return await work
    except (httpx.HTTPError, TimeoutError) as exc:
        logger.warning("Upstream request failed: %s: %s", type(exc).__name__, exc)
        raise ApiError(502, "upstream_failed", "The video host did not answer") from exc


router = APIRouter(prefix="/watch", tags=["watch"])
# "original", or a language tag as players spell it ("pt", "pt-BR", "por").
AUDIO_LANG = r"^(original|[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,4})?)$"
# The pseudo-source that lets the API pick the best version for the viewer (app.ranking).
AUTO = "auto"

# How long the player's source menu waits on each source before leaving it out.
OPTION_PROBE_TIMEOUT = 8.0
# How long a source menu is reused for the same episode. Sources gain episodes when they air,
# not from one minute to the next.
OPTIONS_TTL = 600
LANGS: tuple[Lang, ...] = ("sub", "dub")
# Streams resolved ahead of a play (the title page's next episode, the one after the episode
# playing) at once. Warming is a bonus: when this many are running, more requests are dropped.
PREPARE_WIDTH = 4


class WatchCaches:
    """Per-process state of this router: the source menus, and the streams being warmed."""

    def __init__(self) -> None:
        self.options: TTLCache[tuple[int, int], list[StreamOption]] = TTLCache(
            maxsize=4096, ttl=OPTIONS_TTL
        )
        self.option_flights: SingleFlight[tuple[int, int], list[StreamOption]] = SingleFlight()
        self.preparing: set[tuple] = set()
        # The loop only holds tasks weakly: keep them here until they finish.
        self.tasks: set[asyncio.Task] = set()


class SubtitleOut(BaseModel):
    lang: str
    label: str
    # Same-origin-friendly WebVTT link, signed like the HLS parts.
    url: str
    # The same track as styled ASS, when the source has it.
    ass_url: str | None = None


class SkipOut(BaseModel):
    kind: SkipKind
    start: float
    end: float


class PlaybackOut(BaseModel):
    # The source that answered: another enabled one when the requested source failed.
    source: str
    # Sub or dub, as played: automatic picks it.
    lang: Lang
    kind: str
    resolution: int | None
    # Relative to the API base URL. Carries a short-lived token naming this episode; fetching it
    # also needs the same user's bearer token (the web app's proxy adds it from the cookie).
    url: str
    subtitles: list[SubtitleOut] = []
    skips: list[SkipOut] = []
    # Name or language of the audio track to start with, when the stream has several.
    default_audio: str | None = None
    # The tallest quality the viewer asked for, when they set a limit: the player keeps to it.
    max_resolution: int | None = None
    # Font name (lower case) -> link, for rendering the ASS subtitles.
    fonts: dict[str, str] = {}


def normalize_audio_lang(value: str) -> str:
    """Stored as the dub's base language ("pt"); the original audio is "original", however the
    caller spells Japanese. Anything unrecognised is refused."""
    if value == ORIGINAL:
        return value
    code = base_lang(value)
    if code == "und":
        raise ValueError("Unknown language")
    return ORIGINAL if code == ORIGINAL_AUDIO else code


class PlayerPreferencesIO(BaseModel):
    subtitle_size: Literal["small", "medium", "large", "huge"] = "medium"
    subtitle_color: Literal["white", "yellow", "cyan", "green"] = "white"
    subtitle_background: Literal["none", "outline", "translucent", "solid"] = "outline"
    subtitle_position: Literal["bottom", "raised", "top"] = "bottom"
    # What the automatic source choice looks for: "original" audio or a dub's language code.
    audio_lang: str = ORIGINAL
    prefer_soft_subs: bool = True
    # The tallest quality to prefer, or none for the best there is.
    max_resolution: Literal[360, 480, 720, 1080] | None = None


class PlayerPreferencesIn(BaseModel):
    """A change to the preferences: only the fields sent are saved, the rest stay as they are."""

    subtitle_size: Literal["small", "medium", "large", "huge"] | None = None
    subtitle_color: Literal["white", "yellow", "cyan", "green"] | None = None
    subtitle_background: Literal["none", "outline", "translucent", "solid"] | None = None
    subtitle_position: Literal["bottom", "raised", "top"] | None = None
    audio_lang: Annotated[str, Field(pattern=AUDIO_LANG)] | None = None
    prefer_soft_subs: bool | None = None
    # null clears the limit; leaving the field out keeps it.
    max_resolution: Literal[360, 480, 720, 1080] | None = None

    @field_validator("audio_lang")
    @classmethod
    def _audio_lang(cls, value: str | None) -> str | None:
        return None if value is None else normalize_audio_lang(value)


def _source(request: Request, name: str) -> VideoSource:
    source = request.app.state.sources.get(name)
    if source is None:
        raise ApiError(404, "source_not_found", f"Video source '{name}' is not enabled")
    return source


async def load_prefs(session: AsyncSession, user_id: uuid.UUID, subtitle_lang: str | None) -> Prefs:
    """What the viewer wants from the automatic choice: their saved playback preferences and
    their subtitle language."""
    saved = await session.get(PlayerPreferences, user_id)
    if saved is None:
        return Prefs(subtitle=subtitle_lang)
    return Prefs(
        audio=saved.audio_lang,
        subtitle=subtitle_lang,
        soft_subs=saved.prefer_soft_subs,
        resolution=saved.max_resolution,
    )


async def _resolve_auto(
    request: Request, anime: dict, episode: int, prefs: Prefs, fresh: bool = False
) -> Picked | None:
    """The best version across every enabled source, or None when none has the episode. A
    run where sources failed and none answered is a 502, not a 404."""
    outcome = await resolve_auto(
        request.app.state.sources, request.app.state.probes, anime, episode, prefs, fresh
    )
    if outcome.picked is None and outcome.failed:
        raise ApiError(502, "upstream_failed", "The video sources are failing right now")
    return outcome.picked


async def _resolve_stream(
    request: Request, source: str, anime: dict, episode: int, lang: Lang, fresh: bool = False
) -> tuple[str, Stream] | None:
    """The requested source first, then the other enabled ones, so one broken or missing
    source doesn't stop playback. Returns the name of the source that answered.

    A fallback only plays when its own episode list has this episode and is the same length
    as the requested source's (when that is known), so a source that matched another season
    or numbers episodes differently never plays the wrong one.

    A stream whose file is gone is passed over too. One whose host couldn't be checked is
    only used when no other source has a working one.

    `fresh` asks every host again instead of trusting a recent check: the player sets it when
    retrying after a failure, which a cached master may have caused."""
    requested = _source(request, source)
    names = [source] + [n for n in request.app.state.sources if n != source]
    probes: StreamProbes = request.app.state.probes
    expected: int | None = None
    failed = False
    unchecked: tuple[str, Stream] | None = None
    for name in names:
        src: VideoSource = request.app.state.sources[name]
        try:
            if name != source:
                if expected is None:
                    expected = await _episode_count(requested, anime, lang)
                listed = await src.episodes(anime, lang)
                if listed is None or episode not in listed.episodes:
                    continue
                if expected and len(listed.episodes) != expected:
                    continue
            stream = await src.stream(anime, episode, lang)
        except Exception:
            logger.exception("Source %s failed for MAL %s ep %s", name, anime.get("id"), episode)
            failed = True
            continue
        if stream is None:
            continue
        if fresh:
            probes.forget(stream.url, stream.upstream_headers.get("Referer", ""))
        alive = await _stream_alive(probes, stream)
        if alive:
            return name, stream
        if alive is None:
            unchecked = unchecked or (name, stream)
        else:
            logger.warning(
                "Source %s gave a dead stream for MAL %s ep %s", name, anime.get("id"), episode
            )
    if unchecked is not None:
        return unchecked
    if failed:
        raise ApiError(502, "upstream_failed", "The video sources are failing right now")
    return None


async def _stream_alive(probes: StreamProbes, stream: Stream) -> bool | None:
    """Whether the stream's file still exists; None when the host couldn't tell."""
    return await probes.check(stream)


async def _episode_count(source: VideoSource, anime: dict, lang: Lang) -> int:
    """How many episodes a source lists, or 0 when it can't say (it is broken right now)."""
    try:
        listed = await source.episodes(anime, lang)
    except Exception:
        return 0
    return len(listed.episodes) if listed else 0


@router.get("/sources", response_model=list[str])
async def sources(request: Request, user: CurrentUser):
    return list(request.app.state.sources)


def episodes_out(source: str, result: EpisodeList, viewer: hls.Viewer) -> EpisodesOut:
    return EpisodesOut(
        source=source,
        source_title=result.source_title,
        episodes=result.episodes,
        thumbnails={
            episode: f"/watch/{hls.signed_link(url, '', viewer, 'img')}"
            for episode, url in result.thumbnails.items()
        },
    )


@router.get("/{source}/{anime_id}/episodes", response_model=EpisodesOut)
async def episodes(
    request: Request,
    source: str,
    anime_id: int,
    user: CurrentUser,
    sid: CurrentSessionId,
    lang: Lang = "sub",
):
    anime = await request.app.state.mal.visible_details(anime_id, user.show_nsfw)
    if source == AUTO:
        result = await union_episodes(request.app.state.sources, anime, OPTION_PROBE_TIMEOUT)
    else:
        result = await _upstream(_source(request, source).episodes(anime, lang))
    if result is None:
        raise ApiError(404, "not_available", "This anime isn't available from this source")
    return episodes_out(source, result, hls.Viewer(str(user.id), str(sid)))


@router.get("/options/{anime_id}/{episode}", response_model=list[StreamOption])
async def options(request: Request, anime_id: int, episode: int, user: CurrentUser):
    """Every source and sub/dub that lists this episode, in fallback order, for the player's
    source menu. A source that is slow or failing is left out. Kept for a few minutes per
    episode, so reopening the menu or the player doesn't ask every source again."""
    anime = await request.app.state.mal.visible_details(anime_id, user.show_nsfw)
    caches: WatchCaches = request.app.state.watch
    key = (anime_id, episode)
    if (found := caches.options.get(key)) is not None:
        return found
    return await caches.option_flights.run(key, lambda: _probe_options(request, anime, episode))


async def _probe_options(request: Request, anime: dict, episode: int) -> list[StreamOption]:
    # The title page already found out which sources have no subbed episodes: don't ask those
    # again for the sub. Their dub is still asked for, and a source that merely failed there is.
    hints = request.app.state.source_hints
    pairs = [
        (name, lang)
        for name in request.app.state.sources
        for lang in LANGS
        if not (lang == "sub" and lacks_subbed(hints, name, anime["id"]))
    ]
    failed = False

    async def has(name: str, lang: Lang) -> bool:
        nonlocal failed
        try:
            listed = await asyncio.wait_for(
                request.app.state.sources[name].episodes(anime, lang), OPTION_PROBE_TIMEOUT
            )
        except Exception:
            failed = True
            return False
        return listed is not None and episode in listed.episodes

    found = await asyncio.gather(*(has(name, lang) for name, lang in pairs))
    menu = [
        StreamOption(source=name, lang=lang)
        for (name, lang), hit in zip(pairs, found, strict=True)
        if hit
    ]
    if len(menu) > 1:
        # Letting the API choose is only a choice when there is something to choose between.
        menu.insert(0, StreamOption(source=AUTO, lang="sub"))
    # A source that failed may be back in a moment: only a complete answer is kept.
    if not failed:
        request.app.state.watch.options[(anime["id"], episode)] = menu
    return menu


@router.post(
    "/{source}/{anime_id}/episodes/{episode}/prepare",
    status_code=202,
    responses={202: {"description": "Warming started, or not needed"}},
)
async def prepare(
    request: Request,
    source: str,
    anime_id: Annotated[int, Path(ge=1)],
    episode: Annotated[int, Path(ge=1)],
    user: CurrentUser,
    session: Session,
    lang: Lang = "sub",
):
    """Resolves an episode in the background so pressing play on it later hits warm caches:
    the title page asks for the episode its Play button opens, the player for the next one.
    Answers at once; nothing is returned and failures are only logged."""
    if source != AUTO:
        _source(request, source)
    caches: WatchCaches = request.app.state.watch
    key = (source, anime_id, episode, lang)
    if key in caches.preparing or len(caches.preparing) >= PREPARE_WIDTH:
        return Response(status_code=202)
    prefs = await load_prefs(session, user.id, user.subtitle_lang) if source == AUTO else None
    await session.commit()
    caches.preparing.add(key)
    task = asyncio.create_task(_warm(request, key, user.show_nsfw, prefs))
    caches.tasks.add(task)

    def done(finished: asyncio.Task) -> None:
        caches.tasks.discard(finished)
        caches.preparing.discard(key)

    task.add_done_callback(done)
    return Response(status_code=202)


async def _warm(request: Request, key: tuple, show_nsfw: bool, prefs: Prefs | None) -> None:
    source, anime_id, episode, lang = key
    try:
        anime = await request.app.state.mal.visible_details(anime_id, show_nsfw)
        if prefs is not None:
            await _resolve_auto(request, anime, episode, prefs)
        else:
            await _resolve_stream(request, source, anime, episode, lang)
    except ApiError as exc:
        logger.info("Warming MAL %s ep %s skipped: %s", anime_id, episode, exc.code)
    except Exception:
        logger.exception("Warming MAL %s ep %s failed", anime_id, episode)


@router.get("/skips/{anime_id}/{episode}", response_model=list[SkipOut])
async def skips(
    request: Request,
    anime_id: Annotated[int, Path(ge=1)],
    episode: Annotated[int, Path(ge=1)],
    length: Annotated[float, Query(gt=0, le=86400)],
    user: CurrentUser,
):
    """Opening, ending and recap times from AniSkip for a copy `length` seconds long. The
    player asks once it knows the length, and fills in what the source didn't give."""
    found = await request.app.state.aniskip.skips(anime_id, episode, length)
    return [SkipOut(kind=k.kind, start=k.start, end=k.end) for k in found]


@router.put("/choice/{anime_id}", status_code=204)
async def put_choice(
    anime_id: Annotated[int, Path(ge=1)],
    body: StreamOption,
    request: Request,
    user: CurrentUser,
    session: Session,
):
    """Remembers the source and sub/dub the user picked for this title."""
    saved = await session.get(SourceChoice, (user.id, anime_id))
    if body.source == AUTO:
        # Back to the automatic choice: nothing to remember.
        if saved is not None:
            await session.delete(saved)
        await session.commit()
        return
    _source(request, body.source)
    if saved is None:
        saved = SourceChoice(user_id=user.id, anime_id=anime_id)
        session.add(saved)
    saved.source = body.source
    saved.lang = body.lang
    await session.commit()


@router.get("/preferences", response_model=PlayerPreferencesIO)
async def get_preferences(user: CurrentUser, session: Session):
    saved = await session.get(PlayerPreferences, user.id)
    if saved is None:
        return PlayerPreferencesIO()
    return PlayerPreferencesIO.model_validate(saved, from_attributes=True)


@router.put("/preferences", response_model=PlayerPreferencesIO)
async def put_preferences(body: PlayerPreferencesIn, user: CurrentUser, session: Session):
    saved = await session.get(PlayerPreferences, user.id)
    if saved is None:
        saved = PlayerPreferences(user_id=user.id)
        session.add(saved)
    # Only what the request names changes: the subtitle look and the playback choices are
    # saved by different parts of the app.
    for field, value in body.model_dump(exclude_unset=True).items():
        # Only max_resolution may be null (no limit); a null anywhere else is "unchanged".
        if value is not None or field == "max_resolution":
            setattr(saved, field, value)
    await session.commit()
    return PlayerPreferencesIO.model_validate(saved, from_attributes=True)


class LinkOut(BaseModel):
    url: str


@router.post(
    "/{source}/{anime_id}/episodes/{episode}/link",
    response_model=LinkOut,
    dependencies=[throttle("stream_link")],
)
async def link(
    request: Request,
    source: str,
    anime_id: int,
    episode: int,
    user: CurrentUser,
    sid: CurrentSessionId,
    kind: Literal["hls", "mp4"] = "hls",
    lang: Lang = "sub",
):
    """A fresh link to start the episode a /play answer picked (`source` and `lang` are the
    ones it reported). Asking costs nothing upstream: the stream is only looked up when the
    link is opened. Used to hand the stream to a device that fetches it itself, such as an
    AirPlay receiver, long after the first link has expired."""
    _source(request, source)
    token = create_playback_token(user.id, sid, source, anime_id, episode, lang)
    return LinkOut(url=f"/watch/{'video' if kind == 'mp4' else 'hls'}?token={token}")


@router.post("/{source}/{anime_id}/episodes/{episode}/play", response_model=PlaybackOut)
async def play(
    request: Request,
    source: str,
    anime_id: int,
    episode: int,
    user: CurrentUser,
    sid: CurrentSessionId,
    session: Session,
    lang: Lang = "sub",
    fresh: Annotated[
        bool, Query(description="Check the stream again instead of trusting a recent check")
    ] = False,
):
    anime = await request.app.state.mal.visible_details(anime_id, user.show_nsfw)
    default_audio: str | None = None
    prefs = await load_prefs(session, user.id, user.subtitle_lang)
    await session.commit()  # the sources below can take seconds: don't hold a connection
    if source == AUTO:
        picked = await _resolve_auto(request, anime, episode, prefs, fresh)
        if picked is None:
            raise ApiError(404, "not_available", "This episode isn't available")
        used, lang, stream, default_audio = (
            picked.source,
            picked.lang,
            picked.stream,
            picked.default_audio,
        )
    else:
        resolved = await _resolve_stream(request, source, anime, episode, lang, fresh)
        if resolved is None:
            raise ApiError(404, "not_available", "This episode isn't available from this source")
        used, stream = resolved
    token = create_playback_token(user.id, sid, used, anime_id, episode, lang)
    path = "video" if stream.kind == "mp4" else "hls"
    referer = stream.upstream_headers.get("Referer", "")
    viewer = hls.Viewer(str(user.id), str(sid))
    resolution = stream.resolution
    master = request.app.state.probes.peek(stream.url, referer) if stream.kind == "hls" else None
    if resolution is None and master:
        # The liveness check just read the master; its variants say the best quality.
        resolution = hls.top_resolution(master.text)
    if default_audio is None and master and not stream.default_audio:
        # A viewer who likes a dub hears it whenever the stream carries it, picked by hand or not.
        default_audio = audio_to_start(hls.audio_tracks(master.text), prefs)
    return PlaybackOut(
        source=used,
        lang=lang,
        kind=stream.kind,
        resolution=resolution,
        url=f"/watch/{path}?token={token}",
        subtitles=[
            SubtitleOut(
                lang=s.lang,
                label=s.label,
                url=f"/watch/{hls.signed_link(s.url, referer, viewer, 'sub')}",
                ass_url=(
                    f"/watch/{hls.signed_link(s.ass_url, referer, viewer, 'ass')}"
                    if s.ass_url
                    else None
                ),
            )
            for s in stream.subtitles
        ],
        skips=[SkipOut(kind=k.kind, start=k.start, end=k.end) for k in stream.skips],
        default_audio=default_audio or stream.default_audio,
        max_resolution=prefs.resolution,
        fonts={
            name: f"/watch/{hls.signed_link(url, referer, viewer, 'font')}"
            for name, url in stream.fonts.items()
        },
    )


async def _playback_claims(request: Request, session: AsyncSession, token: str | None) -> dict:
    """The claims of a playback token. The token stands on its own, since the devices that play
    it can't send a login, but it only works while the login session it was made in is open, so
    signing out stops it."""
    claims = decode_playback_token(token) if token else None
    if claims is None or not await _session_open(request, session, claims["sub"], claims["sid"]):
        raise ApiError(403, "invalid_link", "Invalid or expired playback token")
    return claims


async def _session_open(request: Request, session: AsyncSession, user: str, sid: str) -> bool:
    try:
        ids = uuid.UUID(user), uuid.UUID(sid)
    except ValueError:
        return False
    return await session_check(request).is_open(session, *ids)


@router.get("/video")
async def video(request: Request, session: Session, token: Annotated[str, Query()]):
    claims = await _playback_claims(request, session, token)
    await session.commit()  # the stream below can run for hours: don't hold a connection

    src = _source(request, claims["src"])
    anime = await request.app.state.mal.details(claims["aid"])
    stream = await _upstream(src.stream(anime, claims["ep"], claims["lang"]))
    if stream is None or stream.kind != "mp4":
        raise ApiError(404, "not_available", "This episode isn't available any more")

    headers = dict(stream.upstream_headers)
    if "range" in request.headers:
        headers["Range"] = request.headers["range"]  # lets the player seek

    http: httpx.AsyncClient = request.app.state.http
    upstream = await _upstream(
        http.send(
            http.build_request(
                "GET", stream.url, headers=headers, timeout=httpx.Timeout(30.0, read=None)
            ),
            stream=True,
        )
    )
    if upstream.status_code == 416:
        # A seek past the end: players expect the real 416 and the size in Content-Range.
        await upstream.aclose()
        return Response(
            status_code=416,
            headers={h: upstream.headers[h] for h in ("content-range",) if h in upstream.headers},
        )
    if upstream.status_code >= 400:
        await upstream.aclose()
        raise ApiError(502, "upstream_failed", f"Video host answered {upstream.status_code}")

    passthrough = {
        h: upstream.headers[h] for h in ("content-length", "content-range") if h in upstream.headers
    }
    passthrough["accept-ranges"] = "bytes"

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        except (httpx.HTTPError, TimeoutError) as exc:
            # Headers are already sent: all that's left is to cut the stream short.
            logger.info("Video host dropped a stream: %s", type(exc).__name__)
        finally:
            await upstream.aclose()

    return StreamingResponse(
        body(), status_code=upstream.status_code, media_type="video/mp4", headers=passthrough
    )


# Library files never change once converted; a link stays valid for hours.
LOCAL_CACHE = "private, max-age=3600"


def _serve_local(url: str, viewer: hls.Viewer) -> Response:
    """A file from the local library: playlists rewritten like remote ones, the rest as is
    (with Range support, for seeking). Blocking, and the library may sit on a network mount,
    so it runs in a thread; each request costs one resolve and one stat."""
    found = hls.local_file(url)
    if found is None:
        raise ApiError(404, "not_available", "This episode isn't available any more")
    path, info = found
    if path.suffix == ".m3u8":
        if info.st_size > hls.MAX_PLAYLIST_BYTES:
            raise ApiError(502, "upstream_failed", "Playlist is too large")
        return Response(
            hls.rewrite_playlist(path.read_text(encoding="utf-8"), url, "", viewer),
            media_type="application/vnd.apple.mpegurl",
            headers={"cache-control": "no-store"},
        )
    return FileResponse(
        path,
        media_type=hls.local_media_type(path),
        headers={"cache-control": LOCAL_CACHE, "x-content-type-options": "nosniff"},
        stat_result=info,
    )


@router.get("/hls")
async def hls_proxy(
    request: Request,
    session: Session,
    token: Annotated[str | None, Query()] = None,
    subs: Annotated[bool, Query()] = False,
    u: Annotated[str | None, Query()] = None,
    r: Annotated[str, Query()] = "",
    k: Annotated[str, Query()] = "",
    v: Annotated[str, Query()] = "",
    i: Annotated[str, Query()] = "",
    e: Annotated[int, Query()] = 0,
    s: Annotated[str, Query()] = "",
):
    """Without `u`, the master playlist of the episode the token is for (with `subs`, listing
    its subtitles in the playlist, for players that fetch it themselves). With `u`, one
    playlist, segment, subtitle or image that an earlier response linked to. Neither needs a
    login header: the token or the link names the user and the session, and is checked against
    both."""
    if u is None:
        claims = await _playback_claims(request, session, token)
        # A token can be replayed for its few minutes: don't let that hammer the scrapers.
        request.app.state.action_limits.hit("stream_start", claims["sub"])
        await session.commit()  # the scraper call below can be slow
        src = _source(request, claims["src"])
        anime = await request.app.state.mal.details(claims["aid"])
        stream = await _upstream(src.stream(anime, claims["ep"], claims["lang"]))
        if stream is None or stream.kind != "hls":
            raise ApiError(404, "not_available", "This episode isn't available any more")
        url, referer = stream.url, stream.upstream_headers.get("Referer", "")
        viewer = hls.Viewer(claims["sub"], claims["sid"])
        tracks = [(t.lang, t.label, t.url) for t in stream.subtitles] if subs else []
    else:
        viewer = hls.Viewer(v, i)
        # The signature first: it costs nothing and keeps strangers away from the database.
        # 403, not 401: a stale or foreign link can't be fixed by refreshing the session.
        if not hls.verify_link(u, r, k, viewer, e, s) or not await _session_open(
            request, session, v, i
        ):
            raise ApiError(403, "invalid_link", "Invalid or expired stream link")
        await session.commit()
        url, referer, tracks = u, r, []
    if u is not None and k == "subpl":
        return Response(
            hls.subtitle_playlist(url, referer, viewer),
            media_type="application/vnd.apple.mpegurl",
            headers={"cache-control": "no-store"},
        )

    if url.startswith("file:"):
        return await asyncio.to_thread(_serve_local, url, viewer)
    if u is None:
        # Usually already fetched when playback checked the stream: no trip to the host.
        master = await _master(request.app.state.probes, url, referer)
        return Response(
            hls.add_subtitles(
                hls.rewrite_playlist(master.text, master.url, referer, viewer),
                tracks,
                referer,
                viewer,
            ),
            media_type="application/vnd.apple.mpegurl",
            headers={"cache-control": "no-store"},
        )

    headers = {"Referer": referer} if referer else {}
    if referer:
        # Some segment hosts (AnimeStream's) answer 403 without an Origin next to the Referer.
        site = urlsplit(referer)
        if site.scheme and site.netloc:
            headers["Origin"] = f"{site.scheme}://{site.netloc}"
    if "range" in request.headers:
        headers["Range"] = request.headers["range"]
    http: httpx.AsyncClient = request.app.state.http
    upstream, url = await _upstream(open_upstream(http, url, headers))
    if upstream.status_code >= 400 and upstream.status_code != 416:
        await upstream.aclose()
        raise ApiError(502, "upstream_failed", f"Video host answered {upstream.status_code}")

    content_type = upstream.headers.get("content-type", "")
    if k == "sub" and url.split("?")[0].lower().endswith(".ass"):
        # A host that only has styled subtitles: serve the spoken lines as WebVTT for the
        # plain track, next to the styled copy the player draws itself.
        return Response(
            ass_to_vtt(await read_playlist(upstream)),
            media_type="text/vtt",
            headers={"x-content-type-options": "nosniff"},
        )
    if k == "" and hls.is_playlist(url, content_type):
        text = await read_playlist(upstream)
        return Response(
            hls.rewrite_playlist(text, str(upstream.url), referer, viewer),
            media_type="application/vnd.apple.mpegurl",
            headers={"cache-control": "no-store"},
        )

    media_type = hls.media_type(url, k, content_type)
    passthrough = {
        h: upstream.headers[h] for h in ("content-length", "content-range") if h in upstream.headers
    }
    passthrough["accept-ranges"] = "bytes"
    # Upstream bytes are untrusted: never let a browser guess them into HTML or script.
    passthrough["x-content-type-options"] = "nosniff"

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        except (httpx.HTTPError, TimeoutError) as exc:
            # Headers are already sent: all that's left is to cut the stream short.
            logger.info("Video host dropped a stream: %s", type(exc).__name__)
        finally:
            await upstream.aclose()

    return StreamingResponse(
        body(), status_code=upstream.status_code, media_type=media_type, headers=passthrough
    )


async def _master(probes: StreamProbes, url: str, referer: str) -> Master:
    try:
        return await _upstream(probes.master(url, referer))
    except Gone as exc:
        raise ApiError(502, "upstream_failed", "The video host no longer has this file") from exc
    except HostError as exc:
        raise ApiError(502, "upstream_failed", str(exc)) from exc
