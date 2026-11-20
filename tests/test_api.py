from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from mos.api.app import create_app
from mos.api.preview_auth import COOKIE_NAME
from mos.config import load_settings
from mos.db.database import Database
from mos.db.repo import MessageRepo
from mos.services.realtime import RealtimeHub
from tests.test_db import make_row

ORIGIN = "https://chat.example.com"
CHANNEL = 1573319705849102408
KEY = "preview-key-" + "x" * 20


class FakeBot:
    def __init__(self) -> None:
        self.ready = True

    def is_gateway_ready(self) -> bool:
        return self.ready

    def channel_info(self, channel_id: int) -> dict[str, Any] | None:
        return {"id": str(channel_id), "name": "일반", "guild_id": "1", "guild_name": "테스트"}


@pytest.fixture
def setup(tmp_path: Path) -> Iterator[tuple[TestClient, FakeBot, RealtimeHub, MessageRepo]]:
    settings = load_settings(
        {
            "DISCORD_BOT_TOKEN": "t",
            "PUBLIC_ORIGIN": ORIGIN,
            "DB_PATH": str(tmp_path / "api.db"),
            "PREVIEW_CHANNEL_ID": str(CHANNEL),
            "PREVIEW_ACCESS_KEY": KEY,
        }
    )
    db = Database(settings.db_path)
    repo = MessageRepo(db)
    hub = RealtimeHub()
    bot = FakeBot()
    app = create_app(settings, db, repo, hub, bot)
    with TestClient(app, base_url=ORIGIN) as client:
        yield client, bot, hub, repo


def login(client: TestClient, key: str = KEY, origin: str = ORIGIN) -> int:
    return client.post(
        "/api/preview/session", json={"key": key}, headers={"origin": origin}
    ).status_code


def test_healthz_reports_ok_and_gateway(setup) -> None:
    client, bot, _hub, _repo = setup
    body = client.get("/api/healthz").json()
    assert body == {"ok": True, "version": "dev", "db": True, "gateway": True}
    bot.ready = False
    response = client.get("/api/healthz")
    assert response.status_code == 503
    assert response.json()["ok"] is False


def test_login_requires_same_origin(setup) -> None:
    client, *_ = setup
    assert login(client, origin="https://evil.example") == 403
    assert login(client, origin="") == 403


def test_wrong_key_then_lockout(setup) -> None:
    client, *_ = setup
    for _ in range(5):
        assert login(client, key="wrong") == 401
    assert login(client) == 429  # 잠긴 동안은 맞는 열쇠도 거부


def test_login_sets_secure_cookie_and_allows_messages(setup) -> None:
    client, _bot, _hub, repo = setup
    assert client.get(f"/api/channels/{CHANNEL}/messages").status_code == 401

    response = client.post("/api/preview/session", json={"key": KEY}, headers={"origin": ORIGIN})
    assert response.status_code == 204
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "secure" in cookie

    client.portal.call(repo.upsert_many, [make_row(i, channel_id=CHANNEL) for i in range(1, 4)])
    body = client.get(f"/api/channels/{CHANNEL}/messages?limit=2").json()
    assert [m["id"] for m in body["messages"]] == ["2", "3"]
    assert body["has_more"] is True
    assert (
        client.get(f"/api/channels/{CHANNEL}/messages?before=2").json()["messages"][0]["id"] == "1"
    )
    assert client.get("/api/channels/123456789012345678/messages").status_code == 404
    assert client.get("/api/preview/channel").json()["name"] == "일반"
    assert client.get("/api/healthz").headers["cache-control"] == "no-store"


def test_logout_invalidates_session(setup) -> None:
    client, *_ = setup
    assert login(client) == 204
    assert client.get("/api/preview/session").status_code == 204
    assert client.delete("/api/preview/session", headers={"origin": ORIGIN}).status_code == 204
    assert client.get("/api/preview/session").status_code == 401


def test_websocket_requires_origin_and_session(setup) -> None:
    client, _bot, hub, _repo = setup
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws", headers={"origin": ORIGIN}),
    ):
        pass  # 로그인 전

    assert login(client) == 204
    # 테스트 클라이언트는 웹소켓에 쿠키를 자동으로 싣지 않아 직접 넣는다(브라우저는 자동)
    cookie = f"{COOKIE_NAME}={client.cookies.get(COOKIE_NAME)}"
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(
            "/ws", headers={"origin": "https://evil.example", "cookie": cookie}
        ),
    ):
        pass  # 쿠키가 있어도 다른 사이트에서 연 연결은 거부

    with client.websocket_connect("/ws", headers={"origin": ORIGIN, "cookie": cookie}) as socket:
        socket.send_text("ping")
        assert socket.receive_text() == "pong"
        assert hub.count == 1
        client.portal.call(hub.broadcast, "message_create", {"id": "1"})
        assert socket.receive_json() == {"type": "message_create", "data": {"id": "1"}}


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
