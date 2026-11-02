import httpx
import pytest
import respx
from sqlalchemy import select

from app import hls
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.models import SourceChoice
from app.probes import StreamProbes
from app.sources.base import EpisodeList, Stream, Subtitle, Traits
from tests.conftest import make_user, viewer_of


class Source:
    def __init__(self, name, subs, *, dub_audio=None, episodes=(1, 2, 3)):
        self.name = name
        self._subs = subs
        self._dub = dub_audio
        self._episodes = list(episodes)
        self.traits = Traits(dub_audio_lang=dub_audio)

    async def episodes(self, anime, lang):
        if lang == "dub" and not self._dub:
            return None
        return EpisodeList(self._episodes, anime["title"], {1: f"https://img.example/{self.name}"})

    async def stream(self, anime, episode, lang):
        if lang == "dub" and not self._dub:
            return None
        subs = (
            () if lang == "dub" else tuple(Subtitle(s, s, f"https://s/{s}.vtt") for s in self._subs)
        )
        return Stream(f"https://{self.name}.example/{lang}.mp4", "mp4", 1080, {}, subtitles=subs)


@pytest.fixture(autouse=True)
def streams_alive(monkeypatch):
    async def alive(self, stream):
        return True

    monkeypatch.setattr(StreamProbes, "check", alive)


def mock_details():
    respx.get(f"{API_BASE}/anime/21").mock(
        return_value=httpx.Response(200, json={"id": 21, "title": "One Piece", "num_episodes": 3})
    )


def use(*sources):
    fastapi_app.state.sources = {s.name: s for s in sources}


@respx.mock
async def test_auto_plays_the_best_version_for_the_viewer(client, session) -> None:
    use(Source("english", ["en"]), Source("portuguese", ["pt-BR"]))
    _, headers = await make_user(session, "kafka")
    mock_details()
    play = await client.post("/watch/auto/21/episodes/1/play", headers=headers)
    assert play.status_code == 200
    body = play.json()
    assert (body["source"], body["lang"]) == ("portuguese", "sub")
    # The link works like any other playback link, naming the source that was picked.
    upstream = respx.get("https://portuguese.example/sub.mp4").mock(
        return_value=httpx.Response(200, content=b"x", headers={"content-length": "1"})
    )
    assert (await client.get(body["url"], headers=headers)).status_code == 200
    assert upstream.called


@respx.mock
async def test_saved_dub_preference_picks_the_dub(client, session) -> None:
    use(Source("subs", ["pt-BR"]), Source("dubs", ["en"], dub_audio="pt-BR"))
    _, headers = await make_user(session, "kafka")
    mock_details()
    saved = await client.put("/watch/preferences", json={"audio_lang": "pt-BR"}, headers=headers)
    assert saved.status_code == 200 and saved.json()["audio_lang"] == "pt"
    body = (await client.post("/watch/auto/21/episodes/1/play", headers=headers)).json()
    assert (body["source"], body["lang"]) == ("dubs", "dub")


@respx.mock
async def test_resolution_limit_is_honoured(client, session) -> None:
    class Low(Source):
        async def stream(self, anime, episode, lang):
            found = await super().stream(anime, episode, lang)
            assert found
            return Stream(found.url, "mp4", 480, {}, subtitles=found.subtitles)

    use(Source("sharp", ["pt-BR"]), Low("light", ["pt-BR"]))
    _, headers = await make_user(session, "kafka")
    mock_details()
    first = (await client.post("/watch/auto/21/episodes/1/play", headers=headers)).json()
    assert first["source"] == "sharp"
    await client.put("/watch/preferences", json={"max_resolution": 480}, headers=headers)
    second = (await client.post("/watch/auto/21/episodes/1/play", headers=headers)).json()
    assert second["source"] == "light"
    # The player keeps automatic quality within the limit too.
    assert first["max_resolution"] is None and second["max_resolution"] == 480


@respx.mock
async def test_auto_with_nothing_to_play_is_not_available(client, session) -> None:
    use(Source("only", ["en"]))
    _, headers = await make_user(session, "kafka")
    mock_details()
    r = await client.post("/watch/auto/21/episodes/9/play", headers=headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_available"


@respx.mock
async def test_auto_episodes_are_every_source_s_and_the_menu_offers_auto(client, session) -> None:
    use(Source("a", ["en"], episodes=(1, 2)), Source("b", ["en"], episodes=(2, 3)))
    _, headers = await make_user(session, "kafka")
    mock_details()
    eps = (await client.get("/watch/auto/21/episodes", headers=headers)).json()
    assert eps["episodes"] == [1, 2, 3] and eps["source"] == "auto"
    menu = (await client.get("/watch/options/21/2", headers=headers)).json()
    assert menu[0] == {"source": "auto", "lang": "sub"}
    assert {"source": "a", "lang": "sub"} in menu and {"source": "b", "lang": "sub"} in menu


@respx.mock
async def test_picking_auto_clears_a_manual_choice(client, session) -> None:
    use(Source("a", ["en"]))
    user, headers = await make_user(session, "kafka")
    manual = await client.put(
        "/watch/choice/21", json={"source": "a", "lang": "sub"}, headers=headers
    )
    assert manual.status_code == 204
    assert (await session.scalars(select(SourceChoice))).all()
    back = await client.put(
        "/watch/choice/21", json={"source": "auto", "lang": "sub"}, headers=headers
    )
    assert back.status_code == 204
    session.expire_all()
    assert not (await session.scalars(select(SourceChoice))).all()
    unknown = await client.put(
        "/watch/choice/21", json={"source": "nope", "lang": "sub"}, headers=headers
    )
    assert unknown.status_code == 404


async def test_playback_preferences_validate_and_update_partially(client, session) -> None:
    _, headers = await make_user(session, "kafka")
    await client.put(
        "/watch/preferences", json={"audio_lang": "pt-BR", "max_resolution": 720}, headers=headers
    )
    # The subtitle look is saved by another screen and must not reset these.
    after = await client.put("/watch/preferences", json={"subtitle_size": "large"}, headers=headers)
    assert after.json()["audio_lang"] == "pt" and after.json()["max_resolution"] == 720
    assert after.json()["subtitle_size"] == "large"
    cleared = await client.put("/watch/preferences", json={"max_resolution": None}, headers=headers)
    assert cleared.json()["max_resolution"] is None
    # Players spell languages many ways; they are stored as the dub's base language.
    for spelled, stored in (("por", "pt"), ("pt-BR", "pt"), ("jpn", "original"), ("EN", "en")):
        r = await client.put("/watch/preferences", json={"audio_lang": spelled}, headers=headers)
        assert r.json()["audio_lang"] == stored
    for bad in ({"audio_lang": "klingon!"}, {"max_resolution": 999}):
        assert (
            await client.put("/watch/preferences", json=bad, headers=headers)
        ).status_code == 422
    got = await client.get("/watch/preferences", headers=headers)
    assert got.json()["audio_lang"] == "en" and got.json()["prefer_soft_subs"] is True


@respx.mock
async def test_styled_only_subtitles_are_served_as_webvtt_too(client, session, monkeypatch) -> None:
    async def resolve(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    _, headers = await make_user(session, "kafka")
    url = "https://host.example/en.ass"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            text="[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,Hello\n",
        )
    )
    link = "/watch/" + hls.signed_link(url, "", viewer_of(headers), "sub")
    reply = await client.get(link, headers=headers)
    assert reply.status_code == 200
    assert reply.headers["content-type"].startswith("text/vtt")
    assert "00:00:01.000 --> 00:00:02.000\nHello" in reply.text


@respx.mock
async def test_manual_playback_starts_on_the_wanted_dub_track(client, session) -> None:
    master = (
        "#EXTM3U\n"
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="jpn",URI="j.m3u8"\n'
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Portuguese",LANGUAGE="por",URI="p.m3u8"\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="a"\nv.m3u8\n'
    )

    class Multi(Source):
        async def stream(self, anime, episode, lang):
            return Stream("https://multi.example/m.m3u8", "hls", None, {})

    def peek(self, url, referer):
        from app.probes import Master

        return Master(url, master)

    use(Multi("multi", ["en"]))
    _, headers = await make_user(session, "kafka")
    mock_details()
    from pytest import MonkeyPatch

    with MonkeyPatch.context() as patch:
        patch.setattr(StreamProbes, "peek", peek)
        first = (await client.post("/watch/multi/21/episodes/1/play", headers=headers)).json()
        assert first["default_audio"] is None and first["resolution"] == 1080
        await client.put("/watch/preferences", json={"audio_lang": "pt"}, headers=headers)
        second = (await client.post("/watch/multi/21/episodes/1/play", headers=headers)).json()
        assert second["default_audio"] == "por"
