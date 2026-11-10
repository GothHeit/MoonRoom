import logging

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError

logger = logging.getLogger(__name__)


class ApiError(Exception):
    """An error the clients can translate.

    `code` is stable and is what the web and app translations key on. `message` is
    English and only meant for logs and API explorers.
    """

    def __init__(self, status: int, code: str, message: str, headers: dict[str, str] | None = None):
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers


def _body(code: str, message: str, **extra) -> dict:
    return {"error": {"code": code, "message": message, **extra}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError):
        return JSONResponse(
            _body(exc.code, exc.message), status_code=exc.status, headers=exc.headers
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        return JSONResponse(
            _body(
                "validation_failed",
                "Request validation failed",
                details=jsonable_encoder(exc.errors()),
            ),
            status_code=422,
        )

    @app.exception_handler(DBAPIError)
    async def database_error(request: Request, exc: DBAPIError):
        # Postgres refuses a NUL character in text. Names and ids are validated at the edge, so
        # this catches the ones that slipped through (a free-text field nobody thought of).
        if "NUL" in str(exc.orig):
            return JSONResponse(
                _body("validation_failed", "Request validation failed"), status_code=422
            )
        return _internal_error(request, exc)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, __: Exception):
        # The server logs the traceback itself when this handler returns, so it isn't logged here.
        return JSONResponse(_body("internal_error", "Something went wrong"), status_code=500)


def _internal_error(request: Request, exc: Exception) -> JSONResponse:
    """Logs the failure once and answers JSON, so clients can show a translated message."""
    logger.error(
        "unhandled %s on %s %s",
        type(exc).__name__,
        request.method,
        request.url.path,
        exc_info=exc,
    )
    return JSONResponse(_body("internal_error", "Something went wrong"), status_code=500)
