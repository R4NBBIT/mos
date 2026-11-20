"""FastAPI 앱. 모든 경로는 /api 아래, 실시간은 /ws 하나."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

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
from mos.services.directory import Directory, DirectoryError, GuildInfo
from mos.services.discord_oauth import DiscordOAuth, OAuthClient
from mos.services.messages import row_to_api
from mos.services.permissions import ChannelAccess, PermissionService
from mos.services.realtime import RealtimeHub
from mos.services.session import ActiveAccount, Device, SessionError, SessionService
from mos.version import current_version

log = logging.getLogger(__name__)

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
WS_POLICY_VIOLATION = 1008
COOKIE_NAME = "sid"
COOKIE_MAX_AGE_SEC = 180 * 24 * 3600
ACCOUNT_ID_PATTERN = r"^[0-9]{1,18}$"
WS_RECHECK_SEC = 60  # 열린 실시간 연결도 잠금·계정 변경을 이 간격으로 확인
OLDER_FETCH_LIMIT = 100


def group_to_api(guild: GuildInfo) -> dict[str, Any]:
    # 화면·주소에는 '서버(guild)' 대신 평범한 '모임(group)'이라는 말을 쓴다
    return {"id": str(guild.id), "name": guild.name, "icon_url": guild.icon_url}


def channel_to_api(access: ChannelAccess, group_name: str | None = None) -> dict[str, Any]:
    channel = access.channel
    data: dict[str, Any] = {
        "id": str(channel.id),
        "name": channel.name,
        "kind": channel.kind,
        "group_id": str(channel.guild_id),
        "category_id": str(channel.category_id) if channel.category_id else None,
        "category_name": channel.category_name,
        "can_send": access.can_send,
    }
    if group_name is not None:
        data["group_name"] = group_name
    return data


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
    directory: Directory,
    oauth: OAuthClient | None = None,
    clock: Callable[[], float] = time.time,
    permissions: PermissionService | None = None,
) -> FastAPI:
    perms = permissions or PermissionService(directory)
    hub.set_access_check(perms.can_read)
    sessions = SessionService(
        AuthRepo(db),
        TokenCipher(settings.secret_key),
        oauth
        or DiscordOAuth(
            settings.discord_client_id,
            settings.discord_client_secret,
            settings.connect_redirect_uri,
        ),
        bot_guild_ids=directory.guild_ids,
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

    async def require_channel(account: ActiveAccount, channel_id: int) -> ChannelAccess:
        """볼 수 없는 채널은 없는 채널과 똑같이 404."""
        access = await perms.channel_access(account.discord_user_id, channel_id)
        if access is None:
            raise HTTPException(status_code=404, detail="not found")
        return access

    def require_ready() -> None:
        if not directory.is_gateway_ready():
            raise HTTPException(status_code=503, detail="not ready")

    @app.exception_handler(DirectoryError)
    async def directory_error(_request: Request, error: DirectoryError) -> JSONResponse:
        log.warning("디스코드 조회 실패: %s", error)
        return JSONResponse({"detail": "upstream_unavailable"}, status_code=503)

    def check_rate(limiter: RateLimiter, request: Request) -> None:
        if not limiter.allow(client_ip(request)):
            raise SessionError("rate_limited", status=429, retry_after=60)

    # ------------------------------------------------------------ 상태 확인(자동 배포가 본다)

    @app.get("/api/healthz")
    async def healthz() -> JSONResponse:
        db_ok = await db.can_write()
        gateway_ok = directory.is_gateway_ready()
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

    # ------------------------------------------------------------ 모임·채널 목록

    @app.get("/api/groups")
    async def list_groups(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        guilds = await perms.visible_guilds(account.discord_user_id)
        guilds.sort(key=lambda guild: guild.name.casefold())
        return {"groups": [group_to_api(guild) for guild in guilds]}

    @app.get("/api/groups/{group_id}/channels")
    async def list_channels(group_id: int, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        accesses = await perms.visible_channels(account.discord_user_id, group_id)
        guild = directory.guild(group_id)
        if accesses is None or guild is None:
            raise HTTPException(status_code=404, detail="not found")
        return {
            "group": group_to_api(guild),
            "channels": [channel_to_api(access) for access in accesses],
        }

    @app.get("/api/channels/{channel_id}")
    async def channel_detail(channel_id: int, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        access = await require_channel(account, channel_id)
        guild = directory.guild(access.channel.guild_id)
        return channel_to_api(access, group_name=guild.name if guild else "")

    # ------------------------------------------------------------ 메시지

    @app.get("/api/channels/{channel_id}/messages")
    async def list_messages(
        request: Request,
        channel_id: int,
        before: int | None = Query(default=None, ge=1),
        limit: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
    ) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        access = await require_channel(account, channel_id)
        if access.channel.kind == "forum":
            raise HTTPException(status_code=404, detail="not found")  # 포럼 화면은 5단계
        if before is None:
            await directory.ensure_synced(channel_id)
        rows = await repo.list_page(channel_id, before_id=before, limit=limit)
        if len(rows) < limit:
            # 저장된 것이 모자라면 그보다 오래된 메시지를 디스코드에서 더 받아 온다
            oldest = int(rows[0]["id"]) if rows else before
            if oldest is not None and await directory.fetch_older(
                channel_id, oldest, OLDER_FETCH_LIMIT
            ):
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
        except SessionError:
            await websocket.close(code=WS_POLICY_VIOLATION)
            return
        await websocket.accept()
        hub.add(websocket, account.discord_user_id)

        async def watch_session() -> None:
            # 다른 탭에서 잠그거나 계정을 바꾸면, 열려 있던 연결도 끊는다(잠금 시간은 늘리지 않음)
            while True:
                await asyncio.sleep(WS_RECHECK_SEC)
                try:
                    # 쿠키 토큰은 잠금 해제 때 바뀌므로 기기 번호로 다시 찾는다
                    current = await sessions.device_by_id(account.device_id)
                    still = await sessions.require_active(current, touch=False)
                    ok = still.account_id == account.account_id
                except SessionError:
                    ok = False
                if not ok:
                    hub.remove(websocket)
                    with contextlib.suppress(Exception):
                        await websocket.close(code=WS_POLICY_VIOLATION)
                    return

        watcher = asyncio.create_task(watch_session())
        try:
            while True:
                text = await websocket.receive_text()
                if text == "ping":
                    await websocket.send_text("pong")
                    continue
                await handle_client_message(websocket, account, text)
        except WebSocketDisconnect:
            pass
        except RuntimeError:
            pass  # 감시 작업이 먼저 닫은 경우
        finally:
            watcher.cancel()
            hub.remove(websocket)

    async def handle_client_message(
        websocket: WebSocket, account: ActiveAccount, text: str
    ) -> None:
        """화면이 보는 채널을 알려 준다: {"type": "subscribe", "channel_id": "123" | null}"""
        try:
            message = json.loads(text)
        except ValueError:
            return
        if not isinstance(message, dict) or message.get("type") != "subscribe":
            return
        raw = message.get("channel_id")
        if raw is None:
            hub.subscribe(websocket, None)
            return
        if not isinstance(raw, str) or not raw.isdigit() or len(raw) > 21:
            return
        channel_id = int(raw)
        allowed = False
        with contextlib.suppress(DirectoryError):
            allowed = await perms.can_read(account.discord_user_id, channel_id)
        hub.subscribe(websocket, channel_id if allowed else None)
        await websocket.send_json(
            {"type": "subscribed" if allowed else "subscribe_denied", "data": {"channel_id": raw}}
        )

    return app
