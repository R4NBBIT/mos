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
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketDisconnect

from mos.api.command_routes import register_command_routes
from mos.api.rate_limit import RateLimiter
from mos.api.todo_ai_routes import register_todo_ai_routes
from mos.api.todo_friend_routes import register_todo_friend_routes
from mos.api.todo_routes import register_todo_routes
from mos.config import Settings
from mos.db.auth_repo import AuthRepo
from mos.db.database import Database
from mos.db.lists_repo import ListsRepo
from mos.db.repo import MAX_PAGE_SIZE, MessageRepo
from mos.db.sender_repo import SenderRepo
from mos.db.todo_repo import TodoRepo
from mos.services import reactions
from mos.services.boss_files import KINDS as BOSS_KINDS
from mos.services.boss_files import MAX_BYTES as BOSS_MAX_BYTES
from mos.services.boss_files import MAX_EDITS_BYTES as BOSS_MAX_EDITS
from mos.services.boss_files import BossFileError, BossFiles
from mos.services.commands import BotCommands
from mos.services.crypto import BytesCipher, TokenCipher
from mos.services.directory import (
    ChannelInfo,
    Directory,
    DirectoryError,
    GuildInfo,
    VoiceChannelInfo,
)
from mos.services.discord_oauth import DiscordOAuth, OAuthClient
from mos.services.egress import EgressMeter
from mos.services.emojis import EmojiService
from mos.services.media_proxy import (
    DiscordFetcher,
    Fetched,
    MediaCache,
    parse_media_url,
    response_headers,
)
from mos.services.media_urls import AttachmentRefresher
from mos.services.menu import MenuService
from mos.services.messages import row_to_api
from mos.services.notify_prefs import NotifyPrefs, NotifyPrefsError
from mos.services.permissions import ADD_REACTIONS, ChannelAccess, PermissionService, is_private
from mos.services.push import PushError, PushService
from mos.services.realtime import MAX_VOICE_GROUPS, RealtimeHub, Subscriber
from mos.services.retention import RETENTION_DAYS, cutoff_snowflake
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
from mos.services.todo import TodoService
from mos.services.todo_access import FEATURE_NAME as TODO_FEATURE
from mos.services.todo_access import TodoAccess
from mos.services.todo_ai_actions import TodoAiActions
from mos.services.todo_alerts import TodoAlerts
from mos.services.todo_bin import TodoBin
from mos.services.todo_friends import TodoFriends
from mos.services.todo_mcp import TodoMcp
from mos.services.todo_oauth import TodoOAuth
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
SEARCH_PAGE = 25
RANGE_RE = re.compile(r"bytes=[0-9]{0,15}-[0-9]{0,15}")
SEARCH_MAX_WORDS = 5
SEARCH_MAX_LEN = 100
FILES_PAGE = 40
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


def channel_to_api(
    access: ChannelAccess, group_name: str | None = None, guild: GuildInfo | None = None
) -> dict[str, Any]:
    channel = access.channel
    data: dict[str, Any] = {
        "id": str(channel.id),
        "name": channel.name,
        "kind": channel.kind,
        "group_id": str(channel.guild_id),
        "category_id": str(channel.category_id) if channel.category_id else None,
        "category_name": channel.category_name,
        "category_position": channel.category_position,
        "can_send": access.can_send,
        # 이 사람에게 걸리는 슬로우 모드(초, 관리 권한이 있으면 0)
        "slowmode": access.slowmode,
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
    elif guild is not None:
        data["private"] = is_private(guild, channel)
    if group_name is not None:
        data["group_name"] = group_name
    return data


# 아이콘 그림을 바꾸면 올린다(설치한 앱과 브라우저가 옛 그림을 붙잡지 않게)
APP_ICON_VERSION = "2"
# 홈 화면 앱(설치형 웹앱) 아이콘: 키 → 바탕색. 그림은 web/public/app-icons/
APP_ICONS = {
    "a": "#f3f1ea",
    "b": "#ffd66b",
    "c": "#e9f0fb",
    "d": "#fdecea",
    "e": "#8ab4f8",
    "f": "#e4f1e8",
    "g": "#efeaf8",
    "h": "#26272b",
}
APP_DEFAULT_NAME = "ㅁㅇㅅ"
APP_DEFAULT_ICON = "h"
APP_NAME_MAX = 20


def clean_app_name(raw: str | None) -> str:
    """홈 화면 이름: 제어 문자와 앞뒤 공백을 빼고, 공백은 하나로, 20자까지. 비면 기본 이름."""
    text = "".join(ch for ch in (raw or "") if ch.isprintable())
    text = " ".join(text.split())[:APP_NAME_MAX].strip()
    return text or APP_DEFAULT_NAME


def app_manifest_data(name: str | None, icon: str | None) -> dict[str, Any]:
    """설치할 때 쓰는 정보(manifest). 이름과 아이콘은 설치하는 사람이 고른 것."""
    key = icon if icon in APP_ICONS else APP_DEFAULT_ICON
    label = clean_app_name(name)
    color = APP_ICONS[key]
    v = APP_ICON_VERSION
    return {
        "id": "/",
        "name": label,
        "short_name": label,
        "lang": "ko",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": color,
        "theme_color": color,
        "icons": [
            {"src": f"/app-icons/{key}-192.png?v={v}", "sizes": "192x192", "type": "image/png"},
            {"src": f"/app-icons/{key}-512.png?v={v}", "sizes": "512x512", "type": "image/png"},
            {
                "src": f"/app-icons/{key}-maskable.png?v={v}",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "maskable",
            },
        ],
    }


def voice_to_api(voice: VoiceChannelInfo, guild: GuildInfo) -> dict[str, Any]:
    channel = voice.channel
    members = sorted(voice.members, key=lambda m: (m.is_bot, m.display_name.casefold()))
    return {
        "id": str(channel.id),
        "name": channel.name,
        "kind": channel.kind,
        "group_id": str(channel.guild_id),
        "group_name": guild.name,
        "category_id": str(channel.category_id) if channel.category_id else None,
        "category_name": channel.category_name,
        "category_position": channel.category_position,
        "private": is_private(guild, channel),
        "members": [
            {
                "id": str(member.user_id),
                "name": member.display_name,
                "avatar_url": member.avatar_url,
                "muted": member.muted,
                "deafened": member.deafened,
                "streaming": member.streaming,
                "video": member.video,
                "bot": member.is_bot,
            }
            for member in members
        ],
    }


class PostEditBody(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    tag_ids: list[str] | None = Field(default=None, max_length=10)


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
    run_background: bool = True,
    send_dm: Callable[[int, str], Awaitable[bool]] | None = None,
    media_fetcher: Any = None,
) -> FastAPI:
    perms = permissions or PermissionService(directory)
    hub.set_access_check(perms.can_read)
    hub.set_group_check(perms.is_member)
    cipher = TokenCipher(settings.secret_key)
    boss_files = BossFiles(db, BytesCipher(cipher), clock=clock)
    emojis = EmojiService(directory, perms)
    lists = ListsRepo(db)
    attachments = AttachmentRefresher(directory, repo, clock=clock)

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
        hidden = {int(item) for item in (await settings_store.get(subscriber.account_id))["hidden"]}
        device_prefs = await notify_prefs.get(subscriber.device_id, subscriber.account_id)
        hidden_mode = device_prefs["hidden"]  # 숨긴 곳 알림은 기기마다
        if hidden & {channel_id, channel.parent_id, channel.guild_id}:
            # 숨긴 서버, 채널(그 스레드 포함): 숨김 알림 설정을 먼저 따른다
            if hidden_mode == "none" or (hidden_mode == "mentions" and not mentioned):
                return None
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
    # (기기, 계정) → 마지막 알림 내용(서비스 워커가 받아 감)
    last_push: dict[tuple[int, int], dict[str, Any]] = {}

    async def push_after_notify(
        channel_id: int, message: dict[str, Any], open_tabs: set[tuple[int, int]]
    ) -> None:
        """탭을 닫아 둔 기기에 웹 푸시. 기기마다 그 기기의 알림 설정을 따른다."""
        for device_id, account_id in await push.targets():
            if (device_id, account_id) in open_tabs:
                continue  # 그 기기에 탭이 열려 있으면 탭이 알린다(다른 기기는 따로)
            account = await sessions.repo.account(account_id)
            if account is None or account.get("status") != "active":
                continue
            prefs = await notify_prefs.get(device_id, account_id)
            if not prefs["notify"]:
                continue
            target = Subscriber(
                user_id=int(account["discord_user_id"]),
                account_id=account_id,
                device_id=device_id,
                notify_scope=prefs["scope"],
            )
            if not await perms.can_read(target.user_id, channel_id):
                continue
            payload = await notify_rule(target, channel_id, message)
            if payload is None:
                continue
            last_push[(device_id, account_id)] = {**payload, "at": clock()}
            await push.send(account_id, device_id)

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
    notify_prefs = NotifyPrefs(db, settings_store)
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
    search_limiter = RateLimiter(limit=20, window_sec=10, clock=clock)  # 찾기, 서랍(계정당)
    unlock_limiter = RateLimiter(limit=10, window_sec=60)
    # 그림 넘겨주기: 화면 하나에 이모지, 프로필 사진이 많아 넉넉히(계정당)
    media_limiter = RateLimiter(limit=600, window_sec=60, clock=clock)
    fetcher = media_fetcher or DiscordFetcher()
    media_cache = MediaCache()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        opened_here = not db.is_open
        await db.open()
        alert_task = asyncio.create_task(_app.state.todo_alert_loop()) if run_background else None
        try:
            yield
        finally:
            if alert_task is not None:
                alert_task.cancel()
            with contextlib.suppress(Exception):
                await _app.state.media_fetcher.close()
            if opened_here:
                await db.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.sender = sender  # 디스코드 앱 메시지 명령(봇)도 같은 서비스를 쓴다
    app.state.sessions = sessions  # 봇이 니트로 증거를 보면 알려 준다
    app.state.push = push
    app.state.media_fetcher = fetcher  # 테스트가 가짜로 바꿀 수 있게

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
        if request.url.path.startswith("/api/") and request.url.path != "/api/media":
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
        headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
        return JSONResponse({"detail": error.code}, status_code=error.status, headers=headers)

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

    # ------------------------------------------------------------ TODO(공개 전, 기능 스위치)

    todo_access = TodoAccess(settings)
    todo_repo = TodoRepo(db)
    todo_service = TodoService(todo_repo, clock)
    todo_account = register_todo_routes(app, require_account, todo_access, todo_service, clock)

    async def active_user(account_id: int) -> int | None:
        account = await sessions.repo.account(account_id)
        if account is None or account.get("status") != "active":
            return None
        return int(account["discord_user_id"])

    todo_actions = TodoAiActions(db, todo_service, todo_repo, clock)
    todo_service.trash = todo_actions.trash_item
    todo_bin = TodoBin(db, clock)  # 카테고리, 반복 앞으로 것, 그룹 지우기도 휴지통에 7일
    todo_service.bin = todo_bin
    todo_actions.bin = todo_bin
    register_todo_ai_routes(
        app,
        origin=settings.public_origin.rstrip("/"),
        todo_account=todo_account,
        account_status=active_user,
        access=todo_access,
        oauth=TodoOAuth(db, clock),
        mcp=TodoMcp(todo_service, todo_repo, todo_actions, clock),
        actions=todo_actions,
        todo=todo_service,
        clock=clock,
    )
    todo_alerts = TodoAlerts(todo_service, todo_repo, clock)

    async def send_todo_alerts() -> None:
        """TODO 알림(NOTI-01, NOTI-03, NOTI-05): 허용된 활성 계정만.
        열린 탭이 있는 기기는 탭이 띄우고(위장 중 규칙은 탭이 따름), 나머지는 웹 푸시.
        아침 요약을 DM으로 고른 계정은 봇 DM."""
        due = await todo_alerts.due()
        if not due:
            return
        targets = await push.targets()
        for alert in due:
            account = await sessions.repo.account(alert.account_id)
            if account is None or account.get("status") != "active":
                continue
            user_id = int(account["discord_user_id"])
            if not todo_access.allowed(user_id):
                continue
            if alert.dm is not None and send_dm is not None:
                try:
                    sent = await send_dm(user_id, alert.dm)
                except Exception:
                    sent = False
                    logging.getLogger(__name__).warning("TODO 아침 요약 DM 실패")
                if not sent:
                    await todo_repo.add_news(
                        alert.account_id,
                        "dm_failed",
                        "봇 DM을 보내지 못했어요",
                        "ㅁㅇㅅ 봇과 같은 서버에 있고 서버 멤버의 DM을 허용했는지 확인해 주세요.",
                        int(clock()),
                    )
            if alert.push is None:
                continue
            await deliver_todo(alert.account_id, alert.push, alert.boss, targets)

    async def deliver_todo(
        account_id: int,
        payload: dict[str, Any],
        boss_mode: str,
        targets: list[tuple[int, int]] | None = None,
    ) -> None:
        """TODO 알림 하나: 열린 탭(위장 규칙은 탭이), 나머지 기기는 웹 푸시(알림 켠 기기만)."""
        event = {"type": "todo_alert", "data": {**payload, "boss_mode": boss_mode}}
        in_tabs = await hub.send_to_account(account_id, event)
        for device_id, target_account in targets if targets is not None else await push.targets():
            if target_account != account_id or device_id in in_tabs:
                continue
            if not (await notify_prefs.get(device_id, account_id))["todo"]:
                continue  # TODO 알림은 채팅 알림과 따로 켜고 끈다
            last_push[(device_id, account_id)] = {**payload, "at": clock()}
            await push.send(account_id, device_id)

    async def notify_todo(account_id: int, title: str, body: str) -> None:
        """친구 소식(NOTI-02): TODO 알림과 같은 길로(위장 중 규칙도 같은 설정)."""
        prefs = await todo_service.alert_prefs(account_id)
        payload = {"kind": "todo", "title": title, "body": body, "url": "/#/todo"}
        await deliver_todo(account_id, payload, prefs["boss_mode"])

    async def todo_guilds_of(user_id: int) -> set[int]:
        return {guild.id for guild in await perms.visible_guilds(user_id)}

    async def todo_emoji_codes(user_id: int, premium: bool) -> set[str]:
        return {
            f"<{'a' if item.emoji.animated else ''}:{item.emoji.name}:{item.emoji.id}>"
            for item in await emojis.usable_anywhere(user_id, premium)
        }

    async def todo_emoji_list(user_id: int, premium: bool) -> list[dict[str, Any]]:
        return [
            {
                "id": str(item.emoji.id),
                "name": item.emoji.name,
                "animated": item.emoji.animated,
                "group_id": str(item.emoji.guild_id),
                "group_name": item.group_name,
            }
            for item in await emojis.usable_anywhere(user_id, premium)
        ]

    todo_friends = TodoFriends(
        db,
        todo_service,
        todo_repo,
        todo_access,
        guilds_of=todo_guilds_of,
        emojis_of=todo_emoji_codes,
        notify=notify_todo,
        clock=clock,
    )
    todo_service.decorate = todo_friends.annotate
    todo_actions.friends = todo_friends  # AI가 요청한 친구 일을 승인하면 실행
    todo_friends.bin = todo_bin
    register_todo_friend_routes(
        app,
        todo_account=todo_account,
        friends=todo_friends,
        emoji_list=todo_emoji_list,
        clock=clock,
    )

    # 봇 명령(/점메추, /메뉴판, /메뉴추가, /메뉴삭제, /todo)
    # 디스코드 슬래시 명령과 웹 입력칸이 같이 쓴다
    menu = MenuService(db, clock)
    commands = BotCommands(db, menu, todo_service, todo_access, settings.operator_discord_id)
    commands.more.friends = todo_friends
    commands.more.trash_list = todo_actions.trash
    commands.more.trash_restore = todo_actions.restore
    app.state.menu = menu
    app.state.commands = commands
    register_command_routes(
        app,
        require_account=require_account,
        commands=commands,
        menu=menu,
        perms=perms,
        db=db,
        clock=clock,
    )

    async def todo_alert_loop() -> None:
        while True:
            await asyncio.sleep(60 - time.time() % 60 + 1)  # 매분 1초쯤
            try:
                await send_todo_alerts()
            except Exception:  # 다음 분에 다시
                logging.getLogger(__name__).exception("TODO 알림 보내기 실패")

    app.state.send_todo_alerts = send_todo_alerts  # 테스트가 바로 부른다
    app.state.todo_alerts = todo_alerts
    app.state.todo_alert_loop = todo_alert_loop

    # ------------------------------------------------------------ 상태 확인(자동 배포가 본다)

    @app.get("/api/app/manifest")
    async def app_manifest(name: str | None = None, icon: str | None = None) -> JSONResponse:
        """로그인 없이 받는다(설치할 때 브라우저가 쿠키 없이 가져감). 값은 검사해서만 쓴다."""
        return JSONResponse(
            app_manifest_data(name, icon),
            media_type="application/manifest+json",
            headers={"Cache-Control": "no-cache"},
        )

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
        state = await sessions.describe(await current_device(request))
        # 공개 전 기능은 허용된 계정에만 'features'를 붙인다(허용 안 되면 키도 없음)
        for account in state["accounts"]:
            if todo_access.allowed(int(account["user_id"])):
                account["features"] = [TODO_FEATURE]
                if not todo_access.is_public:
                    account["preview_features"] = [TODO_FEATURE]
        return state

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
        return await settings_store.get(account.account_id, account.device_id)

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
            saved = await settings_store.update(account.account_id, body, account.device_id)
        except SettingsError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        notify_prefs.account_changed(account.account_id)  # 기기 알림의 기본값이 바뀌었을 수 있다
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

    @app.post("/api/session/logout", status_code=204)
    async def logout(request: Request, response: Response) -> None:
        """이 브라우저에서 로그아웃: 모든 계정을 빼고 쿠키와 알림 구독도 지운다."""
        device = await current_device(request)
        if device is not None:
            await push.forget_device_account(device.id)
            await notify_prefs.forget(device.id)
            await settings_store.forget_device(device.id)
        await sessions.logout(device)
        clear_device_cookie(response)

    @app.delete("/api/session/accounts/{account_id}", status_code=204)
    async def remove_account(account_id: int, request: Request, response: Response) -> None:
        device = await current_device(request)
        if device is not None:
            await push.forget_device_account(device.id, account_id)
            await notify_prefs.forget(device.id, account_id)
            await settings_store.forget_device(device.id, account_id)
        if await sessions.remove_account(device, account_id):
            clear_device_cookie(response)

    # ------------------------------------------------------------ 모임·채널 목록

    async def unread_for(
        account: ActiveAccount, accesses: list[ChannelAccess]
    ) -> dict[int, tuple[int, int]]:
        ids = [access.channel.id for access in accesses if access.channel.kind != "forum"]
        return await lists.unread(account.account_id, account.discord_user_id, ids)

    async def hidden_prefs(account_id: int, device_id: int) -> tuple[set[int], str]:
        """숨긴 곳(계정 전체)과 이 기기의 목록 숫자 규칙."""
        prefs = await settings_store.get(account_id, device_id)
        return {int(item) for item in prefs["hidden"]}, prefs["hidden_unread"]

    def counted(counts: tuple[int, int], hidden: bool, mode: str) -> tuple[int, int]:
        """숨긴 곳의 안 읽음: 알리지 않기면 0, 나를 부른 것만이면 부른 수만, 모두면 그대로."""
        if not hidden or mode == "all":
            return counts
        if mode == "mentions":
            return counts[1], counts[1]
        return 0, 0

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
        hidden, hidden_mode = await hidden_prefs(account.account_id, account.device_id)
        groups = []
        for guild in await perms.visible_guilds(user):
            accesses = await perms.visible_channels(user, guild.id) or []
            counts = await unread_for(account, accesses)
            # 서버 합계: 숨긴 채널은 숨김 알림 설정대로 세고, 서버를 숨겼으면 합계도 그 설정대로
            parts = [counted(value, cid in hidden, hidden_mode) for cid, value in counts.items()]
            total = (sum(u for u, _ in parts), sum(m for _, m in parts))
            data = group_to_api(guild)
            data["pinned"] = guild.id in group_pins
            data["unread"], data["mentions"] = counted(total, guild.id in hidden, hidden_mode)
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
            data = channel_to_api(access, group_name=guild.name if guild else "", guild=guild)
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
            data = with_unread(channel_to_api(access, guild=guild), counts.get(access.channel.id))
            data["pinned"] = access.channel.id in pinned
            channels.append(data)
        return {"group": group, "channels": channels}

    @app.get("/api/groups/{group_id}/members")
    async def list_members(group_id: int, request: Request) -> dict[str, Any]:
        """서버 인원과, 비공개 채널처럼 일부만 볼 수 있는 채널마다 볼 수 있는 사람."""
        account = await require_account(request)
        require_ready()
        found = await perms.channel_viewers(account.discord_user_id, group_id)
        if found is None:
            raise HTTPException(status_code=404, detail="not found")
        members, restricted = found
        ordered = sorted(members, key=lambda m: (m.is_bot, m.display_name.casefold()))
        return {
            "members": [
                {
                    "id": str(member.user_id),
                    "name": member.display_name,
                    "avatar_url": member.avatar_url,
                    "bot": member.is_bot,
                }
                for member in ordered
            ],
            "restricted": {
                str(channel_id): [str(user) for user in viewers]
                for channel_id, viewers in restricted.items()
            },
        }

    @app.get("/api/groups/{group_id}/voice")
    async def list_voice(group_id: int, request: Request) -> dict[str, Any]:
        """볼 수 있는 음성 채널과 지금 들어가 있는 사람. 듣기, 말하기는 없다."""
        account = await require_account(request)
        require_ready()
        found = await perms.visible_voice_channels(account.discord_user_id, group_id)
        guild = directory.guild(group_id)
        if found is None or guild is None:
            raise HTTPException(status_code=404, detail="not found")
        return {"channels": [voice_to_api(voice, guild) for voice in found]}

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
            "parent": channel_to_api(access, group_name=guild.name if guild else "", guild=guild),
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
        data = channel_to_api(access, group_name=guild.name if guild else "", guild=guild)
        # 새 메시지 구분선: 이 채널을 열기 전에 어디까지 읽었는지(처음이면 없음)
        last_read = await lists.read_position(account.account_id, channel_id)
        data["last_read_id"] = str(last_read) if last_read is not None else None
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
            data["can_edit_post"] = bool(
                sender is not None and await sender.can_edit_post(account.discord_user_id, access)
            )
            starter = await repo.get(channel.id)
            if starter is not None:
                await attachments.fresh([starter])
            allowed_homes = {channel.id, channel.parent_id}
            data["starter"] = (
                row_to_api(starter)
                if starter is not None and int(starter["channel_id"]) in allowed_homes
                else None
            )
        return data

    @app.patch("/api/threads/{thread_id}", status_code=204)
    async def edit_post(thread_id: int, body: PostEditBody, request: Request) -> None:
        """포럼 글, 스레드의 제목과 태그.
        글쓴이나 스레드 관리 권한이 있는 사람만, 봇에도 권한이 있어야 한다."""
        account = await require_account(request)
        require_ready()
        tags = None
        if body.tag_ids is not None:
            if any(not tag.isdigit() or len(tag) > 21 for tag in body.tag_ids):
                raise HTTPException(status_code=400, detail="bad_tags")
            tags = [int(tag) for tag in body.tag_ids]
        user = account.discord_user_id
        await require_sender(account).edit_post(user, thread_id, body.title, tags)

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
        await attachments.fresh(rows)
        return {"messages": [row_to_api(row) for row in rows], "has_more": len(rows) == limit}

    # ------------------------------------------------------------ 디스코드 그림 넘겨주기

    @app.get("/api/media")
    async def media(
        request: Request,
        u: str = Query(min_length=1, max_length=2000),
        dl: int = Query(default=0, ge=0, le=1),
    ) -> Response:
        """디스코드 그림, 동영상, 파일을 대신 받아 준다(회사 망에 디스코드 주소가 남지 않게)."""
        target = parse_media_url(u)
        if target is None:
            raise HTTPException(status_code=400, detail="bad_media_url")
        device = await current_device(request)
        if target.kind == "avatar" and device is not None and device.active_account_id:
            pass  # 잠금 화면의 프로필 사진: 이 기기에 계정이 있으면(잠겨 있어도)
        else:
            # 그림을 받는 것만으로 자동 잠금 시간이 늘어나지 않게(touch=False)
            account = await sessions.require_active(device, touch=False)
            if not media_limiter.allow(f"account:{account.account_id}"):
                raise HTTPException(status_code=429, detail="too_fast")
            if target.channel_id is not None and not await perms.can_read(
                account.discord_user_id, target.channel_id
            ):
                raise HTTPException(status_code=404, detail="not found")
        range_header = request.headers.get("range")
        if range_header is not None and not RANGE_RE.fullmatch(range_header):
            range_header = None
        cached = None if range_header else media_cache.get(target.url)
        if cached is not None:
            headers, body = cached
            return Response(body, headers=response_headers(headers, target.filename, bool(dl)))
        try:
            fetched: Fetched = await app.state.media_fetcher.fetch(target.url, range_header)
        except Exception as error:
            raise HTTPException(status_code=502, detail="media_unavailable") from error
        if fetched.status not in (200, 206):
            async for _ in fetched.chunks:  # 연결을 돌려준다
                break
            status = 404 if fetched.status in (403, 404, 410) else 502
            raise HTTPException(status_code=status, detail="media_unavailable")
        headers = response_headers(fetched.headers, target.filename, bool(dl))
        length = int(fetched.headers.get("content-length") or 0)
        if target.kind != "attachment" and fetched.status == 200 and 0 < length <= 512 * 1024:
            body = b"".join([chunk async for chunk in fetched.chunks])
            media_cache.put(target.url, fetched.headers, body)
            return Response(body, headers=headers)
        return StreamingResponse(fetched.chunks, status_code=fetched.status, headers=headers)

    async def drawer_channel(request: Request, channel_id: int) -> ChannelAccess:
        """찾기와 서랍: 볼 수 있는 채널(포럼 목록 제외)인지, 너무 자주 묻지 않는지."""
        account = await require_account(request)
        require_ready()
        access = await require_channel(account, channel_id)
        if access.channel.kind == "forum":
            raise HTTPException(status_code=404, detail="not found")
        if not search_limiter.allow(f"account:{account.account_id}"):
            raise HTTPException(status_code=429, detail="too_fast")
        return access

    @app.get("/api/channels/{channel_id}/search")
    async def search_messages(
        request: Request,
        channel_id: int,
        q: str = Query(min_length=1, max_length=SEARCH_MAX_LEN),
        before: int | None = Query(default=None, ge=1),
    ) -> dict[str, Any]:
        """이 채널에서 받아 둔 메시지(보관 기간 안) 찾기. 낱말은 모두 들어가야 한다."""
        await drawer_channel(request, channel_id)
        words = q.split()[:SEARCH_MAX_WORDS]
        if not words:
            raise HTTPException(status_code=400, detail="empty_query")
        rows = await repo.search(
            channel_id, words, cutoff_snowflake(clock()), before, SEARCH_PAGE + 1
        )
        await attachments.fresh(rows[:SEARCH_PAGE])
        return {
            "messages": [row_to_api(row) for row in rows[:SEARCH_PAGE]],
            "has_more": len(rows) > SEARCH_PAGE,
            "days": RETENTION_DAYS,
        }

    @app.get("/api/channels/{channel_id}/pins")
    async def pinned_messages(request: Request, channel_id: int) -> dict[str, Any]:
        """서랍: 고정된 메시지(봇이 디스코드에서 받아 옴)."""
        await drawer_channel(request, channel_id)
        try:
            ids = await directory.pinned_ids(channel_id)
        except DirectoryError as error:
            raise HTTPException(status_code=502, detail="discord_unavailable") from error
        rows = []
        for message_id in ids:
            row = await repo.get(message_id)
            if row is not None and int(row["channel_id"]) == channel_id:
                rows.append(row)
        await attachments.fresh(rows)
        return {"messages": [row_to_api(row) for row in rows]}

    @app.get("/api/channels/{channel_id}/files")
    async def channel_files(
        request: Request,
        channel_id: int,
        before: int | None = Query(default=None, ge=1),
    ) -> dict[str, Any]:
        """서랍: 사진과 파일이 붙은 메시지(받아 둔 것, 최신부터)."""
        await drawer_channel(request, channel_id)
        rows = await repo.with_files(channel_id, before, FILES_PAGE + 1)
        await attachments.fresh(rows[:FILES_PAGE])
        return {
            "messages": [row_to_api(row) for row in rows[:FILES_PAGE]],
            "has_more": len(rows) > FILES_PAGE,
        }

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

    # ------------------------------------------------------------ 이 기기 알림 설정

    @app.get("/api/notify-prefs")
    async def get_notify_prefs(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        return await notify_prefs.get(account.device_id, account.account_id)

    @app.patch("/api/notify-prefs")
    async def set_notify_prefs(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="bad_body")
        try:
            return await notify_prefs.update(account.device_id, account.account_id, body)
        except NotifyPrefsError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/api/push/latest")
    async def push_latest(request: Request) -> dict[str, Any]:
        """서비스 워커가 푸시를 받으면 보여 줄 글. 잠겨 있거나 내용 보이기를 껐으면 내용 없이."""
        device = await current_device(request)
        if device is None or device.active_account_id is None:
            raise HTTPException(status_code=404, detail="not found")
        account_id = device.active_account_id
        prefs = await settings_store.get(account_id, device.id)
        device_prefs = await notify_prefs.get(device.id, account_id)
        title = prefs["tab_title"] or DEFAULT_TITLES.get(prefs["theme"], "작업 메모")
        latest = last_push.get((device.id, account_id))
        result: dict[str, Any] = {"title": title, "body": "새 알림이 있어요", "url": "/"}
        if latest is None:
            return result
        if latest.get("kind") == "todo":
            # TODO 알림: 내용 보이기를 켜고 잠기지 않았을 때만 TODO 이름(NOTI-04)
            result["url"] = latest["url"]
            try:
                await sessions.require_active(device, touch=False)
                todo_unlocked = True
            except SessionError:
                todo_unlocked = False
            if device_prefs["preview"] and todo_unlocked:
                result["title"] = latest["title"]
                result["body"] = latest["body"]
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
        if device_prefs["preview"] and unlocked:
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
        hub.add(websocket, account.discord_user_id, account.account_id, account.device_id)

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
        알림 받기: {"type": "notify", "scope": "mentions" | "pinned" | null}
        음성 채널 변화: {"type": "voice", "group_ids": ["123", ...]}"""
        try:
            message = json.loads(text)
        except ValueError:
            return
        if isinstance(message, dict) and message.get("type") == "voice":
            raw_ids = message.get("group_ids")
            if not isinstance(raw_ids, list):
                return
            wanted = {
                int(raw)
                for raw in raw_ids[:MAX_VOICE_GROUPS]
                if isinstance(raw, str) and raw.isdigit() and len(raw) <= 21
            }
            groups: set[int] = set()
            for group_id in wanted:
                with contextlib.suppress(DirectoryError):
                    if await perms.is_member(account.discord_user_id, group_id):
                        groups.add(group_id)
            hub.set_voice_groups(websocket, groups)
            return
        if isinstance(message, dict) and message.get("type") == "notify":
            scope = message.get("scope")
            hub.set_notify(
                websocket, scope if isinstance(scope, str) else None, message.get("todo") is True
            )
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
