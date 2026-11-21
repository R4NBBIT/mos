"""FastAPI 앱. 모든 경로는 /api 아래, 실시간은 /ws 하나."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    WebSocket,
)
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketDisconnect

from mos.api.rate_limit import RateLimiter
from mos.config import Settings
from mos.db.auth_repo import AuthRepo
from mos.db.database import Database
from mos.db.lists_repo import ListsRepo
from mos.db.repo import MAX_PAGE_SIZE, MessageRepo
from mos.db.sender_repo import SenderRepo
from mos.services import reactions
from mos.services.boss_files import KINDS as BOSS_KINDS
from mos.services.boss_files import MAX_BYTES as BOSS_MAX_BYTES
from mos.services.boss_files import MAX_EDITS_BYTES as BOSS_MAX_EDITS
from mos.services.boss_files import BossFileError, BossFiles
from mos.services.crypto import BytesCipher, TokenCipher
from mos.services.directory import ChannelInfo, Directory, DirectoryError, GuildInfo
from mos.services.discord_oauth import DiscordOAuth, OAuthClient
from mos.services.egress import EgressMeter
from mos.services.emojis import EmojiService
from mos.services.messages import row_to_api
from mos.services.permissions import ADD_REACTIONS, ChannelAccess, PermissionService
from mos.services.push import PushError, PushService
from mos.services.realtime import RealtimeHub, Subscriber
from mos.services.sender import (
    MAX_FILES,
    MAX_FILES_BYTES,
    Messenger,
    OutgoingFile,
    SendError,
    SenderService,
    safe_filename,
)
from mos.services.session import ActiveAccount, Device, SessionError, SessionService
from mos.services.settings import SettingsError, SettingsStore
from mos.version import current_version

log = logging.getLogger(__name__)

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
WS_POLICY_VIOLATION = 1008
COOKIE_NAME = "sid"
COOKIE_MAX_AGE_SEC = 180 * 24 * 3600
ACCOUNT_ID_PATTERN = r"^[0-9]{1,18}$"
WS_RECHECK_SEC = 60  # 열린 실시간 연결도 잠금·계정 변경을 이 간격으로 확인
OLDER_FETCH_LIMIT = 100
MAX_PINNED_GROUPS = 5
MAX_PINNED_CHANNELS = 10
NONCE_PATTERN = r"^[A-Za-z0-9-]{8,64}$"
NOTIFY_KINDS = {0, 19, 20, 23}  # 보통·답장·명령 응답(입장·고정 같은 시스템 알림은 알리지 않음)
NOTIFY_TEXT_LIMIT = 300  # 알림에 보내는 본문 앞부분
STICKER_MAX_BYTES = 2 * 1024 * 1024
GIF_STICKER = 4
# 테마별 탭 제목(웹 theme.ts와 같게). 웹 푸시 알림 제목에 쓴다
DEFAULT_TITLES = {
    "moon": "작업 메모",
    "night": "작업 메모",
    "sheet": "통합 문서1",
    "memo": "제목 없음 - 메모장",
    "note": "업무 노트",
    "word": "업무 정리.docx",
}
SNOWFLAKE_PATTERN = r"^[0-9]{15,21}$"
UPLOAD_CHUNK = 64 * 1024
THREAD_PAGE = 25
DISCORD_EPOCH_MS = 1420070400000


def group_to_api(guild: GuildInfo) -> dict[str, Any]:
    # 화면·주소에는 '서버(guild)' 대신 평범한 '모임(group)'이라는 말을 쓴다
    return {"id": str(guild.id), "name": guild.name, "icon_url": guild.icon_url}


def snowflake_time(snowflake: int) -> str:
    """디스코드 ID에 들어 있는 만든 시각(ISO)."""
    millis = (snowflake >> 22) + DISCORD_EPOCH_MS
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(millis / 1000))


def thread_to_api(thread: ChannelInfo, preview: str | None) -> dict[str, Any]:
    return {
        "id": str(thread.id),
        "name": thread.name,
        "tag_ids": [str(tag) for tag in thread.applied_tag_ids],
        "archived": thread.archived,
        "locked": thread.thread_locked,
        "private": thread.private_thread,
        "message_count": thread.message_count,
        "created_at": snowflake_time(thread.id),
        "last_message_at": snowflake_time(thread.last_message_id or thread.id),
        "preview": preview,
    }


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
    if channel.kind == "forum":
        data["can_post"] = access.can_create_post
        data["require_tag"] = channel.require_tag
        data["tags"] = [
            {
                "id": str(tag.id),
                "name": tag.name,
                "emoji": tag.emoji,
                # 관리자 전용 태그는 권한 없는 사람에게 고를 수 없게 표시
                "usable": not tag.moderated or access.can_use_moderated_tags,
            }
            for tag in channel.forum_tags
        ]
    if channel.kind == "thread":
        data["parent_id"] = str(channel.parent_id) if channel.parent_id else None
        data["locked"] = channel.thread_locked
        data["archived"] = channel.archived
        data["private"] = channel.private_thread
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


class SendBody(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    # 화면이 메시지마다 만드는 무작위 값. 같은 값으로 다시 오면 다시 보내지 않는다
    nonce: str = Field(pattern=r"^[A-Za-z0-9-]{8,64}$")
    reply_to: str | None = Field(default=None, pattern=r"^[0-9]{15,21}$")


class StickerBody(BaseModel):
    sticker_id: str = Field(pattern=SNOWFLAKE_PATTERN)
    nonce: str = Field(pattern=NONCE_PATTERN)
    reply_to: str | None = Field(default=None, pattern=SNOWFLAKE_PATTERN)


class PushBody(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1000)


class ReactionBody(BaseModel):
    emoji: str = Field(min_length=1, max_length=80)


class EditBody(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class PinBody(BaseModel):
    kind: str = Field(pattern=r"^(group|channel)$")
    id: str = Field(pattern=SNOWFLAKE_PATTERN)


class NitroBody(BaseModel):
    claimed: bool


class ReadBody(BaseModel):
    last_id: str = Field(pattern=SNOWFLAKE_PATTERN)


def create_app(
    settings: Settings,
    db: Database,
    repo: MessageRepo,
    hub: RealtimeHub,
    directory: Directory,
    oauth: OAuthClient | None = None,
    clock: Callable[[], float] = time.time,
    permissions: PermissionService | None = None,
    messenger: Messenger | None = None,
    notify_operator: Callable[[str], Awaitable[None]] | None = None,
    push_service: PushService | None = None,
) -> FastAPI:
    perms = permissions or PermissionService(directory)
    hub.set_access_check(perms.can_read)
    cipher = TokenCipher(settings.secret_key)
    boss_files = BossFiles(db, BytesCipher(cipher), clock=clock)
    emojis = EmojiService(directory, perms)
    lists = ListsRepo(db)

    async def notify_rule(
        subscriber: Subscriber, channel_id: int, message: dict[str, Any]
    ) -> dict[str, Any] | None:
        """알림 조건: 남이 쓴 보통 메시지 중 나를 부른 것(멘션, 내 글에 답장).
        범위가 'pinned'면 고정한 채널(그 채널의 스레드 포함)의 새 메시지도,
        'all'이면 볼 수 있는 모든 채널의 새 메시지."""
        user = subscriber.user_id
        if int(message.get("kind") or 0) not in NOTIFY_KINDS:
            return None
        if message["author"]["id"] == str(user) or message.get("web_sender_id") == str(user):
            return None
        channel = directory.channel(channel_id)
        if channel is None:
            return None
        mentioned = str(user) in message["mentions"]["users"]
        if not mentioned and message.get("reference_id"):
            original = await repo.get(int(message["reference_id"]))
            mentioned = original is not None and user in (
                original["author_id"],
                original.get("web_sender_id"),
            )
        if not mentioned and subscriber.notify_scope != "all":
            if subscriber.notify_scope != "pinned":
                return None
            pinned = {
                int(pin["target_id"])
                for pin in await lists.pins(subscriber.account_id)
                if pin["kind"] == "channel"
            }
            if channel_id not in pinned and channel.parent_id not in pinned:
                return None
        guild = directory.guild(channel.guild_id)
        stickers = message.get("stickers") or []
        return {
            "message_id": message["id"],
            "channel_id": str(channel_id),
            "group_id": str(channel.guild_id),
            "parent_id": str(channel.parent_id) if channel.parent_id else None,
            "channel_name": channel.name,
            "group_name": guild.name if guild else "",
            "author_name": message["author"]["name"],
            "content": message["content"][:NOTIFY_TEXT_LIMIT],
            "extra": "스티커" if stickers else "첨부" if message.get("attachments") else "",
            "mentioned": mentioned,
        }

    hub.set_notify_rule(notify_rule)

    # ------------------------------------------------------------ 웹 푸시(탭이 닫힌 계정)

    push = push_service or PushService(db, cipher, subject=settings.public_origin, clock=clock)
    last_push: dict[int, dict[str, Any]] = {}  # 계정 → 마지막 알림 내용(서비스 워커가 받아 감)

    async def push_after_notify(
        channel_id: int, message: dict[str, Any], open_accounts: set[int]
    ) -> None:
        for account_id in await push.accounts():
            if account_id in open_accounts:
                continue  # 탭이 열려 있으면 그 탭이 알린다
            account = await sessions.repo.account(account_id)
            if account is None or account.get("status") != "active":
                continue
            prefs = await settings_store.get(account_id)
            if not prefs["notify"]:
                continue
            target = Subscriber(
                user_id=int(account["discord_user_id"]),
                account_id=account_id,
                notify_scope=prefs["notify_scope"],
            )
            if not await perms.can_read(target.user_id, channel_id):
                continue
            payload = await notify_rule(target, channel_id, message)
            if payload is None:
                continue
            last_push[account_id] = {**payload, "at": clock()}
            await push.send(account_id)

    hub.set_after_notify(push_after_notify)
    egress = EgressMeter(lists, settings.egress_limit_bytes, notify=notify_operator, clock=clock)
    sender = (
        SenderService(
            repo,
            SenderRepo(db),
            cipher,
            messenger,
            directory,
            perms,
            hub,
            clock=clock,
            emojis=emojis,
        )
        if messenger is not None
        else None
    )
    settings_store = SettingsStore(db, clock=clock)
    sessions = SessionService(
        AuthRepo(db),
        cipher,
        oauth
        or DiscordOAuth(
            settings.discord_client_id,
            settings.discord_client_secret,
            settings.connect_redirect_uri,
        ),
        bot_guild_ids=directory.guild_ids,
        clock=clock,
        lock_seconds=settings_store.lock_seconds,
    )
    connect_limiter = RateLimiter(limit=20, window_sec=600)
    send_limiter = RateLimiter(limit=2, window_sec=1, clock=clock)  # 계정당 1초 2번(설계서 11장)
    reaction_limiter = RateLimiter(limit=4, window_sec=2, clock=clock)  # 디스코드 반응 한도에 맞춰
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
    app.state.sender = sender  # 디스코드 앱 메시지 명령(봇)도 같은 서비스를 쓴다
    app.state.sessions = sessions  # 봇이 니트로 증거를 보면 알려 준다
    app.state.push = push

    # ------------------------------------------------------------ 공통 보호

    @app.middleware("http")
    async def protect(request: Request, call_next: Any) -> Response:
        # 상태를 바꾸는 요청은 우리 화면에서 온 것만(CSRF 방지, SameSite 쿠키와 이중)
        if request.method in UNSAFE_METHODS and request.url.path.startswith("/api/"):
            if request.headers.get("origin") != settings.public_origin:
                return JSONResponse({"detail": "forbidden"}, status_code=403)
        response: Response = await call_next(request)
        if request.url.path.startswith("/api/"):
            length = response.headers.get("content-length")
            if length and length.isdigit():
                await egress.record(int(length))  # 월 송신량(가끔 모아서 기록)
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

    @app.exception_handler(SendError)
    async def send_error(_request: Request, error: SendError) -> JSONResponse:
        return JSONResponse({"detail": error.code}, status_code=error.status)

    async def read_uploads(files: list[UploadFile]) -> tuple[list[OutgoingFile], int]:
        """올린 파일을 읽는다(합계 10MB를 넘으면 그 자리에서 멈춤)."""
        outgoing: list[OutgoingFile] = []
        total = 0
        for upload in files:
            chunks = []
            while chunk := await upload.read(UPLOAD_CHUNK):
                total += len(chunk)
                if total > MAX_FILES_BYTES:
                    raise HTTPException(status_code=413, detail="files_too_large")
                chunks.append(chunk)
            name = safe_filename(upload.filename or "file")
            outgoing.append(
                OutgoingFile(name, b"".join(chunks), spoiler=name.startswith("SPOILER_"))
            )
        return outgoing, total

    def require_sender(account: ActiveAccount) -> SenderService:
        if sender is None:
            raise HTTPException(status_code=503, detail="sending_unavailable")
        if not send_limiter.allow(f"account:{account.account_id}"):
            raise SessionError("rate_limited", status=429, retry_after=1)
        return sender

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

    @app.post("/api/account/nitro", status_code=204)
    async def set_nitro(body: NitroBody, request: Request) -> None:
        """'니트로 있어요' 켜기·끄기. 켠 계정만 디스코드 앱 사용으로 7일씩 확인한다."""
        account = await require_account(request)
        await sessions.set_nitro_claim(account, body.claimed)

    @app.get("/api/settings")
    async def get_settings(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        return await settings_store.get(account.account_id)

    @app.patch("/api/settings")
    async def update_settings(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        try:
            body = await request.json()
        except ValueError as error:
            raise HTTPException(status_code=400, detail="bad_json") from error
        if not isinstance(body, dict) or len(body) > 10:
            raise HTTPException(status_code=400, detail="bad_json")
        try:
            saved = await settings_store.update(account.account_id, body)
        except SettingsError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        if "lock_minutes" in body:
            # 지금 열려 있는 이 기기의 잠금 시간도 새 기준으로 바로 맞춘다
            await sessions.require_active(await current_device(request))
        return saved

    @app.post("/api/session/lock", status_code=204)
    async def lock(request: Request) -> None:
        await sessions.lock(await current_device(request))

    @app.post("/api/session/switch", status_code=204)
    async def switch(body: SwitchBody, request: Request) -> None:
        await sessions.switch(await current_device(request), int(body.account_id))

    @app.delete("/api/session/accounts/{account_id}", status_code=204)
    async def remove_account(account_id: int, request: Request, response: Response) -> None:
        device = await current_device(request)
        if device is not None:
            await push.forget_device_account(device.id, account_id)
        if await sessions.remove_account(device, account_id):
            clear_device_cookie(response)

    # ------------------------------------------------------------ 모임·채널 목록

    async def unread_for(
        account: ActiveAccount, accesses: list[ChannelAccess]
    ) -> dict[int, tuple[int, int]]:
        ids = [access.channel.id for access in accesses if access.channel.kind != "forum"]
        return await lists.unread(account.account_id, account.discord_user_id, ids)

    def with_unread(data: dict[str, Any], counts: tuple[int, int] | None) -> dict[str, Any]:
        data["unread"], data["mentions"] = counts or (0, 0)
        return data

    @app.get("/api/groups")
    async def list_groups(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        user = account.discord_user_id
        pins = await lists.pins(account.account_id)
        group_pins = {p["target_id"]: p["position"] for p in pins if p["kind"] == "group"}
        groups = []
        for guild in await perms.visible_guilds(user):
            accesses = await perms.visible_channels(user, guild.id) or []
            counts = await unread_for(account, accesses)
            data = group_to_api(guild)
            data["pinned"] = guild.id in group_pins
            data["unread"] = sum(count for count, _ in counts.values())
            data["mentions"] = sum(mention for _, mention in counts.values())
            groups.append(data)
        groups.sort(
            key=lambda g: (
                group_pins.get(int(g["id"]), 1_000_000),
                str(g["name"]).casefold(),
            )
        )
        pinned_channels = []
        for pin in pins:
            if pin["kind"] != "channel":
                continue
            access = await perms.channel_access(user, pin["target_id"])
            if access is None:
                continue  # 권한이 사라진 고정은 숨긴다(지우지는 않음)
            guild = directory.guild(access.channel.guild_id)
            counts = await unread_for(account, [access])
            data = channel_to_api(access, group_name=guild.name if guild else "")
            pinned_channels.append(with_unread(data, counts.get(access.channel.id)))
        return {"groups": groups, "pinned_channels": pinned_channels}

    @app.get("/api/groups/{group_id}/channels")
    async def list_channels(group_id: int, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        accesses = await perms.visible_channels(account.discord_user_id, group_id)
        guild = directory.guild(group_id)
        if accesses is None or guild is None:
            raise HTTPException(status_code=404, detail="not found")
        pins = await lists.pins(account.account_id)
        pinned = {p["target_id"] for p in pins if p["kind"] == "channel"}
        counts = await unread_for(account, accesses)
        group = group_to_api(guild)
        group["pinned"] = any(p["kind"] == "group" and p["target_id"] == group_id for p in pins)
        channels = []
        for access in accesses:
            data = with_unread(channel_to_api(access), counts.get(access.channel.id))
            data["pinned"] = access.channel.id in pinned
            channels.append(data)
        return {"group": group, "channels": channels}

    @app.post("/api/pins", status_code=204)
    async def add_pin(body: PinBody, request: Request) -> None:
        account = await require_account(request)
        require_ready()
        target = int(body.id)
        if body.kind == "group":
            if await perms.visible_channels(account.discord_user_id, target) is None:
                raise HTTPException(status_code=404, detail="not found")
            limit = MAX_PINNED_GROUPS
        else:
            await require_channel(account, target)
            limit = MAX_PINNED_CHANNELS
        if not await lists.add_pin(account.account_id, body.kind, target, limit):
            raise HTTPException(status_code=409, detail="pin_limit")

    @app.delete("/api/pins/{kind}/{target_id}", status_code=204)
    async def remove_pin(kind: str, target_id: int, request: Request) -> None:
        account = await require_account(request)
        if kind not in ("group", "channel"):
            raise HTTPException(status_code=404, detail="not found")
        await lists.remove_pin(account.account_id, kind, target_id)

    @app.post("/api/channels/{channel_id}/read", status_code=204)
    async def mark_read(channel_id: int, body: ReadBody, request: Request) -> None:
        account = await require_account(request)
        require_ready()
        await require_channel(account, channel_id)
        await lists.mark_read(account.account_id, channel_id, int(body.last_id))

    @app.get("/api/channels/{channel_id}/threads")
    async def list_threads(
        channel_id: int,
        request: Request,
        before: float | None = Query(default=None, gt=0),
    ) -> dict[str, Any]:
        """포럼의 글 목록, 일반 채널의 스레드 목록. 열린 것 먼저, 보관된 것은 25개씩."""
        account = await require_account(request)
        require_ready()
        access = await require_channel(account, channel_id)
        if access.channel.kind == "thread":
            raise HTTPException(status_code=404, detail="not found")
        threads, has_more = await directory.list_threads(channel_id, before, THREAD_PAGE)
        items = []
        for thread in threads:
            if thread.private_thread and not await perms.can_read(
                account.discord_user_id, thread.id
            ):
                continue  # 비공개 스레드는 들어가 있는 사람(또는 스레드 관리 권한)만
            preview = None
            if access.channel.kind == "forum":
                starter = await repo.get(thread.id)  # 포럼 글 ID = 첫 메시지 ID
                if starter is not None:
                    text = re.sub(r"[*_~`|>]", "", row_to_api(starter)["content"])
                    preview = " ".join(text.split())[:120] or None
            items.append(thread_to_api(thread, preview))
        archived = [t.archive_ts for t in threads if t.archived and t.archive_ts]
        guild = directory.guild(access.channel.guild_id)
        return {
            "parent": channel_to_api(access, group_name=guild.name if guild else ""),
            "threads": items,
            "has_more": has_more,
            "next_before": min(archived) if has_more and archived else None,
        }

    @app.get("/api/channels/{channel_id}/emojis")
    async def channel_emojis(channel_id: int, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        access = await require_channel(account, channel_id)
        items = await emojis.usable(account.discord_user_id, account.premium, access)
        state = next(
            (
                item["nitro"]
                for item in (await sessions.describe(await current_device(request)))["accounts"]
                if item["id"] == str(account.account_id)
            ),
            "none",
        )
        return {
            "premium": account.premium,
            "nitro": state,
            "emojis": [
                {
                    "id": str(item.emoji.id),
                    "name": item.emoji.name,
                    "animated": item.emoji.animated,
                    "group_id": str(item.emoji.guild_id),
                    "group_name": item.group_name,
                }
                for item in items
            ],
        }

    @app.get("/api/channels/{channel_id}")
    async def channel_detail(channel_id: int, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        access = await require_channel(account, channel_id)
        guild = directory.guild(access.channel.guild_id)
        data = channel_to_api(access, group_name=guild.name if guild else "")
        channel = access.channel
        if channel.kind == "thread" and channel.parent_id:
            # 글·스레드 화면: 부모 이름, 붙은 태그, 첫 메시지(글 ID = 첫 메시지 ID)
            parent = directory.channel(channel.parent_id)
            data["parent_name"] = parent.name if parent else ""
            data["parent_kind"] = parent.kind if parent else "text"
            tags = {tag.id: tag for tag in (parent.forum_tags if parent else ())}
            data["applied_tags"] = [
                {"id": str(tag.id), "name": tag.name, "emoji": tag.emoji, "usable": True}
                for tag_id in channel.applied_tag_ids
                if (tag := tags.get(tag_id)) is not None
            ]
            starter = await repo.get(channel.id)
            allowed_homes = {channel.id, channel.parent_id}
            data["starter"] = (
                row_to_api(starter)
                if starter is not None and int(starter["channel_id"]) in allowed_homes
                else None
            )
        return data

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

    @app.post("/api/channels/{channel_id}/messages")
    async def send_message(channel_id: int, body: SendBody, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        service = require_sender(account)
        return await service.send(
            account.account_id,
            account.discord_user_id,
            channel_id,
            body.content,
            body.nonce,
            int(body.reply_to) if body.reply_to else None,
            premium=account.premium,
        )

    @app.post("/api/channels/{channel_id}/messages/files")
    async def send_files(
        channel_id: int,
        request: Request,
        nonce: Annotated[str, Form(pattern=NONCE_PATTERN)],
        content: Annotated[str, Form(max_length=2000)] = "",
        reply_to: Annotated[str | None, Form(pattern=SNOWFLAKE_PATTERN)] = None,
        files: Annotated[list[UploadFile] | None, File()] = None,
    ) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        if not files or len(files) > MAX_FILES:
            raise HTTPException(status_code=400, detail="too_many_files")
        if not await egress.attachments_allowed():
            raise HTTPException(status_code=403, detail="egress_limit")
        outgoing, total = await read_uploads(files)
        service = require_sender(account)
        message = await service.send(
            account.account_id,
            account.discord_user_id,
            channel_id,
            content,
            nonce,
            int(reply_to) if reply_to else None,
            premium=account.premium,
            files=outgoing,
        )
        await egress.record(total, force=True)
        return message

    @app.get("/api/channels/{channel_id}/stickers")
    async def channel_stickers(channel_id: int, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        access = await require_channel(account, channel_id)
        items = await emojis.usable_stickers(account.discord_user_id, account.premium, access)
        return {
            "stickers": [
                {
                    "id": str(item.sticker.id),
                    "name": item.sticker.name,
                    "format": item.sticker.format,
                    "group_name": item.group_name,
                }
                for item in items
            ]
        }

    @app.post("/api/channels/{channel_id}/stickers")
    async def send_sticker(channel_id: int, body: StickerBody, request: Request) -> dict[str, Any]:
        """스티커 보내기. 웹훅은 진짜 스티커를 못 보내서, 스티커 그림을 사진으로 보낸다."""
        account = await require_account(request)
        require_ready()
        access = await require_channel(account, channel_id)
        if not await egress.attachments_allowed():
            raise HTTPException(status_code=403, detail="egress_limit")
        usable = await emojis.usable_stickers(account.discord_user_id, account.premium, access)
        found = next(
            (item.sticker for item in usable if str(item.sticker.id) == body.sticker_id), None
        )
        if found is None:
            raise HTTPException(status_code=403, detail="sticker_not_allowed")
        data = await directory.sticker_image(found)
        if len(data) > STICKER_MAX_BYTES:
            raise HTTPException(status_code=413, detail="files_too_large")
        extension = "gif" if found.format == GIF_STICKER else "png"
        service = require_sender(account)
        message = await service.send(
            account.account_id,
            account.discord_user_id,
            channel_id,
            "",
            body.nonce,
            int(body.reply_to) if body.reply_to else None,
            premium=account.premium,
            files=[OutgoingFile(safe_filename(f"{found.name}.{extension}"), data)],
        )
        await egress.record(len(data), force=True)
        return message

    @app.post("/api/channels/{channel_id}/posts")
    async def create_post(
        channel_id: int,
        request: Request,
        nonce: Annotated[str, Form(pattern=NONCE_PATTERN)],
        title: Annotated[str, Form(min_length=1, max_length=100)],
        content: Annotated[str, Form(max_length=2000)] = "",
        tag_ids: Annotated[str, Form(max_length=120, pattern=r"^[0-9,]*$")] = "",
        files: Annotated[list[UploadFile] | None, File()] = None,
    ) -> dict[str, Any]:
        """포럼 새 글(글자·태그·첨부). 글 ID를 돌려준다."""
        account = await require_account(request)
        require_ready()
        uploads = files or []
        if len(uploads) > MAX_FILES:
            raise HTTPException(status_code=400, detail="too_many_files")
        if uploads and not await egress.attachments_allowed():
            raise HTTPException(status_code=403, detail="egress_limit")
        outgoing, total = await read_uploads(uploads)
        tags = [int(part) for part in tag_ids.split(",") if part.isdigit() and len(part) <= 21]
        service = require_sender(account)
        result = await service.create_post(
            account.account_id,
            account.discord_user_id,
            channel_id,
            title,
            content,
            tags,
            nonce,
            premium=account.premium,
            files=outgoing,
        )
        if total:
            await egress.record(total, force=True)
        return result

    @app.patch("/api/messages/{message_id}")
    async def edit_message(message_id: int, body: EditBody, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        require_ready()
        service = require_sender(account)
        return await service.edit(
            account.discord_user_id, message_id, body.content, premium=account.premium
        )

    # ------------------------------------------------------------ 반응

    async def publish_reactions(channel_id: int, message_id: int) -> list[dict[str, Any]]:
        row = await repo.get(message_id)
        items = row_to_api(row)["reactions"] if row else []
        await hub.publish(
            channel_id,
            "reactions_update",
            {"channel_id": str(channel_id), "message_id": str(message_id), "reactions": items},
        )
        return items

    @app.post("/api/messages/{message_id}/reactions")
    async def toggle_reaction(
        message_id: int, body: ReactionBody, request: Request
    ) -> dict[str, Any]:
        """반응 누르기·빼기. 디스코드에는 봇이 하나만 달고, 누가 눌렀는지는 여기 남긴다."""
        account = await require_account(request)
        require_ready()
        if messenger is None:
            raise HTTPException(status_code=503, detail="sending_unavailable")
        if not reaction_limiter.allow(f"account:{account.account_id}"):
            raise SessionError("rate_limited", status=429, retry_after=1)
        row = await repo.get(message_id)
        if row is None:
            raise HTTPException(status_code=404, detail="not found")
        channel_id = int(row["channel_id"])
        access = await require_channel(account, channel_id)
        try:
            emoji = reactions.parse_emoji(body.emoji)
        except reactions.ReactionError as error:
            raise HTTPException(status_code=400, detail="bad_emoji") from error
        key = reactions.emoji_key(emoji["id"], emoji["name"])
        user = account.discord_user_id
        known = set(row.get("reaction_users") or [])
        stored = next(
            (item for item in json.loads(row["reactions_json"] or "[]") if item["key"] == key),
            None,
        )
        bot_has = bool(stored and stored.get("bot"))
        if (key, user, "web") in known:
            await repo.set_reaction_user(message_id, key, user, "web", False)
            others = [u for (k, u, via) in known if k == key and via == "web" and u != user]
            if bot_has and not others:
                await messenger.remove_reaction(channel_id, message_id, emoji)
                await repo.change_reaction(message_id, emoji, -1, by_bot=True)
        else:
            if (key, user, "discord") in known:
                raise HTTPException(status_code=409, detail="reacted_in_discord")
            if stored is None and not access.permissions & ADD_REACTIONS:
                raise HTTPException(status_code=403, detail="no_permission")
            if emoji["id"] is not None:
                usable = await emojis.usable(user, account.premium, access)
                if emoji["id"] not in {item.emoji.id for item in usable}:
                    raise HTTPException(status_code=403, detail="emoji_not_allowed")
            if not bot_has:
                await messenger.add_reaction(channel_id, message_id, emoji)
                await repo.change_reaction(message_id, emoji, 1, by_bot=True)
            await repo.set_reaction_user(message_id, key, user, "web", True)
        return {"reactions": await publish_reactions(channel_id, message_id)}

    # ------------------------------------------------------------ 웹 푸시

    @app.get("/api/push/key")
    async def push_key(request: Request) -> dict[str, Any]:
        await require_account(request)
        return {"key": await push.public_key()}

    @app.post("/api/push/subscribe", status_code=204)
    async def push_subscribe(body: PushBody, request: Request) -> None:
        account = await require_account(request)
        try:
            await push.subscribe(account.device_id, account.account_id, body.endpoint)
        except PushError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/api/push/unsubscribe", status_code=204)
    async def push_unsubscribe(body: PushBody, request: Request) -> None:
        device = await current_device(request)
        if device is not None:
            await push.unsubscribe(body.endpoint, device.id)

    @app.post("/api/push/status")
    async def push_status(body: PushBody, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        return {
            "subscribed": await push.subscribed(
                body.endpoint, account.device_id, account.account_id
            )
        }

    @app.get("/api/push/latest")
    async def push_latest(request: Request) -> dict[str, Any]:
        """서비스 워커가 푸시를 받으면 보여 줄 글. 잠겨 있거나 내용 보이기를 껐으면 내용 없이."""
        device = await current_device(request)
        if device is None or device.active_account_id is None:
            raise HTTPException(status_code=404, detail="not found")
        account_id = device.active_account_id
        prefs = await settings_store.get(account_id)
        title = prefs["tab_title"] or DEFAULT_TITLES.get(prefs["theme"], "작업 메모")
        latest = last_push.get(account_id)
        result: dict[str, Any] = {"title": title, "body": "새 알림이 있어요", "url": "/"}
        if latest is None:
            return result
        route = (
            f"#/g/{latest['group_id']}/p/{latest['parent_id']}/t/{latest['channel_id']}"
            if latest.get("parent_id")
            else f"#/g/{latest['group_id']}/c/{latest['channel_id']}"
        )
        result["url"] = "/" + route
        unlocked = True
        try:
            await sessions.require_active(device, touch=False)
        except SessionError:
            unlocked = False
        if prefs["notify_preview"] and unlocked:
            text = " ".join(str(latest["content"]).split())[:80] or latest.get("extra") or ""
            result["title"] = f"{latest['author_name']} (#{latest['channel_name']})"
            result["body"] = text or "새 메시지"
        return result

    # ------------------------------------------------------------ 위장 화면 파일(계정에 저장)

    async def read_body(request: Request, limit: int) -> bytes:
        length = request.headers.get("content-length", "")
        if length.isdigit() and int(length) > limit:
            raise HTTPException(status_code=413, detail="file_too_large")
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > limit:
                raise HTTPException(status_code=413, detail="file_too_large")
            chunks.append(chunk)
        return b"".join(chunks)

    @app.exception_handler(BossFileError)
    async def boss_file_error(_request: Request, error: BossFileError) -> JSONResponse:
        return JSONResponse({"detail": error.code}, status_code=error.status)

    @app.get("/api/boss")
    async def boss_info(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        return {"assets": await boss_files.info(account.account_id)}

    @app.delete("/api/boss", status_code=204)
    async def boss_reset(request: Request) -> None:
        account = await require_account(request)
        await boss_files.reset(account.account_id)

    @app.get("/api/boss/assets/{kind}")
    async def boss_asset(kind: str, request: Request) -> Response:
        account = await require_account(request)
        found = await boss_files.load(account.account_id, kind)
        if found is None:
            raise HTTPException(status_code=404, detail="not found")
        data, mime, version = found
        return Response(
            data,
            media_type=mime,
            headers={
                "Cache-Control": "private, no-store",
                "X-Boss-Version": version,
                "Content-Disposition": "inline",
            },
        )

    @app.put("/api/boss/assets/{kind}")
    async def boss_asset_save(
        kind: str, request: Request, name: str = Query(default="", max_length=200)
    ) -> dict[str, Any]:
        account = await require_account(request)
        if kind not in BOSS_KINDS:
            raise HTTPException(status_code=404, detail="not found")
        data = await read_body(request, BOSS_MAX_BYTES[kind])
        return await boss_files.save(account.account_id, kind, name, data)

    @app.delete("/api/boss/assets/{kind}", status_code=204)
    async def boss_asset_delete(kind: str, request: Request) -> None:
        account = await require_account(request)
        await boss_files.delete(account.account_id, kind)

    @app.get("/api/boss/edits/{key}")
    async def boss_edits(key: str, request: Request) -> dict[str, Any]:
        account = await require_account(request)
        return {"edits": await boss_files.edits(account.account_id, key)}

    @app.put("/api/boss/edits/{key}", status_code=204)
    async def boss_edits_save(key: str, request: Request) -> None:
        account = await require_account(request)
        raw = await read_body(request, BOSS_MAX_EDITS)
        try:
            value = json.loads(raw)
        except ValueError as error:
            raise HTTPException(status_code=400, detail="bad_json") from error
        if not isinstance(value, dict | str):
            raise HTTPException(status_code=400, detail="bad_json")
        await boss_files.save_edits(account.account_id, key, value)

    @app.delete("/api/boss/edits/{key}", status_code=204)
    async def boss_edits_delete(key: str, request: Request) -> None:
        account = await require_account(request)
        await boss_files.delete_edits(account.account_id, key)

    @app.delete("/api/messages/{message_id}", status_code=204)
    async def delete_message(message_id: int, request: Request) -> None:
        account = await require_account(request)
        require_ready()
        await require_sender(account).delete(account.discord_user_id, message_id)

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
        hub.add(websocket, account.discord_user_id, account.account_id)

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
        """화면이 보는 채널: {"type": "subscribe", "channel_id": "123" | null}
        알림 받기: {"type": "notify", "scope": "mentions" | "pinned" | null}"""
        try:
            message = json.loads(text)
        except ValueError:
            return
        if isinstance(message, dict) and message.get("type") == "notify":
            scope = message.get("scope")
            hub.set_notify(websocket, scope if isinstance(scope, str) else None)
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
