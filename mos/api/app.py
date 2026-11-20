"""FastAPI 앱. 모든 경로는 /api 아래, 실시간은 /ws 하나."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketDisconnect

from mos.api.preview_auth import COOKIE_NAME, SESSION_TTL_SEC, PreviewAuth
from mos.config import Settings
from mos.db.database import Database
from mos.db.repo import MAX_PAGE_SIZE, MessageRepo
from mos.services.messages import row_to_api
from mos.services.realtime import RealtimeHub
from mos.version import current_version

log = logging.getLogger(__name__)

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
WS_POLICY_VIOLATION = 1008


class BotState(Protocol):
    def is_gateway_ready(self) -> bool: ...

    def channel_info(self, channel_id: int) -> dict[str, Any] | None: ...


class PreviewLogin(BaseModel):
    key: str = Field(min_length=1, max_length=256)


def create_app(
    settings: Settings,
    db: Database,
    repo: MessageRepo,
    hub: RealtimeHub,
    bot: BotState,
) -> FastAPI:
    preview = PreviewAuth(access_key=settings.preview_access_key)

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

    def client_ip(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    def require_preview(request: Request) -> None:
        if not preview.check(request.cookies.get(COOKIE_NAME)):
            raise HTTPException(status_code=401, detail="login required")

    def require_preview_channel(channel_id: int) -> int:
        if settings.preview_channel_id is None or channel_id != settings.preview_channel_id:
            raise HTTPException(status_code=404, detail="not found")
        return channel_id

    # ------------------------------------------------------------ 상태 확인(자동 배포가 본다)

    @app.get("/api/healthz")
    async def healthz() -> JSONResponse:
        db_ok = await db.can_write()
        gateway_ok = bot.is_gateway_ready()
        ok = db_ok and gateway_ok
        body = {"ok": ok, "version": current_version(), "db": db_ok, "gateway": gateway_ok}
        return JSONResponse(body, status_code=200 if ok else 503)

    # ------------------------------------------------------------ 임시 운영자 로그인

    @app.post("/api/preview/session", status_code=204)
    async def preview_login(body: PreviewLogin, request: Request, response: Response) -> None:
        ip = client_ip(request)
        if preview.is_locked(ip):
            raise HTTPException(status_code=429, detail="too many attempts")
        token = preview.login(ip, body.key)
        if token is None:
            log.warning("미리보기 로그인 실패")
            raise HTTPException(status_code=401, detail="invalid key")
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=SESSION_TTL_SEC,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="strict",
            path="/",
        )

    @app.get("/api/preview/session", status_code=204)
    async def preview_status(_: None = Depends(require_preview)) -> None:
        return None

    @app.delete("/api/preview/session", status_code=204)
    async def preview_logout(request: Request, response: Response) -> None:
        preview.logout(request.cookies.get(COOKIE_NAME))
        response.delete_cookie(COOKIE_NAME, path="/")

    @app.get("/api/preview/channel")
    async def preview_channel(_: None = Depends(require_preview)) -> dict[str, Any]:
        if settings.preview_channel_id is None:
            raise HTTPException(status_code=404, detail="not configured")
        info = bot.channel_info(settings.preview_channel_id)
        if info is None:
            raise HTTPException(status_code=503, detail="channel not ready")
        return info

    # ------------------------------------------------------------ 메시지

    @app.get("/api/channels/{channel_id}/messages")
    async def list_messages(
        channel_id: int,
        before: int | None = Query(default=None, ge=1),
        limit: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
        _: None = Depends(require_preview),
    ) -> dict[str, Any]:
        require_preview_channel(channel_id)
        rows = await repo.list_page(channel_id, before_id=before, limit=limit)
        return {"messages": [row_to_api(row) for row in rows], "has_more": len(rows) == limit}

    # ------------------------------------------------------------ 실시간

    @app.websocket("/ws")
    async def realtime(websocket: WebSocket) -> None:
        origin_ok = websocket.headers.get("origin") == settings.public_origin
        if not origin_ok or not preview.check(websocket.cookies.get(COOKIE_NAME)):
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
