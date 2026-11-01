import logging
from collections.abc import Awaitable

import httpx

from app.errors import ApiError

log = logging.getLogger(__name__)


async def soft[T](work: Awaitable[T], what: str) -> T | None:
    """Run one optional section: a failure (MAL down, expired link) is logged and becomes None."""
    try:
        return await work
    except ApiError as exc:
        log.warning("%s unavailable: %s", what, exc.code)
    except httpx.HTTPError as exc:
        log.warning("%s failed: %s", what, exc)
    except ValueError as exc:  # e.g. a MAL token that TOKEN_ENCRYPTION_KEY can't decrypt
        log.warning("%s failed: %s", what, exc)
    return None
