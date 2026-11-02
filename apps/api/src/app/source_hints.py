"""Which sources have a title at all, as the title page found out. Shared by the title page and
the player's source menu, so the menu doesn't ask sources the page already knows lack it."""

from cachetools import TLRUCache

# How long a source's answer (it has the title or not) is trusted.
SOURCE_HINT_TTL = 900
# A source that failed to answer is asked again sooner; its hint says nothing about the title.
SOURCE_FAILURE_TTL = 60

# Values are (found, ttl): failures are remembered too, but only briefly.
type SourceHints = TLRUCache[tuple[str, int], tuple[bool, float]]


def new_source_hints() -> SourceHints:
    return TLRUCache(maxsize=2048, ttu=lambda _key, value, now: now + value[1])


def lacks_subbed(hints: SourceHints, name: str, anime_id: int) -> bool:
    """True only when the source answered that it has no subbed episodes of this title. The
    title page asks for the subbed listing only, so this says nothing about a dub."""
    found = hints.get((name, anime_id))
    return found is not None and not found[0] and found[1] == SOURCE_HINT_TTL
