"""The plug-in boundary for where video comes from.

The rest of the app (player, progress, UI) only talks to a VideoSource. The private
implementations are the ZokoAnime, AnimesDigital, AnimesDrive, KickAssAnime and AniZone scrapers
and the user's own converted files; a licensed catalog would be another one.
"""

from dataclasses import dataclass, field
from typing import Literal, Protocol

Lang = Literal["sub", "dub"]
SkipKind = Literal["intro", "outro", "recap"]


@dataclass(frozen=True)
class EpisodeList:
    episodes: list[int]
    source_title: str
    # Episode number -> still image, for the episodes the source has art for.
    thumbnails: dict[int, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Subtitle:
    # BCP 47 code ("pt-BR", "en"); the player matches the user's preference against it.
    lang: str
    label: str
    url: str
    # The same track as styled ASS, for players that render it; `url` stays the WebVTT copy.
    ass_url: str | None = None


@dataclass(frozen=True)
class Skip:
    """A stretch the viewer may want to jump over, in seconds from the start."""

    kind: SkipKind
    start: float
    end: float


@dataclass(frozen=True)
class Stream:
    url: str
    kind: Literal["mp4", "hls"]
    resolution: int | None
    # Headers the upstream host needs, e.g. a Referer for hotlink protection.
    upstream_headers: dict[str, str]
    subtitles: tuple[Subtitle, ...] = ()
    skips: tuple[Skip, ...] = ()
    # Name or language of the audio track to start with, when the stream has several.
    default_audio: str | None = None
    # Font name (lower case) -> file, for the ASS subtitles. Fetched only when a script uses it.
    fonts: dict[str, str] = field(default_factory=dict)
    # Subtitles made by machine translation. The ranking puts such a version below any other.
    machine_translated: bool = False
    # Language of this stream's dub, when it differs from the source's usual one (a source that
    # falls back to English for an episode without a Portuguese dub says so here).
    dub_audio_lang: str | None = None


@dataclass(frozen=True)
class Traits:
    """What a source's streams are, when the stream itself doesn't say. The ranking reads this
    to tell a hard-subbed copy from a soft-subbed one and to know what language a dub is in."""

    # Language burned into the picture of the "sub" copies, when they carry one.
    hard_sub_lang: str | None = None
    # Language of the source's "dub" copies; None when it has none.
    dub_audio_lang: str | None = "en"


class VideoSource(Protocol):
    name: str

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        """`anime` is the MAL detail payload. None means the title isn't available."""
        ...

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None: ...
