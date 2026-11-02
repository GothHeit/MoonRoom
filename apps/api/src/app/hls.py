"""Helpers to proxy HLS through the API.

Source hosts want a Referer a browser can't send, and spread segments over other hosts, so
every playlist is rewritten to point back at /watch/hls. Each rewritten URL is signed, so
the proxy only fetches URLs that came out of a playlist it already served (no open relay).
Signatures are bound to the viewer, so a copied link is useless to anyone else.

The local library uses the same links with file: URLs, which are only ever served from inside
the library folders.
"""

import asyncio
import hashlib
import hmac
import ipaddress
import os
import re
import socket
import stat
import time
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple
from urllib.parse import quote, unquote, urljoin, urlsplit

from cachetools import TTLCache

from app.config import get_settings

URI_ATTR = re.compile(r'URI="([^"]*)"')
RESOLUTION = re.compile(r"RESOLUTION=\d+x(\d+)")
# Long enough for a film watched with a few pauses; a stale link only needs a retry.
SEGMENT_LIFETIME = 4 * 3600
# How long a host's DNS verdict is trusted. Segments come from a handful of hosts.
DNS_TTL = 300
MAX_PLAYLIST_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 3
INTERNAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".corp")
# What a signed link points at, when the proxy can't tell from the upstream answer:
# "" a playlist or segment, "sub" WebVTT subtitles, "img" a still image, "ass" styled
# subtitles and "font" a font for them (both local library only).
# "subpl" is a one-segment playlist wrapping a WebVTT file, which is how HLS carries subtitles.
KINDS = ("", "sub", "img", "ass", "font", "subpl")
SAFE_IMAGES = ("image/jpeg", "image/png", "image/webp", "image/gif", "image/avif")

_public_hosts: TTLCache[str, bool] = TTLCache(maxsize=1024, ttl=DNS_TTL)


def _public_ip(value: str) -> bool:
    try:
        return ipaddress.ip_address(value).is_global
    except ValueError:
        return False


def looks_public(url: str) -> bool:
    """Cheap check on the URL text alone: http(s), and a real hostname or a public IP.
    Hosts come from third-party playlists, so nothing internal may be reachable through us."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not host:
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        # A name: single-label hosts (db, redis) and internal suffixes never face the internet.
        return "." in host and not host.endswith(INTERNAL_SUFFIXES) and host != "localhost"
    return _public_ip(host)


async def resolve_host(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


async def is_public_target(url: str) -> bool:
    """`looks_public` plus DNS: every address the name resolves to must be public."""
    if not looks_public(url):
        return False
    host = urlsplit(url).hostname or ""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if host in _public_hosts:
        return _public_hosts[host]
    try:
        addresses = await resolve_host(host)
    except OSError:
        # Not cached: a lookup that failed may work on the next segment.
        return False
    verdict = bool(addresses) and all(_public_ip(a) for a in addresses)
    _public_hosts[host] = verdict
    return verdict


class Viewer(NamedTuple):
    """Who a stream link is for: the user and the login session it was made in. The link names
    both, so it works without a login header (a TV or AirPlay receiver sends none), and it stops
    working the moment that session is signed out."""

    user: str
    sid: str = ""


def _who(viewer: "Viewer | str") -> Viewer:
    return viewer if isinstance(viewer, Viewer) else Viewer(viewer)


def _mac(
    url: str, referer: str, kind: str, viewer: Viewer, expires: int, key: bytes | None = None
) -> str:
    key = key or get_settings().stream_link_keys[0]
    msg = f"hls\n{url}\n{referer}\n{kind}\n{viewer.user}\n{viewer.sid}\n{expires}".encode()
    return hmac.new(key, msg, hashlib.sha256).hexdigest()[:32]


def signed_link(
    url: str, referer: str, viewer: "Viewer | str", kind: str = "", lifetime: int = SEGMENT_LIFETIME
) -> str:
    """A link the proxy serves to the user it is for, for `lifetime` seconds."""
    # Relative to /watch/hls on purpose: it resolves under whatever prefix the client
    # reaches the API through (the web app serves it under /api/stream and /api/proxy).
    who = _who(viewer)
    expires = int(time.time()) + lifetime
    kind_param = f"&k={kind}" if kind else ""
    return (
        f"hls?u={quote(url, safe='')}&r={quote(referer, safe='')}{kind_param}"
        f"&v={who.user}&i={who.sid}&e={expires}&s={_mac(url, referer, kind, who, expires)}"
    )


def verify_link(
    url: str, referer: str, kind: str, viewer: "Viewer | str", expires: int, sig: str
) -> bool:
    """Whether the link is genuine and unexpired. Whether its session is still open is the
    caller's question."""
    who = _who(viewer)
    if kind not in KINDS or expires <= time.time():
        return False
    # Links signed before a key rotation keep working until they expire.
    return any(
        hmac.compare_digest(sig, _mac(url, referer, kind, who, expires, key))
        for key in get_settings().stream_link_keys
    )


def is_playlist(url: str, content_type: str) -> bool:
    return "mpegurl" in content_type.lower() or url.split("?")[0].lower().endswith(".m3u8")


def media_type(url: str, kind: str, upstream_type: str) -> str:
    """The type to serve a non-playlist with. Hosts often disguise segments as images, so
    their own type is only trusted when it already says video or audio."""
    path = url.split("?")[0].lower()
    upstream_type = upstream_type.split(";")[0].strip().lower()
    if kind == "sub" or path.endswith(".vtt") or upstream_type == "text/vtt":
        return "text/vtt"
    if kind == "img":
        # Raster formats only: an SVG served from our origin could run script.
        return upstream_type if upstream_type in SAFE_IMAGES else "image/jpeg"
    if upstream_type.startswith(("video/", "audio/")):
        return upstream_type
    if path.endswith((".m4s", ".mp4")):
        return "video/mp4"
    return "video/mp2t"


LOCAL_TYPES = {
    ".m4s": "video/mp4",
    ".mp4": "video/mp4",
    ".ts": "video/mp2t",
    ".vtt": "text/vtt",
    ".ass": "text/plain; charset=utf-8",
    ".jpg": "image/jpeg",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".ttc": "font/collection",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


@lru_cache(maxsize=8)
def _roots(spec: tuple[str, ...]) -> tuple[tuple[Path, ...], tuple[str, ...]]:
    """The library folders resolved (where files really are) and as written (what links say).
    Resolving costs a metadata call per path component, which adds up on a network mount."""
    return tuple(Path(r).resolve() for r in spec), tuple(os.path.normpath(r) for r in spec)


def _file_url_path(url: str) -> str | None:
    if not url.startswith("file:"):
        return None
    return unquote(urlsplit(url).path)


def local_file(url: str) -> tuple[Path, os.stat_result] | None:
    """The library file a file: URL names and its stat; None for anything else, or anything
    that leads outside every library folder (dot segments, symlinks to elsewhere)."""
    spec = tuple(get_settings().library_roots)
    raw = _file_url_path(url)
    if not spec or raw is None:
        return None
    resolved, _ = _roots(spec)
    path = Path(raw).resolve()
    if not any(path.is_relative_to(root) for root in resolved):
        return None
    try:
        info = path.stat()
    except OSError:
        return None
    return (path, info) if stat.S_ISREG(info.st_mode) else None


def local_path(url: str) -> Path | None:
    found = local_file(url)
    return found[0] if found else None


def in_library(url: str) -> bool:
    """Whether a file: URL names a path inside a library folder, judged from the text alone.
    Used for the links inside library playlists, which can list hundreds of segments: they are
    checked for real (symlinks included) when each one is fetched, through `local_file`."""
    spec = tuple(get_settings().library_roots)
    raw = _file_url_path(url)
    if not spec or raw is None:
        return False
    path = os.path.normpath(raw)
    resolved, written = _roots(spec)
    return any(
        path == root or path.startswith(root.rstrip(os.sep) + os.sep)
        for root in (*written, *map(str, resolved))
    )


def local_media_type(path: Path) -> str:
    return LOCAL_TYPES.get(path.suffix.lower(), "application/octet-stream")


def top_resolution(master: str) -> int | None:
    """Height of the best variant a master playlist lists; None for a media playlist."""
    return max((int(h) for h in RESOLUTION.findall(master)), default=None)


ATTRIBUTE = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')


def audio_tracks(master: str) -> list[tuple[str, str]]:
    """(name, language) of each separate audio track a master playlist lists, in order and
    without repeats. Some hosts list the same track once per quality; the player offers it once."""
    found: list[tuple[str, str]] = []
    for line in master.splitlines():
        if not line.startswith("#EXT-X-MEDIA:"):
            continue
        attrs = {k: v.strip('"') for k, v in ATTRIBUTE.findall(line[len("#EXT-X-MEDIA:") :])}
        if attrs.get("TYPE") != "AUDIO":
            continue
        track = (attrs.get("NAME", ""), attrs.get("LANGUAGE", ""))
        if track not in found:
            found.append(track)
    return found


def rewrite_playlist(text: str, base_url: str, referer: str, viewer: "Viewer | str") -> str:
    local = base_url.startswith("file:")

    def link(target: str) -> str:
        # Inline data (keys, init sections) needs no fetching and must reach the player as is.
        if target.startswith("data:"):
            return target
        absolute = urljoin(base_url, target)
        # A library playlist may only point inside the library, a remote one only at the
        # internet. Refused URLs are blanked, so the player just fails to load that part.
        allowed = in_library(absolute) if local else looks_public(absolute)
        return signed_link(absolute, referer, viewer) if allowed else ""

    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append(line)
        elif stripped.startswith("#"):
            # Tags like EXT-X-MEDIA, EXT-X-KEY and EXT-X-MAP carry URIs in attributes.
            lines.append(URI_ATTR.sub(lambda m: f'URI="{link(m.group(1))}"', line))
        elif target := link(stripped):
            lines.append(target)
    return "\n".join(lines) + "\n"


# A subtitle file covers the whole episode; HLS wants it as a playlist of one long segment.
SUBTITLE_SPAN = 4 * 3600


def _attr(value: str) -> str:
    return re.sub(r'["\r\n,]', " ", value).strip()


def add_subtitles(
    master: str, tracks: list[tuple[str, str, str]], referer: str, viewer: "Viewer | str"
) -> str:
    """Lists the (language, label, WebVTT url) subtitles in an already rewritten master playlist,
    so a player that plays the stream natively (AirPlay hands it to the TV, which fetches the
    playlist itself) gets them without any help from our page. A media playlist has nowhere to
    attach them and is returned as is."""
    lines = master.splitlines()
    if not tracks or not any(line.startswith("#EXT-X-STREAM-INF:") for line in lines):
        return master
    media = [
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",'
        f'NAME="{_attr(label) or _attr(lang)}",LANGUAGE="{_attr(lang)}",DEFAULT=NO,AUTOSELECT=NO,'
        f'URI="{signed_link(url, referer, viewer, "subpl")}"'
        for lang, label, url in tracks
    ]
    out: list[str] = []
    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:") and "SUBTITLES=" not in line:
            line += ',SUBTITLES="subs"'
        out.append(line)
        if line.startswith("#EXTM3U"):
            out.extend(media)
    return "\n".join(out) + "\n"


def subtitle_playlist(url: str, referer: str, viewer: "Viewer | str") -> str:
    return (
        "#EXTM3U\n#EXT-X-VERSION:3\n"
        f"#EXT-X-TARGETDURATION:{SUBTITLE_SPAN}\n#EXT-X-PLAYLIST-TYPE:VOD\n"
        f"#EXTINF:{SUBTITLE_SPAN}.0,\n{signed_link(url, referer, viewer, 'sub')}\n#EXT-X-ENDLIST\n"
    )
