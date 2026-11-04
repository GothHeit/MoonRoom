"""Watch-together rooms, kept in memory and mirrored to Redis.

A room is one episode watched in sync by up to MAX_MEMBERS people. It lives only as long as
someone is in it (plus a short grace period, so a page reload doesn't lose it), which is why
there is no table: the API runs as a single process. Every change is copied to Redis (see
RoomStore) so a restart or a deploy picks the rooms up again and viewers just reconnect.
"""

import asyncio
import secrets
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from app.errors import ApiError

MAX_MEMBERS = 10
MAX_ROOMS = 100
MAX_ROOMS_PER_HOST = 3
# A host who drops (reload, network blip) keeps the room for this long before it passes on.
HOST_GRACE_SECONDS = 20
CODE_LENGTH = 6
# No 0/O or 1/I, so a code read aloud or from a screenshot can't be mistyped.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CHAT_HISTORY = 50
CHAT_MAX_LENGTH = 300
REACTIONS = ("👍", "❤️", "😂", "😮", "😢", "🔥")
EMPTY_GRACE_SECONDS = 60
MAX_EPISODE = 10_000
# When someone's video stalls the room pauses for everyone, but never for longer than this in
# one go, and nobody can hold it again for a while after, so one bad (or rude) connection
# can't keep the room waiting.
MAX_HOLD_SECONDS = 10
BUFFER_COOLDOWN_SECONDS = 20
# A just-created room is empty until its host connects; only older empty rooms are replaced.
REPLACE_EMPTY_AFTER_SECONDS = 5
# A friend invited to a room can still see the invite for this long.
INVITE_TTL_SECONDS = 30 * 60
# Starts are scheduled a moment ahead, so every viewer starts on the same frame instead of
# whenever the news reaches them. A seek needs longer, to load the new spot; a new episode or
# stream longer still (the room counts it down).
START_LEAD_SECONDS = 0.4
SEEK_LEAD_SECONDS = 1.0
EPISODE_LEAD_SECONDS = 3.0
MAX_INVITES_PER_ROOM = 50
MAX_INVITES_PER_PERSON = 10

Event = tuple[str, dict]


@dataclass
class Member:
    username: str
    queues: set[asyncio.Queue[Event | None]] = field(default_factory=set)


@dataclass
class Room:
    code: str
    host_id: uuid.UUID
    source: str
    anime_id: int
    title: str
    episode: int
    lang: str
    locked: bool = False
    playing: bool = False
    # Where the video is at `moved_at` (monotonic seconds), which is in the future while a
    # start is scheduled: until then a playing room waits at `position`.
    position: float = 0.0
    moved_at: float = field(default_factory=time.monotonic)
    # Goes up with every change to playback, so a viewer can drop news older than what it has.
    version: int = 0
    # Goes up with every new snapshot, so a viewer whose stream missed one notices.
    revision: int = 0
    members: dict[uuid.UUID, Member] = field(default_factory=dict)
    votes: dict[uuid.UUID, int] = field(default_factory=dict)
    chat: list[dict] = field(default_factory=list)
    # Invited user -> (who invited, monotonic time of the invite).
    invited: dict[uuid.UUID, tuple[uuid.UUID, float]] = field(default_factory=dict)
    empty_since: float | None = field(default_factory=time.monotonic)
    # Who is waiting for their video to load, and since when (monotonic).
    buffering: dict[uuid.UUID, float] = field(default_factory=dict)
    # True while the room is paused only because someone is buffering.
    held: bool = False
    # Until when a viewer who held the room may not hold it again.
    hold_blocked: dict[uuid.UUID, float] = field(default_factory=dict)
    # When the host was last seen leaving (monotonic), so a room whose host never came back
    # can be handed to whoever joins next.
    host_left_at: float | None = None
    _hold_timer: asyncio.TimerHandle | None = None
    # Called with the room's code whenever something worth keeping changed.
    on_change: Callable[[str], None] | None = None

    def changed(self) -> None:
        if self.on_change is not None:
            self.on_change(self.code)

    def now_position(self) -> float:
        if not self.playing:
            return self.position
        return self.position + max(time.monotonic() - self.moved_at, 0.0)

    def _move(self, position: float, playing: bool, lead: float = 0.0) -> None:
        self.position = position
        self.playing = playing
        self.moved_at = time.monotonic() + (lead if playing else 0.0)
        self.version += 1

    def playback(self, by: uuid.UUID | None = None) -> dict:
        """Where the room is: at `position` at server time `at` (epoch ms, possibly a moment
        ahead), moving on from there in real time while it plays."""
        wall = time.time() + (self.moved_at - time.monotonic())
        return {
            "playing": self.playing,
            "position": round(self.position, 3),
            "at": round(wall * 1000),
            "version": self.version,
            "by": str(by) if by else None,
        }

    def snapshot(self) -> dict:
        return {
            "code": self.code,
            "host_id": str(self.host_id),
            "source": self.source,
            "anime_id": self.anime_id,
            "title": self.title,
            "episode": self.episode,
            "lang": self.lang,
            "locked": self.locked,
            "members": [{"id": str(i), "username": m.username} for i, m in self.members.items()],
            "votes": {str(user): episode for user, episode in self.votes.items()},
            "buffering": [str(user) for user in self.buffering],
            "playback": self.playback(),
            "revision": self.revision,
        }

    def broadcast(
        self, kind: str, data: dict, skip: asyncio.Queue[Event | None] | None = None
    ) -> None:
        self.changed()
        for member in self.members.values():
            for queue in member.queues:
                if queue is not skip:
                    queue.put_nowait((kind, data))

    def _state(self) -> None:
        self.revision += 1
        self.broadcast("state", self.snapshot())

    def is_full_for(self, user_id: uuid.UUID) -> bool:
        return user_id not in self.members and len(self.members) >= MAX_MEMBERS

    def join(self, user_id: uuid.UUID, username: str) -> asyncio.Queue[Event | None]:
        if self.is_full_for(user_id):
            raise ApiError(409, "room_full", "The room is full")
        queue: asyncio.Queue[Event | None] = asyncio.Queue()
        is_new = user_id not in self.members
        if user_id == self.host_id:
            self.host_left_at = None
        elif (
            self.host_id not in self.members
            and self.host_left_at is not None
            and time.monotonic() - self.host_left_at > HOST_GRACE_SECONDS
        ):
            # The host dropped while this person was gone too, and never came back.
            self.host_id = user_id
            self.host_left_at = None
        self.members.setdefault(user_id, Member(username)).queues.add(queue)
        self.empty_since = None
        self.invited.pop(user_id, None)
        self.changed()
        if is_new:
            self.revision += 1
        snapshot = self.snapshot()
        queue.put_nowait(("state", snapshot))
        for message in self.chat:
            queue.put_nowait(("chat", message))
        if is_new:
            self.broadcast("state", snapshot, skip=queue)
        return queue

    def leave(self, user_id: uuid.UUID, queue: asyncio.Queue[Event | None]) -> None:
        member = self.members.get(user_id)
        if member is None:
            return
        member.queues.discard(queue)
        if member.queues:
            return
        del self.members[user_id]
        self.votes.pop(user_id, None)
        self._stop_buffering(user_id)
        if user_id == self.host_id:
            self.host_left_at = time.monotonic()
        if not self.members:
            self.empty_since = time.monotonic()
            self._move(self.now_position(), False)
            self.changed()
            return
        if user_id == self.host_id:
            asyncio.get_running_loop().call_later(HOST_GRACE_SECONDS, self._pass_host, user_id)
        self._switch_if_majority()
        self._state()

    def _pass_host(self, former: uuid.UUID) -> None:
        # Only if the host never came back and someone is still here.
        if self.host_id != former or former in self.members or not self.members:
            return
        self.host_id = next(iter(self.members))
        self._state()

    def _switch_if_majority(self) -> None:
        tally: dict[int, int] = {}
        for episode in self.votes.values():
            tally[episode] = tally.get(episode, 0) + 1
        for episode, count in tally.items():
            if count * 2 > len(self.members):
                self._switch(episode)
                return

    def _require_member(self, user_id: uuid.UUID) -> None:
        if user_id not in self.members:
            raise ApiError(403, "not_in_room", "Join the room first")

    def control(self, user_id: uuid.UUID, action: str, position: float | None) -> None:
        self._require_member(user_id)
        if self.locked and user_id != self.host_id:
            raise ApiError(403, "controls_locked", "Only the host can control playback")
        at = self.now_position() if position is None else max(position, 0.0)
        if action in ("play", "pause"):
            # Whoever plays or pauses decides, so the hold no longer applies. A seek doesn't.
            if self.held:
                self.held = False
                if self._hold_timer is not None:
                    self._hold_timer.cancel()
                    self._hold_timer = None
            playing = action == "play"
            self._move(at, playing, START_LEAD_SECONDS)
        else:
            self._move(at, self.playing, SEEK_LEAD_SECONDS)
        self.broadcast("playback", self.playback(user_id))

    def set_locked(self, user_id: uuid.UUID, locked: bool) -> None:
        if user_id != self.host_id:
            raise ApiError(403, "host_only", "Only the host can do this")
        self.locked = locked
        self._state()

    def set_stream(self, user_id: uuid.UUID, source: str, lang: str) -> None:
        """The host plays the same episode from another source or in sub/dub. Everyone reloads
        and picks up where the room is, so nobody waits on anyone else's old stream."""
        if user_id != self.host_id:
            raise ApiError(403, "host_only", "Only the host can do this")
        if (source, lang) == (self.source, self.lang):
            return
        self.buffering.clear()
        self.held = False
        if self._hold_timer is not None:
            self._hold_timer.cancel()
            self._hold_timer = None
        self._move(self.now_position(), self.playing, EPISODE_LEAD_SECONDS)
        self.source = source
        self.lang = lang
        self._state()

    def set_buffering(self, user_id: uuid.UUID, buffering: bool) -> None:
        self._require_member(user_id)
        if not buffering:
            self._stop_buffering(user_id)
            return
        now = time.monotonic()
        self.hold_blocked = {u: t for u, t in self.hold_blocked.items() if t > now}
        if user_id in self.buffering or user_id in self.hold_blocked:
            return
        if not self.held:
            # Nothing to hold in a paused room, and a locked room's playback is the host's.
            if not self.playing or (self.locked and user_id != self.host_id):
                return
            self._move(self.now_position(), False)
            self.held = True
            self._hold_timer = asyncio.get_running_loop().call_later(
                MAX_HOLD_SECONDS, self._release_hold
            )
            self.broadcast("playback", self.playback())
        self.buffering[user_id] = now
        self._state()

    def _stop_buffering(self, user_id: uuid.UUID) -> None:
        if self.buffering.pop(user_id, None) is None:
            return
        self.hold_blocked[user_id] = time.monotonic() + BUFFER_COOLDOWN_SECONDS
        if self.held and not self.buffering:
            self._resume()
        if self.members:
            self._state()

    def _resume(self) -> None:
        if self._hold_timer is not None:
            self._hold_timer.cancel()
            self._hold_timer = None
        if not self.held:
            return
        self.held = False
        self._move(self.position, True, START_LEAD_SECONDS)
        self.broadcast("playback", self.playback())

    def _release_hold(self) -> None:
        """The hold ran out: carry on without whoever is still stuck."""
        self._hold_timer = None
        now = time.monotonic()
        for user_id in self.buffering:
            self.hold_blocked[user_id] = now + BUFFER_COOLDOWN_SECONDS
        self.buffering.clear()
        self._resume()
        if self.members:
            self._state()

    def _switch(self, episode: int) -> None:
        self.buffering.clear()
        self.held = False
        if self._hold_timer is not None:
            self._hold_timer.cancel()
            self._hold_timer = None
        self.episode = episode
        self.votes.clear()
        self._move(0.0, True, EPISODE_LEAD_SECONDS)
        self._state()

    def vote_episode(self, user_id: uuid.UUID, episode: int) -> None:
        """The host's pick applies at once; for anyone else it is a vote that needs a majority."""
        self._require_member(user_id)
        if not 0 <= episode <= MAX_EPISODE:
            raise ApiError(422, "invalid_episode", "Invalid episode")
        if user_id == self.host_id:
            self._switch(episode)
            return
        if episode == self.episode:
            return
        self.votes[user_id] = episode
        self._switch_if_majority()
        if self.votes:
            self._state()

    def withdraw_vote(self, user_id: uuid.UUID) -> None:
        self._require_member(user_id)
        if self.votes.pop(user_id, None) is not None:
            self._state()

    def invite(self, inviter_id: uuid.UUID, target_id: uuid.UUID) -> None:
        self._require_member(inviter_id)
        if target_id in self.members:
            raise ApiError(409, "already_in_room", "They are already in the room")
        now = time.monotonic()
        self.invited = {
            u: (by, at) for u, (by, at) in self.invited.items() if now - at < INVITE_TTL_SECONDS
        }
        by_inviter = sum(1 for by, _ in self.invited.values() if by == inviter_id)
        if target_id not in self.invited and (
            len(self.invited) >= MAX_INVITES_PER_ROOM or by_inviter >= MAX_INVITES_PER_PERSON
        ):
            raise ApiError(429, "too_many_invites", "Too many invites for this room")
        self.invited[target_id] = (inviter_id, now)
        self.changed()

    def say(self, user_id: uuid.UUID, text: str) -> None:
        self._require_member(user_id)
        text = text.strip()[:CHAT_MAX_LENGTH]
        if not text:
            raise ApiError(422, "empty_message", "Empty message")
        message = {
            "id": secrets.token_hex(6),
            "user_id": str(user_id),
            "username": self.members[user_id].username,
            "text": text,
            "reaction": False,
        }
        self.chat = [*self.chat, message][-CHAT_HISTORY:]
        self.broadcast("chat", message)

    def react(self, user_id: uuid.UUID, emoji: str) -> None:
        self._require_member(user_id)
        if emoji not in REACTIONS:
            raise ApiError(422, "invalid_reaction", "Unknown reaction")
        # Reactions are fleeting, so they are not kept for people who join later.
        self.broadcast(
            "chat",
            {
                "id": secrets.token_hex(6),
                "user_id": str(user_id),
                "username": self.members[user_id].username,
                "text": emoji,
                "reaction": True,
            },
        )

    def dump(self) -> dict:
        """What a restart needs to bring the room back. Members are left out: they reconnect.
        Times are wall-clock seconds, since monotonic ones mean nothing to the next process."""
        now = time.time()
        mono = time.monotonic()
        return {
            "code": self.code,
            "host_id": str(self.host_id),
            "source": self.source,
            "anime_id": self.anime_id,
            "title": self.title,
            "episode": self.episode,
            "lang": self.lang,
            "locked": self.locked,
            "playing": self.playing,
            "position": self.position,
            # When (wall clock) the room was at `position`.
            "at": now + (self.moved_at - mono),
            "version": self.version,
            "revision": self.revision,
            "chat": self.chat,
            "invited": {
                str(user): [str(by), now - (mono - at)] for user, (by, at) in self.invited.items()
            },
            "saved_at": now,
        }

    @classmethod
    def load(cls, data: dict) -> "Room":
        """A room from `dump`. One that was playing has kept playing all along: the viewers'
        players did, while the server was away, so they carry on without a jump."""
        now = time.time()
        mono = time.monotonic()
        room = cls(
            code=data["code"],
            host_id=uuid.UUID(data["host_id"]),
            source=data["source"],
            anime_id=int(data["anime_id"]),
            title=data["title"],
            episode=int(data["episode"]),
            lang=data["lang"],
            locked=bool(data["locked"]),
            playing=bool(data["playing"]),
            position=float(data["position"]),
            moved_at=mono + (float(data["at"]) - now),
            # Ahead of anything a viewer saw before the restart, so nothing they hold wins.
            version=int(data["version"]) + 1,
            revision=int(data["revision"]) + 1,
            chat=list(data.get("chat", []))[-CHAT_HISTORY:],
        )
        for user, (by, at) in data.get("invited", {}).items():
            if now - at < INVITE_TTL_SECONDS:
                room.invited[uuid.UUID(user)] = (uuid.UUID(by), mono - (now - at))
        # The host gets the usual grace to come back before someone else may take over.
        room.host_left_at = mono
        return room


class Rooms:
    def __init__(self, max_per_host: int = MAX_ROOMS_PER_HOST) -> None:
        self._rooms: dict[str, Room] = {}
        self._max_per_host = max_per_host
        # Codes changed or removed since the store last saved them.
        self.dirty: set[str] = set()
        self.removed: set[str] = set()

    def _changed(self, code: str) -> None:
        self.dirty.add(code)

    def _add(self, room: Room) -> None:
        room.on_change = self._changed
        self._rooms[room.code] = room
        self.dirty.add(room.code)
        self.removed.discard(room.code)

    def _remove(self, code: str) -> None:
        del self._rooms[code]
        self.dirty.discard(code)
        self.removed.add(code)

    def restore(self, saved: list[dict]) -> int:
        """Brings back rooms saved before a restart. Returns how many."""
        count = 0
        for data in saved:
            try:
                room = Room.load(data)
            except (KeyError, TypeError, ValueError):
                continue
            if room.code in self._rooms:
                continue
            room.on_change = self._changed
            self._rooms[room.code] = room
            count += 1
        return count

    def pending(self) -> tuple[list[dict], list[str]]:
        """Rooms to save and codes to delete since the last call. Rooms with people in them
        are always saved, so a restart resumes them from close to where they were."""
        codes = self.dirty | {code for code, room in self._rooms.items() if room.members}
        saves = [self._rooms[code].dump() for code in codes if code in self._rooms]
        removed = list(self.removed)
        self.dirty.clear()
        self.removed.clear()
        return saves, removed

    def get(self, code: str) -> Room:
        room = self._rooms.get(code.strip().upper())
        if room is None:
            raise ApiError(404, "room_not_found", "Room not found")
        return room

    def create(
        self, host_id: uuid.UUID, source: str, anime_id: int, title: str, episode: int, lang: str
    ) -> Room:
        # A host who left rooms behind (reloads, closed tabs) shouldn't be locked out by them.
        for old_code, old in list(self._rooms.items()):
            idle = old.empty_since is not None and time.monotonic() - old.empty_since
            if old.host_id == host_id and not old.members and idle > REPLACE_EMPTY_AFTER_SECONDS:
                self._remove(old_code)
        hosted = sum(1 for r in self._rooms.values() if r.host_id == host_id)
        if len(self._rooms) >= MAX_ROOMS or hosted >= self._max_per_host:
            raise ApiError(429, "too_many_rooms", "Too many rooms are open")
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        while code in self._rooms:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        room = Room(code, host_id, source, anime_id, title, episode, lang)
        self._add(room)
        return room

    def sweep(self) -> None:
        """Drops rooms that have been empty past the grace period."""
        now = time.monotonic()
        for code, room in list(self._rooms.items()):
            if (
                not room.members
                and room.empty_since is not None
                and now - room.empty_since > EMPTY_GRACE_SECONDS
            ):
                self._remove(code)

    def __len__(self) -> int:
        return len(self._rooms)
