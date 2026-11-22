"""TODO AI 연결의 OAuth 2.1 서버(T3, AI-01~03).

각자의 Claude, ChatGPT가 커넥터(MCP)로 붙을 때 쓴다.
- 동적 등록(RFC 7591): 누구나 앱을 등록할 수 있지만 사용자가 승인하기 전에는 아무 권한이 없다.
- 승인 코드 + PKCE(S256)만. 비밀 없는 공개 앱(token_endpoint_auth_method=none).
- 코드와 토큰은 SHA-256 해시만 저장. 코드는 한 번만, 5분. 접근 토큰 1시간,
  새로 고침 토큰 30일(쓸 때마다 새것, 이미 쓴 것을 다시 쓰면 그 연결을 끊는다).
- 토큰으로는 TODO만(ㅁㅇㅅ 메시지, 디스코드 정보는 못 봄). 연결은 설정에서 끊을 수 있다.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlsplit

from mos.db.database import Database

REQUEST_TTL_SEC = 10 * 60
CODE_TTL_SEC = 5 * 60
ACCESS_TTL_SEC = 60 * 60
REFRESH_TTL_SEC = 30 * 86400
MAX_CLIENTS = 2000
MAX_REDIRECT_URIS = 5
MAX_URI_LEN = 500
MAX_NAME_LEN = 60
MAX_GRANTS_PER_ACCOUNT = 20
CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
STATE_MAX = 500
SCOPE = "todo"


class OAuthError(Exception):
    """OAuth 오류(error 코드는 RFC 6749 이름)."""

    def __init__(self, error: str, description: str = "", status: int = 400) -> None:
        super().__init__(error)
        self.error = error
        self.description = description
        self.status = status

    def body(self) -> dict[str, str]:
        result = {"error": self.error}
        if self.description:
            result["error_description"] = self.description
        return result


@dataclass
class Grant:
    id: int
    account_id: int
    client_id: str
    client_name: str


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean_name(value: Any) -> str:
    if not isinstance(value, str):
        return "AI 앱"
    text = " ".join(value.split())
    text = "".join(ch for ch in text if ch.isprintable())[:MAX_NAME_LEN]
    return text or "AI 앱"


# 휴대폰 앱(안드로이드 위젯)의 되돌아올 주소: 거꾸로 쓴 도메인 모양의 앱 전용 스킴(RFC 8252 7.1)
APP_SCHEME_RE = re.compile(r"^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}:/[A-Za-z0-9/_-]{1,60}$")


def check_redirect_uri(uri: Any) -> str:
    """https만(로컬 개발 도구는 http://localhost, 127.0.0.1, 휴대폰 앱은 com.예.앱:/경로).
    조각(#)과 사용자 정보는 안 됨. 앱 스킴은 다른 앱이 가로챌 수 있지만 PKCE가 막는다."""
    if not isinstance(uri, str) or not uri or len(uri) > MAX_URI_LEN:
        raise OAuthError("invalid_redirect_uri", "redirect_uri가 올바르지 않아요")
    if APP_SCHEME_RE.match(uri) and not uri.startswith(("http:", "https:")):
        return uri
    parts = urlsplit(uri)
    host = (parts.hostname or "").lower()
    local = host in ("localhost", "127.0.0.1", "[::1]", "::1")
    if parts.fragment or parts.username or parts.password or not host:
        raise OAuthError("invalid_redirect_uri", "redirect_uri가 올바르지 않아요")
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        raise OAuthError("invalid_redirect_uri", "redirect_uri는 https여야 해요")
    return uri


def _s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class TodoOAuth:
    def __init__(self, db: Database, clock: Callable[[], float] = time.time) -> None:
        self.db = db
        self.clock = clock

    def now(self) -> int:
        return int(self.clock())

    # ------------------------------------------------------------ 동적 등록

    async def register(self, body: dict[str, Any]) -> dict[str, Any]:
        uris = body.get("redirect_uris")
        if not isinstance(uris, list) or not uris or len(uris) > MAX_REDIRECT_URIS:
            raise OAuthError("invalid_redirect_uri", "redirect_uris가 필요해요")
        clean = [check_redirect_uri(uri) for uri in uris]
        method = body.get("token_endpoint_auth_method", "none")
        if method != "none":
            raise OAuthError("invalid_client_metadata", "token_endpoint_auth_method는 none만")
        grant_types = body.get("grant_types", ["authorization_code", "refresh_token"])
        if not isinstance(grant_types, list) or not set(grant_types) <= {
            "authorization_code",
            "refresh_token",
        }:
            raise OAuthError("invalid_client_metadata", "지원하지 않는 grant_types")
        name = _clean_name(body.get("client_name"))
        row = await self.db.fetch_one("SELECT COUNT(*) FROM oauth_client")
        if row and int(row[0]) >= MAX_CLIENTS:
            # 오래되고 연결이 없는 앱부터 지운다
            async with self.db.writing() as conn:
                await conn.execute(
                    "DELETE FROM oauth_client WHERE id IN (SELECT c.id FROM oauth_client c"
                    " WHERE NOT EXISTS (SELECT 1 FROM oauth_grant g WHERE g.client_id = c.id)"
                    " ORDER BY c.created_at LIMIT 100)"
                )
        client_id = secrets.token_urlsafe(24)
        now = self.now()
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO oauth_client (id, name, redirect_uris, created_at)"
                " VALUES (?, ?, ?, ?)",
                (client_id, name, json.dumps(clean), now),
            )
        return {
            "client_id": client_id,
            "client_id_issued_at": now,
            "client_name": name,
            "redirect_uris": clean,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": SCOPE,
        }

    async def _client(self, client_id: Any) -> dict[str, Any] | None:
        if not isinstance(client_id, str) or not ID_RE.match(client_id):
            return None
        row = await self.db.fetch_one(
            "SELECT id, name, redirect_uris FROM oauth_client WHERE id = ?", (client_id,)
        )
        if row is None:
            return None
        return {"id": str(row[0]), "name": str(row[1]), "redirect_uris": json.loads(row[2])}

    # ------------------------------------------------------------ 승인 요청

    async def start(self, query: dict[str, str], resource: str) -> str:
        """/oauth/authorize. 잘못되면 OAuthError(사용자에게 보여 줌, 앱으로 돌려보내지 않음).
        맞으면 승인 화면이 쓸 요청 ID."""
        client = await self._client(query.get("client_id"))
        if client is None:
            raise OAuthError("invalid_client", "등록되지 않은 앱이에요")
        redirect_uri = query.get("redirect_uri") or (
            client["redirect_uris"][0] if len(client["redirect_uris"]) == 1 else ""
        )
        if redirect_uri not in client["redirect_uris"]:
            raise OAuthError("invalid_request", "redirect_uri가 등록된 것과 달라요")
        if query.get("response_type") != "code":
            raise OAuthError("unsupported_response_type", "response_type=code만 돼요")
        challenge = query.get("code_challenge", "")
        if query.get("code_challenge_method") != "S256" or not CHALLENGE_RE.match(challenge):
            raise OAuthError("invalid_request", "PKCE(S256)가 필요해요")
        scope = query.get("scope")
        if scope and set(scope.split()) - {SCOPE}:
            raise OAuthError("invalid_scope", "todo 범위만 돼요")
        wanted = query.get("resource")
        if wanted and wanted.rstrip("/") != resource.rstrip("/"):
            raise OAuthError("invalid_target", "이 서버의 MCP 주소가 아니에요")
        state = query.get("state")
        if state is not None and len(state) > STATE_MAX:
            raise OAuthError("invalid_request", "state가 너무 길어요")
        request_id = secrets.token_urlsafe(24)
        now = self.now()
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM oauth_request WHERE created_at < ?", (now - REQUEST_TTL_SEC,)
            )
            await conn.execute(
                "INSERT INTO oauth_request (id, client_id, redirect_uri, state, code_challenge,"
                " created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (request_id, client["id"], redirect_uri, state, challenge, now),
            )
        return request_id

    async def _request(self, request_id: Any) -> dict[str, Any] | None:
        if not isinstance(request_id, str) or not ID_RE.match(request_id):
            return None
        row = await self.db.fetch_one(
            "SELECT r.client_id, r.redirect_uri, r.state, r.code_challenge, r.created_at, c.name"
            " FROM oauth_request r JOIN oauth_client c ON c.id = r.client_id WHERE r.id = ?",
            (request_id,),
        )
        if row is None or int(row[4]) < self.now() - REQUEST_TTL_SEC:
            return None
        return {
            "client_id": str(row[0]),
            "redirect_uri": str(row[1]),
            "state": row[2],
            "code_challenge": str(row[3]),
            "client_name": str(row[5]),
        }

    async def describe(self, request_id: Any) -> dict[str, Any] | None:
        """승인 화면에 보일 것: 앱 이름과 돌아갈 곳(사이트 주소)."""
        found = await self._request(request_id)
        if found is None:
            return None
        parts = urlsplit(found["redirect_uri"])
        return {
            "client_name": found["client_name"],
            # 휴대폰 앱(com.예.앱:/경로)은 주소가 없어서 앱 이름표로 보인다
            "redirect_host": parts.hostname or f"{parts.scheme} 앱",
        }

    async def decide(self, request_id: Any, account_id: int, allow: bool) -> str | None:
        """승인/거절. 앱으로 돌아갈 주소(코드 또는 access_denied). 요청이 없으면 None."""
        found = await self._request(request_id)
        if found is None:
            return None
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM oauth_request WHERE id = ?", (request_id,))
        params: dict[str, str] = {}
        if allow:
            grant_id = await self._grant(account_id, found["client_id"])
            code = secrets.token_urlsafe(32)
            async with self.db.writing() as conn:
                await conn.execute(
                    "INSERT INTO oauth_code (code_hash, grant_id, redirect_uri, code_challenge,"
                    " expires_at) VALUES (?, ?, ?, ?, ?)",
                    (
                        _hash(code),
                        grant_id,
                        found["redirect_uri"],
                        found["code_challenge"],
                        self.now() + CODE_TTL_SEC,
                    ),
                )
            params["code"] = code
        else:
            params["error"] = "access_denied"
        if found["state"] is not None:
            params["state"] = str(found["state"])
        joiner = "&" if "?" in found["redirect_uri"] else "?"
        return found["redirect_uri"] + joiner + urlencode(params)

    async def _grant(self, account_id: int, client_id: str) -> int:
        """같은 앱을 다시 승인하면 그 연결을 다시 쓴다(끊었던 것은 새로)."""
        row = await self.db.fetch_one(
            "SELECT id FROM oauth_grant WHERE account_id = ? AND client_id = ?"
            " AND revoked_at IS NULL",
            (account_id, client_id),
        )
        if row is not None:
            return int(row[0])
        count = await self.db.fetch_one(
            "SELECT COUNT(*) FROM oauth_grant WHERE account_id = ? AND revoked_at IS NULL",
            (account_id,),
        )
        if count and int(count[0]) >= MAX_GRANTS_PER_ACCOUNT:
            raise OAuthError("access_denied", "연결은 20개까지예요", 409)
        async with self.db.writing() as conn:
            cursor = await conn.execute(
                "INSERT INTO oauth_grant (account_id, client_id, created_at) VALUES (?, ?, ?)",
                (account_id, client_id, self.now()),
            )
            return int(cursor.lastrowid or 0)

    # ------------------------------------------------------------ 토큰

    async def token(self, form: dict[str, str]) -> dict[str, Any]:
        grant_type = form.get("grant_type")
        if grant_type == "authorization_code":
            return await self._from_code(form)
        if grant_type == "refresh_token":
            return await self._from_refresh(form)
        raise OAuthError("unsupported_grant_type")

    async def _from_code(self, form: dict[str, str]) -> dict[str, Any]:
        code = form.get("code", "")
        verifier = form.get("code_verifier", "")
        if not code or not VERIFIER_RE.match(verifier):
            raise OAuthError("invalid_request", "code, code_verifier가 필요해요")
        row = await self.db.fetch_one(
            "SELECT c.grant_id, c.redirect_uri, c.code_challenge, c.expires_at, c.used,"
            " g.client_id, g.revoked_at FROM oauth_code c JOIN oauth_grant g ON g.id = c.grant_id"
            " WHERE c.code_hash = ?",
            (_hash(code),),
        )
        if row is None:
            raise OAuthError("invalid_grant")
        grant_id = int(row[0])
        if int(row[4]):
            # 코드를 두 번 쓰려 하면 그 연결을 끊는다(RFC 6749 4.1.2)
            await self.revoke_grant(grant_id)
            raise OAuthError("invalid_grant")
        async with self.db.writing() as conn:
            await conn.execute("UPDATE oauth_code SET used = 1 WHERE code_hash = ?", (_hash(code),))
        client_id = form.get("client_id")
        if (
            int(row[3]) < self.now()
            or row[6] is not None
            or (client_id is not None and client_id != row[5])
            or form.get("redirect_uri", row[1]) != row[1]
            or not secrets.compare_digest(_s256(verifier), str(row[2]))
        ):
            raise OAuthError("invalid_grant")
        return await self._issue(grant_id)

    async def _from_refresh(self, form: dict[str, str]) -> dict[str, Any]:
        token = form.get("refresh_token", "")
        if not token:
            raise OAuthError("invalid_request")
        row = await self.db.fetch_one(
            "SELECT t.grant_id, t.expires_at, t.used, g.client_id, g.revoked_at FROM oauth_token t"
            " JOIN oauth_grant g ON g.id = t.grant_id"
            " WHERE t.token_hash = ? AND t.kind = 'refresh'",
            (_hash(token),),
        )
        if row is None:
            raise OAuthError("invalid_grant")
        grant_id = int(row[0])
        if int(row[2]):
            await self.revoke_grant(grant_id)  # 이미 쓴 새로 고침 토큰: 도난으로 보고 끊는다
            raise OAuthError("invalid_grant")
        client_id = form.get("client_id")
        if int(row[1]) < self.now() or row[4] is not None or (client_id and client_id != row[3]):
            raise OAuthError("invalid_grant")
        async with self.db.writing() as conn:
            await conn.execute(
                "UPDATE oauth_token SET used = 1 WHERE token_hash = ?", (_hash(token),)
            )
        return await self._issue(grant_id)

    async def _issue(self, grant_id: int) -> dict[str, Any]:
        access = secrets.token_urlsafe(32)
        refresh = secrets.token_urlsafe(32)
        now = self.now()
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM oauth_token WHERE grant_id = ? AND expires_at < ?", (grant_id, now)
            )
            await conn.execute(
                "INSERT INTO oauth_token (token_hash, kind, grant_id, expires_at)"
                " VALUES (?, 'access', ?, ?), (?, 'refresh', ?, ?)",
                (
                    _hash(access),
                    grant_id,
                    now + ACCESS_TTL_SEC,
                    _hash(refresh),
                    grant_id,
                    now + REFRESH_TTL_SEC,
                ),
            )
        return {
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_TTL_SEC,
            "refresh_token": refresh,
            "scope": SCOPE,
        }

    async def verify(self, token: str) -> Grant | None:
        if not token or len(token) > 200:
            return None
        row = await self.db.fetch_one(
            "SELECT g.id, g.account_id, g.client_id, c.name, t.expires_at, g.revoked_at"
            " FROM oauth_token t JOIN oauth_grant g ON g.id = t.grant_id"
            " JOIN oauth_client c ON c.id = g.client_id"
            " WHERE t.token_hash = ? AND t.kind = 'access'",
            (_hash(token),),
        )
        if row is None or int(row[4]) < self.now() or row[5] is not None:
            return None
        grant = Grant(int(row[0]), int(row[1]), str(row[2]), str(row[3]))
        async with self.db.writing() as conn:
            await conn.execute(
                "UPDATE oauth_grant SET last_used_at = ? WHERE id = ?", (self.now(), grant.id)
            )
        return grant

    # ------------------------------------------------------------ 연결 관리(설정 화면)

    async def connections(self, account_id: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT g.id, c.name, g.created_at, g.last_used_at FROM oauth_grant g"
            " JOIN oauth_client c ON c.id = g.client_id"
            " WHERE g.account_id = ? AND g.revoked_at IS NULL ORDER BY g.id DESC",
            (account_id,),
        )
        return [
            {
                "id": str(row[0]),
                "name": str(row[1]),
                "created_at": int(row[2]),
                "last_used_at": int(row[3]) if row[3] is not None else None,
            }
            for row in rows
        ]

    async def disconnect(self, account_id: int, grant_id: Any) -> bool:
        if not isinstance(grant_id, str) or not grant_id.isdigit() or len(grant_id) > 18:
            return False
        row = await self.db.fetch_one(
            "SELECT id FROM oauth_grant WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
            (int(grant_id), account_id),
        )
        if row is None:
            return False
        await self.revoke_grant(int(row[0]))
        return True

    async def revoke_grant(self, grant_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "UPDATE oauth_grant SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                (self.now(), grant_id),
            )
            await conn.execute("DELETE FROM oauth_token WHERE grant_id = ?", (grant_id,))
            await conn.execute("DELETE FROM oauth_code WHERE grant_id = ?", (grant_id,))
