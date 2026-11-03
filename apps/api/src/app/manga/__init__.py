from app.manga.base import MangaSource
from app.manga.madara import SITES
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
        elif name == "mangapill":
            from app.manga.mangapill import MangapillSource

            sources[name] = MangapillSource(shared=shared)
        elif name in SITES:
            from app.manga.madara import MadaraSource

            base, lang, prefix = SITES[name]
            sources[name] = MadaraSource(name, base, lang, shared=shared, prefix=prefix)
        elif name == "leituramanga":
            from app.manga.leituramanga import LeituramangaSource

            sources[name] = LeituramangaSource(shared=shared)
        elif name == "toonbr":
            from app.manga.toonbr import ToonbrSource

            sources[name] = ToonbrSource(shared=shared)
        else:
            raise ValueError(f"Unknown manga source: {name}")
    return sources
