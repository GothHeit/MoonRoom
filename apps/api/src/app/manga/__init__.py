from app.manga.base import MangaSource
from app.sharedcache import SharedCache


def load_manga_sources(
    names: list[str], shared: SharedCache | None = None
) -> dict[str, MangaSource]:
    """Build the enabled manga sources, lazily imported like the video ones."""
    sources: dict[str, MangaSource] = {}
    for name in names:
        if name == "mangadex":
            from app.manga.mangadex import MangaDexSource

            sources[name] = MangaDexSource(shared=shared)
        else:
            raise ValueError(f"Unknown manga source: {name}")
    return sources
