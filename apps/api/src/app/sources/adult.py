"""Which titles the adult sources may answer for.

The adult sources only carry titles in MAL's adult genre, so they skip every other entry
without a request. Whether a user may see such a title at all is the MAL client's job
(`visible_details` honours the per-user +18 switch before any source is asked).
"""

ADULT_GENRE_ID = 12
ADULT_RATING = "rx"


def is_adult(anime: dict) -> bool:
    if (anime.get("rating") or "") == ADULT_RATING:
        return True
    return any(g.get("id") == ADULT_GENRE_ID for g in anime.get("genres") or [])
