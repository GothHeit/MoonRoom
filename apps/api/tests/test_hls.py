import asyncio
import time

import httpx
import pytest
import respx

from app import hls
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.probes import StreamProbes
from app.sources.base import EpisodeList, Stream, Subtitle
from tests.conftest import make_user, viewer_of

MASTER = "https://host.example/p/master.m3u8"
MEDIA = (
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\n1080/index.m3u8\n"
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/a.m3u8"\n'
)


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    async def resolve(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    hls._public_hosts.clear()


VIEWER = "4b1d6a0e-1111-4c2b-9a8e-000000000001"


def test_rewrite_resolves_relative_urls_and_signs_them():
    out = hls.rewrite_playlist(MEDIA, MASTER, "https://ref.example/", VIEWER)
    lines = out.splitlines()
    assert lines[2].startswith("hls?u=https%3A%2F%2Fhost.example%2Fp%2F1080%2Findex.m3u8")
    assert 'URI="hls?u=https%3A%2F%2Fhost.example%2Fp%2Faudio%2Fa.m3u8' in lines[3]


def test_verify_rejects_tampering_expiry_and_other_viewers():
    link = hls.signed_link("https://a.example/x", "https://r/", VIEWER, "sub")
    q = dict(p.split("=") for p in link.split("?")[1].split("&"))
    expires = int(q["e"])
    assert q["k"] == "sub"
    assert hls.verify_link("https://a.example/x", "https://r/", "sub", VIEWER, expires, q["s"])
    assert not hls.verify_link(
        "https://evil.example/x", "https://r/", "sub", VIEWER, expires, q["s"]
    )
    assert not hls.verify_link(
        "https://a.example/x", "https://other/", "sub", VIEWER, expires, q["s"]
    )
    assert not hls.verify_link("https://a.example/x", "https://r/", "", VIEWER, expires, q["s"])
    assert not hls.verify_link(
        "https://a.example/x", "https://r/", "sub", "someone", expires, q["s"]
    )
    assert expires <= time.time() + hls.SEGMENT_LIFETIME
    old = int(time.time()) - 1
    mac = hls._mac("https://a.example/x", "https://r/", "", hls.Viewer(VIEWER), old)
    assert not hls.verify_link("https://a.example/x", "https://r/", "", VIEWER, old, mac)


def test_data_uris_are_left_alone():
    text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"\nseg.ts\n'
    out = hls.rewrite_playlist(text, MASTER, "", VIEWER)
    assert 'URI="data:text/plain;base64,AAAA"' in out
    assert out.splitlines()[2].startswith("hls?u=")


@pytest.mark.parametrize(
    ("url", "kind", "upstream", "expected"),
    [
        ("https://h/s.ts.jpg", "", "image/jpeg", "video/mp2t"),
        ("https://h/s.m4s", "", "", "video/mp4"),
        ("https://h/a.aac", "", "audio/aac", "audio/aac"),
        ("https://h/subs/x", "sub", "application/octet-stream", "text/vtt"),
        ("https://h/x.vtt?t=1", "", "", "text/vtt"),
        ("https://h/p.jpg", "img", "image/webp", "image/webp"),
        ("https://h/p", "img", "text/html", "image/jpeg"),
        ("https://h/p.svg", "img", "image/svg+xml", "image/jpeg"),
    ],
)
def test_media_type(url, kind, upstream, expected):
    assert hls.media_type(url, kind, upstream) == expected


async def test_dns_verdicts_are_cached(monkeypatch):
    calls = []

    async def resolve(host):
        calls.append(host)
        return ["93.184.216.34"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    assert await hls.is_public_target("https://seg.example/1.ts")
    assert await hls.is_public_target("https://seg.example/2.ts")
    assert calls == ["seg.example"]


class HlsSource:
    name = "hlsfake"

    async def episodes(self, anime, lang):
        return EpisodeList(episodes=[1], source_title="x")

    async def stream(self, anime, episode, lang):
        return Stream(
            MASTER,
            "hls",
            1080,
            {"Referer": "https://ref.example/"},
            (Subtitle("pt-BR", "Portuguese", "https://subs.example/pt.vtt"),),
        )


class BrokenSource:
    name = "broken"

    async def episodes(self, anime, lang):
        raise RuntimeError("down")

    async def stream(self, anime, episode, lang):
        raise RuntimeError("down")


class EmptySource(BrokenSource):
    async def stream(self, anime, episode, lang):
        return None


def mock_details():
    respx.get(f"{API_BASE}/anime/21").mock(
        return_value=httpx.Response(200, json={"id": 21, "title": "One Piece"})
    )


@respx.mock
async def test_hls_playback_falls_back_and_proxies_with_referer(client, session):
    fastapi_app.state.sources = {
        "broken": BrokenSource(),
        "empty": EmptySource(),
        "ok": HlsSource(),
    }
    _, headers = await make_user(session, "kafka")
    mock_details()

    master = respx.get(MASTER).mock(return_value=httpx.Response(200, text=MEDIA))
    play = await client.post("/watch/broken/21/episodes/1/play", headers=headers)
    assert play.status_code == 200
    assert play.json()["kind"] == "hls"
    url = play.json()["url"]
    assert url.startswith("/watch/hls?token=")
    [track] = play.json()["subtitles"]
    assert (track["lang"], track["label"]) == ("pt-BR", "Portuguese")
    vtt = respx.get("https://subs.example/pt.vtt").mock(
        return_value=httpx.Response(200, text="WEBVTT\n\n", headers={"content-type": "text/vtt"})
    )
    subs = await client.get(track["url"], headers=headers)
    assert subs.text.startswith("WEBVTT")
    assert subs.headers["content-type"].startswith("text/vtt")
    assert vtt.calls.last.request.headers["referer"] == "https://ref.example/"

    seg = respx.get("https://seg.example/s0.ts.jpg").mock(
        return_value=httpx.Response(
            200, content=b"\x47data", headers={"content-type": "image/jpeg"}
        )
    )
    r = await client.get(url, headers=headers)
    assert r.status_code == 200
    assert master.calls.last.request.headers["referer"] == "https://ref.example/"
    variant = r.text.splitlines()[2]

    respx.get("https://host.example/p/1080/index.m3u8").mock(
        return_value=httpx.Response(
            200, text="#EXTM3U\n#EXTINF:5,\nhttps://seg.example/s0.ts.jpg\n"
        )
    )
    v = await client.get(f"/watch/{variant}", headers=headers)
    segment_link = v.text.splitlines()[-1]
    s = await client.get(f"/watch/{segment_link}", headers=headers)
    assert s.content == b"\x47data"
    assert s.headers["content-type"].startswith("video/mp2t")
    assert seg.calls.last.request.headers["referer"] == "https://ref.example/"
    assert seg.calls.last.request.headers["origin"] == "https://ref.example"
    assert play.json()["source"] == "ok"

    assert s.headers["x-content-type-options"] == "nosniff"

    # Links name their viewer and session, so a TV or AirPlay receiver plays them with no
    # login header; changing the viewer, or signing the session out, ends them.
    assert (await client.get(f"/watch/{segment_link}")).status_code == 200
    assert (await client.get(url)).status_code == 200
    assert (await client.get(f"/watch/{segment_link}".replace("&v=", "&v=x"))).status_code == 403
    assert (await client.get(f"/watch/{segment_link}".replace("&i=", "&i=0"))).status_code == 403
    await client.delete("/me/sessions", headers=headers)
    assert (await client.get(f"/watch/{segment_link}")).status_code == 403
    assert (await client.get(url)).status_code == 403


async def test_hls_proxy_refuses_unsigned_urls(client, session):
    fastapi_app.state.sources = {"ok": HlsSource()}
    _, headers = await make_user(session, "kafka")
    r = await client.get(
        "/watch/hls",
        params={"u": "http://169.254.169.254/", "r": "", "e": 9999999999, "s": "0" * 32},
    )
    assert r.status_code == 403
    # A forged signature is refused with or without a login.
    r = await client.get(
        "/watch/hls",
        params={"u": "http://169.254.169.254/", "r": "", "e": 9999999999, "s": "0" * 32},
        headers=headers,
    )
    assert r.status_code == 403


@respx.mock
async def test_all_sources_failing_is_a_clean_error_not_a_crash(client, session):
    fastapi_app.state.sources = {"broken": BrokenSource()}
    _, headers = await make_user(session, "kafka")
    mock_details()
    r = await client.post("/watch/broken/21/episodes/1/play", headers=headers)
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "upstream_failed"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/x",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.5/x.ts",
        "http://[::1]/x",
        "http://db:5432/x",
        "http://localhost/x",
        "http://service.internal/x",
        "file:///etc/passwd",
        "ftp://host.example/x",
    ],
)
def test_internal_and_odd_urls_are_never_signed(url):
    assert not hls.looks_public(url)
    out = hls.rewrite_playlist(f"#EXTM3U\n#EXTINF:5,\n{url}\n", MASTER, "https://r/", VIEWER)
    assert "hls?u=" not in out


def test_public_urls_pass():
    assert hls.looks_public("https://hls1.drama1.cfd/s/seg.ts.jpg")
    assert hls.looks_public("http://93.184.216.34/x")


async def test_names_resolving_to_private_addresses_are_refused(monkeypatch):
    async def resolve(host):
        return ["93.184.216.34", "10.0.0.7"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    assert not await hls.is_public_target("https://rebind.example/x")


def signed(url: str, viewer: hls.Viewer) -> str:
    return "/watch/" + hls.signed_link(url, "https://ref.example/", viewer)


@respx.mock
async def test_proxy_refuses_signed_internal_urls_and_internal_redirects(client, session):
    fastapi_app.state.sources = {"ok": HlsSource()}
    user, headers = await make_user(session, "kafka")
    internal = respx.get("http://127.0.0.1:8000/secret").mock(return_value=httpx.Response(200))

    direct = await client.get(
        signed("http://127.0.0.1:8000/secret", viewer_of(headers)), headers=headers
    )
    assert direct.status_code == 502

    respx.get("https://host.example/redir.ts").mock(
        return_value=httpx.Response(302, headers={"location": "http://127.0.0.1:8000/secret"})
    )
    redirected = await client.get(
        signed("https://host.example/redir.ts", viewer_of(headers)), headers=headers
    )
    assert redirected.status_code == 502
    assert not internal.called


@respx.mock
async def test_proxy_follows_public_redirects_but_not_forever(client, session):
    fastapi_app.state.sources = {"ok": HlsSource()}
    user, headers = await make_user(session, "kafka")
    respx.get("https://host.example/a.ts").mock(
        return_value=httpx.Response(302, headers={"location": "https://cdn.example/a.ts"})
    )
    respx.get("https://cdn.example/a.ts").mock(return_value=httpx.Response(200, content=b"seg"))
    assert (
        await client.get(signed("https://host.example/a.ts", viewer_of(headers)), headers=headers)
    ).content == b"seg"

    respx.get("https://host.example/loop.ts").mock(
        return_value=httpx.Response(302, headers={"location": "https://host.example/loop.ts"})
    )
    assert (
        await client.get(
            signed("https://host.example/loop.ts", viewer_of(headers)), headers=headers
        )
    ).status_code == 502


@respx.mock
async def test_oversized_playlists_are_cut_off(client, session):
    fastapi_app.state.sources = {"ok": HlsSource()}
    user, headers = await make_user(session, "kafka")
    big = "#EXTM3U\n" + "#EXTINF:1,\nhttps://seg.example/s.ts\n" * 80_000
    respx.get("https://host.example/big.m3u8").mock(return_value=httpx.Response(200, text=big))
    assert len(big) > hls.MAX_PLAYLIST_BYTES
    r = await client.get(
        signed("https://host.example/big.m3u8", viewer_of(headers)), headers=headers
    )
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "upstream_failed"


class OtherHls(HlsSource):
    def __init__(self, url):
        self.url = url

    async def stream(self, anime, episode, lang):
        return Stream(self.url, "hls", None, {})


class Mp4Source(HlsSource):
    async def stream(self, anime, episode, lang):
        return Stream("https://files.example/ep1.mp4", "mp4", None, {"Referer": "https://r/"})


@respx.mock
@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(404),
        httpx.Response(410),
        httpx.Response(200, text="<html>File not found</html>"),
    ],
)
async def test_a_dead_stream_falls_through_to_the_next_source(client, session, answer):
    backup = "https://backup.example/master.m3u8"
    fastapi_app.state.sources = {"ok": HlsSource(), "backup": OtherHls(backup)}
    _, headers = await make_user(session, "kafka")
    mock_details()
    respx.get(MASTER).mock(return_value=answer)
    respx.get(backup).mock(return_value=httpx.Response(200, text="\ufeff#EXTM3U\n"))

    play = await client.post("/watch/ok/21/episodes/1/play", headers=headers)
    assert play.status_code == 200
    assert play.json()["source"] == "backup"


@respx.mock
async def test_a_stream_that_cant_be_checked_is_the_last_resort(client, session):
    backup = "https://backup.example/master.m3u8"
    fastapi_app.state.sources = {"ok": HlsSource(), "backup": OtherHls(backup)}
    _, headers = await make_user(session, "kafka")
    mock_details()
    respx.get(MASTER).mock(side_effect=httpx.ConnectTimeout("slow"))
    respx.get(backup).mock(return_value=httpx.Response(404))

    play = await client.post("/watch/ok/21/episodes/1/play", headers=headers)
    assert play.json()["source"] == "ok"

    respx.get(MASTER).mock(return_value=httpx.Response(404))
    play = await client.post("/watch/ok/21/episodes/1/play", headers=headers)
    assert play.json()["error"]["code"] == "not_available"


@respx.mock
async def test_an_mp4_is_checked_with_head(client, session):
    backup = "https://backup.example/master.m3u8"
    fastapi_app.state.sources = {"mp4": Mp4Source(), "backup": OtherHls(backup)}
    _, headers = await make_user(session, "kafka")
    mock_details()
    head = respx.head("https://files.example/ep1.mp4").mock(return_value=httpx.Response(405))
    respx.get(backup).mock(return_value=httpx.Response(200, text="#EXTM3U\n"))

    # A host that refuses HEAD may still serve the file.
    play = await client.post("/watch/mp4/21/episodes/1/play", headers=headers)
    assert play.json()["source"] == "mp4"
    assert head.calls.last.request.headers["referer"] == "https://r/"

    # Verdicts are kept for a while; a new process (or a later play) asks again.
    fastapi_app.state.probes = StreamProbes(fastapi_app.state.http)
    head.mock(return_value=httpx.Response(404))
    play = await client.post("/watch/mp4/21/episodes/1/play", headers=headers)
    assert play.json()["source"] == "backup"


@respx.mock
async def test_play_reads_the_master_once_for_check_quality_and_proxy(client, session):
    fastapi_app.state.sources = {"plain": OtherHls(MASTER)}
    _, headers = await make_user(session, "kafka")
    mock_details()
    master = respx.get(MASTER).mock(return_value=httpx.Response(200, text=MEDIA))

    play = await client.post("/watch/plain/21/episodes/1/play", headers=headers)
    # The source didn't say; the master's best variant does.
    assert play.json()["resolution"] == 1080
    r = await client.get(play.json()["url"], headers=headers)
    assert r.status_code == 200
    assert "hls?u=" in r.text.splitlines()[2]
    # Playing again soon reuses the same copy too.
    await client.post("/watch/plain/21/episodes/1/play", headers=headers)
    assert master.call_count == 1
    assert master.calls.last.request.headers.get("referer") is None


@respx.mock
async def test_a_master_gone_since_the_check_is_a_clean_error(client, session):
    fastapi_app.state.sources = {"ok": HlsSource()}
    _, headers = await make_user(session, "kafka")
    mock_details()
    respx.get(MASTER).mock(return_value=httpx.Response(200, text=MEDIA))
    url = (await client.post("/watch/ok/21/episodes/1/play", headers=headers)).json()["url"]

    fastapi_app.state.probes = StreamProbes(fastapi_app.state.http)
    respx.get(MASTER).mock(return_value=httpx.Response(404))
    r = await client.get(url, headers=headers)
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "upstream_failed"


async def test_concurrent_checks_share_one_fetch():
    calls = 0

    def answer(request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, text="#EXTM3U\n")

    transport = httpx.MockTransport(answer)
    async with httpx.AsyncClient(transport=transport) as http:
        probes = StreamProbes(http)
        stream = Stream(MASTER, "hls", None, {"Referer": "https://ref.example/"})

        assert await asyncio.gather(*(probes.check(stream) for _ in range(5))) == [True] * 5
    assert calls == 1


class CountingHls(OtherHls):
    def __init__(self, url):
        super().__init__(url)
        self.calls = 0

    async def stream(self, anime, episode, lang):
        self.calls += 1
        return await super().stream(anime, episode, lang)


@respx.mock
async def test_prepare_warms_the_stream_in_the_background(client, session):
    source = CountingHls(MASTER)
    fastapi_app.state.sources = {"plain": source}
    _, headers = await make_user(session, "kafka")
    mock_details()
    master = respx.get(MASTER).mock(return_value=httpx.Response(200, text=MEDIA))

    r = await client.post("/watch/plain/21/episodes/2/prepare", headers=headers)
    assert r.status_code == 202

    await asyncio.gather(*fastapi_app.state.watch.tasks)
    assert (source.calls, master.call_count) == (1, 1)
    # Play then finds the master already checked.
    play = await client.post("/watch/plain/21/episodes/2/play", headers=headers)
    assert play.status_code == 200
    assert master.call_count == 1

    assert (
        await client.post("/watch/nope/21/episodes/2/prepare", headers=headers)
    ).status_code == 404
    assert (await client.post("/watch/plain/21/episodes/2/prepare")).status_code == 401


@respx.mock
async def test_a_retry_checks_the_master_again(client, session):
    backup = "https://backup.example/master.m3u8"
    fastapi_app.state.sources = {"ok": HlsSource(), "backup": OtherHls(backup)}
    _, headers = await make_user(session, "kafka")
    mock_details()
    master = respx.get(MASTER).mock(return_value=httpx.Response(200, text=MEDIA))
    respx.get(backup).mock(return_value=httpx.Response(200, text="#EXTM3U\n"))
    assert (await client.post("/watch/ok/21/episodes/1/play", headers=headers)).json()[
        "source"
    ] == "ok"

    # The file went away; a plain play still trusts the recent check, a retry asks again.
    master.mock(return_value=httpx.Response(404))
    retry = await client.post(
        "/watch/ok/21/episodes/1/play", params={"fresh": True}, headers=headers
    )
    assert master.call_count == 2
    assert retry.json()["source"] == "backup"
