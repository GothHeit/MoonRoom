"""Links that stand on their own: what a TV or an AirPlay receiver is given."""

import time
import uuid
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import respx

from app import hls
from app.config import get_settings
from app.main import app as fastapi_app
from app.security import create_access_token, create_playback_token, decode_playback_token
from tests.conftest import make_user, viewer_of
from tests.test_hls import MASTER, MEDIA, HlsSource, mock_details, public_dns  # noqa: F401


def test_stream_links_use_a_key_of_their_own(monkeypatch):
    settings = get_settings()
    token = create_playback_token(uuid.uuid4(), uuid.uuid4(), "s", 1, 1, "sub")
    # Not a login token: signed with a derived key, never the JWT secret itself.
    try:
        jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidSignatureError:
        pass
    else:
        raise AssertionError("playback token signed with the login secret")
    assert decode_playback_token(token) is not None
    # And a login token is not a playback token.
    assert decode_playback_token(create_access_token(uuid.uuid4(), uuid.uuid4())) is None

    # An own secret rotates apart from JWT_SECRET; old links work while it is listed.
    link = hls.signed_link("https://cdn.example/s.ts", "", hls.Viewer("u", "s"))
    q = {k: v[0] for k, v in parse_qs(urlsplit(link).query).items()}

    def valid() -> bool:
        return hls.verify_link(q["u"], "", "", hls.Viewer("u", "s"), int(q["e"]), q["s"])

    assert valid()
    monkeypatch.setattr(settings, "stream_link_secret", "an-own-stream-secret-of-32-chars-!!")
    assert not valid()
    monkeypatch.setattr(settings, "stream_link_previous_secrets", settings.jwt_secret)
    assert valid()


def test_playback_tokens_are_short_lived():
    token = create_playback_token(uuid.uuid4(), uuid.uuid4(), "s", 1, 1, "sub")
    claims = decode_playback_token(token)
    assert claims is not None
    assert claims["exp"] - time.time() <= get_settings().playback_token_minutes * 60 + 5
    assert get_settings().playback_token_minutes <= 15


def test_subtitles_join_the_master_playlist_only_when_there_is_something_to_attach_to():
    viewer = hls.Viewer("u", "s")
    master = hls.rewrite_playlist(MEDIA, MASTER, "https://ref.example/", viewer)
    out = hls.add_subtitles(
        master,
        [("pt-BR", 'Port"uguese', "https://subs.example/pt.vtt")],
        "https://ref.example/",
        viewer,
    )
    lines = out.splitlines()
    assert lines[0] == "#EXTM3U"
    assert lines[1].startswith('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Port uguese"')
    assert "&k=subpl" in lines[1]
    assert any(line.endswith(',SUBTITLES="subs"') for line in lines)
    # A media playlist has no variants to hang them on.
    plain = "#EXTM3U\n#EXTINF:5,\nhls?u=x\n"
    assert hls.add_subtitles(plain, [("pt", "P", "https://s/x.vtt")], "", viewer) == plain
    assert hls.add_subtitles(master, [], "", viewer) == master


@respx.mock
async def test_native_players_get_subtitles_in_the_playlist_and_a_fresh_link(client, session):
    fastapi_app.state.sources = {"ok": HlsSource()}
    _, headers = await make_user(session, "kafka")
    mock_details()
    respx.get(MASTER).mock(return_value=httpx.Response(200, text=MEDIA))
    respx.get("https://subs.example/pt.vtt").mock(
        return_value=httpx.Response(200, text="WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n")
    )

    play = (await client.post("/watch/ok/21/episodes/1/play", headers=headers)).json()
    plain = await client.get(play["url"])
    assert "SUBTITLES" not in plain.text  # hls.js draws its own

    # The link for AirPlay is minted without asking the source anything.
    fresh = (
        await client.post("/watch/ok/21/episodes/1/link", params={"kind": "hls"}, headers=headers)
    ).json()["url"]
    assert fresh.startswith("/watch/hls?token=")
    assert (await client.post("/watch/nope/21/episodes/1/link", headers=headers)).status_code == 404
    assert (await client.post("/watch/ok/21/episodes/1/link")).status_code == 401

    native = await client.get(fresh + "&subs=true")
    assert native.status_code == 200
    media = next(x for x in native.text.splitlines() if x.startswith("#EXT-X-MEDIA:TYPE=SUBTITLES"))
    uri = media.split('URI="')[1].split('"')[0]
    wrapper = await client.get(f"/watch/{uri}")
    assert wrapper.status_code == 200 and "#EXT-X-ENDLIST" in wrapper.text
    vtt_link = next(x for x in wrapper.text.splitlines() if x.startswith("hls?u="))
    vtt = await client.get(f"/watch/{vtt_link}")
    assert vtt.headers["content-type"].startswith("text/vtt") and "Hi" in vtt.text
    assert viewer_of(headers).sid in uri


def test_a_playback_token_without_an_expiry_is_refused():
    key = get_settings().stream_link_keys[0]
    claims = {"sub": str(uuid.uuid4()), "sid": str(uuid.uuid4()), "typ": "playback"}
    assert decode_playback_token(jwt.encode(claims, key, algorithm="HS256")) is None


async def test_minting_and_starting_links_are_rate_limited(client, session, monkeypatch):
    from app.ratelimit import ActionLimits

    fastapi_app.state.sources = {"ok": HlsSource()}
    monkeypatch.setattr(
        fastapi_app.state,
        "action_limits",
        ActionLimits({"stream_link": (2, 60), "stream_start": (1, 60)}),
    )
    _, headers = await make_user(session, "kafka")
    url = "/watch/ok/21/episodes/1/link"
    assert (await client.post(url, headers=headers)).status_code == 200
    assert (await client.post(url, headers=headers)).status_code == 200
    assert (await client.post(url, headers=headers)).status_code == 429
