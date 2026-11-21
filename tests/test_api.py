from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from mos.api.app import COOKIE_NAME, create_app
from mos.config import load_settings
from mos.db.database import Database
from mos.db.repo import MessageRepo
from mos.services.directory import (
    ChannelInfo,
    EmojiInfo,
    ForumTagInfo,
    GuildInfo,
    MemberInfo,
    Overwrite,
)
from mos.services.discord_oauth import DiscordUser, OAuthError, TokenSet
from mos.services.messages import row_to_api
from mos.services.permissions import (
    MENTION_EVERYONE,
    READ_MESSAGE_HISTORY,
    SEND_MESSAGES,
    VIEW_CHANNEL,
    PermissionService,
)
from mos.services.realtime import RealtimeHub
from mos.services.sender import OutgoingMessage, Webhook, WebhookGoneError
from tests.test_db import make_row

ORIGIN = "https://chat.example.com"
CHANNEL = 1573319705849102408
SECRET = 1573319705849102500
FORUM = 1573319705849102600
GUILD = 1573319960745353352
OTHER_GUILD = 1573319960745353999
SECRET_ROLE = 1573319960745354000
BASIC = VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES
PASSWORD = "달빛 아래 수다 2026"
POST = {"origin": ORIGIN}


class FakeDirectory:
    """서버 A: 일반(모두), 비밀(SECRET_ROLE만), 포럼. 옆 서버: 일반 하나."""

    def __init__(self) -> None:
        self.ready = True
        self.thread_lookups = 0
        self.thread_members: set[tuple[int, int]] = set()  # 비공개 스레드 참여자
        self.guild_map = {
            GUILD: GuildInfo(
                GUILD,
                "서버 A",
                None,
                owner_id=1,
                role_permissions={GUILD: BASIC, SECRET_ROLE: MENTION_EVERYONE},
            ),
            OTHER_GUILD: GuildInfo(OTHER_GUILD, "옆 서버", None, 1, {OTHER_GUILD: BASIC}),
        }
        deny_everyone = Overwrite(GUILD, True, 0, VIEW_CHANNEL)
        allow_role = Overwrite(SECRET_ROLE, True, VIEW_CHANNEL, 0)
        self.channel_map = {
            CHANNEL: ChannelInfo(CHANNEL, GUILD, "일반", "text", 0),
            SECRET: ChannelInfo(
                SECRET, GUILD, "비밀", "text", 1, overwrites=(deny_everyone, allow_role)
            ),
            FORUM: ChannelInfo(
                FORUM,
                GUILD,
                "포럼",
                "forum",
                2,
                forum_tags=(ForumTagInfo(901, "질문", "❓"), ForumTagInfo(902, "공지", None, True)),
                require_tag=True,
            ),
            9001: ChannelInfo(9001, OTHER_GUILD, "옆일반", "text", 0),
        }
        self.members: dict[tuple[int, int], frozenset[int]] = {
            (GUILD, 42): frozenset({GUILD, SECRET_ROLE}),
            (GUILD, 43): frozenset({GUILD}),
            (OTHER_GUILD, 45): frozenset({OTHER_GUILD}),
        }
        self.emoji_map = {
            GUILD: [
                EmojiInfo(1573320336554852801, "smile", False, GUILD),
                EmojiInfo(1573320336554852802, "dance", True, GUILD),
                EmojiInfo(
                    1573320336554852803, "vip", False, GUILD, role_ids=frozenset({SECRET_ROLE})
                ),
            ],
            OTHER_GUILD: [EmojiInfo(1573320336554852804, "other", False, OTHER_GUILD)],
        }
        self.archived_map: dict[int, ChannelInfo] = {}
        self.synced: list[int] = []
        self.older_calls: list[tuple[int, int]] = []

    def is_gateway_ready(self) -> bool:
        return self.ready

    def guild_ids(self) -> set[int]:
        return set(self.guild_map)

    def guilds(self) -> list[GuildInfo]:
        return list(self.guild_map.values())

    def guild(self, guild_id: int) -> GuildInfo | None:
        return self.guild_map.get(guild_id)

    def channels(self, guild_id: int) -> list[ChannelInfo]:
        return [c for c in self.channel_map.values() if c.guild_id == guild_id]

    def channel(self, channel_id: int) -> ChannelInfo | None:
        return self.channel_map.get(channel_id)

    def emojis(self, guild_id: int) -> list[EmojiInfo]:
        return self.emoji_map.get(guild_id, [])

    async def fetch_channel(self, channel_id: int) -> ChannelInfo | None:
        return self.archived_map.get(channel_id)  # 캐시에 없는 보관 스레드

    def stickers(self, guild_id: int) -> list:
        from mos.services.directory import StickerInfo

        if guild_id != GUILD:
            return []
        return [
            StickerInfo(1573320336554852901, "빙글", 4, GUILD),
            StickerInfo(1573320336554852902, "벡터", 3, GUILD),  # Lottie: 못 보냄
        ]

    async def sticker_image(self, sticker: Any) -> bytes:
        return b"GIF89a" + b"x" * 100

    async def is_thread_member(self, thread_id: int, user_id: int) -> bool:
        self.thread_lookups += 1
        return (thread_id, user_id) in self.thread_members

    async def list_threads(
        self, parent_id: int, before: float | None, limit: int
    ) -> tuple[list[ChannelInfo], bool]:
        active = [
            c for c in self.channel_map.values() if c.parent_id == parent_id and not c.archived
        ]
        archived = sorted(
            (c for c in self.archived_map.values() if c.parent_id == parent_id),
            key=lambda c: c.archive_ts or 0,
            reverse=True,
        )
        if before is not None:
            archived = [c for c in archived if (c.archive_ts or 0) < before]
        page = archived[: limit + 1]
        return ([] if before is not None else active) + page[:limit], len(page) > limit

    async def fetch_member(self, guild_id: int, user_id: int) -> MemberInfo | None:
        roles = self.members.get((guild_id, user_id))
        if roles is None:
            return None
        return MemberInfo(guild_id, user_id, roles, f"user{user_id}", None)

    async def ensure_synced(self, channel_id: int) -> None:
        self.synced.append(channel_id)

    async def fetch_older(self, channel_id: int, before_id: int, limit: int) -> int:
        self.older_calls.append((channel_id, before_id))
        return 0


class FakeMessenger:
    """웹훅 대신. 보낸 내용을 기록하고 메시지 행을 돌려준다."""

    def __init__(self) -> None:
        self.created: list[int] = []
        self.hook_channel: dict[int, int] = {}
        self.sent: list[tuple[Webhook, OutgoingMessage]] = []
        self.edited: list[tuple[int, OutgoingMessage]] = []
        self.deleted: list[tuple[int, int | None]] = []
        self.gone_once = False
        self.next_id = 1573400000000000000
        self.reacted: list[tuple[str, int, str]] = []

    async def add_reaction(self, channel_id: int, message_id: int, emoji: dict) -> None:
        self.reacted.append(("add", message_id, emoji["name"]))

    async def remove_reaction(self, channel_id: int, message_id: int, emoji: dict) -> None:
        self.reacted.append(("remove", message_id, emoji["name"]))

    async def create_webhook(self, channel_id: int) -> Webhook:
        self.created.append(channel_id)
        hook = Webhook(700 + len(self.created), f"hook-token-secret-{len(self.created)}")
        self.hook_channel[hook.id] = channel_id
        return hook

    def _row(self, hook: Webhook, message_id: int, message: OutgoingMessage) -> dict:
        # 포럼 새 글이면 디스코드가 글(스레드)을 만들고, 글 ID = 첫 메시지 ID
        channel = (
            message_id if message.thread_name else message.thread_id or self.hook_channel[hook.id]
        )
        row = make_row(message_id, channel_id=channel, content=message.content)
        row.update(author_id=hook.id, author_name=message.username or "x", webhook_id=hook.id)
        return row

    async def send(self, webhook: Webhook, message: OutgoingMessage) -> dict:
        if self.gone_once:
            self.gone_once = False
            raise WebhookGoneError
        self.next_id += 1
        self.sent.append((webhook, message))
        return self._row(webhook, self.next_id, message)

    async def edit(self, webhook: Webhook, message_id: int, message: OutgoingMessage) -> dict:
        self.edited.append((message_id, message))
        return self._row(webhook, message_id, message)

    async def delete(self, webhook: Webhook, message_id: int, thread_id: int | None) -> None:
        self.deleted.append((message_id, thread_id))


class FakeOAuth:
    """code → (사용자, 들어가 있는 서버)"""

    def __init__(self) -> None:
        self.users: dict[str, tuple[DiscordUser, set[int]]] = {}
        self.verifiers: list[str] = []

    def add(self, code: str, user_id: int, name: str, guilds: set[int], premium: int = 0) -> None:
        self.users[code] = (DiscordUser(user_id, name, None, premium), guilds)

    def authorize_url(self, state: str, code_challenge: str) -> str:
        return f"https://discord.com/oauth2/authorize?state={state}&code_challenge={code_challenge}"

    async def exchange_code(self, code: str, code_verifier: str) -> TokenSet:
        if code not in self.users:
            raise OAuthError("invalid_grant")
        self.verifiers.append(code_verifier)
        return TokenSet(f"access-{code}", f"refresh-{code}", 2_000_000_000, "identify")

    async def fetch_user(self, access_token: str) -> DiscordUser:
        return self.users[access_token.removeprefix("access-")][0]

    async def fetch_guild_ids(self, access_token: str) -> set[int]:
        return self.users[access_token.removeprefix("access-")][1]


@dataclass
class Env:
    client: TestClient
    bot: FakeDirectory
    hub: RealtimeHub
    repo: MessageRepo
    oauth: FakeOAuth
    clock: list[float]
    permissions: PermissionService
    messenger: FakeMessenger
    app: Any = None

    def tick(self, seconds: float) -> None:
        self.clock[0] += seconds


def build_client(tmp_path: Path) -> Iterator[Env]:
    settings = load_settings(
        {
            "DISCORD_BOT_TOKEN": "t",
            "DISCORD_CLIENT_ID": "1573318317446529064",
            "DISCORD_CLIENT_SECRET": "s",
            "MOS_SECRET_KEY": base64.urlsafe_b64encode(b"k" * 32).decode(),
            "PUBLIC_ORIGIN": ORIGIN,
            "DB_PATH": str(tmp_path / "api.db"),
        }
    )
    db = Database(settings.db_path)
    repo = MessageRepo(db)
    hub = RealtimeHub()
    bot = FakeDirectory()
    permissions = PermissionService(bot)
    oauth = FakeOAuth()
    messenger = FakeMessenger()
    oauth.add("mocha", 42, "모카", {GUILD})
    oauth.add("latte", 43, "라떼", {GUILD})
    oauth.add("stranger", 44, "남", {123456789012345678})
    oauth.add("other", 45, "옆동네", {OTHER_GUILD})
    clock = [1_800_000_000.0]
    app = create_app(
        settings,
        db,
        repo,
        hub,
        bot,
        oauth=oauth,
        clock=lambda: clock[0],
        permissions=permissions,
        messenger=messenger,
    )
    with TestClient(app, base_url=ORIGIN) as client:
        yield Env(client, bot, hub, repo, oauth, clock, permissions, messenger, app)


@pytest.fixture
def env(tmp_path: Path) -> Iterator[Env]:
    yield from build_client(tmp_path)


def start(env: Env, purpose: str = "connect") -> str:
    response = env.client.get(f"/api/auth/connect/start?purpose={purpose}", follow_redirects=False)
    assert response.status_code == 302
    query = parse_qs(urlsplit(response.headers["location"]).query)
    return query["state"][0]


def callback(env: Env, code: str, state: str) -> str:
    response = env.client.get(
        f"/api/auth/connect/callback?code={code}&state={state}", follow_redirects=False
    )
    assert response.status_code == 302
    return response.headers["location"]


def connect(env: Env, code: str = "mocha", purpose: str = "connect") -> str:
    return callback(env, code, start(env, purpose))


def session(env: Env) -> dict[str, Any]:
    return env.client.get("/api/session").json()


def set_password(env: Env, password: str = PASSWORD) -> int:
    return env.client.post(
        "/api/auth/password", json={"password": password}, headers=POST
    ).status_code


def unlock(env: Env, account_id: str, password: str = PASSWORD, keep: bool = False) -> Any:
    return env.client.post(
        "/api/session/unlock",
        json={"account_id": account_id, "password": password, "keep": keep},
        headers=POST,
    )


def messages_status(env: Env) -> int:
    return env.client.get(f"/api/channels/{CHANNEL}/messages").status_code


def signed_up(env: Env, code: str = "mocha") -> str:
    """연결 + 비밀번호 설정까지 마친 활성 계정 ID."""
    assert connect(env, code) == "/"
    assert set_password(env) == 204
    return session(env)["active_account_id"]


# ------------------------------------------------------------ 기본


def test_healthz_reports_ok_and_gateway(env: Env) -> None:
    body = env.client.get("/api/healthz").json()
    assert body == {"ok": True, "version": "dev", "db": True, "gateway": True}
    env.bot.ready = False
    response = env.client.get("/api/healthz")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"


def test_empty_session_and_no_access(env: Env) -> None:
    assert session(env) == {"accounts": [], "active_account_id": None, "max_accounts": 5}
    assert messages_status(env) == 401
    assert env.client.get("/api/groups").status_code == 401


# ------------------------------------------------------------ 처음 연결과 비밀번호


def test_first_connect_then_password_then_messages(env: Env) -> None:
    response = env.client.get("/api/auth/connect/start", follow_redirects=False)
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "secure" in cookie
    location = response.headers["location"]
    assert location.startswith("https://discord.com/oauth2/authorize?")

    state = parse_qs(urlsplit(location).query)["state"][0]
    assert callback(env, "mocha", state) == "/"
    assert len(env.oauth.verifiers[0]) >= 43  # PKCE verifier가 토큰 교환에 실렸다

    state_now = session(env)
    account = state_now["accounts"][0]
    assert account["name"] == "모카"
    assert account["password_set"] is False
    assert account["can_set_password"] is True
    assert account["locked"] is True
    assert "discord_user_id" not in account and "access" not in str(state_now)
    assert messages_status(env) == 401

    assert set_password(env, "password1") == 400
    assert set_password(env) == 204
    assert session(env)["accounts"][0]["locked"] is False

    env.client.portal.call(
        env.repo.upsert_many, [make_row(i, channel_id=CHANNEL) for i in range(1, 4)]
    )
    body = env.client.get(f"/api/channels/{CHANNEL}/messages?limit=2").json()
    assert [m["id"] for m in body["messages"]] == ["2", "3"]
    assert env.client.get("/api/channels/123456789012345678/messages").status_code == 404
    assert env.client.get(f"/api/channels/{CHANNEL}").json()["name"] == "일반"


def test_password_setup_window_expires(env: Env) -> None:
    connect(env)
    env.tick(5 * 60 + 1)
    assert set_password(env) == 403
    assert session(env)["accounts"][0]["can_set_password"] is False


def test_tokens_are_stored_encrypted(env: Env, tmp_path: Path) -> None:
    signed_up(env)
    raw = (tmp_path / "api.db").read_bytes()
    assert b"access-mocha" not in raw and b"refresh-mocha" not in raw
    assert PASSWORD.encode() not in raw


# ------------------------------------------------------------ OAuth 거부 상황


def test_state_must_match_device_and_is_single_use(env: Env, tmp_path: Path) -> None:
    state = start(env)
    assert callback(env, "mocha", "wrong-state") == "/?connect_error=expired"

    # 다른 브라우저가 내 state를 가져가도 안 됨
    other = build_client(tmp_path / "other")
    other_env = next(other)
    try:
        start(other_env)
        response = other_env.client.get(
            f"/api/auth/connect/callback?code=mocha&state={state}", follow_redirects=False
        )
        assert response.headers["location"] == "/?connect_error=expired"
    finally:
        other.close()

    assert callback(env, "mocha", state) == "/"
    assert callback(env, "mocha", state) == "/?connect_error=expired"  # 재사용 불가


def test_state_expires_after_ten_minutes(env: Env) -> None:
    state = start(env)
    env.tick(10 * 60 + 1)
    assert callback(env, "mocha", state) == "/?connect_error=expired"


def test_user_cancel_and_failed_exchange(env: Env) -> None:
    start(env)
    response = env.client.get(
        "/api/auth/connect/callback?error=access_denied&state=x", follow_redirects=False
    )
    assert response.headers["location"] == "/?connect_error=cancelled"
    assert connect(env, "unknown-code") == "/?connect_error=connect_failed"


def test_user_without_shared_server_is_rejected(env: Env) -> None:
    assert connect(env, "stranger") == "/?connect_error=no_server"
    assert session(env)["accounts"] == []


def test_bad_purpose_is_rejected(env: Env) -> None:
    response = env.client.get("/api/auth/connect/start?purpose=admin", follow_redirects=False)
    assert response.status_code == 400


# ------------------------------------------------------------ 잠금·해제


def test_lock_unlock_and_failure_limit(env: Env) -> None:
    account_id = signed_up(env)
    assert env.client.post("/api/session/lock", headers=POST).status_code == 204
    assert messages_status(env) == 401

    for _ in range(5):
        assert unlock(env, account_id, "wrong password").status_code == 401
    blocked = unlock(env, account_id)
    assert blocked.status_code == 429  # 잠긴 동안은 맞는 비밀번호도 거부
    assert blocked.json()["detail"] == "too_many_attempts"

    env.tick(5 * 60 + 1)
    old_cookie = env.client.cookies.get(COOKIE_NAME)
    response = unlock(env, account_id)
    assert response.status_code == 204
    new_cookie = env.client.cookies.get(COOKIE_NAME)
    assert new_cookie and new_cookie != old_cookie  # 잠금 해제 때 기기 토큰 교체
    assert messages_status(env) == 200

    env.client.cookies.set(COOKIE_NAME, old_cookie or "", domain="chat.example.com")
    assert session(env)["accounts"] == []  # 예전 토큰은 더 이상 기기가 아님


def test_auto_lock_and_keep_signed_in(env: Env) -> None:
    account_id = signed_up(env)
    env.tick(29 * 60)
    assert messages_status(env) == 200  # 요청이 있으면 잠금 시간이 밀린다
    env.tick(31 * 60)
    assert messages_status(env) == 401

    assert unlock(env, account_id, keep=True).status_code == 204
    assert session(env)["accounts"][0]["kept"] is True
    env.tick(7 * 24 * 3600)
    assert messages_status(env) == 200
    env.tick(31 * 24 * 3600)
    assert messages_status(env) == 401


def test_lock_minutes_setting(env: Env) -> None:
    account_id = signed_up(env)
    # 5분으로 줄이면 바로(다음 요청부터) 5분 기준
    changed = env.client.patch("/api/settings", json={"lock_minutes": 5}, headers=POST)
    assert changed.json()["lock_minutes"] == 5
    env.tick(4 * 60)
    assert messages_status(env) == 200
    env.tick(5 * 60 + 1)
    assert messages_status(env) == 401

    # 2시간으로 늘리면 잠금 해제 뒤 2시간까지 열림
    assert unlock(env, account_id).status_code == 204
    env.client.patch("/api/settings", json={"lock_minutes": 120}, headers=POST)
    env.tick(100 * 60)
    assert messages_status(env) == 200
    for bad in (0, 7, 1000, True, "30"):
        response = env.client.patch("/api/settings", json={"lock_minutes": bad}, headers=POST)
        assert response.status_code == 400


def test_boss_files_saved_per_account_encrypted(env: Env, tmp_path: Path) -> None:
    signed_up(env)
    png = b"\x89PNG\r\n\x1a\n" + b"secret-screen" * 10
    put = env.client.put(
        "/api/boss/assets/image?name=업무화면.png",
        content=png,
        headers={**POST, "content-type": "application/octet-stream"},
    )
    assert put.status_code == 200 and put.json()["mime"] == "image/png"
    info = env.client.get("/api/boss").json()["assets"]
    assert info["image"]["name"] == "업무화면.png" and info["image"]["size"] == len(png)
    got = env.client.get("/api/boss/assets/image")
    assert got.content == png and got.headers["content-type"] == "image/png"
    assert b"secret-screen" not in (tmp_path / "api.db").read_bytes()  # 암호화해서 저장

    # 사진이 아닌 것, 너무 큰 것, 모르는 종류
    fake = env.client.put("/api/boss/assets/image", content=b"<svg>", headers=POST)
    assert fake.status_code == 400
    big = env.client.put("/api/boss/assets/text", content=b"a" * 300_000, headers=POST)
    assert big.status_code == 413
    assert env.client.put("/api/boss/assets/exe", content=b"x", headers=POST).status_code == 404

    # 고친 내용: 저장, 읽기, 되돌리기
    edits = {"0": {"B3": "완료"}}
    assert env.client.put("/api/boss/edits/weekly", json=edits, headers=POST).status_code == 204
    assert env.client.get("/api/boss/edits/weekly").json() == {"edits": edits}
    assert env.client.delete("/api/boss/edits/weekly", headers=POST).status_code == 204
    assert env.client.get("/api/boss/edits/weekly").json() == {"edits": None}
    assert env.client.get("/api/boss/edits/../x").status_code == 404

    # 노션, Word 글도 올릴 수 있고, 모두 처음으로 하면 파일과 고친 내용이 다 지워진다
    for kind in ("note", "word"):
        saved = env.client.put(
            f"/api/boss/assets/{kind}?name=정리.md", content="# 업무 정리".encode(), headers=POST
        )
        assert saved.status_code == 200
    env.client.put("/api/boss/edits/mos.boss.note.v1", json="고친 글", headers=POST)
    assert set(env.client.get("/api/boss").json()["assets"]) == {"image", "note", "word"}
    assert env.client.delete("/api/boss", headers=POST).status_code == 204
    assert env.client.get("/api/boss").json()["assets"] == {}
    assert env.client.get("/api/boss/edits/mos.boss.note.v1").json() == {"edits": None}

    # 다른 계정에서는 안 보인다
    signed_up(env, "latte")
    assert env.client.get("/api/boss").json()["assets"] == {}
    assert env.client.get("/api/boss/assets/image").status_code == 404


def test_unsafe_requests_need_our_origin(env: Env) -> None:
    account_id = signed_up(env)
    for origin in ("https://evil.example", ""):
        response = env.client.post(
            "/api/session/unlock",
            json={"account_id": account_id, "password": PASSWORD},
            headers={"origin": origin},
        )
        assert response.status_code == 403


def test_bad_account_id_is_rejected(env: Env) -> None:
    signed_up(env)
    assert unlock(env, "1 OR 1=1").status_code == 422
    assert unlock(env, "999").status_code == 404


# ------------------------------------------------------------ 여러 계정


def test_switch_accounts_and_reconnect_existing(env: Env) -> None:
    mocha = signed_up(env, "mocha")
    latte = signed_up(env, "latte")
    assert session(env)["active_account_id"] == latte
    assert [a["name"] for a in session(env)["accounts"]] == ["모카", "라떼"]

    switch = env.client.post("/api/session/switch", json={"account_id": mocha}, headers=POST)
    assert switch.status_code == 204
    assert session(env)["active_account_id"] == mocha
    assert messages_status(env) == 200

    # 비밀번호가 있는 계정은 디스코드로 다시 연결하면 바로 열린다
    env.client.post("/api/session/lock", headers=POST)
    assert connect(env, "mocha") == "/"
    assert messages_status(env) == 200


def test_add_with_same_account_is_reported(env: Env) -> None:
    mocha = signed_up(env, "mocha")
    env.client.post("/api/session/lock", headers=POST)
    assert connect(env, "mocha", purpose="add") == "/?connect_error=already_added"
    state = session(env)
    assert state["active_account_id"] == mocha
    assert state["accounts"][0]["locked"] is True  # 아무것도 바뀌지 않음
    assert connect(env, "latte", purpose="add") == "/"
    assert len(session(env)["accounts"]) == 2


def test_add_same_account_keeps_state(env: Env) -> None:
    env.oauth.add("late", 46, "늦게옴", {OTHER_GUILD})
    account_id = signed_up(env, "late")
    assert connect(env, "late", purpose="add") == "/?connect_error=already_added"
    assert session(env)["active_account_id"] == account_id


def test_joining_a_server_shows_up_after_member_event(env: Env) -> None:
    signed_up(env, "other")
    assert messages_status(env) == 404
    env.bot.members[(GUILD, 45)] = frozenset({GUILD})  # 서버 A에 들어감
    env.permissions.forget_member(GUILD, 45)  # 봇이 받는 '멤버 들어옴' 이벤트
    assert messages_status(env) == 200


def test_account_limit_per_device(env: Env) -> None:
    for index in range(5):
        env.oauth.add(f"user{index}", 100 + index, f"u{index}", {GUILD})
        assert connect(env, f"user{index}") == "/"
    assert connect(env, "mocha") == "/?connect_error=too_many_accounts"
    assert connect(env, "user0") == "/"  # 이미 있는 계정은 다시 연결 가능


def test_account_outside_server_cannot_read(env: Env) -> None:
    signed_up(env, "other")
    assert messages_status(env) == 404
    assert env.client.get(f"/api/channels/{CHANNEL}").status_code == 404
    assert env.client.get(f"/api/groups/{GUILD}/channels").status_code == 404


def test_reset_password_via_reconnect(env: Env) -> None:
    signed_up(env)
    assert connect(env, "mocha", purpose="reset") == "/"
    account = session(env)["accounts"][0]
    assert account["can_set_password"] is True and account["locked"] is True
    assert set_password(env, "새 비밀번호 바꿨어요") == 204
    env.client.post("/api/session/lock", headers=POST)
    assert unlock(env, account["id"], PASSWORD).status_code == 401
    assert unlock(env, account["id"], "새 비밀번호 바꿨어요").status_code == 204


def test_remove_last_account_forgets_device(env: Env) -> None:
    account_id = signed_up(env)
    response = env.client.delete(f"/api/session/accounts/{account_id}", headers=POST)
    assert response.status_code == 204
    assert (
        'sid=""' in response.headers["set-cookie"]
        or "max-age=0" in response.headers["set-cookie"].lower()
    )
    assert session(env)["accounts"] == []


# ------------------------------------------------------------ 실시간


def ws_cookie(env: Env) -> str:
    # 테스트 클라이언트는 웹소켓에 쿠키를 자동으로 싣지 않아 직접 넣는다(브라우저는 자동)
    return f"{COOKIE_NAME}={env.client.cookies.get(COOKIE_NAME)}"


def test_websocket_requires_origin_and_unlocked_session(env: Env) -> None:
    with (
        pytest.raises(WebSocketDisconnect),
        env.client.websocket_connect("/ws", headers={"origin": ORIGIN}),
    ):
        pass  # 로그인 전

    signed_up(env)
    cookie = ws_cookie(env)
    with (
        pytest.raises(WebSocketDisconnect),
        env.client.websocket_connect(
            "/ws", headers={"origin": "https://evil.example", "cookie": cookie}
        ),
    ):
        pass

    with env.client.websocket_connect("/ws", headers={"origin": ORIGIN, "cookie": cookie}) as ws:
        ws.send_text("ping")
        assert ws.receive_text() == "pong"
        assert env.hub.count == 1

    env.client.post("/api/session/lock", headers=POST)
    with (
        pytest.raises(WebSocketDisconnect),
        env.client.websocket_connect("/ws", headers={"origin": ORIGIN, "cookie": cookie}),
    ):
        pass  # 잠긴 뒤에는 연결 불가


def test_websocket_only_gets_subscribed_and_permitted_channels(env: Env) -> None:
    signed_up(env, "latte")  # 서버 A 멤버지만 비밀 채널 역할은 없음
    with env.client.websocket_connect(
        "/ws", headers={"origin": ORIGIN, "cookie": ws_cookie(env)}
    ) as ws:
        ws.send_text(f'{{"type": "subscribe", "channel_id": "{SECRET}"}}')
        assert ws.receive_json()["type"] == "subscribe_denied"
        env.client.portal.call(env.hub.publish, SECRET, "message_create", {"id": "s"})

        ws.send_text(f'{{"type": "subscribe", "channel_id": "{CHANNEL}"}}')
        assert ws.receive_json() == {"type": "subscribed", "data": {"channel_id": str(CHANNEL)}}
        env.client.portal.call(env.hub.publish, 9001, "message_create", {"id": "other"})
        env.client.portal.call(env.hub.publish, CHANNEL, "message_create", {"id": "1"})
        # 비밀·다른 채널 것은 오지 않고, 구독한 채널 것만 온다
        assert ws.receive_json() == {"type": "message_create", "data": {"id": "1"}}

        # 권한이 사라지면(역할 제거) 구독 중이어도 더 이상 보내지 않는다
        env.bot.members.pop((GUILD, 43))
        env.permissions.forget_member(GUILD, 43)
        env.client.portal.call(env.hub.publish, CHANNEL, "message_create", {"id": "2"})
        ws.send_text("ping")
        assert ws.receive_text() == "pong"  # 그 사이 아무것도 안 왔다


def notify_message(message_id: int, author: int = 5, mention: int | None = None) -> dict:
    row = make_row(message_id, channel_id=CHANNEL, content="점심 뭐 먹어?")
    row["author_id"] = author
    if mention is not None:
        row["mentions_json"] = json.dumps({"users": {str(mention): "모카"}})
    return row_to_api(row)


def test_notify_only_mentions_or_pinned_channels(env: Env) -> None:
    signed_up(env, "latte")  # 라떼(43): 서버 A 멤버지만 비밀 채널은 못 봄
    with env.client.websocket_connect(
        "/ws", headers={"origin": ORIGIN, "cookie": ws_cookie(env)}
    ) as ws:
        ws.send_text('{"type": "notify", "scope": "mentions"}')
        ws.send_text("ping")
        assert ws.receive_text() == "pong"
        # 나를 안 부른 글, 내가 쓴 글, 볼 수 없는 채널은 알리지 않는다
        env.client.portal.call(env.hub.notify, CHANNEL, notify_message(1))
        env.client.portal.call(env.hub.notify, CHANNEL, notify_message(2, author=43, mention=43))
        env.client.portal.call(env.hub.notify, SECRET, notify_message(3, mention=43))
        env.client.portal.call(env.hub.notify, CHANNEL, notify_message(4, mention=43))
        event = ws.receive_json()
        assert event["type"] == "notify"
        assert event["data"]["message_id"] == "4" and event["data"]["mentioned"] is True
        assert event["data"]["group_id"] == str(GUILD)

        # 고정한 채널이면 부르지 않은 새 글도 알린다(범위 pinned)
        assert pin(env, "channel", CHANNEL) == 204
        env.client.portal.call(env.hub.notify, CHANNEL, notify_message(5))
        ws.send_text('{"type": "notify", "scope": "pinned"}')
        ws.send_text("ping")
        assert ws.receive_text() == "pong"
        env.client.portal.call(env.hub.notify, CHANNEL, notify_message(6))
        assert ws.receive_json()["data"]["message_id"] == "6"

        # 범위 all이면 고정하지 않은 채널의 부르지 않은 글도 알린다
        ws.send_text('{"type": "notify", "scope": "all"}')
        ws.send_text("ping")
        assert ws.receive_text() == "pong"
        env.client.portal.call(env.hub.notify, CHANNEL, notify_message(8))
        assert ws.receive_json()["data"]["message_id"] == "8"

        # 알림을 끄면 아무것도 오지 않는다
        ws.send_text('{"type": "notify", "scope": null}')
        ws.send_text("ping")
        assert ws.receive_text() == "pong"
        env.client.portal.call(env.hub.notify, CHANNEL, notify_message(7, mention=43))
        ws.send_text("ping")
        assert ws.receive_text() == "pong"


def test_reactions_toggle_through_bot(env: Env) -> None:
    signed_up(env)  # 모카(42)
    row = make_row(CHANNEL + 50, channel_id=CHANNEL)
    row["reactions_json"] = json.dumps(
        [{"key": "👍", "id": None, "name": "👍", "animated": False, "count": 2, "bot": False}]
    )
    env.client.portal.call(env.repo.upsert_many, [row])
    env.client.portal.call(env.repo.set_reaction_user, CHANNEL + 50, "👍", 43, "discord", True)
    url = f"/api/messages/{CHANNEL + 50}/reactions"

    # 내가 누르면 봇이 하나 달고, 수는 2 + 나 1 = 3
    first = env.client.post(url, json={"emoji": "👍"}, headers=POST).json()["reactions"]
    assert first[0]["count"] == 3 and "42" in first[0]["users"] and "43" in first[0]["users"]
    assert env.messenger.reacted == [("add", CHANNEL + 50, "👍")]
    # 다시 누르면 빼고 봇 반응도 뺀다
    second = env.client.post(url, json={"emoji": "👍"}, headers=POST).json()["reactions"]
    assert second[0]["count"] == 2 and "42" not in second[0]["users"]
    assert env.messenger.reacted[-1] == ("remove", CHANNEL + 50, "👍")
    # 디스코드에서 단 반응은 여기서 뺄 수 없다
    env.client.portal.call(env.repo.set_reaction_user, CHANNEL + 50, "👍", 42, "discord", True)
    assert env.client.post(url, json={"emoji": "👍"}, headers=POST).status_code == 409
    env.tick(3)  # 반응은 2초에 4번까지
    # 이상한 값, 못 쓰는 모임 이모지
    assert env.client.post(url, json={"emoji": "abc"}, headers=POST).status_code == 400
    blocked = env.client.post(url, json={"emoji": "<:x:1573319960745359999>"}, headers=POST)
    assert blocked.status_code == 403
    # 볼 수 없는 채널의 메시지는 없는 것과 같다
    hidden = make_row(SECRET + 1, channel_id=SECRET)
    env.client.portal.call(env.repo.upsert_many, [hidden])
    signed_up(env, "latte")
    assert (
        env.client.post(
            f"/api/messages/{SECRET + 1}/reactions", json={"emoji": "👍"}, headers=POST
        ).status_code
        == 404
    )


def test_web_push_when_no_tab_is_open(env: Env) -> None:
    import base64 as b64

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    signed_up(env, "latte")  # 라떼(43)
    push = env.app.state.push
    posted: list[tuple[str, dict]] = []

    async def fake_post(endpoint: str, headers: dict) -> int:
        posted.append((endpoint, headers))
        return 201

    push._post = fake_post
    bad = env.client.post(
        "/api/push/subscribe", json={"endpoint": "https://evil.example/push"}, headers=POST
    )
    assert bad.status_code == 400  # 브라우저 회사 푸시 서버만
    endpoint = "https://fcm.googleapis.com/fcm/send/abc123"
    sub = env.client.post("/api/push/subscribe", json={"endpoint": endpoint}, headers=POST)
    assert sub.status_code == 204
    assert env.client.post("/api/push/status", json={"endpoint": endpoint}, headers=POST).json()[
        "subscribed"
    ]

    # 탭이 없을 때 나를 부른 글 → 빈 푸시 하나, 서명은 서버 공개 열쇠로 확인된다
    env.client.portal.call(env.hub.notify, CHANNEL, notify_message(9, mention=43))
    assert len(posted) == 1 and posted[0][0] == endpoint
    auth = posted[0][1]["Authorization"]
    token = auth.split("t=")[1].split(",")[0]
    head, body, sig = token.split(".")
    pad = lambda text: text + "=" * (-len(text) % 4)  # noqa: E731
    raw = b64.urlsafe_b64decode(pad(sig))
    key = env.client.get("/api/push/key").json()["key"]
    public = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), b64.urlsafe_b64decode(pad(key))
    )
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    public.verify(der, f"{head}.{body}".encode(), ec.ECDSA(hashes.SHA256()))

    # 서비스 워커가 받아 가는 글: 기본은 내용 없이, 누르면 그 채널로
    latest = env.client.get("/api/push/latest").json()
    assert latest["body"] == "새 알림이 있어요" and latest["url"].endswith(f"/c/{CHANNEL}")
    env.client.patch("/api/settings", json={"notify_preview": True}, headers=POST)
    assert "점심" in env.client.get("/api/push/latest").json()["body"]

    # 탭(알림 연결)이 열려 있으면 푸시는 보내지 않는다
    env.tick(60)
    with env.client.websocket_connect(
        "/ws", headers={"origin": ORIGIN, "cookie": ws_cookie(env)}
    ) as ws:
        ws.send_text('{"type": "notify", "scope": "mentions"}')
        ws.send_text("ping")
        assert ws.receive_text() == "pong"
        env.client.portal.call(env.hub.notify, CHANNEL, notify_message(10, mention=43))
        assert ws.receive_json()["type"] == "notify"
    assert len(posted) == 1


def test_sticker_sent_as_picture(env: Env) -> None:
    signed_up(env)
    listed = env.client.get(f"/api/channels/{CHANNEL}/stickers").json()["stickers"]
    assert [item["name"] for item in listed] == ["빙글"]  # Lottie는 빠진다
    sent = env.client.post(
        f"/api/channels/{CHANNEL}/stickers",
        json={"sticker_id": "1573320336554852901", "nonce": "sticker-0001"},
        headers=POST,
    )
    assert sent.status_code == 200
    _hook, message = env.messenger.sent[-1]
    assert message.content == "" and message.files[0].filename == "빙글.gif"
    blocked = env.client.post(
        f"/api/channels/{CHANNEL}/stickers",
        json={"sticker_id": "1573320336554852902", "nonce": "sticker-0002"},
        headers=POST,
    )
    assert blocked.status_code == 403


def test_open_websocket_is_closed_after_lock(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    import mos.api.app as app_module

    monkeypatch.setattr(app_module, "WS_RECHECK_SEC", 0.05)
    # 감시 간격은 앱을 만들 때가 아니라 연결마다 읽으므로 여기서 바꿔도 된다
    signed_up(env)
    with env.client.websocket_connect(
        "/ws", headers={"origin": ORIGIN, "cookie": ws_cookie(env)}
    ) as ws:
        env.client.post("/api/session/lock", headers=POST)
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == 1008


# ------------------------------------------------------------ 모임·채널 목록


def test_groups_and_channels_follow_permissions(env: Env) -> None:
    signed_up(env, "mocha")  # 비밀 역할 있음
    groups = env.client.get("/api/groups").json()["groups"]
    assert groups == [
        {
            "id": str(GUILD),
            "name": "서버 A",
            "icon_url": None,
            "pinned": False,
            "unread": 0,
            "mentions": 0,
        }
    ]
    body = env.client.get(f"/api/groups/{GUILD}/channels").json()
    assert [c["name"] for c in body["channels"]] == ["일반", "비밀", "포럼"]
    assert body["channels"][0]["can_send"] is True
    assert env.client.get(f"/api/groups/{OTHER_GUILD}/channels").status_code == 404

    signed_up(env, "latte")  # 같은 서버, 역할 없음
    names = [c["name"] for c in env.client.get(f"/api/groups/{GUILD}/channels").json()["channels"]]
    assert names == ["일반", "포럼"]
    assert env.client.get(f"/api/channels/{SECRET}").status_code == 404
    assert env.client.get(f"/api/channels/{SECRET}/messages").status_code == 404


def test_forum_messages_are_not_served_yet(env: Env) -> None:
    signed_up(env)
    assert env.client.get(f"/api/channels/{FORUM}/messages").status_code == 404


def test_first_open_syncs_and_short_page_fetches_older(env: Env) -> None:
    signed_up(env)
    env.client.portal.call(env.repo.upsert_many, [make_row(i, channel_id=CHANNEL) for i in (5, 6)])
    env.client.get(f"/api/channels/{CHANNEL}/messages")
    assert env.bot.synced == [CHANNEL]
    assert env.bot.older_calls == [(CHANNEL, 5)]  # 저장된 가장 오래된 것보다 앞을 더 받아 봄
    env.client.get(f"/api/channels/{CHANNEL}/messages?before=5")
    assert env.bot.synced == [CHANNEL]  # 위로 넘길 때는 최신 동기화를 다시 하지 않는다
    assert env.bot.older_calls[-1] == (CHANNEL, 5)


def test_not_ready_gateway_returns_503(env: Env) -> None:
    signed_up(env)
    env.bot.ready = False
    assert env.client.get("/api/groups").status_code == 503


def test_cookie_name_is_not_discord_related() -> None:
    assert "discord" not in COOKIE_NAME


def test_hub_drops_broken_sockets() -> None:
    class Broken:
        async def send_json(self, data: Any) -> None:
            raise ConnectionError

    async def allow(_user: int, _channel: int) -> bool:
        return True

    hub = RealtimeHub()
    hub.set_access_check(allow)
    socket = Broken()
    hub.add(socket, 42)
    hub.subscribe(socket, 7)
    asyncio.run(hub.publish(7, "x", {}))
    assert hub.count == 0


# ------------------------------------------------------------ 보내기(3-3)

_nonce_counter = [0]


def send(env: Env, content: str = "안녕", channel: int = CHANNEL, **extra: Any) -> Any:
    _nonce_counter[0] += 1
    body = {"content": content, "nonce": f"nonce-{_nonce_counter[0]:06d}", **extra}
    return env.client.post(f"/api/channels/{channel}/messages", json=body, headers=POST)


def test_send_uses_my_server_name_and_records_sender(env: Env, tmp_path: Path) -> None:
    signed_up(env, "latte")
    response = send(env, "점심 뭐 먹지")
    assert response.status_code == 200
    message = response.json()
    assert message["content"] == "점심 뭐 먹지"
    assert message["web_sender_id"] == "43"
    hook, outgoing = env.messenger.sent[0]
    assert outgoing.username == "user43"  # 그 서버의 내 닉네임으로 고정
    assert outgoing.allow_everyone is False  # 권한 없으면 @everyone 막음
    assert env.messenger.created == [CHANNEL]
    assert session(env)["accounts"][0]["user_id"] == "43"

    send(env, "두 번째")
    assert env.messenger.created == [CHANNEL]  # 웹훅은 채널마다 한 번만 만든다
    raw = (tmp_path / "api.db").read_bytes()
    assert hook.token.encode() not in raw  # 웹훅 토큰은 암호화 저장

    page = env.client.get(f"/api/channels/{CHANNEL}/messages").json()["messages"]
    assert [m["web_sender_id"] for m in page] == ["43", "43"]


def test_mention_everyone_only_with_permission(env: Env) -> None:
    signed_up(env, "mocha")  # 역할에 @everyone 멘션 권한 있음
    assert send(env, "@everyone 모여").status_code == 200
    assert env.messenger.sent[0][1].allow_everyone is True


def test_same_nonce_is_sent_once(env: Env) -> None:
    signed_up(env)
    body = {"content": "한 번만", "nonce": "same-nonce-1234"}
    first = env.client.post(f"/api/channels/{CHANNEL}/messages", json=body, headers=POST)
    env.tick(2)
    second = env.client.post(f"/api/channels/{CHANNEL}/messages", json=body, headers=POST)
    assert first.json()["id"] == second.json()["id"]
    assert len(env.messenger.sent) == 1


def test_reply_quotes_on_discord_but_not_on_web(env: Env) -> None:
    signed_up(env)
    original = make_row(1573319705849102409, channel_id=CHANNEL, content="<@43> 점심 *뭐* 먹어?")
    env.client.portal.call(env.repo.upsert, original)
    response = send(env, "김치찌개", reply_to=str(original["id"]))
    assert response.status_code == 200
    sent_text = env.messenger.sent[0][1].content
    first_line, _, rest = sent_text.partition("\n")
    assert first_line.startswith("> ↪ **모카**: @… 점심 뭐 먹어?")
    assert f"/{GUILD}/{CHANNEL}/{original['id']}" in first_line
    assert rest == "김치찌개"
    message = response.json()
    assert message["content"] == "김치찌개"  # ㅁㅇㅅ 화면에서는 인용 줄을 떼고
    assert message["reference_id"] == str(original["id"])  # 일반 답장처럼

    other = make_row(1573319705849109999, channel_id=SECRET, content="비밀")
    env.client.portal.call(env.repo.upsert, other)
    env.tick(2)
    assert (
        send(env, "x", reply_to=str(other["id"])).status_code == 404
    )  # 다른 채널 글에는 답장 불가


def test_cannot_send_where_not_allowed(env: Env) -> None:
    signed_up(env, "latte")
    assert send(env, channel=SECRET).status_code == 404  # 볼 수도 없는 채널
    env.tick(2)
    assert send(env, channel=FORUM).json()["detail"] == "cannot_send"

    read_only = Overwrite(GUILD, True, 0, SEND_MESSAGES)
    env.bot.channel_map[9100] = ChannelInfo(9100, GUILD, "공지", "text", 3, overwrites=(read_only,))
    env.tick(2)
    response = send(env, channel=9100)
    assert response.status_code == 403
    names = {
        c["name"]: c["can_send"]
        for c in env.client.get(f"/api/groups/{GUILD}/channels").json()["channels"]
    }
    assert names["공지"] is False


def test_locked_thread_is_blocked_even_though_webhook_would_work(env: Env) -> None:
    signed_up(env)
    env.bot.channel_map[9200] = ChannelInfo(
        9200, GUILD, "글", "thread", 0, parent_id=CHANNEL, thread_locked=True
    )
    assert send(env, channel=9200).json()["detail"] == "cannot_send"
    env.bot.channel_map[9201] = ChannelInfo(9201, GUILD, "열린 글", "thread", 0, parent_id=CHANNEL)
    env.tick(2)
    assert send(env, channel=9201).status_code == 403  # 스레드 보내기 권한이 없으면 막힘

    env.bot.guild_map[GUILD] = GuildInfo(
        GUILD, "서버 A", None, 1, {GUILD: BASIC | (1 << 38), SECRET_ROLE: MENTION_EVERYONE}
    )
    env.tick(2)
    assert send(env, channel=9201).status_code == 200
    hook, outgoing = env.messenger.sent[-1]
    assert outgoing.thread_id == 9201
    assert env.messenger.hook_channel[hook.id] == CHANNEL  # 웹훅은 부모 채널 것


def test_bad_input_is_rejected(env: Env) -> None:
    signed_up(env)
    assert send(env, "   ").json()["detail"] == "empty"
    env.tick(2)
    assert send(env, "x" * 2001).status_code == 422
    bad = {"content": "a", "nonce": "../../x"}
    assert (
        env.client.post(f"/api/channels/{CHANNEL}/messages", json=bad, headers=POST).status_code
        == 422
    )
    reply_long = make_row(1573319705849102409, channel_id=CHANNEL, content="원문")
    env.client.portal.call(env.repo.upsert, reply_long)
    env.tick(2)
    assert send(env, "x" * 2000, reply_to=str(reply_long["id"])).json()["detail"] == "too_long"


def test_send_rate_limit(env: Env) -> None:
    signed_up(env)
    codes = [send(env, f"{i}").status_code for i in range(3)]
    assert codes[:2] == [200, 200]
    assert codes[2] == 429


def test_recreates_deleted_webhook_once(env: Env) -> None:
    signed_up(env)
    send(env)
    env.messenger.gone_once = True
    env.tick(2)
    assert send(env, "다시").status_code == 200
    assert env.messenger.created == [CHANNEL, CHANNEL]


def test_edit_and_delete_only_my_messages(env: Env) -> None:
    signed_up(env, "mocha")
    original = make_row(1573319705849102409, channel_id=CHANNEL, content="원문")
    env.client.portal.call(env.repo.upsert, original)
    mine = send(env, "처음", reply_to=str(original["id"])).json()

    signed_up(env, "latte")
    assert (
        env.client.patch(
            f"/api/messages/{mine['id']}", json={"content": "남이 고침"}, headers=POST
        ).status_code
        == 404
    )
    env.tick(2)
    assert env.client.delete(f"/api/messages/{mine['id']}", headers=POST).status_code == 404
    env.tick(2)
    assert env.client.delete(f"/api/messages/{original['id']}", headers=POST).status_code == 404

    mocha_id = next(a["id"] for a in session(env)["accounts"] if a["name"] == "모카")
    env.client.post("/api/session/switch", json={"account_id": mocha_id}, headers=POST)
    env.tick(2)
    edited = env.client.patch(f"/api/messages/{mine['id']}", json={"content": "고침"}, headers=POST)
    assert edited.status_code == 200
    assert edited.json()["content"] == "고침"
    assert env.messenger.edited[0][1].content.startswith("> ↪ ")  # 답장 인용은 유지
    env.tick(2)
    assert env.client.delete(f"/api/messages/{mine['id']}", headers=POST).status_code == 204
    assert env.messenger.deleted == [(int(mine["id"]), None)]
    ids = [m["id"] for m in env.client.get(f"/api/channels/{CHANNEL}/messages").json()["messages"]]
    assert mine["id"] not in ids


def test_send_needs_unlocked_account_and_origin(env: Env) -> None:
    assert send(env).status_code == 401
    signed_up(env)
    bad = env.client.post(
        f"/api/channels/{CHANNEL}/messages",
        json={"content": "x", "nonce": "abcdefgh1"},
        headers={"origin": "https://evil.example"},
    )
    assert bad.status_code == 403


# ------------------------------------------------------------ 4단계: 고정·안 읽음·이모지·첨부


def pin(env: Env, kind: str, target: int) -> int:
    return env.client.post(
        "/api/pins", json={"kind": kind, "id": str(target)}, headers=POST
    ).status_code


def test_pins_order_limits_and_permissions(env: Env) -> None:
    signed_up(env, "mocha")
    env.bot.members[(OTHER_GUILD, 42)] = frozenset({OTHER_GUILD})
    env.permissions.forget_member(OTHER_GUILD, 42)
    groups = [g["name"] for g in env.client.get("/api/groups").json()["groups"]]
    assert groups == ["서버 A", "옆 서버"]
    assert pin(env, "group", OTHER_GUILD) == 204
    assert pin(env, "group", OTHER_GUILD) == 204  # 이미 있으면 그대로
    body = env.client.get("/api/groups").json()
    assert [g["name"] for g in body["groups"]] == ["옆 서버", "서버 A"]  # 고정이 위로
    assert body["groups"][0]["pinned"] is True

    assert pin(env, "channel", SECRET) == 204
    shortcuts = env.client.get("/api/groups").json()["pinned_channels"]
    assert [(c["name"], c["group_name"]) for c in shortcuts] == [("비밀", "서버 A")]
    channels = env.client.get(f"/api/groups/{GUILD}/channels").json()["channels"]
    assert {c["name"]: c["pinned"] for c in channels}["비밀"] is True

    # 권한이 사라지면 바로가기에서 숨는다
    env.bot.members[(GUILD, 42)] = frozenset({GUILD})
    env.permissions.forget_member(GUILD, 42)
    assert env.client.get("/api/groups").json()["pinned_channels"] == []

    assert env.client.delete(f"/api/pins/group/{OTHER_GUILD}", headers=POST).status_code == 204
    assert env.client.get("/api/groups").json()["groups"][0]["pinned"] is False
    assert pin(env, "group", 123456789012345678) == 404  # 볼 수 없는 모임은 고정 불가
    assert pin(env, "channel", SECRET) == 404


def test_pin_limit(env: Env) -> None:
    signed_up(env)
    for index in range(10):
        channel_id = 1573319705849103000 + index
        env.bot.channel_map[channel_id] = ChannelInfo(channel_id, GUILD, f"c{index}", "text", 5)
        assert pin(env, "channel", channel_id) == 204
    extra = 1573319705849103999
    env.bot.channel_map[extra] = ChannelInfo(extra, GUILD, "더", "text", 5)
    response = env.client.post(
        "/api/pins", json={"kind": "channel", "id": str(extra)}, headers=POST
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "pin_limit"


def test_unread_counts_and_mentions(env: Env) -> None:
    signed_up(env, "latte")  # 43
    rows = [make_row(1573319705849102500 + i, channel_id=CHANNEL) for i in range(1, 4)]
    env.client.portal.call(env.repo.upsert_many, rows)
    channels = env.client.get(f"/api/groups/{GUILD}/channels").json()["channels"]
    assert channels[0]["unread"] == 0  # 한 번도 안 연 채널은 0에서 시작

    read = env.client.post(
        f"/api/channels/{CHANNEL}/read", json={"last_id": str(rows[0]["id"])}, headers=POST
    )
    assert read.status_code == 204
    mention = make_row(1573319705849102600, channel_id=CHANNEL)
    mention["mentions_json"] = '{"users": {"43": "라떼"}, "roles": {}, "channels": {}}'
    mine = make_row(1573319705849102601, channel_id=CHANNEL)
    mine["author_id"] = 43  # 내가 디스코드에서 쓴 것은 세지 않는다
    joined = make_row(1573319705849102602, channel_id=CHANNEL)
    joined["kind"] = 7  # 입장 알림 같은 시스템 메시지도 세지 않는다
    joined["content"] = ""
    env.client.portal.call(env.repo.upsert_many, [mention, mine, joined])
    listed = env.client.get(f"/api/channels/{CHANNEL}/messages").json()["messages"]
    assert [item["kind"] for item in listed if item["id"] == str(joined["id"])] == [7]

    channel = env.client.get(f"/api/groups/{GUILD}/channels").json()["channels"][0]
    assert (channel["unread"], channel["mentions"]) == (3, 1)
    group = env.client.get("/api/groups").json()["groups"][0]
    assert (group["unread"], group["mentions"]) == (3, 1)

    env.client.post(
        f"/api/channels/{CHANNEL}/read", json={"last_id": str(rows[0]["id"])}, headers=POST
    )  # 예전 위치로는 되돌아가지 않는다
    env.client.post(
        f"/api/channels/{CHANNEL}/read", json={"last_id": str(mine["id"])}, headers=POST
    )
    assert env.client.get(f"/api/groups/{GUILD}/channels").json()["channels"][0]["unread"] == 0
    secret = env.client.post(
        f"/api/channels/{SECRET}/read", json={"last_id": str(mine["id"])}, headers=POST
    )
    assert secret.status_code == 404


def set_nitro(env: Env, claimed: bool) -> int:
    return env.client.post(
        "/api/account/nitro", json={"claimed": claimed}, headers=POST
    ).status_code


def nitro_seen(env: Env, user_id: int) -> bool:
    return env.client.portal.call(env.app.state.sessions.nitro_seen, user_id)


def test_emoji_rules_follow_nitro(env: Env) -> None:
    signed_up(env, "latte")  # 비밀 역할 없음, 니트로 안 켬
    body = env.client.get(f"/api/channels/{CHANNEL}/emojis").json()
    assert (body["premium"], body["nitro"]) == (False, "none")
    assert [e["name"] for e in body["emojis"]] == ["smile"]  # 움직이는·역할 전용·다른 모임 빠짐
    assert send(env, "<a:dance:1573320336554852802>").json()["detail"] == "emoji_not_allowed"
    env.tick(2)
    assert send(env, "<:smile:1573320336554852801> 좋아").status_code == 200


def test_nitro_needs_claim_and_weekly_proof(env: Env) -> None:
    env.bot.members[(OTHER_GUILD, 42)] = frozenset({OTHER_GUILD})
    env.bot.guild_map[GUILD] = GuildInfo(
        GUILD, "서버 A", None, 1, {GUILD: BASIC | (1 << 18), SECRET_ROLE: MENTION_EVERYONE}
    )
    signed_up(env, "mocha")
    assert nitro_seen(env, 42) is False  # '니트로 있어요'를 안 켠 사람은 검사하지 않는다
    assert session(env)["accounts"][0]["nitro"] == "none"

    assert set_nitro(env, True) == 204
    assert session(env)["accounts"][0]["nitro"] == "pending"
    names = [e["name"] for e in env.client.get(f"/api/channels/{CHANNEL}/emojis").json()["emojis"]]
    assert names == ["smile", "vip"]  # 확인 전에는 니트로 없음과 같다

    assert nitro_seen(env, 42) is True  # 디스코드 앱에서 니트로 이모지를 씀
    account = session(env)["accounts"][0]
    assert account["nitro"] == "verified" and account["nitro_until"] is not None
    names = [e["name"] for e in env.client.get(f"/api/channels/{CHANNEL}/emojis").json()["emojis"]]
    assert names == ["smile", "dance", "vip", "other"]  # 이 모임 먼저, 외부 이모지 포함
    env.tick(2)
    assert send(env, "<a:dance:1573320336554852802><:other:1573320336554852804>").status_code == 200

    unlock(env, account["id"], keep=True)  # 일주일 뒤에도 잠기지 않게(로그인 유지)
    env.tick(7 * 24 * 3600 + 1)  # 일주일 동안 증거가 없으면 다시 확인 필요
    assert session(env)["accounts"][0]["nitro"] == "pending"
    assert send(env, "<a:dance:1573320336554852802>").json()["detail"] == "emoji_not_allowed"

    assert set_nitro(env, False) == 204
    assert nitro_seen(env, 42) is False
    assert session(env)["accounts"][0]["nitro"] == "none"


def upload(env: Env, files: list[tuple[str, bytes]], content: str = "", channel: int = CHANNEL):
    _nonce_counter[0] += 1
    return env.client.post(
        f"/api/channels/{channel}/messages/files",
        data={"nonce": f"files-{_nonce_counter[0]:06d}", "content": content},
        files=[("files", (name, data, "application/octet-stream")) for name, data in files],
        headers=POST,
    )


def test_send_files(env: Env) -> None:
    signed_up(env)
    response = upload(env, [("../../사진 1.jpg", b"x" * 1000), ("SPOILER_a.png", b"y")], "사진")
    assert response.status_code == 200
    outgoing = env.messenger.sent[-1][1]
    assert [f.filename for f in outgoing.files] == ["사진 1.jpg", "SPOILER_a.png"]
    assert [f.spoiler for f in outgoing.files] == [False, True]
    assert outgoing.content == "사진"

    env.tick(2)
    assert upload(env, [("a.bin", b"z")]).status_code == 200  # 글 없이 파일만도 된다
    env.tick(2)
    too_big = upload(env, [("big.bin", b"0" * (10 * 1024 * 1024 + 1))])
    assert too_big.status_code == 413
    env.tick(2)
    many = upload(env, [(f"{i}.txt", b"1") for i in range(11)])
    assert many.status_code == 400


def test_egress_limit_blocks_attachments_and_alerts_once(tmp_path: Path) -> None:
    import mos.api.app as app_module

    alerts: list[str] = []

    async def notify(text: str) -> None:
        alerts.append(text)

    settings = load_settings(
        {
            "DISCORD_BOT_TOKEN": "t",
            "DISCORD_CLIENT_ID": "1573318317446529064",
            "DISCORD_CLIENT_SECRET": "s",
            "MOS_SECRET_KEY": base64.urlsafe_b64encode(b"k" * 32).decode(),
            "PUBLIC_ORIGIN": ORIGIN,
            "DB_PATH": str(tmp_path / "e.db"),
            "EGRESS_LIMIT_MB": "10",
        }
    )
    db = Database(settings.db_path)
    bot = FakeDirectory()
    messenger = FakeMessenger()
    oauth = FakeOAuth()
    oauth.add("mocha", 42, "모카", {GUILD})
    clock = [1_800_000_000.0]
    app = app_module.create_app(
        settings,
        db,
        MessageRepo(db),
        RealtimeHub(),
        bot,
        oauth=oauth,
        clock=lambda: clock[0],
        messenger=messenger,
        notify_operator=notify,
    )
    with TestClient(app, base_url=ORIGIN) as client:
        env = Env(
            client,
            bot,
            RealtimeHub(),
            MessageRepo(db),
            oauth,
            clock,
            PermissionService(bot),
            messenger,
        )
        signed_up(env)
        assert upload(env, [("a.bin", b"0" * (8 * 1024 * 1024 + 300_000))]).status_code == 200
        assert len(alerts) == 1 and "8" in alerts[0]  # 80% 넘음 → 한 번 알림
        env.tick(2)
        assert upload(env, [("b.bin", b"0" * (1024 * 1024 + 300_000))]).status_code == 200
        assert len(alerts) == 1  # 두 번 알리지 않는다
        env.tick(2)
        blocked = upload(env, [("c.bin", b"0")])
        assert blocked.status_code == 403  # 95% 넘음 → 첨부 막기
        assert blocked.json()["detail"] == "egress_limit"
        env.tick(2)
        assert send(env, "글은 계속 돼").status_code == 200


# ------------------------------------------------------------ 5-1 포럼·스레드

POST_A = 1573319705849200001
POST_B = 1573319705849200002


def add_forum_posts(env: Env, archived: int = 0) -> None:
    env.bot.channel_map[POST_A] = ChannelInfo(
        POST_A,
        GUILD,
        "점심 뭐 먹지",
        "thread",
        0,
        parent_id=FORUM,
        applied_tag_ids=(901,),
        message_count=3,
    )
    env.client.portal.call(
        env.repo.upsert, make_row(POST_A, channel_id=POST_A, content="**오늘** 점심 추천 받아요")
    )
    for index in range(archived):
        thread_id = POST_B + index
        env.bot.archived_map[thread_id] = ChannelInfo(
            thread_id,
            GUILD,
            f"지난 글 {index}",
            "thread",
            0,
            parent_id=FORUM,
            archived=True,
            archive_ts=1_700_000_000.0 - index,
        )


def test_forum_post_list_with_preview_tags_and_pages(env: Env) -> None:
    signed_up(env)
    add_forum_posts(env, archived=30)
    body = env.client.get(f"/api/channels/{FORUM}/threads").json()
    parent = body["parent"]
    assert parent["kind"] == "forum" and parent["can_post"] is True and parent["require_tag"]
    assert [t["name"] for t in parent["tags"]] == ["질문", "공지"]
    assert [t["usable"] for t in parent["tags"]] == [True, False]  # 공지는 관리자 전용
    first = body["threads"][0]
    assert first["name"] == "점심 뭐 먹지" and first["tag_ids"] == ["901"]
    assert first["preview"] == "오늘 점심 추천 받아요"  # 서식 기호는 빼고
    assert len(body["threads"]) == 1 + 25 and body["has_more"] is True
    second = env.client.get(f"/api/channels/{FORUM}/threads?before={body['next_before']}").json()
    assert len(second["threads"]) == 5 and second["has_more"] is False


def test_archived_thread_opens_through_lookup(env: Env) -> None:
    signed_up(env)
    add_forum_posts(env, archived=1)
    response = env.client.get(f"/api/channels/{POST_B}")
    assert response.status_code == 200
    assert response.json()["archived"] is True and response.json()["parent_id"] == str(FORUM)
    assert env.client.get(f"/api/channels/{POST_B}/messages").status_code == 200


def test_thread_detail_has_parent_tags_and_starter(env: Env) -> None:
    signed_up(env)
    add_forum_posts(env)
    body = env.client.get(f"/api/channels/{POST_A}").json()
    assert (body["parent_name"], body["parent_kind"]) == ("포럼", "forum")
    assert [t["name"] for t in body["applied_tags"]] == ["질문"]
    assert body["starter"]["content"] == "**오늘** 점심 추천 받아요"

    # 일반 채널 스레드: 시작 메시지는 부모 채널에 있다. 다른 채널 메시지는 쓰지 않는다
    thread = 1573319705849300005
    env.bot.channel_map[thread] = ChannelInfo(thread, GUILD, "잡담", "thread", 0, parent_id=CHANNEL)
    env.client.portal.call(env.repo.upsert, make_row(thread, channel_id=CHANNEL, content="시작"))
    body = env.client.get(f"/api/channels/{thread}").json()
    assert body["starter"]["content"] == "시작" and body["parent_kind"] == "text"


def test_text_channel_threads_follow_parent_permissions(env: Env) -> None:
    thread = 1573319705849300001
    secret_thread = 1573319705849300002
    signed_up(env, "latte")
    env.bot.channel_map[thread] = ChannelInfo(
        thread, GUILD, "잡담 스레드", "thread", 0, parent_id=CHANNEL
    )
    env.bot.channel_map[secret_thread] = ChannelInfo(
        secret_thread,
        GUILD,
        "비밀 스레드",
        "thread",
        0,
        parent_id=SECRET,
        overwrites=env.bot.channel_map[SECRET].overwrites,
    )
    names = [
        t["name"] for t in env.client.get(f"/api/channels/{CHANNEL}/threads").json()["threads"]
    ]
    assert names == ["잡담 스레드"]
    assert env.client.get(f"/api/channels/{SECRET}/threads").status_code == 404
    assert env.client.get(f"/api/channels/{secret_thread}/messages").status_code == 404
    assert env.client.get(f"/api/channels/{thread}/threads").status_code == 404


def test_private_threads_only_for_members(env: Env) -> None:
    private = 1573319705849300003
    signed_up(env, "latte")  # 라떼(43): 스레드 관리 권한 없음
    env.bot.channel_map[private] = ChannelInfo(
        private, GUILD, "둘만의 스레드", "thread", 0, parent_id=CHANNEL, private_thread=True
    )
    names = lambda: [  # noqa: E731
        t["name"] for t in env.client.get(f"/api/channels/{CHANNEL}/threads").json()["threads"]
    ]
    assert names() == []
    assert env.client.get(f"/api/channels/{private}/messages").status_code == 404

    # 스레드에 들어가면(캐시가 지워진 뒤) 보이고 열 수 있다
    env.bot.thread_members.add((private, 43))
    env.permissions.forget_thread_member(private, 43)
    assert names() == ["둘만의 스레드"]
    assert env.client.get(f"/api/channels/{private}").status_code == 200
    # 2분 동안은 다시 묻지 않는다
    before = env.bot.thread_lookups
    names()
    assert env.bot.thread_lookups == before


def post(env: Env, title: str = "새 글", content: str = "내용", tags: str = "901", **extra: Any):
    _nonce_counter[0] += 1
    data = {"nonce": f"post-{_nonce_counter[0]:06d}", "title": title, "content": content}
    if tags is not None:
        data["tag_ids"] = tags
    return env.client.post(
        f"/api/channels/{extra.get('channel', FORUM)}/posts",
        data=data,
        files=extra.get("files"),
        headers=POST,
    )


def test_create_forum_post(env: Env) -> None:
    signed_up(env, "latte")
    assert post(env, tags="").json()["detail"] == "tag_required"
    env.tick(2)
    assert post(env, tags="902").status_code == 403  # 관리자 전용 태그
    env.tick(2)
    assert post(env, tags="999").json()["detail"] == "bad_tags"
    env.tick(2)
    assert post(env, title="   ").status_code in (400, 422)
    env.tick(2)
    response = post(env, title="  점심   뭐 먹지 ", content="추천 받아요", tags="901,901")
    assert response.status_code == 200
    thread_id = response.json()["thread_id"]
    outgoing = env.messenger.sent[-1][1]
    assert outgoing.thread_name == "점심 뭐 먹지" and outgoing.applied_tags == (901,)
    assert outgoing.username == "user43"
    assert env.messenger.hook_channel[env.messenger.sent[-1][0].id] == FORUM  # 포럼 웹훅
    assert int(thread_id) == int(env.messenger.next_id)  # 글 ID = 첫 메시지 ID

    env.tick(2)
    with_file = post(env, content="", files=[("files", ("a.png", b"x", "image/png"))])
    assert with_file.status_code == 200
    env.tick(2)
    assert post(env, channel=CHANNEL).status_code == 403  # 일반 채널에는 글을 만들 수 없음


# ------------------------------------------------------------ 5-2 설정


def test_settings_per_account(env: Env) -> None:
    signed_up(env, "mocha")
    defaults = {
        "theme": "moon",
        "tab_title": None,
        "boss_template": "weekly",
        "boss_auto": False,
        "boss_relock": False,
        "boss_key": "Escape*2",
        "boss_fit": "cover",
        "boss_fullscreen": False,
        "boss_url": None,
        "notify": True,
        "notify_scope": "pinned",
        "notify_preview": False,
        "guide_done": False,
        "lock_minutes": 30,
        "show_avatars": True,
        "reactions_view": "full",
        "stickers_view": "full",
        "doc_titles": {},
    }
    assert env.client.get("/api/settings").json() == defaults
    changed = env.client.patch(
        "/api/settings", json={"theme": "sheet", "tab_title": "  주간   보고  "}, headers=POST
    )
    assert changed.json() == {**defaults, "theme": "sheet", "tab_title": "주간 보고"}
    boss = env.client.patch(
        "/api/settings",
        json={"boss_template": "budget", "boss_auto": True, "boss_relock": True},
        headers=POST,
    ).json()
    assert (boss["boss_template"], boss["boss_auto"], boss["boss_relock"]) == ("budget", True, True)
    look = env.client.patch(
        "/api/settings", json={"theme": "word", "show_avatars": False}, headers=POST
    ).json()
    assert (look["theme"], look["show_avatars"]) == ("word", False)
    quiet = env.client.patch(
        "/api/settings", json={"reactions_view": "compact", "stickers_view": "hidden"}, headers=POST
    ).json()
    assert (quiet["reactions_view"], quiet["stickers_view"]) == ("compact", "hidden")
    first = env.client.patch(
        "/api/settings",
        json={"doc_titles": {str(CHANNEL): "  운영   회의 정리 ", f"{CHANNEL}:sub": "운영지원팀"}},
        headers=POST,
    ).json()
    assert first["doc_titles"] == {str(CHANNEL): "운영 회의 정리", f"{CHANNEL}:sub": "운영지원팀"}
    second = env.client.patch(
        "/api/settings", json={"doc_titles": {f"{CHANNEL}:sub": ""}}, headers=POST
    ).json()
    assert second["doc_titles"] == {str(CHANNEL): "운영 회의 정리"}  # 보낸 것만 바뀜
    key = env.client.patch("/api/settings", json={"boss_key": "Ctrl+Shift+KeyK"}, headers=POST)
    assert key.json()["boss_key"] == "Ctrl+Shift+KeyK"
    for bad in (
        {"boss_template": "../x"},
        {"boss_auto": "yes"},
        {"boss_relock": 1},
        {"boss_key": "<script>"},
        {"notify_scope": "everything"},
        {"boss_url": "http://example.com"},
        {"boss_url": "javascript:alert(1)"},
        {"boss_fit": "stretch"},
        {"notify": "yes"},
        {"boss_key": "Ctrl+"},
        {"boss_key": 5},
        {"show_avatars": "off"},
        {"reactions_view": "tiny"},
        {"stickers_view": True},
        {"doc_titles": {"general": "x"}},
        {"doc_titles": {str(CHANNEL): "가" * 81}},
        {"doc_titles": [str(CHANNEL)]},
    ):
        assert env.client.patch("/api/settings", json=bad, headers=POST).status_code == 400
    assert (
        env.client.patch("/api/settings", json={"theme": "pink"}, headers=POST).status_code == 400
    )
    assert env.client.patch("/api/settings", json={"admin": True}, headers=POST).status_code == 400
    assert (
        env.client.patch("/api/settings", json={"tab_title": "x" * 41}, headers=POST).status_code
        == 400
    )
    assert (
        env.client.patch("/api/settings", json={"tab_title": ""}, headers=POST).json()["tab_title"]
        is None
    )

    signed_up(env, "latte")  # 다른 계정은 따로
    assert env.client.get("/api/settings").json()["theme"] == "moon"
    env.client.post("/api/session/lock", headers=POST)
    assert env.client.get("/api/settings").status_code == 401
