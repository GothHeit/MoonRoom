"""The converted local library: how `python -m app.library ingest` lays it out on disk, and
how the `local` video source reads it back.

    <root>/<mal id>/<sub|dub>/title.json            name, finished episodes, thumbnails
    <root>/<mal id>/<sub|dub>/fonts/                 fonts embedded in the original files
    <root>/<mal id>/<sub|dub>/fonts.json             font name (lower case) -> file in fonts/
    <root>/<mal id>/<sub|dub>/<episode>/master.m3u8  HLS master, one variant per folder
    <root>/<mal id>/<sub|dub>/<episode>/episode.json subtitles, skips; written last

An episode folder only counts once its episode.json exists, so a conversion that was cut off
never shows up as playable. title.json lists the finished episodes, rewritten after each one,
so listing a title is one small read even when the library sits on a network share. A library
can span several folders (see LOCAL_LIBRARY_DIRS); a title lives in one of them.
"""

import json
from pathlib import Path
from typing import Any

TITLE_META = "title.json"
EPISODE_META = "episode.json"
MASTER = "master.m3u8"
FONTS_DIR = "fonts"
FONT_INDEX = "fonts.json"
THUMBNAIL = "thumb.jpg"


def title_dir(root: Path, mal_id: int, lang: str) -> Path:
    return root / str(mal_id) / lang


def read_json(path: Path) -> Any:
    """The parsed file, or None when it is missing or unreadable."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def finished_episodes(title: Path) -> tuple[list[int], list[int]]:
    """Walks a title folder: the episodes whose episode.json exists, and those of them that have
    a thumbnail. Costs a few metadata calls per episode, so the API only does this for titles
    converted before title.json held the list."""
    try:
        names = [p.name for p in title.iterdir() if p.name.isdigit()]
    except OSError:
        return [], []
    done = sorted(int(n) for n in names if (title / n / EPISODE_META).is_file())
    return done, [ep for ep in done if (title / str(ep) / THUMBNAIL).is_file()]


def write_title(title: Path, name: str) -> None:
    """(Re)writes title.json from what is on disk. Written under a temporary name and renamed,
    so a reader never sees half a file."""
    episodes, thumbnails = finished_episodes(title)
    partial = title / f".{TITLE_META}.partial"
    write_json(partial, {"title": name, "episodes": episodes, "thumbnails": thumbnails})
    partial.replace(title / TITLE_META)
