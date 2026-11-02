"""Linking a user's MyAnimeList account (OAuth2 with PKCE) and editing their list."""

import asyncio
import secrets
import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
from cachetools import TTLCache
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import utcnow
from app.errors import ApiError
from app.mal.client import API_BASE, filter_nsfw
from app.models import MalLink, MalOAuthState, User

OAUTH_BASE = "https://myanimelist.net/v1/oauth2"
STATE_LIFETIME = timedelta(minutes=10)
LIST_CACHE_TTL = 60  # seconds: the home page and the list page both read the list
CALL_TIMEOUT = 15  # seconds: a full list page can be slow
MAX_CONCURRENT_CALLS = 4


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class MalAccounts:
    def __init__(self, settings: Settings, http: httpx.AsyncClient):
        self._settings = settings
        self._http = http
        self._slots = asyncio.Semaphore(MAX_CONCURRENT_CALLS)
        # (user id, status, nsfw) -> the user's list. Dropped whenever the site changes it.
        self._lists: TTLCache[tuple, dict] = TTLCache(maxsize=256, ttl=LIST_CACHE_TTL)

    async def _call(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """One MAL call with a timeout and a concurrency limit; network errors become a 502."""
        try:
            async with self._slots:
                return await self._http.request(method, url, timeout=CALL_TIMEOUT, **kwargs)
        except httpx.HTTPError as exc:
            raise ApiError(502, "mal_unavailable", f"MyAnimeList request failed: {exc}") from exc

    def _forget_lists(self, user_id: uuid.UUID) -> None:
        for key in [k for k in self._lists if k[0] == user_id]:
            del self._lists[key]

    async def authorize_url(self, session: AsyncSession, user: User) -> str:
        # MAL only supports the "plain" PKCE method.
        verifier = secrets.token_urlsafe(64)
        state = secrets.token_urlsafe(24)
        session.add(
            MalOAuthState(state=state, user_id=user.id, verifier=verifier, locale=user.locale)
        )
        await session.commit()
        params = {
            "response_type": "code",
            "client_id": self._settings.mal_client_id,
            "code_challenge": verifier,
            "code_challenge_method": "plain",
            "state": state,
            "redirect_uri": self._settings.mal_redirect_uri,
        }
        return f"{OAUTH_BASE}/authorize?{urlencode(params)}"

    async def state_locale(self, session: AsyncSession, state: str) -> str | None:
        pending = await session.get(MalOAuthState, state)
        return pending.locale if pending else None

    async def complete(
        self, session: AsyncSession, code: str, state: str, browser_user: uuid.UUID | None
    ) -> None:
        """`browser_user` is who the approving browser is signed in as. A link someone else
        started and passed along must not attach this browser's MAL account to them."""
        pending = await session.get(MalOAuthState, state)
        if pending is None or pending.created_at < utcnow() - STATE_LIFETIME:
            raise ApiError(400, "invalid_oauth_state", "Unknown or expired OAuth state")
        await session.delete(pending)  # single use, even when refused below
        if browser_user != pending.user_id:
            await session.commit()
            raise ApiError(400, "invalid_oauth_state", "Link started by a different session")

        tokens = await self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": pending.verifier,
                "redirect_uri": self._settings.mal_redirect_uri,
            }
        )
        if tokens is None:
            await session.commit()
            raise ApiError(400, "mal_link_failed", "MyAnimeList rejected the authorization")

        link = await session.get(MalLink, pending.user_id)
        if link is None:
            link = MalLink(user_id=pending.user_id)
            session.add(link)
        self._apply_tokens(link, tokens)
        profile = await self.profile(link.access_token)
        if profile:
            link.mal_username = profile.get("name")
            link.mal_picture = profile.get("picture")
        await session.commit()
        self._forget_lists(link.user_id)  # a different MAL account may now be behind it

    async def status(self, session: AsyncSession, user: User) -> dict:
        link = await session.get(MalLink, user.id)
        if link is None:
            return {"connected": False}
        result = {
            "connected": True,
            "mal_username": link.mal_username,
            "mal_picture": link.mal_picture,
            "statistics": None,
        }
        try:
            token = await self._valid_token(session, user)
        except ApiError:
            return result
        profile = await self.profile(token)
        if profile:
            result["statistics"] = profile.get("anime_statistics")
        return result

    async def disconnect(self, session: AsyncSession, user: User) -> None:
        await session.execute(delete(MalLink).where(MalLink.user_id == user.id))
        await session.commit()
        self._forget_lists(user.id)

    async def animelist(self, session: AsyncSession, user: User, status: str | None) -> dict:
        key = (user.id, status, user.show_nsfw)
        cached = self._lists.get(key)
        if cached is not None:
            return cached
        result = await self._fetch_animelist(session, user, status)
        self._lists[key] = result
        return result

    async def _fetch_animelist(self, session: AsyncSession, user: User, status: str | None) -> dict:
        token = await self._valid_token(session, user)
        first_params: dict[str, Any] = {
            "fields": "list_status,num_episodes,main_picture,mean,rating,genres",
            "limit": 1000,
            "nsfw": str(user.show_nsfw).lower(),
            "sort": "list_updated_at",
        }
        if status:
            first_params["status"] = status
        params: dict[str, Any] | None = first_params

        items: list[dict] = []
        url: str | None = f"{API_BASE}/users/@me/animelist"
        while url:
            response = await self._call("GET", url, headers=_bearer(token), params=params)
            if response.status_code != 200:
                raise ApiError(
                    502, "mal_unavailable", f"MyAnimeList answered {response.status_code}"
                )
            data = response.json()
            items.extend(data.get("data", []))
            url = (data.get("paging") or {}).get("next")
            params = None  # the "next" URL already carries them
        return {"data": filter_nsfw(items, user.show_nsfw)}

    async def entry(self, session: AsyncSession, user: User, anime_id: int) -> dict | None:
        """The user's list entry for one title, or None when it isn't on their list."""
        token = await self._valid_token(session, user)
        response = await self._call(
            "GET",
            f"{API_BASE}/anime/{anime_id}",
            headers=_bearer(token),
            params={"fields": "my_list_status"},
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise ApiError(502, "mal_unavailable", f"MyAnimeList answered {response.status_code}")
        return response.json().get("my_list_status")

    async def is_linked(self, session: AsyncSession, user: User) -> bool:
        return await session.get(MalLink, user.id) is not None

    async def update_entry(
        self, session: AsyncSession, user: User, anime_id: int, changes: dict
    ) -> dict:
        token = await self._valid_token(session, user)
        try:
            response = await self._call(
                "PATCH",
                f"{API_BASE}/anime/{anime_id}/my_list_status",
                headers=_bearer(token),
                data=changes,
            )
        finally:
            # After the call, so a list read meanwhile can't re-cache the old one.
            self._forget_lists(user.id)
        if response.status_code != 200:
            raise ApiError(502, "mal_update_failed", f"MyAnimeList answered {response.status_code}")
        return response.json()

    async def sync_finished_episode(
        self, session: AsyncSession, user: User, anime_id: int, episode: int, total: int
    ) -> None:
        """Mirror a finished episode on the user's MAL list.

        Starts the title as watching (from not listed, plan to watch or on hold) and moves the
        watched count forward, never back. Dropped and completed titles are left as they are."""
        if episode < 1 or not await self.is_linked(session, user):
            return
        entry = await self.entry(session, user, anime_id) or {}
        if entry.get("status") in ("dropped", "completed"):
            return
        watched = max(entry.get("num_episodes_watched") or 0, episode)
        if watched == (entry.get("num_episodes_watched") or 0) and entry.get("status"):
            return
        finished = total > 0 and watched >= total
        await self.update_entry(
            session,
            user,
            anime_id,
            {"status": "completed" if finished else "watching", "num_watched_episodes": watched},
        )

    async def remove_entry(self, session: AsyncSession, user: User, anime_id: int) -> None:
        token = await self._valid_token(session, user)
        try:
            response = await self._call(
                "DELETE", f"{API_BASE}/anime/{anime_id}/my_list_status", headers=_bearer(token)
            )
        finally:
            self._forget_lists(user.id)
        if response.status_code not in (200, 404):
            raise ApiError(502, "mal_update_failed", f"MyAnimeList answered {response.status_code}")

    async def profile(self, token: str) -> dict | None:
        try:
            response = await self._http.get(
                f"{API_BASE}/users/@me",
                headers=_bearer(token),
                params={"fields": "name,picture,anime_statistics"},
            )
        except httpx.HTTPError:
            return None
        return response.json() if response.status_code == 200 else None

    async def _valid_token(self, session: AsyncSession, user: User) -> str:
        link = await session.get(MalLink, user.id)
        if link is None:
            raise ApiError(400, "mal_not_linked", "No MyAnimeList account linked")
        access_token, refresh_token = link.access_token, link.refresh_token
        fresh = link.expires_at > utcnow() + timedelta(minutes=1)
        # End the read transaction: the MAL calls that follow must not pin a pooled connection.
        await session.commit()
        if fresh:
            return access_token

        tokens = await self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )
        if tokens is None:
            raise ApiError(401, "mal_session_expired", "MyAnimeList session expired, link again")
        link = await session.get(MalLink, user.id)
        if link is None:
            raise ApiError(400, "mal_not_linked", "No MyAnimeList account linked")
        self._apply_tokens(link, tokens)
        await session.commit()
        return link.access_token

    async def _token_request(self, data: dict) -> dict | None:
        payload = {
            "client_id": self._settings.mal_client_id,
            "client_secret": self._settings.mal_client_secret,
            **data,
        }
        try:
            response = await self._http.post(f"{OAUTH_BASE}/token", data=payload)
        except httpx.HTTPError:
            return None
        return response.json() if response.status_code == 200 else None

    @staticmethod
    def _apply_tokens(link: MalLink, tokens: dict) -> None:
        link.access_token = tokens["access_token"]
        link.refresh_token = tokens["refresh_token"]
        link.expires_at = utcnow() + timedelta(seconds=tokens["expires_in"])
