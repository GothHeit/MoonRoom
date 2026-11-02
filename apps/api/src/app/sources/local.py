"""PRIVATE ONLY: the owner's own episode files, converted ahead of time into the local library
(see app.library and `python -m app.library ingest`).

Titles are folders named by MAL id, so no matching is needed. Links point at files under the
library folders; the HLS proxy serves them from disk to signed-in viewers only.

Listings and streams are cached for a minute: the library may sit on a network share where
every file read costs milliseconds, and most titles people open aren't in it at all.
"""

import asyncio
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from cachetools import TTLCache

from app.library import (
    EPISODE_META,
    FONT_INDEX,
    FONTS_DIR,
    MASTER,
    THUMBNAIL,
    TITLE_META,
    finished_episodes,
    read_json,
    title_dir,
)
from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Skip, Stream, Subtitle, Traits

# How long a listing or stream is reused, so a new conversion shows up within a minute.
CACHE_SECONDS = 60


class LocalSource:
    name = "local"
    traits = Traits(dub_audio_lang=None)

    def __init__(self, roots: Path | Sequence[Path]):
        self.roots = [roots] if isinstance(roots, Path) else list(roots)
        # Misses are cached too (as None): they are the common case.
        self._cache: TTLCache[tuple, Any] = TTLCache(maxsize=4096, ttl=CACHE_SECONDS)
        self._flights: SingleFlight[tuple, Any] = SingleFlight()

    def _title(self, mal_id: int, lang: Lang) -> tuple[Path, dict] | None:
        """The folder holding this title, from the first library folder that has it."""
        for root in self.roots:
            title = title_dir(root, mal_id, lang)
            meta = read_json(title / TITLE_META)
            if isinstance(meta, dict):
                return title, meta
        return None

    def _episodes(self, mal_id: int, lang: Lang) -> EpisodeList | None:
        found = self._title(mal_id, lang)
        if found is None:
            return None
        title, meta = found
        if isinstance(meta.get("episodes"), list):
            done = [int(ep) for ep in meta["episodes"]]
            thumbs = [int(ep) for ep in meta.get("thumbnails", [])]
        else:
            done, thumbs = finished_episodes(title)
        if not done:
            return None
        return EpisodeList(
            episodes=done,
            source_title=str(meta.get("title", "")),
            thumbnails={ep: (title / str(ep) / THUMBNAIL).as_uri() for ep in thumbs},
        )

    def _stream(self, mal_id: int, episode: int, lang: Lang) -> Stream | None:
        found = self._title(mal_id, lang)
        if found is None:
            return None
        title = found[0]
        folder = title / str(episode)
        meta = read_json(folder / EPISODE_META)
        if not isinstance(meta, dict):
            return None
        fonts = read_json(title / FONT_INDEX) or {}
        return Stream(
            url=(folder / MASTER).as_uri(),
            kind="hls",
            resolution=meta.get("height"),
            upstream_headers={},
            subtitles=tuple(
                Subtitle(
                    lang=s["lang"],
                    label=s["label"],
                    url=(folder / s["vtt"]).as_uri(),
                    ass_url=(folder / s["ass"]).as_uri() if s.get("ass") else None,
                )
                for s in meta.get("subtitles", [])
            ),
            skips=tuple(
                Skip(kind=k["kind"], start=k["start"], end=k["end"]) for k in meta.get("skips", [])
            ),
            fonts={name: (title / FONTS_DIR / file).as_uri() for name, file in fonts.items()},
        )

    async def _cached(self, key: tuple, read) -> Any:
        if key in self._cache:
            return self._cache[key]
        value = await self._flights.run(key, lambda: asyncio.to_thread(read, *key[1:]))
        self._cache[key] = value
        return value

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        result: EpisodeList | None = await self._cached(
            ("episodes", anime["id"], lang), self._episodes
        )
        return result

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        result: Stream | None = await self._cached(
            ("stream", anime["id"], episode, lang), self._stream
        )
        return result
