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
    assert "점메추" in names and "todo" in names
    # 메뉴추가, 메뉴삭제는 운영자만: 남에게는 목록에도 없고 명령으로 받지도 않는다
    assert "메뉴추가" not in names and "메뉴삭제" not in names
    for text in ("/메뉴추가 몰래 메뉴", "/메뉴삭제 김치찌개"):
        refused = env.client.post(
            "/api/commands", json={"channel_id": str(CHANNEL), "text": text}, headers=POST
        )
        assert refused.status_code == 400
        env.tick(1)
    board = run(env, "/메뉴판")["text"]
    assert board.startswith("🍽️ 메뉴판") and "김치찌개" in board and "몰래 메뉴" not in board
    env.app.state.commands.operator_id = 42
    names = [c["name"] for c in env.client.get("/api/commands").json()["commands"]]
    assert "메뉴추가" in names and "메뉴삭제" in names
    assert "메뉴 추가 완료" in run(env, "/메뉴추가 우리집 비빔면")["text"]
    assert "이미 등록된" in run(env, "/메뉴추가 김치찌개")["text"]
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
    names = [c["name"] for c in env.client.get("/api/commands").json()["commands"]]
    assert "todo" in names and "todo 보기" not in names
    asked = run(env, "/todo 3시 치과 넣어줘")
    assert asked["text"] == "3시가 오전인가요, 오후인가요?"
    assert [c["label"] for c in asked["choices"]] == ["오전 (03:00)", "오후 (15:00)", "시각 없이"]
    added = run(env, asked["choices"][1]["text"])["text"]
    assert added.startswith("✅ 넣었어요") and "치과" in added and "15:00" in added
    added = run(env, "/todo 강남역에서 장보기 //우유")["text"]
    assert "@강남역" in added and "메모: 우유" in added
    view = run(env, "/todo 오늘 뭐 있어?")["text"]
    assert "1. ⬜ 치과  15:00" in view and "2. ⬜ 장보기  @강남역" in view
    assert run(env, "/todo 1번 완료")["text"] == "✅ 완료: 치과"
    assert run(env, "/todo 치과 완료 취소")["text"] == "↩️ 완료 취소: 치과"
    assert run(env, "/todo 장보기 다 했어")["text"] == "✅ 완료: 장보기"
    moved = run(env, "/todo 치과 내일로 미뤄줘")["text"]
    assert moved.startswith("📅 옮겼어요: 치과")
    assert "치과" in run(env, "/todo 내일 뭐 있어")["text"]
    assert "삭제는" in run(env, "/todo 장보기 삭제해줘")["text"]
    assert "없어요" in run(env, "/todo [없는것] 회의 넣어줘")["text"]


def test_understand_words() -> None:
    from mos.services.todo_words import understand

    today = "2026-11-23"  # 월요일
    said = understand("다음 주 수요일 오후 3시 반에 강남역에서 치과 예약 넣어줘", today)
    assert (said.action, said.title, said.days, said.time, said.place) == (
        "add",
        "치과 예약",
        ["2026-12-02"],
        "15:30",
        "강남역",
    )
    assert understand("장보기", today).action == "add"
    assert understand("서류 확인", today).title == "서류 확인"
    assert understand("", today).action == "view"
    moved = understand("모레 회의 금요일로 옮겨줘", today)
    assert (moved.action, moved.days, moved.title) == ("move", ["2026-11-25", "2026-11-27"], "회의")
    assert understand("업무에 보고서 넣어줘", today, ["업무"]).category == "업무"
