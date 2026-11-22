"""TODO AI 연결(T3): OAuth 2.1 서버, MCP 주소, 승인 화면과 연결 관리 API.

- /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server: 찾기용
- /oauth/register(동적 등록), /oauth/authorize(승인 화면으로), /oauth/token
- /mcp: MCP(Streamable HTTP, JSON 응답). Bearer 토큰 필요
- /api/todo/oauth/*, /api/todo/connections: 화면용(TODO 허용 계정만, 아니면 404)
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any
from urllib.parse import parse_qsl
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from mos.api.rate_limit import RateLimiter
from mos.services.session import ActiveAccount
from mos.services.todo import TodoService
from mos.services.todo_access import TodoAccess
from mos.services.todo_ai_actions import TodoAiActions
from mos.services.todo_mcp import TodoMcp
from mos.services.todo_oauth import SCOPE, OAuthError, TodoOAuth

log = logging.getLogger(__name__)

MAX_BODY = 256 * 1024
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": (
        "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id"
    ),
    "Access-Control-Expose-Headers": "WWW-Authenticate",
    "Access-Control-Max-Age": "600",
}
PUBLIC_PATHS = (
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/token",
    "/mcp",
)


def register_todo_ai_routes(
    app: FastAPI,
    *,
    origin: str,
    todo_account: Callable[[Request], Awaitable[ActiveAccount]],
    account_status: Callable[[int], Awaitable[int | None]],
    access: TodoAccess,
    oauth: TodoOAuth,
    mcp: TodoMcp,
    actions: TodoAiActions,
    todo: TodoService,
    clock: Callable[[], float],
) -> None:
    """account_status: 계정 ID → 활성이면 디스코드 사용자 ID, 아니면 None."""
    resource = origin + "/mcp"
    register_limiter = RateLimiter(limit=10, window_sec=3600, clock=clock)
    token_limiter = RateLimiter(limit=30, window_sec=60, clock=clock)
    mcp_limiter = RateLimiter(limit=120, window_sec=60, clock=clock)
    resource_metadata = origin + "/.well-known/oauth-protected-resource"

    def ip(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    async def read_body(request: Request) -> bytes:
        body = await request.body()
        if len(body) > MAX_BODY:
            raise OAuthError("invalid_request", "요청이 너무 커요", 413)
        return body

    @app.middleware("http")
    async def ai_cors(request: Request, call_next: Any) -> Any:
        # 커넥터 쪽 브라우저 도구도 부를 수 있게(쿠키가 아닌 Bearer 토큰이라 *로 충분)
        path = request.url.path
        if not path.startswith(PUBLIC_PATHS):
            return await call_next(request)
        if request.method == "OPTIONS":
            return Response(status_code=204, headers=CORS)
        response = await call_next(request)
        response.headers.update(CORS)
        return response

    def oauth_error(error: OAuthError) -> JSONResponse:
        return JSONResponse(error.body(), status_code=error.status, headers=NO_STORE)

    # ------------------------------------------------------------ 찾기(메타데이터)

    @app.get("/.well-known/oauth-protected-resource")
    @app.get("/.well-known/oauth-protected-resource/mcp")
    async def protected_resource() -> dict[str, Any]:
        return {
            "resource": resource,
            "authorization_servers": [origin],
            "scopes_supported": [SCOPE],
            "bearer_methods_supported": ["header"],
            "resource_name": "ㅁㅇㅅ TODO",
        }

    @app.get("/.well-known/oauth-authorization-server")
    async def authorization_server() -> dict[str, Any]:
        return {
            "issuer": origin,
            "authorization_endpoint": origin + "/oauth/authorize",
            "token_endpoint": origin + "/oauth/token",
            "registration_endpoint": origin + "/oauth/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": [SCOPE],
        }

    # ------------------------------------------------------------ OAuth

    @app.post("/oauth/register", status_code=201)
    async def oauth_register(request: Request) -> Any:
        if not register_limiter.allow(ip(request)):
            return JSONResponse({"error": "slow_down"}, status_code=429, headers=NO_STORE)
        try:
            body = json.loads(await read_body(request) or b"{}")
            if not isinstance(body, dict):
                raise OAuthError("invalid_client_metadata")
            return JSONResponse(await oauth.register(body), status_code=201, headers=NO_STORE)
        except ValueError:
            return oauth_error(OAuthError("invalid_client_metadata", "JSON이 아니에요"))
        except OAuthError as error:
            return oauth_error(error)

    @app.get("/oauth/authorize")
    async def oauth_authorize(request: Request) -> Response:
        query = {key: value for key, value in request.query_params.items()}
        try:
            request_id = await oauth.start(query, resource)
        except OAuthError as error:
            # 앱이 확실하지 않으면 돌려보내지 않고 여기서 알린다(열린 리다이렉트 방지)
            text = error.description or error.error
            page = (
                "<!doctype html><meta charset='utf-8'><title>연결할 수 없어요</title>"
                "<p style='font-family:sans-serif;padding:24px'>연결할 수 없어요: "
                + _escape(text)
                + "</p>"
            )
            return HTMLResponse(page, status_code=400, headers=NO_STORE)
        # 승인은 ㅁㅇㅅ 화면에서(로그인, 잠금 해제가 먼저)
        return RedirectResponse(f"/#/connect/{request_id}", status_code=302, headers=NO_STORE)

    @app.post("/oauth/token")
    async def oauth_token(request: Request) -> Response:
        if not token_limiter.allow(ip(request)):
            return JSONResponse({"error": "slow_down"}, status_code=429, headers=NO_STORE)
        try:
            raw = await read_body(request)
            kind = request.headers.get("content-type", "")
            if kind.startswith("application/json"):
                parsed = json.loads(raw or b"{}")
                if not isinstance(parsed, dict):
                    raise OAuthError("invalid_request")
                form = {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}
            else:
                form = dict(parse_qsl(raw.decode("utf-8", "replace"), max_num_fields=20))
            return JSONResponse(await oauth.token(form), headers=NO_STORE)
        except ValueError:
            return oauth_error(OAuthError("invalid_request"))
        except OAuthError as error:
            return oauth_error(error)

    # ------------------------------------------------------------ MCP

    def unauthorized() -> JSONResponse:
        return JSONResponse(
            {"error": "invalid_token"},
            status_code=401,
            headers={
                "WWW-Authenticate": f'Bearer resource_metadata="{resource_metadata}"',
                **NO_STORE,
            },
        )

    @app.get("/mcp")
    async def mcp_get() -> Response:
        # 서버가 먼저 보내는 스트림(SSE)은 쓰지 않는다
        return Response(status_code=405, headers={"Allow": "POST"})

    @app.delete("/mcp")
    async def mcp_delete() -> Response:
        return Response(status_code=405, headers={"Allow": "POST"})

    @app.post("/mcp")
    async def mcp_post(request: Request) -> Response:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header[:7].lower() == "bearer " else ""
        grant = await oauth.verify(token)
        if grant is None:
            return unauthorized()
        # 공개 전 기능: 허용된 활성 계정만(나중에 TODO_USERS에서 빠지면 바로 막힘)
        user_id = await account_status(grant.account_id)
        if user_id is None or not access.allowed(user_id):
            return unauthorized()
        if not mcp_limiter.allow(f"grant:{grant.id}"):
            return JSONResponse(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "too fast"}},
                status_code=429,
            )
        try:
            message = json.loads(await read_body(request))
        except (ValueError, OAuthError):
            return JSONResponse(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
                status_code=400,
            )
        prefs = await todo.alert_prefs(grant.account_id)
        today = datetime.fromtimestamp(clock(), ZoneInfo(prefs["tz"])).date().isoformat()
        if isinstance(message, list):
            if not message or len(message) > 20:
                return JSONResponse(
                    {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "batch"}},
                    status_code=400,
                )
            answers = [await mcp.handle(grant, part, today) for part in message]
            replies = [answer for answer in answers if answer is not None]
            if not replies:
                return Response(status_code=202)
            return JSONResponse(replies)
        answer = await mcp.handle(grant, message, today)
        if answer is None:
            return Response(status_code=202)
        return JSONResponse(answer)

    # ------------------------------------------------------------ 화면용(승인, 연결 관리)

    @app.get("/api/todo/oauth/request/{request_id}")
    async def oauth_request_info(request_id: str, request: Request) -> dict[str, Any]:
        await todo_account(request)
        info = await oauth.describe(request_id)
        if info is None:
            return JSONResponse({"detail": "expired"}, status_code=410)  # type: ignore[return-value]
        return info

    @app.post("/api/todo/oauth/request/{request_id}")
    async def oauth_request_decide(request_id: str, request: Request) -> Any:
        account = await todo_account(request)
        try:
            body = await request.json()
        except ValueError:
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("allow"), bool):
            return JSONResponse({"detail": "bad_body"}, status_code=400)
        try:
            target = await oauth.decide(request_id, account.account_id, body["allow"])
        except OAuthError as error:
            return JSONResponse({"detail": "too_many_connections"}, status_code=error.status)
        if target is None:
            return JSONResponse({"detail": "expired"}, status_code=410)
        return {"redirect": target}

    @app.get("/api/todo/connections")
    async def todo_connections(request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return {"connections": await oauth.connections(account.account_id), "mcp_url": resource}

    # AI가 만든 요청 중 ㅁㅇㅅ에서 승인해야 하는 것(공개 범위 넓히기 등), AI가 지운 것(7일)
    @app.get("/api/todo/ai")
    async def todo_ai_state(request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return {
            "pending": await actions.pending(account.account_id),
            "trash": await actions.trash(account.account_id),
        }

    @app.post("/api/todo/ai/pending/{action_id}")
    async def todo_ai_decide(action_id: str, request: Request) -> Any:
        account = await todo_account(request)
        try:
            body = await request.json()
        except ValueError:
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("approve"), bool):
            return JSONResponse({"detail": "bad_body"}, status_code=400)
        result = await actions.decide(account.account_id, action_id, body["approve"])
        if result is None:
            return JSONResponse({"detail": "expired"}, status_code=410)
        return {"message": result}

    @app.post("/api/todo/ai/trash/{trash_id}/restore", status_code=204)
    async def todo_ai_restore(trash_id: str, request: Request) -> Response:
        account = await todo_account(request)
        if not await actions.restore(account.account_id, trash_id):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return Response(status_code=204)

    @app.delete("/api/todo/ai/trash/{trash_id}", status_code=204)
    async def todo_ai_purge(trash_id: str, request: Request) -> Response:
        account = await todo_account(request)
        if not await actions.purge(account.account_id, trash_id):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return Response(status_code=204)

    @app.delete("/api/todo/connections/{grant_id}", status_code=204)
    async def todo_disconnect(grant_id: str, request: Request) -> Response:
        account = await todo_account(request)
        if not await oauth.disconnect(account.account_id, grant_id):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return Response(status_code=204)


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )
