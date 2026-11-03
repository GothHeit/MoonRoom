import pytest
import respx

from app import hls
from app.sources import animesbiz, freak, load_sources
from app.sources.adult import is_adult
from app.sources.animesbiz import AnimesBizSource
from app.sources.freak import FreakSource, episodes_for, parse_results, parse_video

ADULT = [{"id": 12, "name": "Adult"}]
ANIME = {"id": 1, "title": "Kishi Story", "genres": ADULT, "alternative_titles": {}}
GENERAL = {
    "id": 2,
    "title": "Kishi Story",
    "genres": [{"id": 2, "name": "Adventure"}],
    "alternative_titles": {},
}


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    async def resolve(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(hls, "resolve_host", resolve)
    hls._public_hosts.clear()


def test_adult_check():
    assert is_adult(ANIME)
    assert is_adult({"rating": "rx", "genres": []})
    assert not is_adult(GENERAL)
    assert not is_adult({})


# English site: one post per episode.


def post(path, name):
    return f'<h2 class="entry-title"><a href="{freak.BASE}/{path}/" rel="bookmark">{name}</a></h2>'


FREAK_SEARCH = (
    post("kishi-story-episode-1-video", "Kishi Story Episode 1")
    + post("kishi-story-subbed-episode-1-video", "Kishi Story Subbed Episode 1")
    + post("kishi-story-episode-2-video", "Kishi Story Episode 2")
    + post("kishi-story-dubbed-episode-1-video", "Kishi Story Dubbed Episode 1")
    + post("other-tale-episode-1-video", "Other Tale &#038; Co Episode 1")
)


def test_freak_posts_split_title_episode_and_version():
    posts = parse_results(FREAK_SEARCH)
    assert [(p.title, p.episode, p.version) for p in posts] == [
        ("Kishi Story", 1, None),
        ("Kishi Story", 1, "sub"),
        ("Kishi Story", 2, None),
        ("Kishi Story", 1, "dub"),
        ("Other Tale & Co", 1, None),
    ]


def test_freak_named_subbed_post_wins_and_dub_is_separate():
    posts = parse_results(FREAK_SEARCH)
    sub = episodes_for(posts, "Kishi Story", "sub")
    assert sub == {1: "kishi-story-subbed-episode-1-video/", 2: "kishi-story-episode-2-video/"}
    assert episodes_for(posts, "Kishi Story", "dub") == {1: "kishi-story-dubbed-episode-1-video/"}


def test_freak_video_link_is_encoded():
    page = (
        '<video><source src="https://media.example/vid/Kishi Story - 01 [1920x1080].mp4" '
        "type='video/mp4' /></video>"
    )
    found = parse_video(page)
    assert found
    url, height = found
    assert url == "https://media.example/vid/Kishi%20Story%20-%2001%20%5B1920x1080%5D.mp4"
    assert height == 1080
    assert parse_video("<p>nothing</p>") is None


@respx.mock
async def test_freak_stream():
    respx.get(f"{freak.BASE}/search/Kishi%20Story/").respond(text=FREAK_SEARCH)
    respx.get(f"{freak.BASE}/kishi-story-subbed-episode-1-video/").respond(
        text='<source src="https://media.example/vid/kishi-01-720p.mp4" type="video/mp4">'
    )
    source = FreakSource()
    listed = await source.episodes(ANIME, "sub")
    assert listed and listed.episodes == [1, 2] and listed.source_title == "Kishi Story"
    stream = await source.stream(ANIME, 1, "sub")
    assert stream and stream.kind == "mp4" and stream.resolution == 720
    assert stream.upstream_headers == {}


@respx.mock
async def test_adult_sources_skip_other_titles():
    assert await FreakSource().episodes(GENERAL, "sub") is None
    assert await FreakSource().stream(GENERAL, 1, "sub") is None
    assert await AnimesBizSource().episodes(GENERAL, "sub") is None
    assert await AnimesBizSource().stream(GENERAL, 1, "sub") is None
    assert not respx.calls


# Portuguese site: title pages and a Blogger player.

PLAYER = "https://www.blogger.com/video.g?token=AD6v5dx"
BLOGGER = (
    '<div data-p="{&quot;streams&quot;:[{&quot;play_url&quot;:&quot;'
    "https://rr2---sn-x.googlevideo.com/videoplayback?expire=4102444800&amp;ip=1.2.3.4"
    '&amp;itag=22&amp;source=blogger&amp;mime=video%2Fmp4&quot;,&quot;format_id&quot;:22}]}"></div>'
)


def article(slug, name):
    base = animesbiz.BASE
    return (
        f'<article class="item se tvshows" id="post-1"><div class="poster">'
        f'<a href="{base}/hentai/{slug}/"><img src="x.jpg" alt="{name}"></a></div>'
        f'<div class="data"><h3> <a href="{base}/hentai/{slug}/">{name}</a></h3></div></article>'
    )


def title_page(slug, count):
    base = animesbiz.BASE
    items = "".join(
        f'<li><div class="imagen"><a href="{base}/episodio/{slug}-episodio-{n}/"><img></a></div>'
        f'<div class="episodiotitle"> <a href="{base}/episodio/{slug}-episodio-{n}/">'
        f"Episodio {n}</a></div></li>"
        for n in range(1, count + 1)
    )
    return f'<div class="se-c"><div class="se-a"><ul class="episodios">{items}</ul></div></div>'


def test_animesbiz_parsing():
    results = animesbiz.parse_results(article("kishi-story", "Kishi Story"))
    assert [(c.identifier, c.name) for c in results] == [("kishi-story", "Kishi Story")]
    episodes = animesbiz.parse_episodes(title_page("kishi-story", 3))
    assert list(episodes) == [1, 2, 3] and episodes[2].endswith("kishi-story-episodio-2/")


@respx.mock
async def test_animesbiz_stream():
    base = animesbiz.BASE
    respx.get(f"{base}/search/Kishi%20Story").respond(text=article("kishi-story", "Kishi Story"))
    respx.get(f"{base}/hentai/kishi-story/").respond(text=title_page("kishi-story", 2))
    respx.get(f"{base}/episodio/kishi-story-episodio-1/").respond(
        text=f'<iframe class="metaframe rptss" src="{PLAYER}"></iframe>'
    )
    respx.get(PLAYER).respond(text=BLOGGER)
    source = AnimesBizSource()
    listed = await source.episodes(ANIME, "sub")
    assert listed and listed.episodes == [1, 2]
    stream = await source.stream(ANIME, 1, "sub")
    assert stream and stream.kind == "mp4" and stream.resolution == 720
    assert await source.episodes(ANIME, "dub") is None


def test_registry():
    sources = load_sources(["freak", "animesbiz"])
    assert isinstance(sources["freak"], FreakSource)
    assert isinstance(sources["animesbiz"], AnimesBizSource)


@respx.mock
async def test_animesbiz_falls_back_to_one_word_and_handles_dot_titles():
    base = animesbiz.BASE
    anime = {"id": 3, "title": "Futsuma *jo Charlotte.", "genres": ADULT, "alternative_titles": {}}
    respx.get(f"{base}/search/Futsuma%20%2Ajo%20Charlotte").respond(text="")
    respx.get(f"{base}/search/Futsuma").respond(
        text=article("futsuma-shoujo-charlotte", "Futsuma Shoujo Charlotte")
    )
    respx.get(f"{base}/hentai/futsuma-shoujo-charlotte/").respond(
        text=title_page("futsuma-shoujo-charlotte", 2)
    )
    listed = await AnimesBizSource().episodes(anime, "sub")
    assert listed and listed.source_title == "Futsuma Shoujo Charlotte"
    assert listed.episodes == [1, 2]
