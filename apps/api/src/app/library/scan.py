"""Walks a folder tree and converts every folder that has a moonroom.toml, so a whole
collection is one command. Folders with videos but no manifest are listed, so you know which
ones still need one. Each run appends what happened to a log file next to the library."""

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from app.library.ingest import (
    MANIFEST,
    VIDEO_EXTENSIONS,
    IngestError,
    Options,
    find_episodes,
    ingest,
    load_manifest,
)

LOG_FILE = "ingest.log"


@dataclass
class Report:
    converted: int = 0
    skipped: int = 0
    # Folder (with episode number when one episode failed) -> why.
    failed: list[tuple[str, str]] = field(default_factory=list)
    # Folders with video files and no moonroom.toml.
    unmapped: list[Path] = field(default_factory=list)


def find_folders(tree: Path) -> tuple[list[Path], list[Path]]:
    """Folders with a manifest, and folders with videos but none. Hidden folders and symlinked
    folders are skipped (a link back up the tree would loop)."""
    with_manifest: list[Path] = []
    without: list[Path] = []
    for here, dirs, files in os.walk(tree):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        folder = Path(here)
        if MANIFEST in files:
            with_manifest.append(folder)
        elif any(Path(f).suffix.lower() in VIDEO_EXTENSIONS for f in files):
            without.append(folder)
    return with_manifest, without


def scan(
    tree: Path,
    root: Path,
    options: Options,
    dry_run: bool = False,
    log: Callable[[str], None] = print,
) -> Report:
    report = Report()
    folders, report.unmapped = find_folders(tree)
    for folder in folders:
        log(f"== {folder}")
        try:
            manifest = load_manifest(folder, None, {})
            if dry_run:
                episodes = find_episodes(folder, manifest)
                log(f"  MAL {manifest.mal_id} ({manifest.lang}): {len(episodes)} episode(s)")
                continue
            result = ingest(folder, root, manifest, options, log=log, keep_going=True)
        except (IngestError, OSError) as e:
            report.failed.append((str(folder), str(e)))
            log(f"  FAILED: {e}")
            continue
        report.converted += result.converted
        report.skipped += result.skipped
        report.failed += [(f"{folder} episode {n}", why) for n, why in result.failed.items()]
    for folder in report.unmapped:
        log(f"-- no {MANIFEST}: {folder}")
    return report


def write_log(root: Path, tree: Path, report: Report) -> Path:
    """Appends a summary of the run to <library>/ingest.log."""
    path = root / LOG_FILE
    stamp = datetime.now(UTC).isoformat(timespec="seconds")
    lines = [
        f"{stamp} scan {tree}: {report.converted} converted, {report.skipped} already done, "
        f"{len(report.failed)} failed, {len(report.unmapped)} without {MANIFEST}"
    ]
    lines += [
        f"  FAILED {where}: {why.splitlines()[-1] if why else ''}" for where, why in report.failed
    ]
    lines += [f"  no {MANIFEST}: {folder}" for folder in report.unmapped]
    root.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return path
