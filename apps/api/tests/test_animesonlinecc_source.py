import pytest
import respx

from app import hls
from app.sources import load_sources
from app.sources.animesonlinecc import (
    BASE,
    AnimesOnlineCCSource,
    parse_episodes,
    parse_player,
    parse_results,
    parse_videos,
)


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    async def resolve(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    hls._public_hosts.clear()


def article(slug, name):
    return (
        f'<article class="item se tvshows" id="post-1"><div class="poster">'
        f'<a href="{BASE}/anime/{slug}/"><img src="x.jpg" alt="{name}"></a></div>'
        f'<div class="data"><h3><a href="{BASE}/anime/{slug}/">{name}</a></h3></div></article>'
    )


def group(season, slug_part, count):
    items = "".join(
        f'<li><div class="imagen"><a href="{BASE}/episodio/{slug_part}-episodio-{n}/">'
        f"<img></a></div>"
        f'<div class="numerando">Ep - {n}</div><div class="episodiotitle">'
        f'<a href="{BASE}/episodio/{slug_part}-episodio-{n}/">Episodio {n}</a></div></li>'
        for n in range(1, count + 1)
    )
    return (
        f'<div class="se-c"><div class="se-q"><span class="se-t">{season}</span>'
        f'<span class="title">Temporada {season}</span></div>'
        f'<div class="se-a"><ul class="episodios">{items}</ul></div></div>'
    )


TWO_SEASONS = group(1, "frieren", 3) + group(2, "frieren-2", 2)
ANIME = {"id": 52991, "title": "Sousou no Frieren", "alternative_titles": {}}
PLAYER = "https://www.blogger.com/video.g?token=AD6v5dx"
BLOGGER = (
    '<div data-p="{&quot;streams&quot;:[{&quot;play_url&quot;:&quot;'
    "https://rr2---sn-x.googlevideo.com/videoplayback?expire=4102444800&amp;ip=1.2.3.4"
    "&amp;itag=18&amp;source=blogger&amp;mime=video%2Fmp4&quot;,&quot;format_id&quot;:18},"
    "{&quot;play_url&quot;:&quot;"
    "https://rr2---sn-x.googlevideo.com/videoplayback?expire=4102444800&amp;ip=1.2.3.4"
    '&amp;itag=22&amp;source=blogger&amp;mime=video%2Fmp4&quot;,&quot;format_id&quot;:22}]}"></div>'
)


def test_results():
    page = article("sousou-no-frieren", "Sousou no Frieren") + article("x-dublado", "X Dublado")
    assert [c.identifier for c in parse_results(page)] == ["sousou-no-frieren", "x-dublado"]


def test_sequel_takes_its_own_season_group():
    first = parse_episodes(TWO_SEASONS, None)
    assert sorted(first) == [1, 2, 3] and "frieren-episodio" in first[1]
    second = parse_episodes(TWO_SEASONS, 2)
    assert sorted(second) == [1, 2] and "frieren-2-episodio-1" in second[1]
    assert parse_episodes(TWO_SEASONS, 5) == {}


def test_numbers_that_continue_are_merged():
    page = group(1, "a", 2).replace("Ep - 1", "Ep - 1") + group(2, "b", 2).replace(
        "Ep - 1", "Ep - 3"
    ).replace("Ep - 2", "Ep - 4")
    assert sorted(parse_episodes(page, None)) == [1, 2, 3, 4]


def test_videos_best_first_and_escaped_links_read():
    videos = parse_videos(BLOGGER)
    assert [v.height for v in videos] == [720, 360]
    assert "&amp;" not in videos[0].url and "itag=22" in videos[0].url
    assert videos[0].expires == 4102444800.0


def test_player_iframe():
    page = f'<iframe class="metaframe rptss" src="{PLAYER}" allowfullscreen></iframe>'
    assert parse_player(page) == PLAYER


@respx.mock
async def test_stream_reads_the_mp4_at_play_time():
    respx.get(f"{BASE}/search/Sousou%20no%20Frieren").respond(
        text=article("sousou-no-frieren", "Sousou no Frieren")
    )
    respx.get(f"{BASE}/anime/sousou-no-frieren/").respond(text=TWO_SEASONS)
    respx.get(f"{BASE}/episodio/frieren-episodio-1/").respond(
        text=f'<iframe class="metaframe rptss" src="{PLAYER}"></iframe>'
    )
    respx.get(PLAYER).respond(text=BLOGGER)
    source = AnimesOnlineCCSource()
    listed = await source.episodes(ANIME, "sub")
    assert listed and listed.episodes == [1, 2, 3]
    stream = await source.stream(ANIME, 1, "sub")
    assert stream and stream.kind == "mp4" and stream.resolution == 720
    assert await source.episodes(ANIME, "dub") is None


def test_registry():
    assert isinstance(load_sources(["animesonlinecc"])["animesonlinecc"], AnimesOnlineCCSource)
