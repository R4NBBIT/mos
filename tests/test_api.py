from __future__ import annotations

import asyncio
import base64
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
from mos.services.directory import ChannelInfo, GuildInfo, MemberInfo, Overwrite
from mos.services.discord_oauth import DiscordUser, OAuthError, TokenSet
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
            FORUM: ChannelInfo(FORUM, GUILD, "포럼", "forum", 2),
            9001: ChannelInfo(9001, OTHER_GUILD, "옆일반", "text", 0),
        }
        self.members: dict[tuple[int, int], frozenset[int]] = {
            (GUILD, 42): frozenset({GUILD, SECRET_ROLE}),
            (GUILD, 43): frozenset({GUILD}),
            (OTHER_GUILD, 45): frozenset({OTHER_GUILD}),
        }
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

    async def create_webhook(self, channel_id: int) -> Webhook:
        self.created.append(channel_id)
        hook = Webhook(700 + len(self.created), f"hook-token-secret-{len(self.created)}")
        self.hook_channel[hook.id] = channel_id
        return hook

    def _row(self, hook: Webhook, message_id: int, message: OutgoingMessage) -> dict:
        channel = message.thread_id or self.hook_channel[hook.id]
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

    def add(self, code: str, user_id: int, name: str, guilds: set[int]) -> None:
        self.users[code] = (DiscordUser(user_id, name, None, 0), guilds)

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
        yield Env(client, bot, hub, repo, oauth, clock, permissions, messenger)


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
    assert groups == [{"id": str(GUILD), "name": "서버 A", "icon_url": None}]
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
