import asyncio
import logging
import uuid
from collections.abc import Awaitable
from typing import Annotated, Literal
from urllib.parse import urljoin

import httpx
from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app import hls
from app.deps import CurrentUser, Session
from app.errors import ApiError
from app.models import PlayerPreferences, SourceChoice, User
from app.schemas import EpisodesOut, StreamOption
from app.security import create_playback_token, decode_access_token, decode_playback_token
from app.sources.base import EpisodeList, Lang, SkipKind, Stream, VideoSource

logger = logging.getLogger(__name__)


async def _upstream[T](work: Awaitable[T]) -> T:
    """Scraper and video host failures (timeouts, resets, bad statuses) become a clean 502."""
    try:
        return await work
    except (httpx.HTTPError, TimeoutError) as exc:
        logger.warning("Upstream request failed: %s: %s", type(exc).__name__, exc)
        raise ApiError(502, "upstream_failed", "The video host did not answer") from exc


router = APIRouter(prefix="/watch", tags=["watch"])
_bearer = HTTPBearer(auto_error=False)

# How long the player's source menu waits on each source before leaving it out.
OPTION_PROBE_TIMEOUT = 8.0
LANGS: tuple[Lang, ...] = ("sub", "dub")
# How long playback waits on a host to say whether a stream still exists.
PROBE_TIMEOUT = 6.0
# Answers that mean the file is gone, not that the host is having a bad moment.
GONE = (404, 410)


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
    kind: str
    resolution: int | None
    # Relative to the API base URL. Carries a token scoped to this one episode, because
    # <video> and native players can't send an Authorization header.
    url: str
    subtitles: list[SubtitleOut] = []
    skips: list[SkipOut] = []
    # Name or language of the audio track to start with, when the stream has several.
    default_audio: str | None = None
    # Font name (lower case) -> link, for rendering the ASS subtitles.
    fonts: dict[str, str] = {}


class PlayerPreferencesIO(BaseModel):
    subtitle_size: Literal["small", "medium", "large", "huge"] = "medium"
    subtitle_color: Literal["white", "yellow", "cyan", "green"] = "white"
    subtitle_background: Literal["none", "outline", "translucent", "solid"] = "outline"
    subtitle_position: Literal["bottom", "raised", "top"] = "bottom"


def _source(request: Request, name: str) -> VideoSource:
    source = request.app.state.sources.get(name)
    if source is None:
        raise ApiError(404, "source_not_found", f"Video source '{name}' is not enabled")
    return source


async def _resolve_stream(
    request: Request, source: str, anime: dict, episode: int, lang: Lang
) -> tuple[str, Stream] | None:
    """The requested source first, then the other enabled ones, so one broken or missing
    source doesn't stop playback. Returns the name of the source that answered.

    A fallback only plays when its own episode list has this episode and is the same length
    as the requested source's (when that is known), so a source that matched another season
    or numbers episodes differently never plays the wrong one.

    A stream whose file is gone is passed over too. One whose host couldn't be checked is
    only used when no other source has a working one."""
    requested = _source(request, source)
    names = [source] + [n for n in request.app.state.sources if n != source]
    http: httpx.AsyncClient = request.app.state.http
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
        alive = await _stream_alive(http, stream)
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


async def _stream_alive(http: httpx.AsyncClient, stream: Stream) -> bool | None:
    """Whether the stream's file still exists: the first bytes of an HLS master must be a
    playlist, and an MP4 must answer a HEAD. None when the host couldn't tell (slow or erroring)."""
    if stream.url.startswith("file:"):
        return True
    try:
        async with asyncio.timeout(PROBE_TIMEOUT):
            if stream.kind == "mp4":
                response = await http.head(stream.url, headers=stream.upstream_headers)
                if response.status_code in GONE:
                    return False
                # Some hosts refuse HEAD; only a missing file counts as dead.
                return True
            referer = stream.upstream_headers.get("Referer", "")
            upstream, _ = await _open_upstream(
                http, stream.url, {"Referer": referer} if referer else {}
            )
            try:
                if upstream.status_code in GONE:
                    return False
                if upstream.status_code >= 400:
                    return None
                head = b""
                async for chunk in upstream.aiter_bytes():
                    head += chunk
                    if len(head) >= 64:
                        break
            finally:
                await upstream.aclose()
    except ApiError:
        # A private address or a redirect loop: the proxy would refuse to play it anyway.
        return False
    except (httpx.HTTPError, TimeoutError):
        return None
    # An error page served with 200 is not a playlist.
    return head.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"#EXTM3U")


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


def episodes_out(source: str, result: EpisodeList, viewer: str) -> EpisodesOut:
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
    request: Request, source: str, anime_id: int, user: CurrentUser, lang: Lang = "sub"
):
    src = _source(request, source)
    anime = await request.app.state.mal.visible_details(anime_id, user.show_nsfw)
    result = await _upstream(src.episodes(anime, lang))
    if result is None:
        raise ApiError(404, "not_available", "This anime isn't available from this source")
    return episodes_out(source, result, str(user.id))


@router.get("/options/{anime_id}/{episode}", response_model=list[StreamOption])
async def options(request: Request, anime_id: int, episode: int, user: CurrentUser):
    """Every source and sub/dub that lists this episode, in fallback order, for the player's
    source menu. A source that is slow or failing is left out."""
    anime = await request.app.state.mal.visible_details(anime_id, user.show_nsfw)
    pairs = [(name, lang) for name in request.app.state.sources for lang in LANGS]

    async def has(name: str, lang: Lang) -> bool:
        try:
            listed = await asyncio.wait_for(
                request.app.state.sources[name].episodes(anime, lang), OPTION_PROBE_TIMEOUT
            )
        except Exception:
            return False
        return listed is not None and episode in listed.episodes

    found = await asyncio.gather(*(has(name, lang) for name, lang in pairs))
    return [
        StreamOption(source=name, lang=lang)
        for (name, lang), hit in zip(pairs, found, strict=True)
        if hit
    ]


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
    _source(request, body.source)
    saved = await session.get(SourceChoice, (user.id, anime_id))
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
async def put_preferences(body: PlayerPreferencesIO, user: CurrentUser, session: Session):
    saved = await session.get(PlayerPreferences, user.id)
    if saved is None:
        saved = PlayerPreferences(user_id=user.id)
        session.add(saved)
    for field, value in body.model_dump().items():
        setattr(saved, field, value)
    await session.commit()
    return body


@router.post("/{source}/{anime_id}/episodes/{episode}/play", response_model=PlaybackOut)
async def play(
    request: Request,
    source: str,
    anime_id: int,
    episode: int,
    user: CurrentUser,
    lang: Lang = "sub",
):
    anime = await request.app.state.mal.visible_details(anime_id, user.show_nsfw)
    resolved = await _resolve_stream(request, source, anime, episode, lang)
    if resolved is None:
        raise ApiError(404, "not_available", "This episode isn't available from this source")
    used, stream = resolved
    token = create_playback_token(user.id, used, anime_id, episode, lang)
    path = "video" if stream.kind == "mp4" else "hls"
    referer = stream.upstream_headers.get("Referer", "")
    viewer = str(user.id)
    return PlaybackOut(
        source=used,
        kind=stream.kind,
        resolution=stream.resolution,
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
        default_audio=stream.default_audio,
        fonts={
            name: f"/watch/{hls.signed_link(url, referer, viewer, 'font')}"
            for name, url in stream.fonts.items()
        },
    )


@router.get("/video")
async def video(request: Request, session: Session, token: Annotated[str, Query()]):
    claims = decode_playback_token(token)
    if claims is None or await session.get(User, uuid.UUID(claims["sub"])) is None:
        raise ApiError(401, "invalid_token", "Invalid or expired playback token")
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


PLAYLIST_TIMEOUT = httpx.Timeout(15.0)
# Segments can be slow to start, but a host that goes quiet must not hold the connection.
SEGMENT_TIMEOUT = httpx.Timeout(30.0, read=60.0)


async def _open_upstream(
    http: httpx.AsyncClient, url: str, headers: dict[str, str]
) -> tuple[httpx.Response, str]:
    """GET a URL from a third-party host. Playlist hosts are untrusted, so every hop
    (redirects included) must be a public address, never something on our own network."""
    for _ in range(hls.MAX_REDIRECTS + 1):
        if not await hls.is_public_target(url):
            raise ApiError(502, "upstream_failed", "Refused to fetch a non-public address")
        timeout = PLAYLIST_TIMEOUT if hls.is_playlist(url, "") else SEGMENT_TIMEOUT
        upstream = await http.send(
            http.build_request("GET", url, headers=headers, timeout=timeout),
            stream=True,
            follow_redirects=False,
        )
        location = upstream.headers.get("location")
        if upstream.status_code not in (301, 302, 303, 307, 308) or not location:
            return upstream, url
        await upstream.aclose()
        url = urljoin(url, location)
    raise ApiError(502, "upstream_failed", "Too many redirects from the video host")


async def _read_playlist(upstream: httpx.Response) -> str:
    chunks: list[bytes] = []
    size = 0
    try:
        async for chunk in upstream.aiter_bytes():
            size += len(chunk)
            if size > hls.MAX_PLAYLIST_BYTES:
                raise ApiError(502, "upstream_failed", "Playlist from the video host is too large")
            chunks.append(chunk)
    except (httpx.HTTPError, TimeoutError) as exc:
        raise ApiError(502, "upstream_failed", "The video host did not answer") from exc
    finally:
        await upstream.aclose()
    return b"".join(chunks).decode("utf-8", errors="replace")


# Library files never change once converted; a link stays valid for hours.
LOCAL_CACHE = "private, max-age=3600"


def _serve_local(url: str, viewer: str) -> Response:
    """A file from the local library: playlists rewritten like remote ones, the rest as is
    (with Range support, for seeking). Blocking: a playlist checks every segment on disk, and
    the library may sit on a slow mount, so run it in a thread."""
    path = hls.local_path(url)
    if path is None:
        raise ApiError(404, "not_available", "This episode isn't available any more")
    if path.suffix == ".m3u8":
        if path.stat().st_size > hls.MAX_PLAYLIST_BYTES:
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
    )


@router.get("/hls")
async def hls_proxy(
    request: Request,
    session: Session,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    token: Annotated[str | None, Query()] = None,
    u: Annotated[str | None, Query()] = None,
    r: Annotated[str, Query()] = "",
    k: Annotated[str, Query()] = "",
    e: Annotated[int, Query()] = 0,
    s: Annotated[str, Query()] = "",
):
    """Without `u`, the master playlist of the episode the token is for. With `u`, one
    playlist, segment, subtitle or image that an earlier response linked to (signed for the
    signed-in viewer, who must send their bearer token, as the web app's proxy does)."""
    if u is None:
        claims = decode_playback_token(token) if token else None
        if claims is None or await session.get(User, uuid.UUID(claims["sub"])) is None:
            raise ApiError(401, "invalid_token", "Invalid or expired playback token")
        await session.commit()  # the scraper call below can be slow
        src = _source(request, claims["src"])
        anime = await request.app.state.mal.details(claims["aid"])
        stream = await _upstream(src.stream(anime, claims["ep"], claims["lang"]))
        if stream is None or stream.kind != "hls":
            raise ApiError(404, "not_available", "This episode isn't available any more")
        url, referer, viewer = stream.url, stream.upstream_headers.get("Referer", ""), claims["sub"]
    else:
        # Only the token is checked, not the database: these come several times a second.
        decoded = decode_access_token(credentials.credentials) if credentials else None
        if decoded is None:
            raise ApiError(401, "not_authenticated", "Missing or expired bearer token")
        viewer = str(decoded[0])
        # 403, not 401: a stale or foreign link can't be fixed by refreshing the session.
        if not hls.verify_link(u, r, k, viewer, e, s):
            raise ApiError(403, "invalid_link", "Invalid or expired stream link")
        url, referer = u, r

    if url.startswith("file:"):
        return await asyncio.to_thread(_serve_local, url, viewer)

    headers = {"Referer": referer} if referer else {}
    if "range" in request.headers:
        headers["Range"] = request.headers["range"]
    http: httpx.AsyncClient = request.app.state.http
    upstream, url = await _upstream(_open_upstream(http, url, headers))
    if upstream.status_code >= 400 and upstream.status_code != 416:
        await upstream.aclose()
        raise ApiError(502, "upstream_failed", f"Video host answered {upstream.status_code}")

    content_type = upstream.headers.get("content-type", "")
    if k == "" and hls.is_playlist(url, content_type):
        text = await _read_playlist(upstream)
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
