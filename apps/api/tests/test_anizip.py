import io

import httpx
import respx
from PIL import Image

from app.anizip import API, on_blank_background, parse
from tests.conftest import make_user
from tests.mal_fixtures import mock_details

STILL = "https://artworks.thetvdb.com/banners/episode/1.jpg"
FANART = "https://artworks.thetvdb.com/banners/fanart/1.jpg"


def answer():
    return {
        "images": [
            {"coverType": "Banner", "url": "https://artworks.thetvdb.com/banners/banner.jpg"},
            {"coverType": "Fanart", "url": FANART},
        ],
        "episodes": {
            "1": {
                "title": {"en": "Shall We Go, Then?", "de": "Frieren`s Weg", "x-jat": "Jaa"},
                "image": STILL,
            },
            "2": {"title": {"x-jat": "Minami no Yuusha", "pt": "O Herói do Sul"}, "image": None},
            "3": {"title": {}, "image": "http://insecure.example/3.jpg"},
            "S1": {"title": {"en": "A special"}, "image": STILL},
        },
    }


def test_parse_keeps_regular_episodes_and_safe_links():
    art = parse(answer())
    assert art.backdrop == FANART
    assert sorted(art.episodes) == [1, 2]
    assert art.episodes[1].image == STILL
    assert art.episodes[1].title("pt") == "Shall We Go, Then?"
    assert art.episodes[1].titles["de"] == "Frieren\u2019s Weg"
    assert art.episodes[2].title("pt") == "O Herói do Sul"
    assert art.episodes[2].title("en") == "Minami no Yuusha"


def test_parse_falls_back_to_the_banner_and_survives_odd_shapes():
    assert parse({"images": [{"coverType": "Banner", "url": FANART}]}).backdrop == FANART
    art = parse({"images": "nope", "episodes": ["nope"]})
    assert art.backdrop is None and art.episodes == {}


@respx.mock
async def test_art_endpoint_is_cached_and_localized(client, session):
    _, headers = await make_user(session, "kafka")
    mock_details(5)
    upstream = respx.get(API, params={"mal_id": "5"}).mock(
        return_value=httpx.Response(200, json=answer())
    )
    r = await client.get("/anime/5/art", params={"lang": "pt"}, headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "backdrop": FANART,
        "episodes": {
            "1": {"title": "Shall We Go, Then?", "image": STILL},
            "2": {"title": "O Herói do Sul", "image": None},
        },
    }
    await client.get("/anime/5/art", headers=headers)
    assert upstream.call_count == 1


def picture(background, figure="navy", mode: str = "RGB", kind: str = "JPEG") -> bytes:
    """A wide picture: a figure in the middle that reaches the bottom edge, like key art."""
    image = Image.new(mode, (640, 360), background)
    image.paste(Image.new(mode, (360, 300), figure), (140, 60))
    out = io.BytesIO()
    image.save(out, kind)
    return out.getvalue()


def test_art_on_white_or_on_nothing_counts_as_blank():
    assert on_blank_background(picture("white"))
    assert on_blank_background(picture((0, 0, 0, 0), (20, 20, 90, 255), "RGBA", "PNG"))
    assert not on_blank_background(picture("darkgreen"))
    # A light sky over a dark ground is a scene, not a cut-out.
    scene = Image.new("RGB", (640, 360), "white")
    scene.paste(Image.new("RGB", (640, 200), "saddlebrown"), (0, 160))
    out = io.BytesIO()
    scene.save(out, "JPEG")
    assert not on_blank_background(out.getvalue())


@respx.mock
async def test_wide_art_on_a_blank_background_is_left_out(client, session):
    _, headers = await make_user(session, "kafka")
    for anime_id, image in ((11, picture("white")), (12, picture("darkgreen"))):
        mock_details(anime_id)
        respx.get(API, params={"mal_id": str(anime_id)}).mock(
            return_value=httpx.Response(200, json=answer())
        )
        respx.get(FANART).mock(return_value=httpx.Response(200, content=image))
        r = await client.get(f"/anime/{anime_id}/art", headers=headers)
        assert r.json()["backdrop"] == (None if anime_id == 11 else FANART)
        assert r.json()["episodes"]["1"]["image"] == STILL


@respx.mock
async def test_wide_art_that_cannot_be_checked_is_kept(client, session):
    _, headers = await make_user(session, "kafka")
    for anime_id, response in ((13, httpx.Response(503)), (14, httpx.Response(200, content=b"x"))):
        mock_details(anime_id)
        respx.get(API, params={"mal_id": str(anime_id)}).mock(
            return_value=httpx.Response(200, json=answer())
        )
        respx.get(FANART).mock(return_value=response)
        r = await client.get(f"/anime/{anime_id}/art", headers=headers)
        assert r.json()["backdrop"] == FANART


@respx.mock
async def test_a_failing_or_unknown_lookup_gives_no_art(client, session):
    _, headers = await make_user(session, "kafka")
    mock_details(6)
    mock_details(7)
    respx.get(API, params={"mal_id": "6"}).mock(side_effect=httpx.ConnectError("down"))
    respx.get(API, params={"mal_id": "7"}).mock(return_value=httpx.Response(404))
    for anime_id in (6, 7):
        r = await client.get(f"/anime/{anime_id}/art", headers=headers)
        assert r.status_code == 200
        assert r.json() == {"backdrop": None, "episodes": {}}


@respx.mock
async def test_art_of_hidden_titles_is_hidden(client, session):
    _, headers = await make_user(session, "kafka")
    mock_details(9, rating="rx")
    assert (await client.get("/anime/9/art", headers=headers)).status_code == 404
    assert (await client.get("/anime/9/art")).status_code == 401
