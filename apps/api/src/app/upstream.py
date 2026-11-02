"""Fetching from third-party video hosts, shared by the HLS proxy and the stream checks."""

from urllib.parse import urljoin

import httpx

from app import hls
from app.errors import ApiError

PLAYLIST_TIMEOUT = httpx.Timeout(15.0)
# Segments can be slow to start, but a host that goes quiet must not hold the connection.
SEGMENT_TIMEOUT = httpx.Timeout(30.0, read=60.0)


async def open_upstream(
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


async def read_capped(upstream: httpx.Response) -> str:
    """The whole body of a playlist, refusing anything larger than a playlist can be.
    Network errors are left to the caller; the response is always closed."""
    chunks: list[bytes] = []
    size = 0
    try:
        async for chunk in upstream.aiter_bytes():
            size += len(chunk)
            if size > hls.MAX_PLAYLIST_BYTES:
                raise ApiError(502, "upstream_failed", "Playlist from the video host is too large")
            chunks.append(chunk)
    finally:
        await upstream.aclose()
    return b"".join(chunks).decode("utf-8", errors="replace")


async def read_playlist(upstream: httpx.Response) -> str:
    """`read_capped`, with a host that stops answering mid-way as a clean 502."""
    try:
        return await read_capped(upstream)
    except (httpx.HTTPError, TimeoutError) as exc:
        raise ApiError(502, "upstream_failed", "The video host did not answer") from exc
