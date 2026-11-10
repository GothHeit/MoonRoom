import httpx
import respx

from app.anizip import API, parse
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
