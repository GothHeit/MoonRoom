import logging
from pathlib import Path

from app.config import get_settings
from app.sources.base import VideoSource

log = logging.getLogger(__name__)

# Sources that no longer exist. Skipped with a warning so an old VIDEO_SOURCES still boots.
RETIRED = {"allanime"}


def load_sources(names: list[str]) -> dict[str, VideoSource]:
    """Build the enabled sources. Imports are lazy so a public deployment never loads
    (or needs installed) a private source."""
    sources: dict[str, VideoSource] = {}
    for name in names:
        if name in RETIRED:
            log.warning("Video source %r was removed; drop it from VIDEO_SOURCES", name)
        elif name == "zoko":
            from app.sources.zoko import ZokoSource

            sources[name] = ZokoSource()
        elif name == "animesdigital":
            from app.sources.animesdigital import AnimesDigitalSource

            sources[name] = AnimesDigitalSource()
        elif name == "animedrive":
            from app.sources.animedrive import AnimeDriveSource

            sources[name] = AnimeDriveSource()
        elif name == "kaa":
            from app.sources.kaa import KaaSource

            sources[name] = KaaSource()
        elif name == "anizone":
            from app.sources.anizone import AniZoneSource

            sources[name] = AniZoneSource()
        elif name == "local":
            from app.sources.local import LocalSource

            roots = get_settings().library_roots
            if not roots:
                raise ValueError("The local video source needs LOCAL_LIBRARY_DIRS")
            sources[name] = LocalSource([Path(r) for r in roots])
        else:
            raise ValueError(f"Unknown video source: {name}")
    return sources
