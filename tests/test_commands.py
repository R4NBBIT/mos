"""ㅁㅇㅅ 봇 명령(웹 입력칸): 점메추, 메뉴판, 메뉴추가, 메뉴삭제, /todo."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from tests.test_api import CHANNEL, POST, signed_up
from tests.test_todo import Env, build


class FakePoster:
    def __init__(self) -> None:
        self.posted: list[tuple[int, str]] = []
        self.edited: list[tuple[int, str, bool]] = []

    async def post_menu(self, channel_id: int, content: str, session: str) -> int:
        self.posted.append((channel_id, content))
        return 9000 + len(self.posted)

    async def edit_menu(self, channel_id: int, message_id: int, content: str, button: bool) -> None:
        self.edited.append((message_id, content, button))


@pytest.fixture
def env(tmp_path: Path) -> Iterator[Env]:
    yield from build(tmp_path, frozenset({42}))


def run(env: Env, text: str) -> dict:
    response = env.client.post(
        "/api/commands", json={"channel_id": str(CHANNEL), "text": text}, headers=POST
    )
    assert response.status_code == 200, response.text
    env.tick(1)
    return response.json()


def test_menu_commands(env: Env) -> None:
    signed_up(env, "mocha")
    poster = FakePoster()
    env.app.state.menu.poster = poster
    names = [c["name"] for c in env.client.get("/api/commands").json()["commands"]]
    assert "점메추" in names and "todo 보기" in names
    board = run(env, "/메뉴판")["text"]
    assert board.startswith("🍽️ 메뉴판") and "김치찌개" in board
    assert "메뉴 추가 완료" in run(env, "/메뉴추가 우리집 비빔면")["text"]
    assert "이미 등록된" in run(env, "/메뉴추가 김치찌개")["text"]
    assert "운영자만" in run(env, "/메뉴추가 동네 냉면 공통")["text"]
    assert "이 서버에서만 안 보여요" in run(env, "/메뉴삭제 김치찌개")["text"]
    board = run(env, "/메뉴판")["text"]
    assert "우리집 비빔면" in board and "• 김치찌개" not in board
    picked = run(env, "/점메추")
    assert picked["session"] and poster.posted[0][0] == CHANNEL
    assert "/점메추" in poster.posted[0][1] and "오늘의 추천 메뉴는" in poster.posted[0][1]
    again = env.client.post(f"/api/commands/menu/{picked['session']}/reroll", headers=POST).json()
    assert "리롤 1회" in again["text"] and poster.edited[-1][2] is True
    unknown = env.client.post(
        "/api/commands", json={"channel_id": str(CHANNEL), "text": "/없는명령"}, headers=POST
    )
    assert unknown.status_code == 400


def test_todo_commands(env: Env) -> None:
    signed_up(env, "mocha")
    env.client.get("/api/todo/categories")
    added = run(env, "/todo 추가 치과 15:00 @강남역")["text"]
    assert added.startswith("✅") and "치과" in added and "@강남역" in added
    view = run(env, "/todo 보기")["text"]
    assert "1. ⬜ 치과  15:00 @강남역" in view
    assert run(env, "/todo 완료 1")["text"] == "✅ 완료: 치과"
    assert "1. ✅ 치과" in run(env, "/todo 보기 오늘")["text"]
