"""ㅁㅇㅅ 봇 명령(웹 입력칸): 점메추, 메뉴판, 메뉴추가, 메뉴삭제, /todo."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

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


def ok(env: Env, text: str) -> str:
    """바꾸는 일은 [확인] [취소]로 묻는다: 확인을 눌러 결과 글을 돌려준다."""
    asked = run(env, text)
    labels = [c["label"] for c in asked.get("choices") or []]
    assert labels[-2:] == ["확인", "취소"], asked
    assert asked["text"].endswith("이대로 할까요?")
    return run(env, asked["choices"][-2]["text"])["text"]


def test_todo_commands(env: Env) -> None:
    signed_up(env, "mocha")
    env.client.get("/api/todo/categories")
    names = [c["name"] for c in env.client.get("/api/commands").json()["commands"]]
    assert "todo" in names and "todo 보기" not in names
    asked = run(env, "/todo 3시 치과 넣어줘")
    assert asked["text"] == "3시가 오전인가요, 오후인가요?"
    assert [c["label"] for c in asked["choices"]] == ["오전 (03:00)", "오후 (15:00)", "시각 없이"]
    which = run(env, asked["choices"][1]["text"])
    # 카테고리는 말하지 않았으면 하나뿐이어도 무조건 묻는다
    assert which["text"] == "어느 카테고리에 넣을까요?"
    assert [c["label"] for c in which["choices"]] == ["TODO"]
    confirm = run(env, which["choices"][0]["text"])
    assert confirm["text"].startswith("넣을까요?") and "15:00" in confirm["text"]
    # 취소하면 아무것도 바뀌지 않는다
    assert "취소했어요" in run(env, confirm["choices"][1]["text"])["text"]
    assert "없어요" in run(env, "/todo 오늘 뭐 있어")["text"]
    added = run(env, confirm["choices"][0]["text"])["text"]
    assert added.startswith("✅ 넣었어요") and "치과" in added and "15:00" in added
    added = ok(env, "/todo 강남역에서 장보기 //우유 [TODO]")
    assert "| 강남역" in added and "@" not in added and "메모: 우유" in added
    view = run(env, "/todo 오늘 뭐 있어?")["text"]
    day = datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d")
    sources = {
        i["title"]: i["source"] for i in env.client.get(f"/api/todo/day/{day}").json()["items"]
    }
    assert sources["치과"] == "bot"
    assert "1. ⬜ 치과 | 15:00" in view and "2. ⬜ 장보기 | 강남역" in view
    assert ok(env, "/todo 1번 완료") == "✅ 완료: 치과"
    assert ok(env, "/todo 치과 완료 취소") == "↩️ 완료 취소: 치과"
    assert ok(env, "/todo 장보기 다 했어") == "✅ 완료: 장보기"
    assert ok(env, "/todo 치과 내일로 미뤄줘").startswith("📅 옮겼어요: 치과")
    assert "치과" in run(env, "/todo 내일 뭐 있어")["text"]
    asked = run(env, "/todo 장보기 삭제해줘")
    assert asked["text"].startswith("삭제할까요?") and "장보기" in asked["text"]
    assert [c["label"] for c in asked["choices"]] == ["삭제", "취소"]
    assert "취소했어요" in run(env, asked["choices"][1]["text"])["text"]
    assert run(env, asked["choices"][0]["text"])["text"].startswith("🗑️ 삭제했어요")
    assert "장보기" not in run(env, "/todo 오늘 뭐 있어")["text"]
    assert "이미 삭제" in run(env, asked["choices"][0]["text"])["text"]
    missing = run(env, "/todo [없는것] 회의 넣어줘")
    assert "없어요" in missing["text"] and missing["choices"]


def test_todo_commands_more(env: Env) -> None:
    signed_up(env, "mocha")
    env.client.get("/api/todo/categories")
    # 카테고리
    assert "'운동' 카테고리를 만들었어요" in ok(env, "/todo 운동 카테고리 만들어줘")
    assert "운동" in run(env, "/todo 카테고리 보여줘")["text"]
    # 고치기
    ok(env, "/todo 내일 저녁 7시 헬스 넣어줘 [운동]")
    assert "바꿨어요" in ok(env, "/todo 내일 헬스 장소 동네 헬스장으로 바꿔줘")
    assert "바꿨어요" in ok(env, "/todo 내일 헬스 시각 20:00으로")
    view = run(env, "/todo 내일 뭐 있어")["text"]
    assert "헬스 | 20:00 | 동네 헬스장" in view
    # 반복
    asked = run(env, "/todo 평일 9시 반 출근 반복 만들어줘 [TODO]")
    assert asked["text"] == "9시 30분이 오전인가요, 오후인가요?"
    made = ok(env, asked["choices"][0]["text"])
    assert "출근 | 평일마다 | 09:30" in made
    assert "출근" in run(env, "/todo 반복 보여줘")["text"]
    ended = run(env, "/todo 출근 반복 끝내기")
    assert [c["label"] for c in ended["choices"]] == ["끝내기", "취소"]
    assert "오늘까지만" in run(env, ended["choices"][0]["text"])["text"]
    # 카테고리 끝내기는 묻고 나서
    closing = run(env, "/todo 운동 카테고리 끝내기")
    assert "끝낼까요" in closing["text"]
    assert "끝냈어요" in run(env, closing["choices"][0]["text"])["text"]
    # 휴지통
    asked = run(env, "/todo 내일 헬스 삭제")
    run(env, asked["choices"][0]["text"])
    trash = run(env, "/todo 휴지통 보여줘")["text"]
    assert "1. 헬스" in trash
    assert ok(env, "/todo 휴지통 1번 되살려줘").startswith("♻️ 되살렸어요")
    # 친구 이름이 없으면 찾지 못했다고
    assert "찾지 못했어요" in run(env, "/todo 없는사람에게 친구 요청")["text"]


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
