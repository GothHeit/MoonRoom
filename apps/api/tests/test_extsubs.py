import asyncio
import gzip
import random

import httpx
import pytest
import respx

from app import extsubs
from app.extsubs import (
    Cue,
    OpenSubtitles,
    PortugueseSubtitles,
    apply,
    fit,
    parse_ass,
    parse_timed,
    to_vtt,
    usable,
    with_portuguese_subtitles,
    without_adverts,
)
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.sharedcache import SharedCache
from app.sources.base import EpisodeList, Stream, Subtitle, Traits
from tests.conftest import make_user

ANIME = {
    "id": 31859,
    "title": "Hai to Gensou no Grimgar",
    "alternative_titles": {"en": "Grimgar of Fantasy and Ash", "synonyms": []},
}
ENGLISH_URL = "https://subs.example/ep1-en.vtt"
DOWNLOAD = "https://dl.opensubtitles.org/en/download/src-api/vrf-1/filead/111.gz"


def ts(t: float) -> str:
    ms = round(t * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def times(n: int = 200, seed: int = 1) -> list[float]:
    """Line start times of an episode: irregular gaps, like real dialogue."""
    rng = random.Random(seed)
    t, found = 5.0, []
    for _ in range(n):
        t += rng.uniform(1.2, 9.0)
        found.append(round(t, 3))
    return found


def cues(starts: list[float]) -> list[Cue]:
    return [Cue(s, s + 1.5, f"line {i}") for i, s in enumerate(starts)]


def srt(starts: list[float], extra: str = "") -> str:
    blocks = [f"{i + 1}\n{ts(s)} --> {ts(s + 1.5)}\nFala {i}\n" for i, s in enumerate(starts)]
    return extra + "\n".join(blocks)


def row(**changes) -> dict:
    found = {
        "IDSubtitleFile": "111",
        "MovieName": '"Grimgar, Ashes and Illusions" Whisper, Chant, Prayer, Awaken',
        "SubLanguageID": "pob",
        "SeriesSeason": "1",
        "SeriesEpisode": "1",
        "SubFormat": "srt",
        "SubEncoding": "UTF-8",
        "SubDownloadLink": DOWNLOAD,
        "SubAutoTranslation": "0",
        "SubForeignPartsOnly": "0",
        "SubFromTrusted": "1",
        "SubHearingImpaired": "0",
        "SubSumCD": "1",
        "SubDownloadsCnt": "401",
        "SubTranslator": "AnimaKai",
        "SubAuthorComment": "",
    }
    found.update(changes)
    return found


# --- Reading ---


def test_srt_and_webvtt_cues_lose_markup_and_adverts() -> None:
    text = (
        "1\n00:00:01,000 --> 00:00:02,500\n{\\an8}<font color=red>Olá</font> <i>mundo</i>\n\n"
        "2\n00:00:03.000 --> 00:00:04.000\nTorne-se VIP member em www.OpenSubtitles.org\n\n"
        "3\n01:02.5 --> 01:03.000\nDois\nlinhas\n"
    )
    found = without_adverts(parse_timed(text))
    assert found == [
        Cue(1.0, 2.5, "Olá <i>mundo</i>"),
        Cue(62.5, 63.0, "Dois\nlinhas"),
    ]


def test_ass_keeps_dialogue_and_drops_songs_signs_and_karaoke() -> None:
    script = """[Script Info]

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\i1}Peguei!{\\i0}\\Nsegunda
Dialogue: 0,0:00:02.00,0:00:04.00,OP Romaji,,0,0,0,,{\\k20}ka{\\k30}ze
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\pos(10,20)}Guilda
Dialogue: 0,0:00:05.00,0:00:06.00,Sign,,0,0,0,,Placa
Dialogue: 0,0:00:07.00,0:00:08.00,EDJP,,0,0,0,,letra
Dialogue: 0,0:00:09.00,0:00:10.00,Default - Top,,0,0,0,,Em cima
"""
    assert parse_ass(script) == [
        Cue(1.5, 3.25, "<i>Peguei!</i>\nsegunda"),
        Cue(9.0, 10.0, "Em cima"),
    ]


def test_webvtt_output_escapes_text_but_keeps_italics() -> None:
    assert to_vtt([Cue(3661.5, 3662.0, "<i>a</i> & <b>b</b> < c")]) == (
        "WEBVTT\n\n01:01:01.500 --> 01:01:02.000\n<i>a</i> &amp; <b>b</b> &lt; c\n"
    )


# --- Fitting ---


def test_a_file_made_for_another_broadcast_is_shifted_onto_the_copy() -> None:
    rng = random.Random(7)
    own = times()
    # The file runs 9 s late, its lines start a little off, and it has some lines of its own.
    theirs = [s + 9.03 + rng.uniform(-0.08, 0.08) for s in own[:180]] + [33.3, 401.7, 802.2]
    placed = fit(cues(theirs), cues(own))
    assert placed is not None
    assert placed.shift == pytest.approx(-9.03, abs=0.05)
    assert placed.split is None
    assert placed.ratio > 0.9
    moved = apply(cues(theirs), placed)
    assert moved[0].start == pytest.approx(own[0], abs=0.1)


def test_a_cut_in_the_middle_is_fitted_in_two_pieces() -> None:
    own = times()
    # The file's copy has 30 s more before line 120 (a recap the copy we play doesn't have).
    theirs = [s - 4.0 for s in own[:120]] + [s + 26.0 for s in own[120:]]
    placed = fit(cues(theirs), cues(own))
    assert placed is not None
    assert placed.split is not None
    assert {round(placed.shift, 1), round(placed.late_shift or 0, 1)} == {4.0, -26.0}
    assert placed.ratio > 0.95
    moved = apply(cues(theirs), placed)
    assert [round(c.start, 2) for c in moved] == [round(s, 2) for s in own]


def test_a_file_for_another_episode_is_not_offered() -> None:
    assert fit(cues(times(seed=2)), cues(times(seed=3))) is None


def test_too_few_lines_never_fit() -> None:
    own = times(10)
    assert fit(cues(own), cues(own)) is None


# --- Which files ---


def test_usable_files() -> None:
    assert usable(row(), ANIME, 1)
    assert not usable(row(SeriesEpisode="2"), ANIME, 1)
    assert not usable(row(SubLanguageID="por"), ANIME, 1)
    assert not usable(row(SubFormat="sub"), ANIME, 1)
    assert not usable(row(SubSumCD="2"), ANIME, 1)
    assert not usable(row(MovieName='"Steins;Gate" Turning Point'), ANIME, 1)
    assert not usable(row(SubDownloadLink="https://evil.example/x.gz"), ANIME, 1)
    assert not usable(row(SubDownloadLink="http://dl.opensubtitles.org/x.gz"), ANIME, 1)


@pytest.mark.parametrize(
    "changes",
    [
        {"SubAutoTranslation": "1"},
        {"SubAuthorComment": "Traduzido com Google Tradutor"},
        {"SubAuthorComment": "tradução automática"},
        {"SubTranslator": "DeepL"},
        {"SubAuthorComment": "Legenda feita por IA"},
        {"SubAuthorComment": "ChatGPT translation"},
    ],
)
def test_machine_translations_are_never_used(changes: dict) -> None:
    assert not usable(row(**changes), ANIME, 1)


def test_the_portuguese_word_ia_is_not_a_machine() -> None:
    assert usable(row(SubAuthorComment="eu ia sincronizar com o BD"), ANIME, 1)


# --- End to end ---


class Sharp:
    """A source whose copy has English subtitles only."""

    name = "sharp"
    traits = Traits()

    def __init__(self, subtitles: tuple[Subtitle, ...] | None = None) -> None:
        self.subtitles = (
            subtitles if subtitles is not None else (Subtitle("en", "English", ENGLISH_URL),)
        )

    async def episodes(self, anime, lang):
        return EpisodeList(episodes=[1], source_title="Grimgar")

    async def stream(self, anime, episode, lang):
        return Stream(
            url="https://video.example/ep1.mp4",
            kind="mp4",
            resolution=1080,
            upstream_headers={"Referer": "https://source.example/"},
            subtitles=self.subtitles,
        )


class Burned(Sharp):
    traits = Traits(hard_sub_lang="pt-BR")


def mock_site(own: list[float], theirs: list[float]) -> respx.Route:
    respx.get(url__regex=r"https://rest\.opensubtitles\.org/search/.*").mock(
        return_value=httpx.Response(200, json=[row()])
    )
    english = "WEBVTT\n\n" + "\n".join(f"{ts(s)} --> {ts(s + 1)}\nLine\n" for s in own)
    respx.get(ENGLISH_URL).mock(return_value=httpx.Response(200, text=english.replace(",", ".")))
    return respx.get(DOWNLOAD).mock(
        return_value=httpx.Response(200, content=gzip.compress(srt(theirs).encode()))
    )


def subtitles(http: httpx.AsyncClient) -> PortugueseSubtitles:
    cache = SharedCache("")
    return PortugueseSubtitles(http, cache, OpenSubtitles(http, cache, "TestAgent"))


@respx.mock
async def test_a_sharp_copy_gains_a_fitted_portuguese_track() -> None:
    own = times()
    download = mock_site(own, [s + 9.0 for s in own])
    async with httpx.AsyncClient() as http:
        pt = subtitles(http)
        sources = with_portuguese_subtitles({"sharp": Sharp(), "burned": Burned()}, pt)
        stream = await sources["sharp"].stream(ANIME, 1, "sub")
        assert stream is not None
        assert [(s.lang, s.label) for s in stream.subtitles] == [
            ("en", "English"),
            ("pt-BR", "Português (Brasil) · OpenSubtitles"),
        ]
        vtt = await pt.vtt(stream.subtitles[1].url)
        assert vtt is not None and vtt.startswith("WEBVTT")
        first = parse_timed(vtt)[0]
        assert first.start == pytest.approx(own[0], abs=0.05)
        assert first.text == "Fala 0"

        # Cached: the next play neither searches nor downloads again.
        again = await sources["sharp"].stream(ANIME, 1, "sub")
        assert again is not None and len(again.subtitles) == 2
        assert download.call_count == 1

        # A dub, and a source with Portuguese burned in, are left as they are.
        dub = await sources["sharp"].stream(ANIME, 1, "dub")
        assert dub is not None and len(dub.subtitles) == 1
        burned = await sources["burned"].stream(ANIME, 1, "sub")
        assert burned is not None and len(burned.subtitles) == 1
        assert not isinstance(sources["burned"], extsubs.WithPortugueseSubtitles)


@respx.mock
async def test_copies_with_portuguese_or_without_any_track_are_left_alone() -> None:
    search = respx.get(url__regex=r"https://rest\.opensubtitles\.org/.*").mock(
        return_value=httpx.Response(200, json=[])
    )
    async with httpx.AsyncClient() as http:
        pt = subtitles(http)
        has_pt = (Subtitle("pt-BR", "Portuguese", "https://subs.example/pt.vtt"),)
        for tracks in (has_pt, ()):
            sources = with_portuguese_subtitles({"sharp": Sharp(tracks)}, pt)
            stream = await sources["sharp"].stream(ANIME, 1, "sub")
            assert stream is not None and stream.subtitles == tracks
    assert search.call_count == 0


@respx.mock
async def test_a_file_that_does_not_fit_is_not_offered() -> None:
    mock_site(times(seed=4), times(seed=5))
    async with httpx.AsyncClient() as http:
        sources = with_portuguese_subtitles({"sharp": Sharp()}, subtitles(http))
        stream = await sources["sharp"].stream(ANIME, 1, "sub")
    assert stream is not None and len(stream.subtitles) == 1


@respx.mock
async def test_an_outage_leaves_the_copy_playing_without_the_track() -> None:
    respx.get(url__regex=r"https://rest\.opensubtitles\.org/.*").mock(
        return_value=httpx.Response(503)
    )
    async with httpx.AsyncClient() as http:
        sources = with_portuguese_subtitles({"sharp": Sharp()}, subtitles(http))
        stream = await sources["sharp"].stream(ANIME, 1, "sub")
    assert stream is not None and len(stream.subtitles) == 1


@respx.mock
async def test_a_slow_first_look_does_not_hold_up_the_play(monkeypatch) -> None:
    monkeypatch.setattr(extsubs, "FIRST_WAIT", 0.01)
    own = times()
    mock_site(own, own)

    async def slow(*args, **kwargs):
        await asyncio.sleep(0.2)
        return []

    async with httpx.AsyncClient() as http:
        pt = subtitles(http)
        monkeypatch.setattr(pt._site, "search", slow)
        sources = with_portuguese_subtitles({"sharp": Sharp()}, pt)
        stream = await sources["sharp"].stream(ANIME, 1, "sub")
        assert stream is not None and len(stream.subtitles) == 1


@respx.mock
async def test_the_player_gets_the_track_through_the_proxy(client, session) -> None:
    own = times()
    mock_site(own, [s - 3.0 for s in own])
    respx.get(f"{API_BASE}/anime/31859").mock(return_value=httpx.Response(200, json=ANIME))
    respx.route(url="https://video.example/ep1.mp4").mock(return_value=httpx.Response(200))
    _, headers = await make_user(session, "kafka")
    http = fastapi_app.state.http
    pt = subtitles(http)
    saved = getattr(fastapi_app.state, "pt_subtitles", None)
    fastapi_app.state.pt_subtitles = pt
    fastapi_app.state.sources = with_portuguese_subtitles({"sharp": Sharp()}, pt)
    try:
        play = await client.post("/watch/sharp/31859/episodes/1/play", headers=headers)
        assert play.status_code == 200
        tracks = play.json()["subtitles"]
        assert [t["lang"] for t in tracks] == ["en", "pt-BR"]
        served = await client.get(tracks[1]["url"])
        assert served.status_code == 200
        assert served.headers["content-type"].startswith("text/vtt")
        assert parse_timed(served.text)[0].start == pytest.approx(own[0], abs=0.05)

        # The link is signed: another key can't be asked for.
        forged = tracks[1]["url"].replace("31859", "31860")
        assert (await client.get(forged)).status_code == 403
    finally:
        fastapi_app.state.pt_subtitles = saved
