"""Path parameter types that keep ids inside what the database columns can hold.

An id past the size of an int column, or an episode number nobody could reach, would otherwise
get as far as the database and come back as a 500."""

from typing import Annotated

from fastapi import Path

INT_MAX = 2**31 - 1
MAX_EPISODE = 10_000

AnimeId = Annotated[int, Path(ge=1, le=INT_MAX)]
MangaId = Annotated[int, Path(ge=1, le=INT_MAX)]
# 0 is allowed for saved progress (a title opened but not started); playing needs episode 1+.
EpisodeNumber = Annotated[int, Path(ge=0, le=MAX_EPISODE)]
PlayableEpisode = Annotated[int, Path(ge=1, le=MAX_EPISODE)]
