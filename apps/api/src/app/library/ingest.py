"""Converts a folder of the user's own episodes into the local library (see app.library).

Per episode, an HLS master with up to two variants, so each device picks what it can play:
- the original video repackaged without re-encoding, when it is HEVC or 8-bit H.264;
- an 8-bit H.264 copy, unless the original already is one: x264 at a slow preset, which keeps
  the quality of a faster one in a smaller file (conversion runs once, playback forever).
Audio becomes stereo AAC (copied when it already is). Text subtitles are kept as ASS for the
web player's renderer, plus a WebVTT copy for native players. Fonts attached to the files
are collected once per title. Chapters named like an opening or ending become skips.

Needs ffmpeg and ffprobe on PATH. Only reads the originals, which stay where they are; everything
is written under the output folder, and an episode is assembled in a hidden folder next to its
final place.
"""

import hashlib
import json
import re
import shutil
import subprocess
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.library import (
    EPISODE_META,
    FONT_INDEX,
    FONTS_DIR,
    MASTER,
    THUMBNAIL,
    TITLE_META,
    read_json,
    title_dir,
    write_json,
    write_title,
)
from app.library.fonts import font_names

MANIFEST = "moonroom.toml"
VIDEO_EXTENSIONS = {".mkv", ".mp4", ".m4v", ".webm", ".mov"}
SEGMENT_SECONDS = 6
TEXT_SUBTITLES = {"ass", "ssa", "subrip", "webvtt", "mov_text", "text"}
FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".woff", ".woff2"}
# ISO 639-2 tags as found in mkv files -> the BCP 47 codes the player matches on.
LANGUAGES = {
    "por": "pt-BR",
    "pob": "pt-BR",
    "pt": "pt-BR",
    "eng": "en",
    "spa": "es",
    "jpn": "ja",
    "fre": "fr",
    "fra": "fr",
    "ger": "de",
    "deu": "de",
    "ita": "it",
}
# Tags a Brazilian Portuguese dub track may carry.
DUB_AUDIO = ("por", "pob", "pt", "pt-BR")
INTRO = re.compile(r"^\s*(op|opening|intro)\b", re.IGNORECASE)
OUTRO = re.compile(r"^\s*(ed|ending|outro|credits)\b", re.IGNORECASE)
# ASS vector drawings come out of the WebVTT conversion as their path commands.
DRAWING = re.compile(r"^m\s+-?[\d.]+\s+-?[\d.]+(\s+[mnlbspc]|\s+-?[\d.]+)*\s*$")
BRACKETS = re.compile(r"\[[^\]]*\]|\([^)]*\)|\{[^}]*\}")
NUMBER = re.compile(r"(?<![\w.])(\d{1,4})(?:v\d)?(?![\w.])")


class IngestError(Exception):
    pass


@dataclass
class Manifest:
    """What a folder holds. Read from moonroom.toml in the folder; command line flags win."""

    mal_id: int
    lang: str = "sub"
    title: str = ""
    # Regex whose first group is the episode number; default: the last number in the name
    # outside brackets.
    episode_pattern: str = ""
    episode_offset: int = 0
    # File name -> episode number, for names no pattern fits. Wins over the pattern.
    episodes: dict[str, int] = field(default_factory=dict)
    # Part of the subtitle track title to show first, e.g. "EmmidSubs".
    default_subtitle: str = ""
    # Audio track to keep, by language tag; the first one when none matches. Default:
    # Japanese for "sub", Portuguese for "dub".
    audio_language: str = ""

    def audio_languages(self) -> tuple[str, ...]:
        if self.audio_language:
            return (self.audio_language,)
        return DUB_AUDIO if self.lang == "dub" else ("jpn",)


@dataclass(frozen=True)
class Options:
    force: bool = False
    preset: str = "slow"
    crf: int = 19


@dataclass
class Result:
    converted: int = 0
    skipped: int = 0
    # Episode number -> why it failed (only when ingest was told to keep going).
    failed: dict[int, str] = field(default_factory=dict)


def load_manifest(folder: Path, path: Path | None, overrides: dict[str, Any]) -> Manifest:
    data: dict[str, Any] = {}
    source = path or folder / MANIFEST
    if source.is_file():
        with source.open("rb") as f:
            data = tomllib.load(f)
    elif path is not None:
        raise IngestError(f"Manifest not found: {path}")
    data.update({k: v for k, v in overrides.items() if v is not None})
    if "mal_id" not in data:
        raise IngestError(f"No MAL id: write mal_id in {source} or pass --mal-id")
    if data.get("lang", "sub") not in ("sub", "dub"):
        raise IngestError("lang must be sub or dub")
    known = Manifest.__dataclass_fields__
    unknown = set(data) - set(known)
    if unknown:
        raise IngestError(f"Unknown manifest keys: {', '.join(sorted(unknown))}")
    # The title stays empty when nothing names it, so a later run keeps the one already stored.
    return Manifest(**data)


def episode_number(name: str, manifest: Manifest) -> int | None:
    if name in manifest.episodes:
        return manifest.episodes[name]
    stem = Path(name).stem
    if manifest.episode_pattern:
        match = re.search(manifest.episode_pattern, stem)
        found = match.group(1) if match else None
    else:
        numbers = NUMBER.findall(BRACKETS.sub(" ", stem))
        found = numbers[-1] if numbers else None
    return int(found) + manifest.episode_offset if found else None


def find_episodes(folder: Path, manifest: Manifest) -> dict[int, Path]:
    """Episode number -> file. Refuses to guess when two files land on the same number."""
    found: dict[int, Path] = {}
    for path in sorted(folder.iterdir()):
        if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        number = episode_number(path.name, manifest)
        if number is None or number < 1:
            raise IngestError(f"No episode number in {path.name!r}: add it to [episodes]")
        if number in found:
            raise IngestError(
                f"{found[number].name!r} and {path.name!r} are both episode {number}: "
                "set episode_pattern or [episodes]"
            )
        found[number] = path
    if not found:
        raise IngestError(f"No video files in {folder}")
    return found


def run(args: list[str], cwd: Path | None = None, quiet: bool = True) -> str:
    """Runs ffmpeg or ffprobe; its error output becomes the exception message."""
    try:
        done = subprocess.run(
            args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE if quiet else None,
            text=True,
            check=False,
        )
    except FileNotFoundError as e:
        raise IngestError(f"{args[0]} is not installed") from e
    if done.returncode != 0:
        raise IngestError(f"{args[0]} failed: {(done.stderr or '').strip()[-2000:]}")
    return done.stdout


def probe(path: Path) -> dict[str, Any]:
    out = run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_streams", "-show_format", "-show_chapters", str(path),
        ]
    )  # fmt: skip
    return json.loads(out)


def _pick_video(streams: list[dict]) -> dict:
    for s in streams:
        if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic"):
            return s
    raise IngestError("No video stream")


def pick_audio(streams: list[dict], languages: tuple[str, ...]) -> dict:
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if not audio:
        raise IngestError("No audio stream")
    wanted = [s for s in audio if s.get("tags", {}).get("language") in languages]
    return (wanted or audio)[0]


def copyable(video: dict) -> bool:
    """Whether browsers can play the original video as is: HEVC (where the device decodes
    it) or 8-bit H.264. 10-bit H.264 plays almost nowhere."""
    if video.get("codec_name") == "hevc":
        return True
    return video.get("codec_name") == "h264" and video.get("pix_fmt") in ("yuv420p", "yuvj420p")


def codec_tag(video: dict) -> str:
    """The RFC 6381 CODECS entry for a video stream, so players skip what they can't decode."""
    level = int(video.get("level") or 0)
    if video.get("codec_name") == "hevc":
        main10 = "10" in str(video.get("profile", ""))
        return f"hvc1.{2 if main10 else 1}.{4 if main10 else 6}.L{level or 120}.B0"
    profiles = {"high": 0x64, "main": 0x4D, "baseline": 0x42, "constrained baseline": 0x42}
    profile = profiles.get(str(video.get("profile", "")).lower(), 0x64)
    return f"avc1.{profile:02x}00{level or 40:02x}"


def _audio_args(audio: dict) -> list[str]:
    if audio.get("codec_name") == "aac" and int(audio.get("channels") or 2) <= 2:
        return ["-c:a", "copy"]
    return ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]


def _hls_args(out: Path) -> list[str]:
    return [
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-f", "hls", "-hls_time", str(SEGMENT_SECONDS), "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", str(out / "seg_%05d.m4s"), str(out / "index.m3u8"),
    ]  # fmt: skip


def remux(src: Path, video: dict, audio: dict, out: Path) -> None:
    out.mkdir()
    tag = ["-tag:v", "hvc1"] if video.get("codec_name") == "hevc" else []
    run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
         "-map", f"0:{video['index']}", "-map", f"0:{audio['index']}", "-c:v", "copy", *tag,
         *_audio_args(audio), *_hls_args(out)]
    )  # fmt: skip


def encode_h264(src: Path, video: dict, audio: dict, out: Path, options: Options) -> None:
    out.mkdir()
    # Error diffusion while dropping to 8 bits keeps gradients from banding.
    scale = "scale=flags=lanczos+accurate_rnd:sws_dither=ed,format=yuv420p"
    run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-stats", "-y", "-i", str(src),
         "-map", f"0:{video['index']}", "-map", f"0:{audio['index']}", "-vf", scale,
         "-c:v", "libx264", "-preset", options.preset, "-crf", str(options.crf),
         "-tune", "animation", "-profile:v", "high", "-maxrate", "10M", "-bufsize", "20M",
         "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_SECONDS})",
         *_audio_args(audio), *_hls_args(out)],
        quiet=False,
    )  # fmt: skip


def bandwidth(variant: Path) -> tuple[int, int]:
    """Peak and average bits per second, from the segment sizes and durations."""
    playlist = (variant / "index.m3u8").read_text(encoding="utf-8")
    durations = [float(m) for m in re.findall(r"#EXTINF:([\d.]+)", playlist)]
    segments = [line for line in playlist.splitlines() if line and not line.startswith("#")]
    sizes = [(variant / s).stat().st_size for s in segments]
    total = sum(durations) or 1.0
    peak = max(
        (size * 8 / max(d, 0.5) for size, d in zip(sizes, durations, strict=True)), default=0
    )
    average = (sum(sizes) + (variant / "init.mp4").stat().st_size) * 8 / total
    return int(peak), int(average)


def audio_codec_tag(audio: dict) -> str:
    """The CODECS entry for the audio as stored: AAC is copied with its profile, anything else
    becomes AAC-LC."""
    if _audio_args(audio)[1] == "copy":
        profile = str(audio.get("profile", "")).lower()
        if profile == "he-aacv2":
            return "mp4a.40.29"
        if profile == "he-aac":
            return "mp4a.40.5"
    return "mp4a.40.2"


def master_playlist(variants: list[tuple[str, dict]], audio_codec: str = "mp4a.40.2") -> str:
    lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for folder, info in variants:
        lines.append(
            f"#EXT-X-STREAM-INF:BANDWIDTH={info['peak']},AVERAGE-BANDWIDTH={info['average']},"
            f'CODECS="{info["codec"]},{audio_codec}",RESOLUTION={info["width"]}x{info["height"]}'
        )
        lines.append(f"{folder}/index.m3u8")
    return "\n".join(lines) + "\n"


def _variant_info(variant: Path) -> dict:
    video = _pick_video(probe(variant / "index.m3u8")["streams"])
    peak, average = bandwidth(variant)
    return {
        "codec": codec_tag(video),
        "width": video.get("width"),
        "height": video.get("height"),
        "peak": peak,
        "average": average,
    }


def language(tag: str | None) -> str:
    return LANGUAGES.get((tag or "").lower(), tag or "und")


def clean_vtt(text: str) -> str:
    """Drops the cues that are only ASS drawings, which read as gibberish without styling."""
    blocks = text.replace("\r\n", "\n").split("\n\n")
    kept = []
    for block in blocks:
        lines = block.split("\n")
        timing = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if timing is not None:
            body = [line for line in lines[timing + 1 :] if not DRAWING.match(line.strip())]
            if not any(line.strip() for line in body):
                continue
            lines = lines[: timing + 1] + body
        kept.append("\n".join(lines))
    return "\n\n".join(kept).rstrip("\n") + "\n"


def subtitle_order(tracks: list[dict], preferred: str) -> list[dict]:
    """The preferred group's track first (by title), then the file's default, then the rest
    in file order. The player starts with the first track in the viewer's language."""

    def rank(track: dict) -> int:
        if preferred and preferred.lower() in track["label"].lower():
            return 0
        return 1 if track["default"] else 2

    return sorted(tracks, key=rank)


def extract_subtitles(src: Path, streams: list[dict], out: Path, preferred: str) -> list[dict]:
    subs = [s for s in streams if s.get("codec_type") == "subtitle"]
    subs = [s for s in subs if s.get("codec_name") in TEXT_SUBTITLES]
    if not subs:
        return []
    out.mkdir()
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src)]
    tracks = []
    for n, stream in enumerate(subs):
        styled = stream.get("codec_name") in ("ass", "ssa")
        if styled:
            args += ["-map", f"0:{stream['index']}", "-c:s", "copy", str(out / f"{n}.ass")]
        args += ["-map", f"0:{stream['index']}", "-c:s", "webvtt", str(out / f"{n}.vtt")]
        tags = stream.get("tags", {})
        lang = language(tags.get("language"))
        tracks.append(
            {
                "lang": lang,
                "label": tags.get("title") or lang,
                "vtt": f"subs/{n}.vtt",
                "ass": f"subs/{n}.ass" if styled else None,
                "default": bool(stream.get("disposition", {}).get("default")),
            }
        )
    run(args)
    for n in range(len(subs)):
        vtt = out / f"{n}.vtt"
        vtt.write_text(clean_vtt(vtt.read_text(encoding="utf-8")), encoding="utf-8")
    ordered = subtitle_order(tracks, preferred)
    return [{k: v for k, v in t.items() if k != "default"} for t in ordered]


def _font_file(stream: dict) -> bool:
    tags = stream.get("tags", {})
    mimetype = str(tags.get("mimetype", "")).lower()
    suffix = Path(str(tags.get("filename", ""))).suffix.lower()
    return "font" in mimetype or suffix in FONT_EXTENSIONS


def collect_fonts(src: Path, streams: list[dict], scratch: Path, title: Path) -> int:
    """Adds the file's attached fonts to the title's shared folder and name index. Files are
    named by content, so the same font attached to every episode is stored once."""
    fonts = [s for s in streams if s.get("codec_type") == "attachment" and _font_file(s)]
    if not fonts:
        return 0
    scratch.mkdir()
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for n, stream in enumerate(fonts):
        args += [f"-dump_attachment:{stream['index']}", str(scratch / str(n))]
    # Attachments are written while the input opens; the null output only satisfies ffmpeg.
    run([*args, "-i", str(src), "-t", "0", "-f", "null", "-"])
    shared = title / FONTS_DIR
    shared.mkdir(exist_ok=True)
    index: dict[str, str] = read_json(title / FONT_INDEX) or {}
    added = 0
    for n, stream in enumerate(fonts):
        data = (scratch / str(n)).read_bytes()
        suffix = Path(str(stream.get("tags", {}).get("filename", ""))).suffix.lower()
        name = hashlib.sha256(data).hexdigest()[:20] + (suffix if suffix in FONT_EXTENSIONS else "")
        if not (shared / name).exists():
            (shared / name).write_bytes(data)
            added += 1
        for family in font_names(data):
            index.setdefault(family.lower(), name)
    write_json(title / FONT_INDEX, index)
    shutil.rmtree(scratch)
    return added


def chapter_skips(chapters: list[dict]) -> list[dict]:
    skips = []
    for chapter in chapters:
        name = str(chapter.get("tags", {}).get("title", ""))
        kind = "intro" if INTRO.match(name) else "outro" if OUTRO.match(name) else None
        if kind:
            start, end = float(chapter["start_time"]), float(chapter["end_time"])
            if end > start:
                skips.append({"kind": kind, "start": round(start, 3), "end": round(end, 3)})
    return skips


def thumbnail(src: Path, duration: float, out: Path) -> None:
    # A quarter in is usually past the opening and still spoiler-light.
    at = min(duration * 0.25, 300.0) if duration > 0 else 0.0
    run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{at:.2f}",
         "-i", str(src), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", str(out)]
    )  # fmt: skip


def _source_stamp(src: Path) -> dict:
    stat = src.stat()
    return {"file": src.name, "size": stat.st_size, "mtime": int(stat.st_mtime)}


def ingest_episode(
    src: Path, episode: int, title: Path, manifest: Manifest, options: Options
) -> bool:
    """Converts one file. False when it was already converted from the same file."""
    final = title / str(episode)
    stamp = _source_stamp(src)
    meta = read_json(final / EPISODE_META)
    if not options.force and meta and meta.get("source") == stamp:
        return False

    work = title / f".{episode}.partial"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    info = probe(src)
    streams = info["streams"]
    video = _pick_video(streams)
    audio = pick_audio(streams, manifest.audio_languages())

    variants: list[str] = []
    if copyable(video):
        name = "hevc" if video.get("codec_name") == "hevc" else "h264"
        remux(src, video, audio, work / name)
        variants.append(name)
    if "h264" not in variants:
        encode_h264(src, video, audio, work / "h264", options)
        variants.append("h264")
    details = [(v, _variant_info(work / v)) for v in variants]
    (work / MASTER).write_text(master_playlist(details, audio_codec_tag(audio)), encoding="utf-8")

    subtitles = extract_subtitles(src, streams, work / "subs", manifest.default_subtitle)
    collect_fonts(src, streams, work / "attachments", title)
    duration = float(info.get("format", {}).get("duration") or 0)
    thumbnail(src, duration, work / THUMBNAIL)

    write_json(
        work / EPISODE_META,
        {
            "source": stamp,
            "duration": duration,
            "height": max(int(d["height"] or 0) for _, d in details),
            "variants": variants,
            "subtitles": subtitles,
            "skips": chapter_skips(info.get("chapters", [])),
        },
    )
    if final.exists():
        shutil.rmtree(final)
    work.rename(final)
    return True


def title_name(title: Path, manifest: Manifest, folder: Path) -> str:
    """The manifest's title, else the one stored by an earlier run, else the folder name."""
    stored = read_json(title / TITLE_META)
    previous = stored.get("title") if isinstance(stored, dict) else None
    return manifest.title or previous or folder.name


def ingest(
    folder: Path,
    root: Path,
    manifest: Manifest,
    options: Options,
    only: set[int] | None = None,
    log=print,
    keep_going: bool = False,
) -> Result:
    """Converts every episode in `folder` (or just `only`). With `keep_going`, an episode that
    fails is reported in the result and the next one is tried; otherwise the error stops it."""
    episodes = find_episodes(folder, manifest)
    title = title_dir(root, manifest.mal_id, manifest.lang)
    title.mkdir(parents=True, exist_ok=True)
    name = title_name(title, manifest, folder)
    write_title(title, name)
    result = Result()
    for number, src in sorted(episodes.items()):
        if only is not None and number not in only:
            continue
        log(f"Episode {number}: {src.name}")
        try:
            converted = ingest_episode(src, number, title, manifest, options)
        except (IngestError, OSError) as e:
            if not keep_going:
                raise
            shutil.rmtree(title / f".{number}.partial", ignore_errors=True)
            result.failed[number] = str(e)
            log(f"  FAILED: {e}")
            continue
        if converted:
            result.converted += 1
            # Listed right away, so a long run shows each episode as soon as it is ready.
            write_title(title, name)
        else:
            result.skipped += 1
            log("  already converted, skipped")
    write_title(title, name)
    return result
