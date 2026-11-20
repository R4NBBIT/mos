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
from mos.services.discord_oauth import DiscordUser, OAuthError, TokenSet
from mos.services.realtime import RealtimeHub
from tests.test_db import make_row

ORIGIN = "https://chat.example.com"
CHANNEL = 1573319705849102408
GUILD = 1573319960745353352
OTHER_GUILD = 1573319960745353999
PASSWORD = "달빛 아래 수다 2026"
POST = {"origin": ORIGIN}


class FakeBot:
    def __init__(self) -> None:
        self.ready = True

    def is_gateway_ready(self) -> bool:
        return self.ready

    def guild_ids(self) -> set[int]:
        return {GUILD, OTHER_GUILD}

    def channel_info(self, channel_id: int) -> dict[str, Any] | None:
        return {"id": str(channel_id), "name": "일반", "guild_id": str(GUILD), "guild_name": "A"}


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
    bot: FakeBot
    hub: RealtimeHub
    repo: MessageRepo
    oauth: FakeOAuth
    clock: list[float]

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
            "PREVIEW_CHANNEL_ID": str(CHANNEL),
        }
    )
    db = Database(settings.db_path)
    repo = MessageRepo(db)
    hub = RealtimeHub()
    bot = FakeBot()
    oauth = FakeOAuth()
    oauth.add("mocha", 42, "모카", {GUILD})
    oauth.add("latte", 43, "라떼", {GUILD})
    oauth.add("stranger", 44, "남", {123456789012345678})
    oauth.add("other", 45, "옆동네", {OTHER_GUILD})
    clock = [1_800_000_000.0]
    app = create_app(settings, db, repo, hub, bot, oauth=oauth, clock=lambda: clock[0])
    with TestClient(app, base_url=ORIGIN) as client:
        yield Env(client, bot, hub, repo, oauth, clock)


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
    assert env.client.get("/api/preview/channel").status_code == 401


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
    assert env.client.get("/api/preview/channel").json()["name"] == "일반"


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


def test_reconnect_refreshes_server_list(env: Env) -> None:
    env.oauth.add("late", 46, "늦게옴", {OTHER_GUILD})
    account_id = signed_up(env, "late")
    assert messages_status(env) == 404  # 아직 미리보기 서버에 없음
    env.oauth.users["late"] = (env.oauth.users["late"][0], {OTHER_GUILD, GUILD})  # 서버 A 들어감
    assert connect(env, "late", purpose="add") == "/?connect_error=already_added"
    assert session(env)["active_account_id"] == account_id
    assert messages_status(env) == 200  # 같은 계정으로 다시 연결만 해도 서버 목록이 새로 반영


def test_account_limit_per_device(env: Env) -> None:
    for index in range(5):
        env.oauth.add(f"user{index}", 100 + index, f"u{index}", {GUILD})
        assert connect(env, f"user{index}") == "/"
    assert connect(env, "mocha") == "/?connect_error=too_many_accounts"
    assert connect(env, "user0") == "/"  # 이미 있는 계정은 다시 연결 가능


def test_account_outside_preview_server_cannot_read(env: Env) -> None:
    signed_up(env, "other")
    assert messages_status(env) == 404
    assert env.client.get("/api/preview/channel").status_code == 404


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


def test_websocket_requires_origin_and_unlocked_session(env: Env) -> None:
    with (
        pytest.raises(WebSocketDisconnect),
        env.client.websocket_connect("/ws", headers={"origin": ORIGIN}),
    ):
        pass  # 로그인 전

    signed_up(env)
    # 테스트 클라이언트는 웹소켓에 쿠키를 자동으로 싣지 않아 직접 넣는다(브라우저는 자동)
    cookie = f"{COOKIE_NAME}={env.client.cookies.get(COOKIE_NAME)}"
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
        env.client.portal.call(env.hub.broadcast, "message_create", {"id": "1"})
        assert ws.receive_json() == {"type": "message_create", "data": {"id": "1"}}

    env.client.post("/api/session/lock", headers=POST)
    with (
        pytest.raises(WebSocketDisconnect),
        env.client.websocket_connect("/ws", headers={"origin": ORIGIN, "cookie": cookie}),
    ):
        pass  # 잠긴 뒤에는 연결 불가


def test_cookie_name_is_not_discord_related() -> None:
    assert "discord" not in COOKIE_NAME


def test_hub_drops_broken_sockets() -> None:
    class Broken:
        async def send_json(self, data: Any) -> None:
            raise ConnectionError

    hub = RealtimeHub()
    hub.add(Broken())
    asyncio.run(hub.broadcast("x", {}))
    assert hub.count == 0
