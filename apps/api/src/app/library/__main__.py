"""python -m app.library ingest <folder> --out <library> [--mal-id N] [--dry-run]
python -m app.library scan <tree> --out <library> [--dry-run]

Converts a folder of episodes (ingest), or every folder with a moonroom.toml under a tree
(scan), for the `local` video source. See deploy/README.md."""

import argparse
import os
from pathlib import Path

from app.library.ingest import IngestError, Options, find_episodes, ingest, load_manifest
from app.library.scan import scan, write_log


def _out(cmd: argparse.ArgumentParser) -> None:
    cmd.add_argument(
        "--out",
        type=Path,
        default=os.environ.get("LOCAL_LIBRARY_DIR") or None,
        help="library folder to write to (default: $LOCAL_LIBRARY_DIR)",
    )


def _encoding(cmd: argparse.ArgumentParser) -> None:
    cmd.add_argument("--force", action="store_true", help="convert again even if done")
    cmd.add_argument(
        "--preset",
        default=Options.preset,
        help=f"x264 preset for the H.264 copy (default {Options.preset}; slower is smaller)",
    )
    cmd.add_argument(
        "--crf",
        type=int,
        default=Options.crf,
        help=f"x264 quality, lower is better (default {Options.crf})",
    )


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.library")
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("ingest", help="convert a folder of episodes")
    cmd.add_argument("folder", type=Path, help="folder with the episode files (read only)")
    _out(cmd)
    cmd.add_argument("--manifest", type=Path, help="default: <folder>/moonroom.toml")
    cmd.add_argument("--mal-id", type=int)
    cmd.add_argument("--lang", choices=["sub", "dub"])
    cmd.add_argument("--title")
    cmd.add_argument("--default-subtitle", help='subtitle track title to start with, e.g. "Emmid"')
    cmd.add_argument("--episodes", help="only these episode numbers, e.g. 1,2,5")
    _encoding(cmd)
    cmd.add_argument("--dry-run", action="store_true", help="only show the episode mapping")
    walk = commands.add_parser("scan", help="convert every folder with a moonroom.toml in a tree")
    walk.add_argument("tree", type=Path, help="top folder of the originals (read only)")
    _out(walk)
    _encoding(walk)
    walk.add_argument("--dry-run", action="store_true", help="only list what would be converted")
    args = parser.parse_args()

    try:
        if args.command == "scan":
            _scan(args)
        else:
            _ingest(args)
    except IngestError as e:
        raise SystemExit(f"error: {e}") from e


def _scan(args: argparse.Namespace) -> None:
    if args.out is None and not args.dry_run:
        raise IngestError("Pass --out or set LOCAL_LIBRARY_DIR")
    options = Options(force=args.force, preset=args.preset, crf=args.crf)
    report = scan(args.tree, args.out, options, dry_run=args.dry_run)
    if args.dry_run:
        return
    log = write_log(args.out, args.tree, report)
    print(
        f"Done: {report.converted} converted, {report.skipped} already done, "
        f"{len(report.failed)} failed (see {log})"
    )
    if report.failed:
        raise SystemExit(1)


def _ingest(args: argparse.Namespace) -> None:
    manifest = load_manifest(
        args.folder,
        args.manifest,
        {
            "mal_id": args.mal_id,
            "lang": args.lang,
            "title": args.title,
            "default_subtitle": args.default_subtitle,
        },
    )
    if args.dry_run:
        print(f"MAL {manifest.mal_id} ({manifest.lang}) {manifest.title or args.folder.name!r}")
        for number, path in sorted(find_episodes(args.folder, manifest).items()):
            print(f"  {number:>4}  {path.name}")
        return
    if args.out is None:
        raise IngestError("Pass --out or set LOCAL_LIBRARY_DIR")
    only = {int(n) for n in args.episodes.split(",")} if args.episodes else None
    options = Options(force=args.force, preset=args.preset, crf=args.crf)
    result = ingest(args.folder, args.out, manifest, options, only)
    print(f"Done: {result.converted} episode(s) converted")


if __name__ == "__main__":
    main()
