"""휴지통 한 줄을 눌렀을 때 보여 줄 세부 내용(2026-11-23 사용자 요청).

휴지통에 넣을 때 남긴 내용(payload)에서 사람이 읽을 줄만 뽑는다.
화면에는 글자로만 보여 주므로(HTML 아님) 여기서 만든 글은 그대로 넣어도 된다.
"""

from __future__ import annotations

import datetime
from typing import Any

WEEK = "일월화수목금토"
MAX_ROWS = 60
RULES = {"daily": "매일", "weekdays": "평일마다", "weekends": "주말마다"}


def day_text(day: Any) -> str:
    """2026-11-23 → 2026.11.23 (월). 형식이 아니면 빈 글."""
    if not isinstance(day, str):
        return ""
    try:
        value = datetime.date.fromisoformat(day)
    except ValueError:
        return ""
    return f"{value.year}.{value.month:02d}.{value.day:02d} ({WEEK[(value.weekday() + 1) % 7]})"


def _join(*parts: Any) -> str:
    return " | ".join(str(part) for part in parts if part)


def _rule(row: dict[str, Any]) -> str:
    rule = row.get("rule")
    if rule in RULES:
        return RULES[rule]
    mask = row.get("weekdays") or 0
    days = [WEEK[index] for index in range(7) if int(mask) & (1 << index)]
    return "매주 " + " ".join(days) if days else "매주"


def _item_line(row: dict[str, Any]) -> str:
    done = "완료 | " if row.get("done_at") else ""
    return done + _join(
        row.get("title"), day_text(row.get("day")), row.get("time"), row.get("place")
    )


def describe_item(row: dict[str, Any], category: str) -> list[dict[str, Any]]:
    """TODO 한 개(지운 TODO, 반복에서 이 날만 뺀 것)."""
    rows = [
        _join("날짜", day_text(row.get("day"))),
        _join("시각", row.get("time") or "없음"),
        _join("장소", row.get("place") or "없음"),
    ]
    if category:
        rows.append(_join("카테고리", category))
    if row.get("memo"):
        rows.append(_join("메모", row["memo"]))
    if row.get("done_at"):
        rows.append("완료한 TODO")
    return [{"head": "", "rows": rows}]


def describe_bundle(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """카테고리, 반복, 그룹을 지울 때 같이 묶인 것들."""
    packed = payload.get("rows")
    if not isinstance(packed, list):
        return []
    tables: dict[str, list[dict[str, Any]]] = {}
    for entry in packed:
        if isinstance(entry, dict) and isinstance(entry.get("row"), dict):
            tables.setdefault(str(entry.get("table")), []).append(entry["row"])
    out: list[dict[str, Any]] = []

    def add(head: str, lines: list[str]) -> None:
        if not lines:
            return
        shown = lines[:MAX_ROWS]
        if len(lines) > MAX_ROWS:
            shown.append(f"그 밖에 {len(lines) - MAX_ROWS}개")
        out.append({"head": head, "rows": shown})

    add("카테고리", [str(row.get("name", "")) for row in tables.get("todo_category", [])])
    add(
        "반복",
        [
            _join(
                row.get("title"),
                _rule(row),
                row.get("time"),
                row.get("place"),
                day_text(row.get("start_day")) + "부터" if row.get("start_day") else "",
            )
            for row in tables.get("todo_repeat", [])
        ],
    )
    items = sorted(
        tables.get("todo_item", []), key=lambda row: (str(row.get("day")), str(row.get("time")))
    )
    add("TODO", [_item_line(row) for row in items if not row.get("skipped")])
    groups = tables.get("todo_friend_group", [])
    members = len(tables.get("todo_friend_group_member", []))
    add("그룹", [_join(row.get("name"), f"{members}명") for row in groups])
    return out
