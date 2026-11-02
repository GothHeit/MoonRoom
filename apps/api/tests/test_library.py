import shutil
import struct
import subprocess
from pathlib import Path

import httpx
import pytest
import respx

from app import hls
from app.config import get_settings
from app.library import EPISODE_META, read_json, write_json
from app.library.fonts import font_names
from app.library.ingest import (
    IngestError,
    Manifest,
    Options,
    audio_codec_tag,
    chapter_skips,
    clean_vtt,
    codec_tag,
    copyable,
    episode_number,
    find_episodes,
    ingest,
    load_manifest,
    pick_audio,
    subtitle_order,
)
from app.library.scan import scan, write_log
from app.main import app as fastapi_app
from app.mal.client import API_BASE
from app.sources.local import LocalSource
from tests.conftest import make_user

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")

ASS = """[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, \
Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, \
Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Test Sans,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,\
1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.10,0:00:01.50,Default,,0,0,0,,{{\\pos(160,20)}}{text}
Dialogue: 0,0:00:00.20,0:00:01.00,Default,,0,0,0,,{{\\p1}}m 0 0 l 10 0 10 10 0 10{{\\p0}}
"""

CHAPTERS = """;FFMETADATA1
[CHAPTER]
TIMEBASE=1/1000
START=0
END=1000
title=Opening
[CHAPTER]
TIMEBASE=1/1000
START=1000
END=2000
title=Part A
"""


def make_font(*names: str) -> bytes:
    """A minimal sfnt with only a name table, enough for font_names."""
    encoded = [n.encode("utf-16-be") for n in names]
    records = b""
    strings = b""
    for i, raw in enumerate(encoded):
        name_id = (1, 4, 6, 16)[i % 4]
        records += struct.pack(">HHHHHH", 3, 1, 0x409, name_id, len(raw), len(strings))
        strings += raw
    table = struct.pack(">HHH", 0, len(encoded), 6 + 12 * len(encoded)) + records + strings
    header = b"\x00\x01\x00\x00" + struct.pack(">HHHH", 1, 16, 0, 0)
    directory = struct.pack(">4sIII", b"name", 0, 12 + 16, len(table))
    return header + directory + table


def test_font_names_reads_the_name_table():
    assert font_names(make_font("Test Sans", "Test Sans Bold")) == {"Test Sans", "Test Sans Bold"}
    assert font_names(b"not a font") == set()
    assert font_names(b"\x00\x01\x00\x00\x00") == set()


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("[EmmidSubs] Clannad - 01 [BD 1080p HEVC][ABCD1234].mkv", 1),
        ("Clannad - 12v2 (BD 1080p).mkv", 12),
        ("Clannad 2 - 05.mkv", 5),
        ("Clannad_E07_[1080p].mkv", None),
        ("Clannad.mkv", None),
    ],
)
def test_episode_number_from_the_last_number_outside_brackets(name, expected):
    assert episode_number(name, Manifest(mal_id=1)) == expected


def test_episode_number_from_pattern_offset_and_explicit_map():
    manifest = Manifest(
        mal_id=1, episode_pattern=r"_E(\d+)_", episode_offset=-1, episodes={"special.mkv": 99}
    )
    assert episode_number("Clannad_E07_[1080p].mkv", manifest) == 6
    assert episode_number("special.mkv", manifest) == 99


def test_find_episodes_refuses_duplicates_and_skips_other_files(tmp_path: Path):
    for name in ("Show - 01.mkv", "Show - 02.mkv", "notes.txt"):
        (tmp_path / name).write_bytes(b"")
    assert sorted(find_episodes(tmp_path, Manifest(mal_id=1))) == [1, 2]
    (tmp_path / "Show - 01 [alt].mkv").write_bytes(b"")
    with pytest.raises(IngestError, match="both episode 1"):
        find_episodes(tmp_path, Manifest(mal_id=1))


def test_manifest_from_file_with_flags_winning(tmp_path: Path):
    (tmp_path / "moonroom.toml").write_text('mal_id = 2167\ndefault_subtitle = "Emmid"\n')
    manifest = load_manifest(tmp_path, None, {"mal_id": None, "title": "Clannad"})
    assert (manifest.mal_id, manifest.title, manifest.default_subtitle) == (
        2167,
        "Clannad",
        "Emmid",
    )
    assert load_manifest(tmp_path, None, {"mal_id": 5}).mal_id == 5
    (tmp_path / "moonroom.toml").write_text("mal_id = 1\ntypo = 2\n")
    with pytest.raises(IngestError, match="typo"):
        load_manifest(tmp_path, None, {})


def test_manifest_needs_a_mal_id(tmp_path: Path):
    with pytest.raises(IngestError, match="MAL id"):
        load_manifest(tmp_path, None, {"mal_id": None})


def test_audio_track_follows_sub_or_dub_unless_named():
    streams = [
        {"index": 1, "codec_type": "audio", "tags": {"language": "jpn"}},
        {"index": 2, "codec_type": "audio", "tags": {"language": "por"}},
    ]
    assert pick_audio(streams, Manifest(mal_id=1).audio_languages())["index"] == 1
    assert pick_audio(streams, Manifest(mal_id=1, lang="dub").audio_languages())["index"] == 2
    named = Manifest(mal_id=1, lang="dub", audio_language="jpn")
    assert pick_audio(streams, named.audio_languages())["index"] == 1
    # No match: the first track.
    assert pick_audio(streams, ("eng",))["index"] == 1


def test_codecs_and_what_plays_without_re_encoding():
    hevc10 = {"codec_name": "hevc", "profile": "Main 10", "level": 120, "pix_fmt": "yuv420p10le"}
    assert codec_tag(hevc10) == "hvc1.2.4.L120.B0"
    assert copyable(hevc10)
    h264 = {"codec_name": "h264", "profile": "High", "level": 41, "pix_fmt": "yuv420p"}
    assert codec_tag(h264) == "avc1.640029"
    assert copyable(h264)
    assert not copyable({**h264, "pix_fmt": "yuv420p10le"})
    assert not copyable({"codec_name": "av1"})


def test_vtt_drops_drawing_only_cues():
    vtt = (
        "WEBVTT\n\n00:00.100 --> 00:01.500\nOlá\n\n"
        "00:00.200 --> 00:01.000\nm 0 0 l 10 0 10 10 0 10\n\n"
        "00:02.000 --> 00:03.000\nmais 2 linhas\n"
    )
    assert clean_vtt(vtt) == (
        "WEBVTT\n\n00:00.100 --> 00:01.500\nOlá\n\n00:02.000 --> 00:03.000\nmais 2 linhas\n"
    )


def test_subtitle_order_puts_the_preferred_group_first():
    tracks = [
        {"label": "PA", "default": True},
        {"label": "Inglês", "default": False},
        {"label": "EmmidSubs", "default": False},
    ]
    assert [t["label"] for t in subtitle_order(tracks, "emmid")] == ["EmmidSubs", "PA", "Inglês"]
    assert [t["label"] for t in subtitle_order(tracks, "")] == ["PA", "Inglês", "EmmidSubs"]


def test_chapter_skips():
    chapters = [
        {"start_time": "0.0", "end_time": "90.0", "tags": {"title": "Opening"}},
        {"start_time": "90.0", "end_time": "1300.0", "tags": {"title": "Part A"}},
        {"start_time": "1300.0", "end_time": "1390.5", "tags": {"title": "ED"}},
    ]
    assert chapter_skips(chapters) == [
        {"kind": "intro", "start": 0.0, "end": 90.0},
        {"kind": "outro", "start": 1300.0, "end": 1390.5},
    ]


def make_episode(folder: Path, name: str, font: bytes) -> Path:
    """A 2 s HEVC 10-bit mkv with FLAC audio, two ASS tracks, a font and chapters, like a
    BD release."""
    (folder / "pa.ass").write_text(ASS.format(text="Oi do PA"), encoding="utf-8")
    (folder / "emmid.ass").write_text(ASS.format(text="Oi da Emmid"), encoding="utf-8")
    (folder / "chapters.txt").write_text(CHAPTERS)
    (folder / "font.ttf").write_bytes(font)
    out = folder / name
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-i", str(folder / "pa.ass"), "-i", str(folder / "emmid.ass"),
         "-i", str(folder / "chapters.txt"),
         "-map", "0", "-map", "1", "-map", "2", "-map", "3", "-map_chapters", "4",
         "-c:v", "libx265", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p10le",
         "-c:a", "flac", "-c:s", "copy",
         "-metadata:s:a:0", "language=jpn",
         "-metadata:s:s:0", "language=por", "-metadata:s:s:0", "title=PA",
         "-metadata:s:s:1", "language=por", "-metadata:s:s:1", "title=EmmidSubs",
         "-attach", str(folder / "font.ttf"),
         "-metadata:s:t:0", "mimetype=application/x-truetype-font", str(out)],
        check=True,
    )  # fmt: skip
    for name in ("pa.ass", "emmid.ass", "chapters.txt", "font.ttf"):
        (folder / name).unlink()
    return out


@pytest.fixture(scope="module")
def library(tmp_path_factory) -> Path:
    """Originals converted once for all the tests that need them."""
    originals = tmp_path_factory.mktemp("Clannad")
    make_episode(originals, "[EmmidSubs] Clannad - 01 [BD 1080p].mkv", make_font("Test Sans"))
    root = tmp_path_factory.mktemp("library")
    manifest = Manifest(mal_id=2167, title="Clannad", default_subtitle="Emmid")
    result = ingest(originals, root, manifest, Options(preset="ultrafast"), log=lambda _: None)
    assert result.converted == 1
    return root


@needs_ffmpeg
def test_ingest_writes_both_variants_subtitles_fonts_and_skips(library: Path):
    title = library / "2167" / "sub"
    assert read_json(title / "title.json") == {
        "title": "Clannad",
        "episodes": [1],
        "thumbnails": [1],
    }
    episode = title / "1"
    master = (episode / "master.m3u8").read_text()
    assert 'CODECS="hvc1.2.' in master and 'CODECS="avc1.' in master
    assert master.index("hevc/index.m3u8") < master.index("h264/index.m3u8")
    for variant in ("hevc", "h264"):
        assert (episode / variant / "init.mp4").is_file()
        assert "#EXT-X-ENDLIST" in (episode / variant / "index.m3u8").read_text()
    meta = read_json(episode / EPISODE_META)
    assert [s["label"] for s in meta["subtitles"]] == ["EmmidSubs", "PA"]
    assert all(s["lang"] == "pt-BR" for s in meta["subtitles"])
    emmid = meta["subtitles"][0]
    assert "Oi da Emmid" in (episode / emmid["ass"]).read_text()
    vtt = (episode / emmid["vtt"]).read_text()
    assert "Oi da Emmid" in vtt and "m 0 0" not in vtt
    assert meta["skips"] == [{"kind": "intro", "start": 0.0, "end": 1.0}]
    assert (episode / "thumb.jpg").stat().st_size > 0
    fonts = read_json(title / "fonts.json")
    assert (title / "fonts" / fonts["test sans"]).is_file()
    assert not list(title.glob(".*partial"))


@needs_ffmpeg
def test_ingest_skips_converted_episodes_until_forced(library: Path, tmp_path: Path):
    originals = tmp_path / "Clannad"
    originals.mkdir()
    make_episode(originals, "Clannad - 01.mkv", make_font("Test Sans"))
    manifest = Manifest(mal_id=1)
    options = Options(preset="ultrafast")

    def run(opts: Options, manifest: Manifest = manifest):
        return ingest(originals, tmp_path / "lib", manifest, opts, log=lambda _: None)

    assert run(options).converted == 1
    again = run(options)
    assert (again.converted, again.skipped) == (0, 1)
    assert run(Options(preset="ultrafast", force=True)).converted == 1
    # No title anywhere: the folder name, kept by later runs once one was given.
    title = tmp_path / "lib" / "1" / "sub" / "title.json"
    assert read_json(title)["title"] == "Clannad"
    run(options, Manifest(mal_id=1, title="Clannad TV"))
    run(options)
    assert read_json(title)["title"] == "Clannad TV"


def proxied(link: str) -> str:
    """A link from a playlist, as the player requests it relative to /watch/."""
    return f"/watch/{link}"


@needs_ffmpeg
@respx.mock
async def test_local_episode_plays_through_the_proxy(client, session, library, monkeypatch):
    monkeypatch.setattr(get_settings(), "local_library_dirs", str(library))
    fastapi_app.state.sources = {"local": LocalSource(library)}
    _, headers = await make_user(session, "kafka")
    respx.get(f"{API_BASE}/anime/2167").mock(
        return_value=httpx.Response(200, json={"id": 2167, "title": "Clannad"})
    )

    eps = (await client.get("/watch/local/2167/episodes", headers=headers)).json()
    assert (eps["episodes"], eps["source_title"]) == ([1], "Clannad")
    thumb = await client.get(eps["thumbnails"]["1"], headers=headers)
    assert thumb.headers["content-type"] == "image/jpeg"
    missing = await client.get(
        "/watch/local/2167/episodes", params={"lang": "dub"}, headers=headers
    )
    assert missing.status_code == 404

    play = (await client.post("/watch/local/2167/episodes/1/play", headers=headers)).json()
    assert play["kind"] == "hls"
    master = await client.get(play["url"])
    assert master.headers["content-type"] == "application/vnd.apple.mpegurl"
    variants = [line for line in master.text.splitlines() if line.startswith("hls?u=file")]
    assert len(variants) == 2

    # Library links need the viewer's session, like remote ones.
    assert (await client.get(proxied(variants[0]))).status_code == 401
    playlist = (await client.get(proxied(variants[0]), headers=headers)).text
    init = playlist.split('URI="')[1].split('"')[0]
    segment = next(line for line in playlist.splitlines() if line.startswith("hls?u="))
    assert (await client.get(proxied(init), headers=headers)).headers["content-type"] == "video/mp4"
    part = await client.get(proxied(segment), headers={**headers, "Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100
    assert part.headers["x-content-type-options"] == "nosniff"

    emmid = play["subtitles"][0]
    assert (emmid["lang"], emmid["label"]) == ("pt-BR", "EmmidSubs")
    ass = await client.get(emmid["ass_url"], headers=headers)
    assert ass.headers["content-type"].startswith("text/plain") and "Oi da Emmid" in ass.text
    vtt = await client.get(emmid["url"], headers=headers)
    assert vtt.headers["content-type"].startswith("text/vtt")
    font = await client.get(play["fonts"]["test sans"], headers=headers)
    assert font.headers["content-type"] == "font/ttf"
    assert play["skips"] == [{"kind": "intro", "start": 0.0, "end": 1.0}]


async def test_library_links_never_leave_the_library(client, session, tmp_path, monkeypatch):
    root = tmp_path / "library"
    (root / "1").mkdir(parents=True)
    (root / "1" / "a.m3u8").write_text(
        "#EXTM3U\nseg.m4s\n../../secret.txt\nhttps://cdn.example/x\n"
    )
    (root / "1" / "seg.m4s").write_bytes(b"x")
    (tmp_path / "secret.txt").write_text("secret")
    monkeypatch.setattr(get_settings(), "local_library_dirs", str(root))

    assert hls.local_path((root / "1" / "seg.m4s").as_uri()) is not None
    assert hls.local_path((tmp_path / "secret.txt").as_uri()) is None
    assert hls.local_path(f"{(root / '1').as_uri()}/../../secret.txt") is None
    assert hls.local_path("https://cdn.example/x") is None

    links = hls.rewrite_playlist(
        (root / "1" / "a.m3u8").read_text(), (root / "1" / "a.m3u8").as_uri(), "", "v"
    ).splitlines()
    assert links[1].startswith("hls?u=file") and links[2:] == []
    # A remote playlist can't point into the library either.
    remote = hls.rewrite_playlist(
        f"#EXTM3U\n{(root / '1' / 'seg.m4s').as_uri()}\n", "https://a.example/p.m3u8", "", "v"
    )
    assert "file" not in remote

    _, headers = await make_user(session, "kafka")
    user_id = (await client.get("/me", headers=headers)).json()["id"]
    outside = proxied(hls.signed_link((tmp_path / "secret.txt").as_uri(), "", user_id))
    assert (await client.get(outside, headers=headers)).status_code == 404


def test_audio_codecs_follow_the_stored_profile():
    assert audio_codec_tag({"codec_name": "aac", "profile": "LC", "channels": 2}) == "mp4a.40.2"
    assert audio_codec_tag({"codec_name": "aac", "profile": "HE-AAC", "channels": 2}) == "mp4a.40.5"
    assert audio_codec_tag({"codec_name": "aac", "profile": "HE-AACv2"}) == "mp4a.40.29"
    # Re-encoded to AAC-LC: 5.1 AAC and anything that isn't AAC.
    assert audio_codec_tag({"codec_name": "aac", "profile": "HE-AAC", "channels": 6}) == "mp4a.40.2"
    assert audio_codec_tag({"codec_name": "flac"}) == "mp4a.40.2"


def test_h264_copy_defaults_to_the_slow_preset():
    assert Options().preset == "slow"


def make_title(root: Path, mal_id: int, episodes: list[int], listed: bool = True) -> Path:
    """A converted title without any video, enough for listings and links."""
    title = root / str(mal_id) / "sub"
    for ep in episodes:
        (title / str(ep)).mkdir(parents=True)
        write_json(title / str(ep) / EPISODE_META, {"height": 1080, "subtitles": [], "skips": []})
        (title / str(ep) / "master.m3u8").write_text("#EXTM3U\nh264/index.m3u8\n")
    meta: dict = {"title": f"Title {mal_id}"}
    if listed:
        meta |= {"episodes": episodes, "thumbnails": []}
    title.mkdir(parents=True, exist_ok=True)
    write_json(title / "title.json", meta)
    return title


async def test_titles_come_from_any_library_folder_and_are_cached(tmp_path: Path):
    first, second = tmp_path / "d", tmp_path / "nas"
    make_title(first, 1, [1, 2])
    make_title(second, 2, [3])
    # Converted before title.json listed episodes: the folder is walked instead.
    make_title(second, 3, [1], listed=False)
    source = LocalSource([first, second])

    async def listed(mal_id: int) -> list[int] | None:
        found = await source.episodes({"id": mal_id}, "sub")
        return found.episodes if found else None

    assert await listed(1) == [1, 2]
    two = await source.episodes({"id": 2}, "sub")
    assert two is not None and (two.episodes, two.source_title) == ([3], "Title 2")
    assert await listed(3) == [1]
    assert await listed(4) is None
    stream = await source.stream({"id": 2}, 3, "sub")
    assert stream is not None
    assert stream.url == (second / "2" / "sub" / "3" / "master.m3u8").as_uri()

    # Answers are reused for a while, misses included, so nothing touches the disk again.
    shutil.rmtree(first / "1")
    make_title(first, 4, [1])
    assert await listed(1) == [1, 2]
    assert await listed(4) is None
    source._cache.clear()
    assert await listed(1) is None
    assert await listed(4) == [1]


def test_library_links_may_point_into_any_library_folder(tmp_path: Path, monkeypatch):
    disk, nas = tmp_path / "d", tmp_path / "nas"
    make_title(nas, 7, [1])
    (nas / "7" / "sub" / "1" / "seg.m4s").write_bytes(b"x")
    disk.mkdir()
    # Moved to the NAS and linked back: served once the NAS folder is listed too.
    (disk / "7").symlink_to(nas / "7")
    link = (disk / "7" / "sub" / "1" / "seg.m4s").as_uri()
    monkeypatch.setattr(get_settings(), "local_library_dir", "")
    monkeypatch.setattr(get_settings(), "local_library_dirs", str(disk))
    assert hls.local_path(link) is None
    monkeypatch.setattr(get_settings(), "local_library_dirs", f"{disk}, {nas}")
    assert hls.local_path(link) == (nas / "7" / "sub" / "1" / "seg.m4s").resolve()
    assert hls.local_file((nas / "7" / "sub" / "1").as_uri()) is None  # a folder

    # Playlist links are judged by their path alone, without touching each file.
    assert hls.in_library((disk / "7" / "sub" / "1" / "missing.m4s").as_uri())
    assert not hls.in_library(f"{(disk / '7').as_uri()}/../../secret.txt")
    assert not hls.in_library((tmp_path / "dx" / "a.m4s").as_uri())
    assert not hls.in_library("https://cdn.example/x")


@needs_ffmpeg
def test_scan_converts_every_folder_with_a_manifest(tmp_path: Path):
    tree = tmp_path / "anime"
    good = tree / "Clannad"
    good.mkdir(parents=True)
    make_episode(good, "Clannad - 01.mkv", make_font("Test Sans"))
    (good / "moonroom.toml").write_text('mal_id = 2167\ntitle = "Clannad"\n')
    broken = tree / "Broken"
    broken.mkdir()
    (broken / "Broken - 01.mkv").write_bytes(b"not a video")
    (broken / "moonroom.toml").write_text("mal_id = 5\n")
    bad_manifest = tree / "Typo"
    bad_manifest.mkdir()
    (bad_manifest / "moonroom.toml").write_text("mal = 5\n")
    loose = tree / "Unsorted" / "Show"
    loose.mkdir(parents=True)
    (loose / "Show - 01.mkv").write_bytes(b"")
    (tree / ".trash").mkdir()
    (tree / ".trash" / "moonroom.toml").write_text("mal_id = 6\n")
    library = tmp_path / "library"
    options = Options(preset="ultrafast")

    dry = scan(tree, library, options, dry_run=True, log=lambda _: None)
    assert dry.converted == 0 and not library.exists()

    report = scan(tree, library, options, log=lambda _: None)
    assert (report.converted, report.skipped) == (1, 0)
    failed = dict(report.failed)
    assert set(failed) == {f"{broken} episode 1", str(bad_manifest)}
    assert "ffprobe failed" in failed[f"{broken} episode 1"]
    assert report.unmapped == [loose]
    assert read_json(library / "2167" / "sub" / "title.json")["episodes"] == [1]
    # The failed episode left nothing half-written behind.
    assert read_json(library / "5" / "sub" / "title.json")["episodes"] == []
    assert not list((library / "5" / "sub").glob(".*"))

    again = scan(tree, library, options, log=lambda _: None)
    assert (again.converted, again.skipped) == (0, 1)
    log = write_log(library, tree, again).read_text()
    assert "0 converted, 1 already done, 2 failed, 1 without moonroom.toml" in log
    assert f"no moonroom.toml: {loose}" in log
