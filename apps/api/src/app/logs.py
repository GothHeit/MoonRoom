"""Logging setup that keeps credentials out of log files.

Players that can't send an Authorization header carry their token in the query string, and the
MAL callback carries an OAuth code and state there. Access logs would otherwise write them out.
"""

import logging
import re

# Query parameters whose values are credentials or signatures.
SECRET_PARAMS = ("token", "s", "i", "sig", "code", "state", "refresh_token", "access_token")

_SECRET_QUERY = re.compile(r"([?&](?:" + "|".join(SECRET_PARAMS) + r")=)[^&#\s]*")


def redact(text: str) -> str:
    """Replaces the value of every secret query parameter in a path or URL."""
    return _SECRET_QUERY.sub(r"\1[redacted]", text)


class RedactSecrets(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            # Not only strings: httpx logs URL objects, and exceptions can carry a URL too.
            record.args = tuple(
                a if isinstance(a, int | float) else redact(str(a)) for a in record.args
            )
        elif isinstance(record.msg, str):
            record.msg = redact(record.msg)
        return True


def install_logging() -> None:
    """Redact the loggers that print request paths or URLs, and print the app's own INFO lines
    (cleanup counts, security events), which the default setup drops."""
    for name in ("uvicorn.access", "uvicorn.error", "httpx"):
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactSecrets) for f in logger.filters):
            logger.addFilter(RedactSecrets())
    app_logger = logging.getLogger("app")
    if not app_logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        handler.addFilter(RedactSecrets())
        app_logger.addHandler(handler)
        app_logger.setLevel(logging.INFO)
