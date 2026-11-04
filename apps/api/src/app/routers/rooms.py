import asyncio
import json
import time
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from app import db
from app.deps import CurrentUser, Session, bearer_identity, throttle
from app.errors import ApiError
from app.models import User
from app.notifications import notify
from app.rooms import REACTIONS, Room, Rooms
from app.routers.friends import friend_ids

router = APIRouter(prefix="/watch/rooms", tags=["rooms"])
_bearer = HTTPBearer(auto_error=False)

# Often enough that a viewer whose stream quietly missed something catches up within seconds.
KEEPALIVE_SECONDS = 10


class RoomCreate(BaseModel):
    source: str = Field(min_length=1, max_length=40)
    anime_id: int = Field(ge=1)
    # Ignored: the room's title comes from MyAnimeList, never from the client.
    title: str | None = Field(default=None, max_length=200)
    episode: int = Field(ge=0, le=10_000)
    lang: Literal["sub", "dub"] = "sub"


class MemberOut(BaseModel):
    id: str
    username: str


class RoomPlaybackOut(BaseModel):
    playing: bool
    # Where the video is at server time `at` (epoch ms); while playing it moves on from there.
    # `at` can be a moment ahead: a scheduled start, waiting at `position` until then.
    position: float
    at: int
    # Goes up with every change, so older news can be dropped.
    version: int
    by: str | None = None


class RoomOut(BaseModel):
    code: str
    host_id: str
    source: str
    anime_id: int
    title: str
    episode: int
    lang: Literal["sub", "dub"]
    locked: bool
    members: list[MemberOut]
    # User id -> the episode they voted to switch to.
    votes: dict[str, int]
    # Ids of the people whose video is loading; the room is held while there are any.
    buffering: list[str]
    playback: RoomPlaybackOut
    # Goes up with every new snapshot; `tick` events carry it so a missed one is noticed.
    revision: int


class ClockOut(BaseModel):
    # Server time, epoch ms: viewers measure their clock's offset from it.
    now: int


class ControlIn(BaseModel):
    action: Literal["play", "pause", "seek"]
    position: float | None = Field(default=None, ge=0, le=86_400)


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class ReactionIn(BaseModel):
    emoji: str = Field(max_length=16, description=f"One of {' '.join(REACTIONS)}")


class EpisodeIn(BaseModel):
    episode: int = Field(ge=0, le=10_000)


class RoomInviteIn(BaseModel):
    user_id: uuid.UUID


class BufferingIn(BaseModel):
    buffering: bool


class LockIn(BaseModel):
    locked: bool


class StreamIn(BaseModel):
    source: str = Field(min_length=1, max_length=40)
    lang: Literal["sub", "dub"]


def _room(request: Request, code: str) -> Room:
    rooms: Rooms = request.app.state.rooms
    return rooms.get(code)


@router.post("", response_model=RoomOut, status_code=201, dependencies=[throttle("room_create")])
async def create_room(body: RoomCreate, request: Request, user: CurrentUser):
    if body.source not in request.app.state.sources:
        raise ApiError(404, "source_not_found", f"Video source '{body.source}' is not enabled")
    # Same visibility rule as playback: a title hidden by the user's +18 switch can't be hosted.
    details = await request.app.state.mal.visible_details(body.anime_id, user.show_nsfw)
    title = str(details.get("title") or f"#{body.anime_id}")
    rooms: Rooms = request.app.state.rooms
    room = rooms.create(user.id, body.source, body.anime_id, title, body.episode, body.lang)
    return room.snapshot()


@router.get("/clock", response_model=ClockOut)
async def clock():
    """The server's clock, so viewers can line their own up with it. Declared before /{code}."""
    return {"now": round(time.time() * 1000)}


@router.get("/{code}", response_model=RoomOut)
async def get_room(code: str, request: Request, user: CurrentUser):
    room = _room(request, code)
    if room.is_full_for(user.id):
        raise ApiError(409, "room_full", "The room is full")
    return room.snapshot()


@router.post("/{code}/invite", status_code=204, dependencies=[throttle("room_invite")])
async def invite_friend(
    code: str, body: RoomInviteIn, request: Request, user: CurrentUser, session: Session
):
    """Invites a friend to a room you are in. They get a notification."""
    room = _room(request, code)
    if body.user_id not in await friend_ids(session, user.id):
        raise ApiError(403, "invite_not_friends", "You can only invite friends")
    room.invite(user.id, body.user_id)
    await notify(
        session,
        body.user_id,
        "room_invite",
        actor_id=user.id,
        anime_id=room.anime_id,
        episode=room.episode,
        title=room.title[:300],
        room_code=room.code,
    )
    await session.commit()


@router.post("/{code}/control", status_code=204)
async def control(code: str, body: ControlIn, request: Request, user: CurrentUser):
    _room(request, code).control(user.id, body.action, body.position)


@router.post("/{code}/buffering", status_code=204)
async def buffering(code: str, body: BufferingIn, request: Request, user: CurrentUser):
    _room(request, code).set_buffering(user.id, body.buffering)


@router.post("/{code}/chat", status_code=204, dependencies=[throttle("room_chat")])
async def chat(code: str, body: ChatIn, request: Request, user: CurrentUser):
    _room(request, code).say(user.id, body.text)


@router.post("/{code}/reaction", status_code=204, dependencies=[throttle("room_reaction")])
async def reaction(code: str, body: ReactionIn, request: Request, user: CurrentUser):
    _room(request, code).react(user.id, body.emoji)


@router.post("/{code}/episode", status_code=204)
async def vote_episode(code: str, body: EpisodeIn, request: Request, user: CurrentUser):
    _room(request, code).vote_episode(user.id, body.episode)


@router.delete("/{code}/episode", status_code=204)
async def withdraw_vote(code: str, request: Request, user: CurrentUser):
    _room(request, code).withdraw_vote(user.id)


@router.put("/{code}/stream", status_code=204)
async def switch_stream(code: str, body: StreamIn, request: Request, user: CurrentUser):
    """The host switches everyone to another source, or between sub and dub."""
    room = _room(request, code)
    if body.source not in request.app.state.sources:
        raise ApiError(404, "source_not_found", f"Video source '{body.source}' is not enabled")
    room.set_stream(user.id, body.source, body.lang)


@router.put("/{code}/lock", status_code=204)
async def lock(code: str, body: LockIn, request: Request, user: CurrentUser):
    _room(request, code).set_locked(user.id, body.locked)


async def _stream_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    # Not CurrentUser: that holds a database connection until the response ends, and this
    # response lasts as long as the viewer stays in the room.
    async with db.new_session() as session:
        user_id, _ = await bearer_identity(request, session, credentials)
        user = await session.get(User, user_id)
    if user is None:
        raise ApiError(401, "invalid_token", "User no longer exists")
    return user


def _frame(kind: str, data: dict) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.get("/{code}/events", response_class=StreamingResponse)
async def events(code: str, request: Request, user: Annotated[User, Depends(_stream_user)]):
    """Server-sent events: `state` (the whole room), `playback`, `chat`, and every few seconds
    `tick` with the current playback version and snapshot revision. Opening this joins the
    room; closing it leaves."""
    room = _room(request, code)
    if room.is_full_for(user.id):
        raise ApiError(409, "room_full", "The room is full")

    async def stream():
        queue = room.join(user.id, user.username)
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), KEEPALIVE_SECONDS)
                except TimeoutError:
                    yield _frame("tick", {"version": room.version, "revision": room.revision})
                    continue
                if item is None:
                    return
                yield _frame(*item)
        finally:
            room.leave(user.id, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
