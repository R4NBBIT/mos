"""디스코드 OAuth2(승인 코드 + PKCE S256). 나가는 요청은 discord.com API로만 보낸다.

응답 본문이나 토큰은 로그·예외 메시지에 넣지 않는다(상태 코드만).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlencode

import aiohttp

AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
API_BASE = "https://discord.com/api/v10"
SCOPES = ("identify", "guilds", "guilds.members.read")
REQUEST_TIMEOUT_SEC = 10


class OAuthError(Exception):
    """디스코드와 주고받기 실패. str()에는 비밀 값이 없다."""


@dataclass(frozen=True)
class TokenSet:
    access_token: str = field(repr=False)
    refresh_token: str | None = field(repr=False)
    expires_at: int
    scope: str


@dataclass(frozen=True)
class DiscordUser:
    id: int
    name: str
    avatar_url: str | None
    premium_type: int
    # 디스코드 아이디(사용자명, 소문자). 닉네임(name)과 다르다
    username: str = ""


class OAuthClient(Protocol):
    def authorize_url(self, state: str, code_challenge: str) -> str: ...

    async def exchange_code(self, code: str, code_verifier: str) -> TokenSet: ...

    async def fetch_user(self, access_token: str) -> DiscordUser: ...

    async def fetch_guild_ids(self, access_token: str) -> set[int]: ...


def _avatar_url(user: dict[str, Any]) -> str | None:
    avatar = user.get("avatar")
    user_id = user.get("id")
    if not avatar or not user_id or not str(user_id).isdigit():
        return None
    if not all(ch.isalnum() or ch == "_" for ch in str(avatar)):
        return None
    extension = "gif" if str(avatar).startswith("a_") else "png"
    return f"https://cdn.discordapp.com/avatars/{user_id}/{avatar}.{extension}?size=128"


USERNAME_RE = re.compile(r"[a-z0-9_.]{2,32}")


def clean_username(value: object) -> str:
    """디스코드 아이디 모양(소문자, 숫자, _ .)이 아니면 빈 글."""
    text = str(value or "").strip().lower()
    return text if USERNAME_RE.fullmatch(text) else ""


def parse_user(data: dict[str, Any]) -> DiscordUser:
    user_id = str(data.get("id", ""))
    if not user_id.isdigit():
        raise OAuthError("bad user payload")
    name = str(data.get("global_name") or data.get("username") or "")[:64]
    return DiscordUser(
        id=int(user_id),
        name=name or "이름 없음",
        avatar_url=_avatar_url(data),
        premium_type=int(data.get("premium_type") or 0),
        username=clean_username(data.get("username")),
    )


class DiscordOAuth:
    def __init__(self, client_id: int, client_secret: str, redirect_uri: str) -> None:
        self.client_id = client_id
        self._client_secret = client_secret
        self.redirect_uri = redirect_uri

    def __repr__(self) -> str:
        return f"DiscordOAuth(client_id={self.client_id})"

    def authorize_url(self, state: str, code_challenge: str) -> str:
        query = {
            "response_type": "code",
            "client_id": str(self.client_id),
            "scope": " ".join(SCOPES),
            "state": state,
            "redirect_uri": self.redirect_uri,
            "prompt": "consent",
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{AUTHORIZE_URL}?{urlencode(query)}"

    def _session(self) -> aiohttp.ClientSession:
        return aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SEC),
            headers={"User-Agent": "mos (private, 1.0)"},
        )

    async def exchange_code(self, code: str, code_verifier: str) -> TokenSet:
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "code_verifier": code_verifier,
        }
        auth = aiohttp.BasicAuth(str(self.client_id), self._client_secret)
        async with self._session() as session:
            async with session.post(f"{API_BASE}/oauth2/token", data=form, auth=auth) as response:
                if response.status != 200:
                    raise OAuthError(f"token exchange failed: HTTP {response.status}")
                data = await response.json()
        granted = set(str(data.get("scope", "")).split())
        if not set(SCOPES) <= granted:
            raise OAuthError("missing scope")
        access = data.get("access_token")
        if not isinstance(access, str) or not access:
            raise OAuthError("no access token")
        refresh = data.get("refresh_token")
        expires_in = int(data.get("expires_in") or 0)
        return TokenSet(
            access_token=access,
            refresh_token=refresh if isinstance(refresh, str) else None,
            expires_at=int(time.time()) + max(expires_in, 0),
            scope=" ".join(sorted(granted)),
        )

    async def _get(self, path: str, access_token: str) -> Any:
        headers = {"Authorization": f"Bearer {access_token}"}
        async with self._session() as session:
            async with session.get(f"{API_BASE}{path}", headers=headers) as response:
                if response.status != 200:
                    raise OAuthError(f"GET {path} failed: HTTP {response.status}")
                return await response.json()

    async def fetch_user(self, access_token: str) -> DiscordUser:
        data = await self._get("/users/@me", access_token)
        if not isinstance(data, dict):
            raise OAuthError("bad user payload")
        return parse_user(data)

    async def fetch_guild_ids(self, access_token: str) -> set[int]:
        data = await self._get("/users/@me/guilds", access_token)
        if not isinstance(data, list):
            raise OAuthError("bad guild payload")
        return {int(item["id"]) for item in data if str(item.get("id", "")).isdigit()}
