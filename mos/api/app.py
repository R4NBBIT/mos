"""FastAPI 앱. 모든 경로는 /api 아래, 실시간은 /ws 하나."""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketDisconnect

from mos.api.rate_limit import RateLimiter
from mos.config import Settings
from mos.db.auth_repo import AuthRepo
from mos.db.database import Database
from mos.db.repo import MAX_PAGE_SIZE, MessageRepo
from mos.services.crypto import TokenCipher
from mos.services.discord_oauth import DiscordOAuth, OAuthClient
from mos.services.messages import row_to_api
from mos.services.realtime import RealtimeHub
from mos.services.session import ActiveAccount, Device, SessionError, SessionService
from mos.version import current_version

log = logging.getLogger(__name__)

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
WS_POLICY_VIOLATION = 1008
COOKIE_NAME = "sid"
COOKIE_MAX_AGE_SEC = 180 * 24 * 3600
ACCOUNT_ID_PATTERN = r"^[0-9]{1,18}$"


class BotState(Protocol):
    def is_gateway_ready(self) -> bool: ...

    def guild_ids(self) -> set[int]: ...

    def channel_info(self, channel_id: int) -> dict[str, Any] | None: ...


class PasswordBody(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class UnlockBody(BaseModel):
    account_id: str = Field(pattern=ACCOUNT_ID_PATTERN)
    password: str = Field(min_length=1, max_length=256)
    keep: bool = False


class SwitchBody(BaseModel):
    account_id: str = Field(pattern=ACCOUNT_ID_PATTERN)


def create_app(
    settings: Settings,
    db: Database,
    repo: MessageRepo,
    hub: RealtimeHub,
    bot: BotState,
    oauth: OAuthClient | None = None,
    clock: Callable[[], float] = time.time,
) -> FastAPI:
    sessions = SessionService(
        AuthRepo(db),
        TokenCipher(settings.secret_key),
        oauth
        or DiscordOAuth(
            settings.discord_client_id,
            settings.discord_client_secret,
            settings.connect_redirect_uri,
        ),
        bot_guild_ids=bot.guild_ids,
        clock=clock,
    )
    connect_limiter = RateLimiter(limit=20, window_sec=600)
    unlock_limiter = RateLimiter(limit=10, window_sec=60)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        opened_here = not db.is_open
        await db.open()
        try:
            yield
        finally:
            if opened_here:
                await db.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    # ------------------------------------------------------------ 공통 보호

    @app.middleware("http")
    async def protect(request: Request, call_next: Any) -> Response:
        # 상태를 바꾸는 요청은 우리 화면에서 온 것만(CSRF 방지, SameSite 쿠키와 이중)
        if request.method in UNSAFE_METHODS and request.url.path.startswith("/api/"):
            if request.headers.get("origin") != settings.public_origin:
                return JSONResponse({"detail": "forbidden"}, status_code=403)
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(SessionError)
    async def session_error(_request: Request, error: SessionError) -> JSONResponse:
        headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
        return JSONResponse({"detail": error.code}, status_code=error.status, headers=headers)

    def client_ip(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    def set_device_cookie(response: Response, token: str) -> None:
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=COOKIE_MAX_AGE_SEC,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="lax",  # OAuth 콜백은 디스코드에서 돌아오는 요청이라 Strict면 쿠키가 안 온다
            path="/",
        )

    def clear_device_cookie(response: Response) -> None:
        response.delete_cookie(
            COOKIE_NAME, path="/", httponly=True, secure=settings.cookie_secure, samesite="lax"
        )

    async def current_device(request: Request) -> Device | None:
        return await sessions.device_from_token(request.cookies.get(COOKIE_NAME))

    async def require_account(request: Request) -> ActiveAccount:
        return await sessions.require_active(await current_device(request))

    async def require_preview_channel(account: ActiveAccount, channel_id: int) -> dict[str, Any]:
        """3-1 임시: 미리보기 채널 하나, 그 서버에 들어가 있는 계정만. 3-2에서 can()으로 바뀐다."""
        if settings.preview_channel_id is None or channel_id != settings.preview_channel_id:
            raise HTTPException(status_code=404, detail="not found")
        info = bot.channel_info(channel_id)
        if info is None:
            raise HTTPException(status_code=503, detail="channel not ready")
        if not await sessions.account_can_see_guild(account.account_id, int(info["guild_id"])):
            raise HTTPException(status_code=404, detail="not found")
        return info

    def check_rate(limiter: RateLimiter, request: Request) -> None:
        if not limiter.allow(client_ip(request)):
            raise SessionError("rate_limited", status=429, retry_after=60)

    # ------------------------------------------------------------ 상태 확인(자동 배포가 본다)

    @app.get("/api/healthz")
    async def healthz() -> JSONResponse:
        db_ok = await db.can_write()
        gateway_ok = bot.is_gateway_ready()
        ok = db_ok and gateway_ok
        body = {"ok": ok, "version": current_version(), "db": db_ok, "gateway": gateway_ok}
        return JSONResponse(body, status_code=200 if ok else 503)

    # ------------------------------------------------------------ 계정 연결(OAuth)

    @app.get("/api/auth/connect/start")
    async def connect_start(request: Request, purpose: str = "connect") -> Response:
        check_rate(connect_limiter, request)
        device = await current_device(request)
        new_token: str | None = None
        if device is None:
            device, new_token = await sessions.create_device()
        url = await sessions.start_connect(device, purpose)
        response = RedirectResponse(url, status_code=302)
        if new_token:
            set_device_cookie(response, new_token)
        return response

    @app.get("/api/auth/connect/callback")
    async def connect_callback(
        request: Request,
        code: str = Query(default="", max_length=256),
        state: str = Query(default="", max_length=128),
        error: str = Query(default="", max_length=64),
    ) -> Response:
        check_rate(connect_limiter, request)
        device = await current_device(request)
        if error:
            # 사용자가 취소함. state는 남겨 두면 10분 뒤 정리된다
            return RedirectResponse("/?connect_error=cancelled", status_code=302)
        try:
            await sessions.finish_connect(device, state, code)
        except SessionError as failure:
            return RedirectResponse(f"/?connect_error={failure.code}", status_code=302)
        return RedirectResponse("/", status_code=302)

    # ------------------------------------------------------------ 기기 세션

    @app.get("/api/session")
    async def session_state(request: Request) -> dict[str, Any]:
        return await sessions.describe(await current_device(request))

    @app.post("/api/auth/password", status_code=204)
    async def set_password(body: PasswordBody, request: Request) -> None:
        check_rate(unlock_limiter, request)
        await sessions.set_password(await current_device(request), body.password)

    @app.post("/api/session/unlock", status_code=204)
    async def unlock(body: UnlockBody, request: Request, response: Response) -> None:
        check_rate(unlock_limiter, request)
        device = await current_device(request)
        await sessions.unlock(device, int(body.account_id), body.password, body.keep)
        if device is not None:
            # 잠금 해제 때마다 기기 토큰을 바꿔, 새어 나간 예전 쿠키를 무효로 만든다
            set_device_cookie(response, await sessions.rotate_token(device))

    @app.post("/api/session/lock", status_code=204)
    async def lock(request: Request) -> None:
        await sessions.lock(await current_device(request))

    @app.post("/api/session/switch", status_code=204)
    async def switch(body: SwitchBody, request: Request) -> None:
        await sessions.switch(await current_device(request), int(body.account_id))

    @app.delete("/api/session/accounts/{account_id}", status_code=204)
    async def remove_account(account_id: int, request: Request, response: Response) -> None:
        if await sessions.remove_account(await current_device(request), account_id):
            clear_device_cookie(response)

    # ------------------------------------------------------------ 임시: 채널 하나(3-2에서 목록으로)

    @app.get("/api/preview/channel")
    async def preview_channel(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        if settings.preview_channel_id is None:
            raise HTTPException(status_code=404, detail="not configured")
        return await require_preview_channel(account, settings.preview_channel_id)

    # ------------------------------------------------------------ 메시지

    @app.get("/api/channels/{channel_id}/messages")
    async def list_messages(
        request: Request,
        channel_id: int,
        before: int | None = Query(default=None, ge=1),
        limit: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
    ) -> dict[str, Any]:
        account = await require_account(request)
        await require_preview_channel(account, channel_id)
        rows = await repo.list_page(channel_id, before_id=before, limit=limit)
        return {"messages": [row_to_api(row) for row in rows], "has_more": len(rows) == limit}

    # ------------------------------------------------------------ 실시간

    @app.websocket("/ws")
    async def realtime(websocket: WebSocket) -> None:
        if websocket.headers.get("origin") != settings.public_origin:
            await websocket.close(code=WS_POLICY_VIOLATION)
            return
        try:
            device = await sessions.device_from_token(websocket.cookies.get(COOKIE_NAME))
            account = await sessions.require_active(device)
            if settings.preview_channel_id is not None:
                await require_preview_channel(account, settings.preview_channel_id)
        except (SessionError, HTTPException):
            await websocket.close(code=WS_POLICY_VIOLATION)
            return
        await websocket.accept()
        hub.add(websocket)
        try:
            while True:
                text = await websocket.receive_text()
                if text == "ping":
                    await websocket.send_text("pong")
        except WebSocketDisconnect:
            pass
        finally:
            hub.remove(websocket)

    return app
