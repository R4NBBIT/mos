"""할 일 MCP 서버(T3, AI-04~11). Streamable HTTP의 JSON 응답만 쓴다(SSE 없음, 세션 없음).

도구: list_categories, list_todos, add_todos, update_todo, complete_todo, undo_last_add.
지우기, 카테고리 만들기, 공개 범위, 친구, 디스코드 정보는 주지 않는다.
AI가 넣은 할 일은 source='ai', 앱(연결)과 묶음 ID를 남겨 '방금 넣은 것 되돌리기'를 할 수 있다.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

from mos.db.todo_repo import TodoRepo
from mos.services.todo import TodoError, TodoService
from mos.services.todo_oauth import Grant

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "mos-todo", "title": "ㅁㅇㅅ 할 일", "version": "1.0"}
MAX_ADD = 20
MAX_LIST_DAYS = 14
UNDO_WINDOW_SEC = 24 * 3600
WEEKDAYS = "월화수목금토일"

INSTRUCTIONS = """ㅁㅇㅅ 할 일에 사용자의 할 일을 넣고 고치는 도구예요.

넣기 전에 꼭 이 형식으로 날짜별로 묶어 보여 주고, 사용자가 좋다고 한 뒤에 add_todos를 부르세요.
(사용자가 '확인 없이 바로'라고 하면 그 대화에서는 건너뛰어도 돼요)

11월 23일 (일)
- 15:00 치과 @강남역 [할 일]
  메모: 보험증 챙기기
- 장보기 [할 일]

규칙
- 날짜는 오늘을 기준으로 정해요(list_categories가 오늘 날짜를 알려 줘요). 한 주는 일요일부터.
- 1시~12시를 오전/오후(아침, 저녁, 밤) 없이 말하면 반드시 물어보세요.
  13시 이상, 15:00, 0시는 묻지 않아요.
- 사용자가 말하지 않은 칸(시각, 장소, 메모)은 비워 두세요. 추측하지 마세요.
- 카테고리는 list_categories에 있는 이름만. 애매하면 물어보세요. 새 카테고리는 만들 수 없어요.
- 없는 칸은 줄에서 빼요(시각이 없으면 '- 장보기 [할 일]').
- 잘못 넣었으면 undo_last_add로 방금 넣은 묶음을 되돌릴 수 있어요.
"""


def _day_label(day: str) -> str:
    value = date.fromisoformat(day)
    return f"{value.month}월 {value.day}일 ({WEEKDAYS[value.weekday()]})"


def _line(item: dict[str, Any], category: str) -> str:
    parts = ["-"]
    if item.get("time"):
        parts.append(item["time"])
    parts.append(item["title"])
    if item.get("place"):
        parts.append(f"@{item['place']}")
    parts.append(f"[{category}]")
    if item.get("done"):
        parts.append("(완료)")
    text = " ".join(parts)
    if item.get("memo"):
        text += "\n  메모: " + item["memo"].replace("\n", " ")
    return text


def _grouped(items: list[dict[str, Any]], names: dict[str, str]) -> str:
    lines: list[str] = []
    current = ""
    for item in sorted(items, key=lambda it: (it["day"], it.get("time") or "99", it["title"])):
        if item["day"] != current:
            if lines:
                lines.append("")
            current = item["day"]
            lines.append(_day_label(current))
        lines.append(_line(item, names.get(item["category_id"], "")))
    return "\n".join(lines)


TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_categories",
        "title": "카테고리 보기",
        "description": "할 일 카테고리 목록과 오늘 날짜. 할 일을 넣기 전에 먼저 부르세요.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "list_todos",
        "title": "할 일 보기",
        "description": "날짜 범위(최대 14일)의 할 일. id는 고치기, 완료에 써요.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "start_day": {"type": "string", "description": "YYYY-MM-DD"},
                "end_day": {"type": "string", "description": "YYYY-MM-DD, 비우면 start_day와 같음"},
            },
            "required": ["start_day"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "add_todos",
        "title": "할 일 넣기",
        "description": (
            "할 일을 한 번에 20개까지 넣어요. 넣기 전에 안내문의 형식으로 사용자에게 확인받으세요. "
            "사용자가 말하지 않은 칸은 비워 두세요."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_ADD,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string", "maxLength": 100},
                            "day": {"type": "string", "description": "YYYY-MM-DD"},
                            "time": {"type": "string", "description": "HH:MM(24시간), 없으면 빼기"},
                            "place": {"type": "string", "maxLength": 40},
                            "memo": {"type": "string", "maxLength": 1000},
                            "category": {
                                "type": "string",
                                "description": "카테고리 이름. 빼면 첫 카테고리",
                            },
                        },
                        "required": ["title", "day"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "update_todo",
        "title": "할 일 고치기",
        "description": "할 일 하나를 고쳐요. 바꿀 칸만 넣으세요. 시각, 장소를 지우려면 null.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "title": {"type": "string", "maxLength": 100},
                "day": {"type": "string", "description": "YYYY-MM-DD"},
                "time": {"type": ["string", "null"], "description": "HH:MM 또는 null"},
                "place": {"type": ["string", "null"], "maxLength": 40},
                "memo": {"type": "string", "maxLength": 1000},
                "category": {"type": "string", "description": "카테고리 이름"},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "complete_todo",
        "title": "할 일 완료",
        "description": "할 일을 완료로(done=false면 완료 취소).",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "done": {"type": "boolean"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "undo_last_add",
        "title": "방금 넣은 것 되돌리기",
        "description": "이 연결로 마지막에 add_todos로 넣은 묶음을 지워요(24시간 안).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"destructiveHint": True},
    },
]

ERROR_TEXT = {
    "bad_title": "이름은 1~100자 한 줄이어야 해요",
    "bad_day": "날짜는 YYYY-MM-DD여야 해요",
    "bad_time": "시각은 HH:MM(24시간)이어야 해요",
    "bad_place": "장소는 40자까지예요",
    "bad_memo": "메모는 1000자까지예요",
    "too_many_items": "하루 200개(전체 2만 개)를 넘었어요",
    "category_closed": "끝낸 카테고리에는 넣을 수 없어요",
    "not_found": "그런 할 일이나 카테고리가 없어요",
    "bad_range": "날짜 범위가 올바르지 않아요",
}


class ToolError(Exception):
    pass


class TodoMcp:
    def __init__(
        self, todo: TodoService, repo: TodoRepo, clock: Callable[[], float] = time.time
    ) -> None:
        self.todo = todo
        self.repo = repo
        self.clock = clock

    async def handle(self, grant: Grant, message: Any, today: str) -> dict[str, Any] | None:
        """JSON-RPC 메시지 하나. 알림(id 없음)이면 None."""
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return _error(None, -32600, "Invalid Request")
        method = message.get("method")
        msg_id = message.get("id")
        if "id" not in message:
            return None  # notifications/initialized 등
        if not isinstance(method, str):
            return _error(msg_id, -32600, "Invalid Request")
        params = message.get("params") or {}
        if not isinstance(params, dict):
            return _error(msg_id, -32602, "Invalid params")
        if method == "initialize":
            wanted = params.get("protocolVersion")
            version = wanted if wanted in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
            return _result(
                msg_id,
                {
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": SERVER_INFO,
                    "instructions": INSTRUCTIONS,
                },
            )
        if method == "ping":
            return _result(msg_id, {})
        if method == "tools/list":
            return _result(msg_id, {"tools": TOOLS})
        if method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments") or {}
            if not isinstance(name, str) or not isinstance(arguments, dict):
                return _error(msg_id, -32602, "Invalid params")
            try:
                text, data = await self._call(grant, name, arguments, today)
            except ToolError as error:
                return _result(
                    msg_id, {"content": [{"type": "text", "text": str(error)}], "isError": True}
                )
            except TodoError as error:
                message_text = ERROR_TEXT.get(error.code, "처리하지 못했어요")
                return _result(
                    msg_id, {"content": [{"type": "text", "text": message_text}], "isError": True}
                )
            return _result(
                msg_id,
                {"content": [{"type": "text", "text": text}], "structuredContent": data},
            )
        return _error(msg_id, -32601, "Method not found")

    # ------------------------------------------------------------ 도구

    async def _categories(self, account_id: int) -> list[dict[str, Any]]:
        rows = await self.todo.categories(account_id)
        return [row for row in rows if row["closed_at"] is None]

    async def _category_id(self, account_id: int, name: Any) -> str:
        open_rows = await self._categories(account_id)
        if name is None or name == "":
            return str(open_rows[0]["id"])
        if not isinstance(name, str):
            raise ToolError("category는 카테고리 이름이어야 해요")
        wanted = name.strip().lstrip("[").rstrip("]").strip()
        for row in open_rows:
            if row["name"] == wanted:
                return str(row["id"])
        names = ", ".join(row["name"] for row in open_rows)
        raise ToolError(f"'{wanted}' 카테고리가 없어요. 있는 것: {names}. 사용자에게 물어보세요.")

    async def _names(self, account_id: int) -> dict[str, str]:
        return {str(row["id"]): row["name"] for row in await self.todo.categories(account_id)}

    async def _call(
        self, grant: Grant, name: str, args: dict[str, Any], today: str
    ) -> tuple[str, dict[str, Any]]:
        account_id = grant.account_id
        if name == "list_categories":
            rows = await self._categories(account_id)
            data = {"today": today, "categories": [row["name"] for row in rows]}
            return (
                f"오늘: {_day_label(today)} ({today})\n카테고리: " + ", ".join(data["categories"]),
                data,
            )
        if name == "list_todos":
            start = args.get("start_day")
            end = args.get("end_day") or start
            if not isinstance(start, str) or not isinstance(end, str):
                raise ToolError("start_day가 필요해요")
            try:
                first, last = date.fromisoformat(start), date.fromisoformat(end)
            except ValueError as error:
                raise ToolError("날짜는 YYYY-MM-DD여야 해요") from error
            span = (last - first).days
            if span < 0 or span >= MAX_LIST_DAYS:
                raise ToolError("범위는 14일까지예요")
            names = await self._names(account_id)
            items: list[dict[str, Any]] = []
            for offset in range(span + 1):
                day = (first + timedelta(days=offset)).isoformat()
                items.extend((await self.todo.day(account_id, day))["items"])
            listed = [_public(item, names) for item in items]
            text = _grouped(items, names) if items else "할 일이 없어요."
            text += "\n\n(id) " + ", ".join(f"{it['title']}={it['id']}" for it in listed)
            return text, {"todos": listed}
        if name == "add_todos":
            raw = args.get("items")
            if not isinstance(raw, list) or not raw or len(raw) > MAX_ADD:
                raise ToolError(f"items는 1~{MAX_ADD}개여야 해요")
            prepared = []
            for entry in raw:
                if not isinstance(entry, dict):
                    raise ToolError("items의 각 항목은 객체여야 해요")
                body = {
                    "title": entry.get("title"),
                    "day": entry.get("day"),
                    "time": entry.get("time") or None,
                    "place": entry.get("place") or None,
                    "memo": entry.get("memo") or "",
                    "category_id": await self._category_id(account_id, entry.get("category")),
                }
                prepared.append(body)
            batch = secrets.token_hex(8)
            added = []
            for body in prepared:
                added.append(
                    await self.todo.add_item(
                        account_id, body, source="ai", source_client=grant.client_id, batch_id=batch
                    )
                )
            names = await self._names(account_id)
            return (
                f"{len(added)}개 넣었어요.\n\n" + _grouped(added, names),
                {"added": [_public(item, names) for item in added]},
            )
        if name == "update_todo":
            item_id = args.get("id")
            changes: dict[str, Any] = {}
            for key in ("title", "day", "time", "place", "memo"):
                if key in args:
                    changes[key] = args[key]
            if "category" in args:
                changes["category_id"] = await self._category_id(account_id, args["category"])
            if not changes:
                raise ToolError("바꿀 칸이 없어요")
            item = await self.todo.update_item(account_id, item_id, changes)
            names = await self._names(account_id)
            return "고쳤어요.\n" + _grouped([item], names), {"todo": _public(item, names)}
        if name == "complete_todo":
            done = args.get("done", True)
            if not isinstance(done, bool):
                raise ToolError("done은 true 또는 false")
            item = await self.todo.update_item(account_id, args.get("id"), {"done": done})
            names = await self._names(account_id)
            word = "완료했어요" if done else "완료를 취소했어요"
            return f"{word}.\n" + _grouped([item], names), {"todo": _public(item, names)}
        if name == "undo_last_add":
            last = await self.repo.last_batch(account_id, grant.client_id)
            if last is None or last[1] < self.clock() - UNDO_WINDOW_SEC:
                raise ToolError("되돌릴 묶음이 없어요(24시간 안에 이 연결로 넣은 것만)")
            ids = await self.repo.batch_item_ids(account_id, last[0])
            for item_id in ids:
                await self.todo.delete_item(account_id, str(item_id), "today")
            return f"방금 넣은 {len(ids)}개를 지웠어요.", {"removed": len(ids)}
        raise ToolError(f"없는 도구예요: {name}")


def _public(item: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "title": item["title"],
        "day": item["day"],
        "time": item["time"],
        "place": item["place"],
        "memo": item["memo"],
        "category": names.get(item["category_id"], ""),
        "done": item["done"],
        "repeat": repeat_to_api_label(item.get("repeat")),
    }


def repeat_to_api_label(repeat: dict[str, Any] | None) -> str | None:
    if not repeat:
        return None
    return str(repeat.get("rule"))


def _result(msg_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}
