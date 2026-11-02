import uuid

from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import BaseModel

from app.avatars import (
    MAX_BYTES,
    PRESETS,
    avatar_path,
    delete_avatar,
    encode_avatar,
    save_avatar,
)
from app.config import get_settings
from app.deps import CurrentUser, Session, throttle
from app.errors import ApiError
from app.models import User
from app.routers.auth import MeOut, build_me

router = APIRouter(tags=["avatars"])


class PresetIn(BaseModel):
    preset: str


async def _read_limited(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise ApiError(413, "avatar_too_large", "The image is larger than 2 MB")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_BYTES:
            raise ApiError(413, "avatar_too_large", "The image is larger than 2 MB")
    return bytes(data)


@router.put("/me/avatar", response_model=MeOut, dependencies=[throttle("avatar_upload")])
async def upload_avatar(request: Request, user: CurrentUser, session: Session):
    """Sets the picture from the raw image bytes (PNG, JPEG or WebP, up to 2 MB). The server
    crops it to a square and stores a 256 px WebP."""
    data = await _read_limited(request)
    if not data:
        raise ApiError(415, "avatar_type", "Use a PNG, JPEG or WebP image")
    encoded = await encode_avatar(data)
    save_avatar(get_settings().avatar_dir, user.id, encoded)
    user.avatar_version += 1
    user.avatar_uploaded = True
    user.avatar_preset = None
    await session.commit()
    return await build_me(user, session)


@router.put("/me/avatar/preset", response_model=MeOut)
async def choose_preset(body: PresetIn, user: CurrentUser, session: Session):
    if body.preset not in PRESETS:
        raise ApiError(422, "avatar_preset", "Unknown preset")
    user.avatar_uploaded = False
    user.avatar_preset = body.preset
    await session.commit()
    delete_avatar(get_settings().avatar_dir, user.id)
    return await build_me(user, session)


@router.delete("/me/avatar", response_model=MeOut)
async def remove_avatar(user: CurrentUser, session: Session):
    """Back to the default: the linked MAL picture, or the user's initial."""
    user.avatar_uploaded = False
    user.avatar_preset = None
    await session.commit()
    delete_avatar(get_settings().avatar_dir, user.id)
    return await build_me(user, session)


@router.get("/users/{user_id}/avatar")
async def get_avatar(user_id: uuid.UUID, _: CurrentUser, session: Session):
    user = await session.get(User, user_id)
    path = avatar_path(get_settings().avatar_dir, user_id)
    if user is None or not user.avatar_uploaded or not path.is_file():
        raise ApiError(404, "not_found", "No uploaded picture")
    # The URL carries the version, so a changed picture is always a new URL.
    return Response(
        path.read_bytes(),
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )
