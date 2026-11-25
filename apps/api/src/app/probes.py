"""Whether a resolved stream still plays, and the master playlist that said so.

Pressing play used to fetch the same master playlist three times: for the quality, to check the
file still exists, and again when the player asked the proxy for it. Here a master is fetched
once and kept for a few minutes, so the check, the quality and the proxy's first answer all read
the same copy, and concurrent callers share one fetch. Verdicts are kept too, so playing,
preparing the next episode and retrying don't each ask the host again.

The cache lives in this process and holds a few hundred bytes per stream. With several API
workers each keeps its own, which costs one extra fetch per worker, never a wrong answer. A shared
store (Redis) can sit behind these same methods when that matters.
"""

import asyncio
from dataclasses import dataclass
from urllib.parse import urljoin

import httpx
from cachetools import TTLCache

from app import hls
from app.errors import ApiError
from app.singleflight import SingleFlight
from app.sources.base import Stream
from app.upstream import host_headers, open_upstream, read_capped

# How long a fetched master (and so an "alive" verdict) is reused. Long enough to cover the
# title page warming a stream and the user pressing play; short enough that a host taking a
# file down is noticed on the next play.
MASTER_TTL = 300
# A stream found dead is skipped this long before the host is asked again.
DEAD_TTL = 60
# How long playback waits on a host to say whether a stream still exists.
PROBE_TIMEOUT = 6.0
# Answers that mean the file is gone, not that the host is having a bad moment.
GONE = (404, 410)
# Answers to a piece of the picture that mean the viewer won't get it either.
REFUSED = (401, 403, 404, 410)

type Key = tuple[str, str]


@dataclass(frozen=True)
class Master:
    # Where it was served from, after redirects: its relative links resolve against this.
    url: str
    text: str


class Gone(Exception):
    """The host says the file isn't there, or served something that isn't a playlist."""


class HostError(Exception):
    """The host answered with an error that doesn't say the file is gone (a 403, a 500)."""

    def __init__(self, status: int) -> None:
        super().__init__(f"Video host answered {status}")
        self.status = status


class StreamProbes:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._masters: TTLCache[Key, Master] = TTLCache(maxsize=4096, ttl=MASTER_TTL)
        self._dead: TTLCache[Key, None] = TTLCache(maxsize=4096, ttl=DEAD_TTL)
        self._files: TTLCache[Key, bool] = TTLCache(maxsize=4096, ttl=MASTER_TTL)
        self._flights: SingleFlight[Key, Master] = SingleFlight()
        # Whether the first bytes of the picture could be fetched (see `plays`).
        self._plays: TTLCache[Key, bool] = TTLCache(maxsize=4096, ttl=MASTER_TTL)

    def peek(self, url: str, referer: str) -> Master | None:
        """The master already fetched for this stream, without asking the host."""
        return self._masters.get((url, referer))

    def forget(self, url: str, referer: str) -> None:
        """Drops what is known about this stream, so the next check asks the host again."""
        key = (url, referer)
        for cache in (self._masters, self._dead, self._files, self._plays):
            cache.pop(key, None)

    async def master(self, url: str, referer: str) -> Master:
        """The stream's master playlist, from the cache when fresh. Raises Gone, HostError,
        ApiError (a refused address or an oversized playlist) or the network error."""
        key = (url, referer)
        if (found := self._masters.get(key)) is not None:
            return found
        if key in self._dead:
            raise Gone(url)
        return await self._flights.run(key, lambda: self._fetch(key))

    async def _fetch(self, key: Key) -> Master:
        url, referer = key
        try:
            upstream, final = await open_upstream(
                self._http, url, {"Referer": referer} if referer else {}
            )
            if upstream.status_code in GONE:
                await upstream.aclose()
                raise Gone(url)
            if upstream.status_code >= 400:
                await upstream.aclose()
                raise HostError(upstream.status_code)
            text = await read_capped(upstream)
            # An error page served with 200 is not a playlist.
            if not text.lstrip("﻿ \t\r\n").startswith("#EXTM3U"):
                raise Gone(url)
        except (Gone, ApiError):
            # Gone, or something the proxy would refuse to play anyway.
            self._dead[key] = None
            raise
        master = Master(final, text)
        self._masters[key] = master
        return master

    async def check(self, stream: Stream) -> bool | None:
        """Whether the stream's file still exists: an HLS master must be a playlist, and an MP4
        must answer a HEAD. None when the host couldn't tell (slow or erroring)."""
        if stream.url.startswith("file:"):
            return True
        key = (stream.url, stream.upstream_headers.get("Referer", ""))
        if key in self._dead:
            return False
        try:
            async with asyncio.timeout(PROBE_TIMEOUT):
                if stream.kind == "mp4":
                    return await self._file_alive(stream, key)
                await self.master(*key)
                return True
        except (Gone, ApiError):
            return False
        except (HostError, httpx.HTTPError, TimeoutError):
            return None

    async def _file_alive(self, stream: Stream, key: Key) -> bool:
        if key in self._files:
            return True
        # Through open_upstream, like the proxy: a redirect to our own network counts as dead.
        response, _ = await open_upstream(
            self._http, stream.url, dict(stream.upstream_headers), method="HEAD"
        )
        await response.aclose()
        # Some hosts refuse HEAD; only a missing file counts as dead.
        if response.status_code in GONE:
            self._dead[key] = None
            return False
        self._files[key] = True
        return True

    async def plays(self, stream: Stream) -> bool | None:
        """A deeper check than `check`: whether the first piece of the picture can be fetched,
        which is what fails when a host lists a file but refuses to serve it (a 403 on the
        segments, a dead video server behind a working playlist). For HLS that is the first
        segment of the first variant; for an MP4, its first bytes. None when it couldn't tell."""
        if stream.url.startswith("file:"):
            return True
        key = (stream.url, stream.upstream_headers.get("Referer", ""))
        if (known := self._plays.get(key)) is not None:
            return known
        if key in self._dead:
            return False
        try:
            async with asyncio.timeout(PROBE_TIMEOUT):
                target = stream.url if stream.kind == "mp4" else await self._first_segment(key)
                if target is None:
                    return None
                headers = {**stream.upstream_headers, **host_headers(key[1])}
                response, _ = await open_upstream(
                    self._http, target, {**headers, "Range": "bytes=0-1023"}
                )
                status = response.status_code
                await response.aclose()
        except (Gone, ApiError):
            self._plays[key] = False
            return False
        except (HostError, httpx.HTTPError, TimeoutError):
            return None
        if status in REFUSED:
            self._plays[key] = False
            return False
        if status >= 400:
            return None
        self._plays[key] = True
        return True

    async def _first_segment(self, key: Key) -> str | None:
        """The address of the first segment the player would load."""
        master = await self.master(*key)
        playlist_url, text = master.url, master.text
        variant = hls.first_variant(text)
        if variant is not None:
            playlist_url = urljoin(master.url, variant)
            response, final = await open_upstream(self._http, playlist_url, host_headers(key[1]))
            if response.status_code >= 400:
                status = response.status_code
                await response.aclose()
                if status in REFUSED:
                    raise Gone(playlist_url)
                raise HostError(status)
            text = await read_capped(response)
            playlist_url = final
        segment = hls.first_segment(text)
        return urljoin(playlist_url, segment) if segment else None
