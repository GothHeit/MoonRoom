"""Health reports from the TV player, written to the API log, to find out what grows on a TV
before it hangs (memory, buffer, dropped frames, player errors). Nothing is stored."""

import logging
from typing import Annotated

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field, StringConstraints

from app.deps import CurrentUser, throttle

router = APIRouter(prefix="/tv", tags=["tv"])
logger = logging.getLogger("app.tv_health")
# Uvicorn only sets up its own loggers, so INFO lines from the app would go nowhere: give these
# reports their own line on the API's output.
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    # Printed once, by its own handler, even where the root logger has one too.
    logger.propagate = False

Short = Annotated[str, StringConstraints(max_length=40, pattern=r"^[\w.:/ -]*$")]


class TvHealthIn(BaseModel):
    # Why this report was sent: "tick" (every 30 s), "error" (a fatal player error), "stall".
    reason: Short = "tick"
    source: Short = ""
    anime_id: int = Field(default=0, ge=0)
    episode: float = Field(default=0, ge=0)
    # Seconds since the page loaded, and the playback position.
    uptime_s: float = Field(default=0, ge=0, le=10**7)
    position_s: float = Field(default=0, ge=0, le=10**6)
    buffered_ahead_s: float = Field(default=0, ge=0, le=10**5)
    buffered_behind_s: float = Field(default=0, ge=0, le=10**5)
    buffered_ranges: int = Field(default=0, ge=0, le=10**4)
    ready_state: int = Field(default=0, ge=0, le=4)
    paused: bool = False
    level_height: int = Field(default=0, ge=0, le=10_000)
    dropped_frames: int = Field(default=0, ge=0)
    total_frames: int = Field(default=0, ge=0)
    # Chromium's own JavaScript heap figures, in MB; 0 where the browser doesn't report them.
    js_heap_mb: float = Field(default=0, ge=0, le=10**6)
    js_heap_limit_mb: float = Field(default=0, ge=0, le=10**6)
    dom_nodes: int = Field(default=0, ge=0, le=10**7)
    styled_subtitles: bool = False
    # Player errors since the last report, by hls.js detail name.
    errors: dict[Short, Annotated[int, Field(ge=0, le=10**6)]] = Field(
        default_factory=dict, max_length=12
    )


@router.post("/health", status_code=204, dependencies=[throttle("tv_health")])
async def tv_health(body: TvHealthIn, user: CurrentUser) -> Response:
    errors = ",".join(f"{k}={v}" for k, v in sorted(body.errors.items())) or "-"
    logger.info(
        "tv health user=%s reason=%s source=%s anime=%s ep=%g up=%.0fs pos=%.0fs ahead=%.1fs "
        "behind=%.1fs ranges=%d ready=%d paused=%s height=%d dropped=%d/%d heap=%.0f/%.0fMB "
        "dom=%d styled=%s errors=%s",
        user.username,
        body.reason,
        body.source or "-",
        body.anime_id,
        body.episode,
        body.uptime_s,
        body.position_s,
        body.buffered_ahead_s,
        body.buffered_behind_s,
        body.buffered_ranges,
        body.ready_state,
        body.paused,
        body.level_height,
        body.dropped_frames,
        body.total_frames,
        body.js_heap_mb,
        body.js_heap_limit_mb,
        body.dom_nodes,
        body.styled_subtitles,
        errors,
    )
    return Response(status_code=204)
