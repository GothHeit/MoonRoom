import httpx
import pytest
import respx

from app import hls
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.routers import watch
from app.source_hints import SOURCE_FAILURE_TTL, SOURCE_HINT_TTL
from app.sources.base import EpisodeList, Skip, Stream
from tests.conftest import make_user

VIDEO_URL = "https://video.example/ep1.mp4"


@pytest.fixture(autouse=True)
def streams_alive(monkeypatch):
    # The liveness check has its own tests next to the HLS proxy.
    async def alive(http, stream):
        return True

    monkeypatch.setattr(watch, "_stream_alive", alive)


class FakeSource:
    name = "fake"

    async def episodes(self, anime, lang):
        return EpisodeList(episodes=[1, 2, 3], source_title=anime["title"])

    async def stream(self, anime, episode, lang):
        if episode > 3:
            return None
        return Stream(
            url=VIDEO_URL,
            kind="mp4",
            resolution=1080,
            upstream_headers={"Referer": "https://source.example"},
        )


def mock_details():
    respx.get(f"{API_BASE}/anime/21").mock(
        return_value=httpx.Response(200, json={"id": 21, "title": "One Piece"})
    )


@respx.mock
async def test_episodes_and_playback_through_proxy(client, session):
    fastapi_app.state.sources = {"fake": FakeSource()}
    _, headers = await make_user(session, "kafka")
    mock_details()

    eps = await client.get("/watch/fake/21/episodes", headers=headers)
    assert eps.json() == {
        "source": "fake",
        "source_title": "One Piece",
        "episodes": [1, 2, 3],
        "thumbnails": {},
    }

    play = await client.post("/watch/fake/21/episodes/1/play", headers=headers)
    assert play.status_code == 200
    url = play.json()["url"]
    assert url.startswith("/watch/video?token=")

    upstream = respx.get(VIDEO_URL).mock(
        return_value=httpx.Response(
            206, content=b"0123", headers={"content-range": "bytes 0-3/100", "content-length": "4"}
        )
    )
    # The token names the episode; the same user's bearer token must come with it.
    video = await client.get(url, headers={**headers, "Range": "bytes=0-3"})
    assert video.status_code == 206
    assert video.content == b"0123"
    assert video.headers["content-range"] == "bytes 0-3/100"
    sent = upstream.calls.last.request
    assert sent.headers["range"] == "bytes=0-3"
    assert sent.headers["referer"] == "https://source.example"


async def test_video_proxy_rejects_missing_or_bad_tokens(client, session):
    fastapi_app.state.sources = {"fake": FakeSource()}
    assert (await client.get("/watch/video")).status_code == 422
    r = await client.get("/watch/video", params={"token": "garbage"})
    assert r.status_code == 401


async def test_access_token_cannot_be_used_as_playback_token(client, session):
    fastapi_app.state.sources = {"fake": FakeSource()}
    _, headers = await make_user(session, "kafka")
    access = headers["Authorization"].removeprefix("Bearer ")
    assert (await client.get("/watch/video", params={"token": access})).status_code == 401


@respx.mock
async def test_unknown_source_and_missing_episode(client, session):
    fastapi_app.state.sources = {"fake": FakeSource()}
    _, headers = await make_user(session, "kafka")
    mock_details()
    assert (await client.get("/watch/nope/21/episodes", headers=headers)).status_code == 404
    r = await client.post("/watch/fake/21/episodes/9/play", headers=headers)
    assert r.json()["error"]["code"] == "not_available"


async def test_no_sources_enabled_by_default(client, session):
    _, headers = await make_user(session, "kafka")
    assert (await client.get("/watch/sources", headers=headers)).json() == []


@respx.mock
async def test_video_proxy_passes_range_not_satisfiable_through(client, session):
    fastapi_app.state.sources = {"fake": FakeSource()}
    _, headers = await make_user(session, "kafka")
    mock_details()
    url = (await client.post("/watch/fake/21/episodes/1/play", headers=headers)).json()["url"]

    respx.get(VIDEO_URL).mock(
        return_value=httpx.Response(416, headers={"content-range": "bytes */100"})
    )
    video = await client.get(url, headers={**headers, "Range": "bytes=500-"})
    assert video.status_code == 416
    assert video.headers["content-range"] == "bytes */100"

    respx.get(VIDEO_URL).mock(return_value=httpx.Response(403))
    assert (await client.get(url, headers=headers)).status_code == 502


@respx.mock
async def test_nsfw_titles_cannot_be_listed_or_played_with_nsfw_off(client, session):
    fastapi_app.state.sources = {"fake": FakeSource()}
    _, normal = await make_user(session, "kafka")
    _, nsfw = await make_user(session, "friend", nsfw=True)
    respx.get(f"{API_BASE}/anime/21").mock(
        return_value=httpx.Response(200, json={"id": 21, "title": "Adult", "rating": "rx"})
    )
    r = await client.get("/watch/fake/21/episodes", headers=normal)
    assert r.json()["error"]["code"] == "anime_not_found"
    r = await client.post("/watch/fake/21/episodes/1/play", headers=normal)
    assert r.status_code == 404
    assert (await client.get("/watch/fake/21/episodes", headers=nsfw)).status_code == 200


class OtherSeason:
    """A fallback that matched a different season: same numbers, another show."""

    name = "other"

    def __init__(self, count: int):
        self.count = count
        self.streamed = False

    async def episodes(self, anime, lang):
        return EpisodeList(episodes=list(range(1, self.count + 1)), source_title="Other")

    async def stream(self, anime, episode, lang):
        self.streamed = True
        return Stream(url=VIDEO_URL, kind="mp4", resolution=720, upstream_headers={})


class Gone(FakeSource):
    async def stream(self, anime, episode, lang):
        return None


@respx.mock
async def test_fallback_needs_a_matching_episode_list_and_is_reported(client, session):
    _, headers = await make_user(session, "kafka")
    mock_details()

    mismatched = OtherSeason(12)
    fastapi_app.state.sources = {"fake": Gone(), "other": mismatched}
    r = await client.post("/watch/fake/21/episodes/2/play", headers=headers)
    assert r.json()["error"]["code"] == "not_available"
    assert not mismatched.streamed

    fastapi_app.state.sources = {"fake": Gone(), "other": OtherSeason(3)}
    r = await client.post("/watch/fake/21/episodes/2/play", headers=headers)
    assert r.status_code == 200
    assert r.json()["source"] == "other"


class Thumbs(FakeSource):
    async def episodes(self, anime, lang):
        return EpisodeList([1, 2], "x", {2: "https://img.example/2.jpg"})

    async def stream(self, anime, episode, lang):
        return Stream(
            url=VIDEO_URL,
            kind="mp4",
            resolution=1080,
            upstream_headers={},
            skips=(Skip("intro", 30, 120),),
            default_audio="jpn",
        )


@respx.mock
async def test_thumbnails_skips_and_audio_reach_the_player(client, session, monkeypatch):
    async def resolve(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    fastapi_app.state.sources = {"fake": Thumbs()}
    _, headers = await make_user(session, "kafka")
    mock_details()
    eps = (await client.get("/watch/fake/21/episodes", headers=headers)).json()
    assert list(eps["thumbnails"]) == ["2"]
    assert eps["thumbnails"]["2"].startswith("/watch/hls?u=https%3A%2F%2Fimg.example")
    assert "&k=img&" in eps["thumbnails"]["2"]

    respx.get("https://img.example/2.jpg").mock(
        return_value=httpx.Response(200, content=b"jpg", headers={"content-type": "image/jpeg"})
    )
    img = await client.get(eps["thumbnails"]["2"], headers=headers)
    assert img.headers["content-type"] == "image/jpeg"

    play = (await client.post("/watch/fake/21/episodes/1/play", headers=headers)).json()
    assert play["skips"] == [{"kind": "intro", "start": 30, "end": 120}]
    assert play["default_audio"] == "jpn"


async def test_player_preferences_default_then_saved_per_user(client, session):
    _, headers = await make_user(session, "kafka")
    _, other = await make_user(session, "friend")
    r = await client.get("/watch/preferences", headers=headers)
    assert r.json() == {
        "subtitle_size": "medium",
        "subtitle_color": "white",
        "subtitle_background": "outline",
        "subtitle_position": "bottom",
        "audio_lang": "original",
        "prefer_soft_subs": True,
        "max_resolution": None,
    }
    body = {
        "subtitle_size": "large",
        "subtitle_color": "yellow",
        "subtitle_background": "solid",
        "subtitle_position": "raised",
    }
    saved = {**body, "audio_lang": "original", "prefer_soft_subs": True, "max_resolution": None}
    assert (await client.put("/watch/preferences", json=body, headers=headers)).json() == saved
    assert (await client.get("/watch/preferences", headers=headers)).json() == saved
    assert (await client.get("/watch/preferences", headers=other)).json()[
        "subtitle_size"
    ] == "medium"
    bad = await client.put(
        "/watch/preferences", json={**body, "subtitle_color": "red"}, headers=headers
    )
    assert bad.status_code == 422
    assert (await client.get("/watch/preferences")).status_code == 401


class DubOnlyEpisodeTwo:
    """Has every episode subbed but only episode 2 dubbed, and lists no dub at all for 9."""

    name = "dubs"

    async def episodes(self, anime, lang):
        return EpisodeList(episodes=[1, 2, 3] if lang == "sub" else [2], source_title="x")

    async def stream(self, anime, episode, lang):
        return None


class Broken:
    async def episodes(self, anime, lang):
        raise RuntimeError("down")

    async def stream(self, anime, episode, lang):
        raise RuntimeError("down")


@respx.mock
async def test_options_list_each_source_and_lang_with_the_episode(client, session):
    fastapi_app.state.sources = {
        "fake": FakeSource(),
        "dubs": DubOnlyEpisodeTwo(),
        "broken": Broken(),
    }
    _, headers = await make_user(session, "kafka")
    mock_details()

    two = await client.get("/watch/options/21/2", headers=headers)
    assert two.json() == [
        {"source": "auto", "lang": "sub"},
        {"source": "fake", "lang": "sub"},
        {"source": "fake", "lang": "dub"},
        {"source": "dubs", "lang": "sub"},
        {"source": "dubs", "lang": "dub"},
    ]
    three = await client.get("/watch/options/21/3", headers=headers)
    assert {"source": "dubs", "lang": "dub"} not in three.json()
    assert (await client.get("/watch/options/21/9", headers=headers)).json() == []


class Counting(FakeSource):
    def __init__(self):
        self.calls = 0

    async def episodes(self, anime, lang):
        self.calls += 1
        return await super().episodes(anime, lang)


@respx.mock
async def test_options_are_kept_per_episode_and_skip_sources_without_the_title(client, session):
    fake, absent = Counting(), Counting()
    fastapi_app.state.sources = {"fake": fake, "absent": absent}
    _, headers = await make_user(session, "kafka")
    mock_details()
    # The title page found that "absent" has no subbed episodes of this title.
    fastapi_app.state.source_hints[("absent", 21)] = (False, SOURCE_HINT_TTL)

    first = await client.get("/watch/options/21/2", headers=headers)
    # Its dub is still asked for: the title page never looked at dubs.
    assert first.json() == [
        {"source": "auto", "lang": "sub"},
        {"source": "fake", "lang": "sub"},
        {"source": "fake", "lang": "dub"},
        {"source": "absent", "lang": "dub"},
    ]
    assert (fake.calls, absent.calls) == (2, 1)
    again = await client.get("/watch/options/21/2", headers=headers)
    assert again.json() == first.json()
    assert (fake.calls, absent.calls) == (2, 1)


@respx.mock
async def test_options_still_ask_a_source_that_only_failed_on_the_title_page(client, session):
    fake = Counting()
    fastapi_app.state.sources = {"fake": fake}
    _, headers = await make_user(session, "kafka")
    mock_details()
    # A timeout on the title page says nothing about the title.
    fastapi_app.state.source_hints[("fake", 21)] = (False, SOURCE_FAILURE_TTL)

    r = await client.get("/watch/options/21/2", headers=headers)
    assert [o["source"] for o in r.json()] == ["auto", "fake", "fake"]


@respx.mock
async def test_a_picked_source_is_remembered_per_user_and_title(client, session):
    fastapi_app.state.sources = {"fake": FakeSource(), "dubs": DubOnlyEpisodeTwo()}
    _, headers = await make_user(session, "kafka")
    _, other = await make_user(session, "friend")
    mock_details()

    first = await client.get("/anime/21/sources", headers=headers)
    assert first.json()["sources"] == ["fake", "dubs"]
    assert first.json()["choice"] is None
    assert first.json()["stream"] == {"source": "auto", "lang": "sub"}
    assert first.json()["listing"]["episodes"] == [1, 2, 3]

    for lang in ("sub", "dub"):
        r = await client.put(
            "/watch/choice/21", json={"source": "dubs", "lang": lang}, headers=headers
        )
        assert r.status_code == 204
    picked = await client.get("/anime/21/sources", headers=headers)
    assert picked.json()["choice"] == {"source": "dubs", "lang": "dub"}
    assert picked.json()["stream"] == {"source": "dubs", "lang": "dub"}
    assert picked.json()["listing"]["source"] == "dubs"
    assert (await client.get("/anime/21/sources", headers=other)).json()["choice"] is None

    unknown = await client.put(
        "/watch/choice/21", json={"source": "nope", "lang": "sub"}, headers=headers
    )
    assert unknown.status_code == 404
    zero = await client.put(
        "/watch/choice/0", json={"source": "fake", "lang": "sub"}, headers=headers
    )
    assert zero.status_code == 422

    # A choice whose source was turned off is ignored rather than sent to a dead source.
    fastapi_app.state.sources = {"fake": FakeSource()}
    fastapi_app.state.source_hints.clear()
    assert (await client.get("/anime/21/sources", headers=headers)).json()["choice"] is None


class Flaky(FakeSource):
    """A scraper whose site is down, but only after the playback token was issued."""

    down = False

    async def episodes(self, anime, lang):
        if self.down:
            raise httpx.ReadTimeout("slow")
        return await super().episodes(anime, lang)

    async def stream(self, anime, episode, lang):
        if self.down:
            raise httpx.HTTPStatusError(
                "503", request=httpx.Request("GET", "https://x"), response=httpx.Response(503)
            )
        return await super().stream(anime, episode, lang)


@respx.mock
async def test_source_and_video_host_failures_answer_upstream_failed(client, session):
    source = Flaky()
    fastapi_app.state.sources = {"fake": source}
    _, headers = await make_user(session, "kafka")
    mock_details()
    play = await client.post("/watch/fake/21/episodes/1/play", headers=headers)
    url = play.json()["url"]

    source.down = True
    eps = await client.get("/watch/fake/21/episodes", headers=headers)
    assert (eps.status_code, eps.json()["error"]["code"]) == (502, "upstream_failed")
    video = await client.get(url, headers=headers)
    assert (video.status_code, video.json()["error"]["code"]) == (502, "upstream_failed")

    source.down = False
    respx.get(VIDEO_URL).mock(side_effect=httpx.ConnectTimeout("stalled"))
    video = await client.get(url, headers=headers)
    assert (video.status_code, video.json()["error"]["code"]) == (502, "upstream_failed")
