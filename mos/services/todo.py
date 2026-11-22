"""할 일 규칙(기능명세서 TODO, CAT). 화면에서 온 값도 여기서 다시 검사한다."""

from __future__ import annotations

import json
import re
import time
from calendar import monthrange
from collections.abc import Awaitable, Callable
from datetime import date, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from mos.db.todo_repo import TodoRepo

MAX_TITLE = 100
MAX_MEMO = 1000
MAX_PLACE = 40
MAX_CATEGORY_NAME = 20
MAX_CATEGORIES = 50
MAX_PER_DAY = 200
MAX_TOTAL = 20_000
MAX_RANGE_DAYS = 42
FIRST_CATEGORY = ("할 일", "#FFD66B")  # 사용자 결정: 노랑(ㅁㅇㅅ 꿀색)
VISIBILITIES = ("public", "friends", "private")
DEFAULT_VISIBILITY = "friends"
RULES = ("daily", "weekdays", "weekly", "monthly")
MAX_REPEATS = 100
PRESET_COLORS = ("#FFD66B", "#2563EB", "#7C5CDB", "#16A34A", "#C2410C", "#DB2777", "#0891B2")
MAX_RECENT_COLORS = 8
VIRTUAL_RE = re.compile(r"^r(\d{1,18}):(\d{4}-\d{2}-\d{2})$")

DAY_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
COLOR_RE = re.compile(r"^#[0-9A-F]{6}$")
SPACES_RE = re.compile(r"\s+")
TZ_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]{0,30}(/[A-Za-z0-9_+-]{1,30}){0,2}$")


class TodoError(Exception):
    """화면에 보여 줄 수 있는 실패. code는 웹이 구분하는 짧은 문자열."""

    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def clean_day(raw: Any) -> str:
    if not isinstance(raw, str):
        raise TodoError("bad_day")
    match = DAY_RE.match(raw)
    if not match:
        raise TodoError("bad_day")
    try:
        value = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError as error:
        raise TodoError("bad_day") from error
    if not 2000 <= value.year <= 2100:
        raise TodoError("bad_day")
    return value.isoformat()


def clean_time(raw: Any) -> str | None:
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str) or not TIME_RE.match(raw):
        raise TodoError("bad_time")
    return raw


def one_line(raw: Any, limit: int, code: str, allow_empty: bool = False) -> str:
    if not isinstance(raw, str):
        raise TodoError(code)
    text = SPACES_RE.sub(" ", raw).strip()
    if (not text and not allow_empty) or len(text) > limit:
        raise TodoError(code)
    return text


def clean_memo(raw: Any) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise TodoError("bad_memo")
    text = raw.replace("\r\n", "\n").strip()
    if len(text) > MAX_MEMO:
        raise TodoError("bad_memo")
    return text


def clean_place(raw: Any) -> str | None:
    if raw is None or raw == "":
        return None
    return one_line(raw, MAX_PLACE, "bad_place", allow_empty=True) or None


def clean_color(raw: Any) -> str:
    if not isinstance(raw, str):
        raise TodoError("bad_color")
    value = raw.strip().upper()
    if not value.startswith("#"):
        value = "#" + value
    if len(value) == 4:  # #2E8 → #22EE88
        value = "#" + "".join(ch * 2 for ch in value[1:])
    if not COLOR_RE.match(value):
        raise TodoError("bad_color")
    return value


def parse_id(raw: Any) -> int:
    if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0:
        return raw
    if isinstance(raw, str) and raw.isdigit() and len(raw) <= 18:
        return int(raw)
    raise TodoError("bad_id")


def category_to_api(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "color": row["color"],
        "visibility": row["visibility"],
        "memo_shared": bool(row["memo_shared"]),
        "closed": row["closed_at"] is not None,
    }


def repeat_to_api(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "rule": row["rule"],
        "weekdays": [day for day in range(7) if row["weekdays"] & (1 << day)],
        "end_day": row["end_day"],
    }


def item_to_api(row: dict[str, Any], repeat: dict[str, Any] | None = None) -> dict[str, Any]:
    virtual = row.get("id") is None
    return {
        # 아직 행이 없는 반복 회차는 r<반복 ID>:<날짜>
        "id": f"r{repeat['id']}:{row['day']}" if virtual and repeat else str(row["id"]),
        "category_id": str(row["category_id"]),
        "title": row["title"],
        "memo": row["memo"],
        "day": row["day"],
        "time": row["time"],
        "place": row["place"],
        "done": row["done_at"] is not None,
        "source": row["source"],
        "position": row["position"],
        "repeat": repeat_to_api(repeat) if repeat else None,
    }


def repeat_on(rep: dict[str, Any], day: str) -> bool:
    """그날 반복 회차가 있는지(시작 전, 끝난 뒤는 없음)."""
    if day < rep["start_day"] or (rep["end_day"] and day > rep["end_day"]):
        return False
    value = date.fromisoformat(day)
    sunday_index = (value.weekday() + 1) % 7  # 일=0 … 토=6
    rule = rep["rule"]
    if rule == "daily":
        return True
    if rule == "weekdays":
        return 1 <= sunday_index <= 5
    if rule == "weekly":
        return bool(rep["weekdays"] & (1 << sunday_index))
    if rule == "monthly":
        start = date.fromisoformat(rep["start_day"])
        last = monthrange(value.year, value.month)[1]
        return value.day == min(start.day, last)  # 31일 반복은 짧은 달엔 마지막 날
    return False


def virtual_row(rep: dict[str, Any], day: str) -> dict[str, Any]:
    return {
        "id": None,
        "category_id": rep["category_id"],
        "title": rep["title"],
        "memo": rep["memo"],
        "day": day,
        "time": rep["time"],
        "place": rep["place"],
        "visibility": None,
        "position": rep["position"],
        "done_at": None,
        "source": "app",
        "repeat_id": rep["id"],
        "skipped": 0,
    }


def day_range(start: str, end: str) -> list[str]:
    first = date.fromisoformat(start)
    count = (date.fromisoformat(end) - first).days + 1
    return [(first + timedelta(days=offset)).isoformat() for offset in range(max(count, 0))]


class TodoService:
    # 하루 보기에 덧붙이기(친구 기능의 반응). (보는 사람, 주인, 할 일들)
    decorate: Callable[[int, int, list[dict[str, Any]]], Awaitable[None]] | None = None

    def __init__(self, repo: TodoRepo, clock: Callable[[], float] = time.time) -> None:
        self.repo = repo
        self.clock = clock

    def now(self) -> int:
        return int(self.clock())

    # ------------------------------------------------------------ 카테고리

    async def categories(self, account_id: int) -> list[dict[str, Any]]:
        rows = await self.repo.categories(account_id)
        if not rows:
            name, color = FIRST_CATEGORY
            await self.repo.add_category(
                account_id, name, color, DEFAULT_VISIBILITY, MAX_CATEGORIES, self.now()
            )
            rows = await self.repo.categories(account_id)
        return rows

    async def _open_category(self, account_id: int, raw_id: Any) -> dict[str, Any]:
        category = await self.repo.category(account_id, parse_id(raw_id))
        if category is None:
            raise TodoError("not_found", 404)
        if category["closed_at"] is not None:
            raise TodoError("category_closed", 409)
        return category

    async def _check_name(self, account_id: int, name: str, skip_id: int | None = None) -> None:
        for row in await self.repo.categories(account_id):
            if row["id"] != skip_id and row["name"].casefold() == name.casefold():
                raise TodoError("duplicate_name", 409)

    async def create_category(self, account_id: int, body: dict[str, Any]) -> dict[str, Any]:
        await self.categories(account_id)  # 처음이면 기본 카테고리부터
        name = one_line(body.get("name"), MAX_CATEGORY_NAME, "bad_name")
        color = clean_color(body.get("color", FIRST_CATEGORY[1]))
        visibility = body.get("visibility", DEFAULT_VISIBILITY)
        if visibility not in VISIBILITIES:
            raise TodoError("bad_visibility")
        await self._check_name(account_id, name)
        new_id = await self.repo.add_category(
            account_id, name, color, visibility, MAX_CATEGORIES, self.now()
        )
        if new_id is None:
            raise TodoError("too_many_categories", 409)
        await self.remember_color(account_id, color)
        row = await self.repo.category(account_id, new_id)
        if row is None:  # 방금 넣었으니 오지 않는다
            raise TodoError("not_found", 404)
        return category_to_api(row)

    async def update_category(
        self, account_id: int, category_id: int, body: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self.repo.category(account_id, category_id)
        if row is None:
            raise TodoError("not_found", 404)
        changes: dict[str, Any] = {}
        if "name" in body:
            name = one_line(body["name"], MAX_CATEGORY_NAME, "bad_name")
            await self._check_name(account_id, name, skip_id=category_id)
            changes["name"] = name
        if "color" in body:
            changes["color"] = clean_color(body["color"])
            await self.remember_color(account_id, changes["color"])
        if "visibility" in body:
            if body["visibility"] not in VISIBILITIES:
                raise TodoError("bad_visibility")
            changes["visibility"] = body["visibility"]
        if "memo_shared" in body:
            if not isinstance(body["memo_shared"], bool):
                raise TodoError("bad_memo_shared")
            changes["memo_shared"] = int(body["memo_shared"])
        if "closed" in body:
            if not isinstance(body["closed"], bool):
                raise TodoError("bad_closed")
            if body["closed"] and row["closed_at"] is None:
                await self._keep_one_open(account_id, category_id)
                changes["closed_at"] = self.now()
            elif not body["closed"]:
                changes["closed_at"] = None
        await self.repo.update_category(account_id, category_id, changes, self.now())
        updated = await self.repo.category(account_id, category_id)
        return category_to_api(updated or row)

    async def _keep_one_open(self, account_id: int, category_id: int) -> None:
        others = [
            row
            for row in await self.repo.categories(account_id)
            if row["id"] != category_id and row["closed_at"] is None
        ]
        if not others:
            raise TodoError("last_category", 409)

    async def reorder_categories(self, account_id: int, ids: Any) -> list[dict[str, Any]]:
        rows = await self.repo.categories(account_id)
        if not isinstance(ids, list) or len(ids) > MAX_CATEGORIES:
            raise TodoError("bad_order")
        wanted = [parse_id(value) for value in ids]
        known = {row["id"] for row in rows}
        if set(wanted) != known or len(wanted) != len(known):
            raise TodoError("bad_order")
        now = self.now()
        for position, category_id in enumerate(wanted, start=1):
            await self.repo.update_category(account_id, category_id, {"position": position}, now)
        return [category_to_api(row) for row in await self.repo.categories(account_id)]

    async def delete_category(self, account_id: int, category_id: int) -> None:
        row = await self.repo.category(account_id, category_id)
        if row is None:
            raise TodoError("not_found", 404)
        if row["closed_at"] is None:
            await self._keep_one_open(account_id, category_id)
        await self.repo.delete_category(account_id, category_id)

    # ------------------------------------------------------------ 하루, 요약

    async def _open_category_ids(self, account_id: int) -> set[int]:
        return {row["id"] for row in await self.categories(account_id) if row["closed_at"] is None}

    async def day(self, account_id: int, raw_day: Any) -> dict[str, Any]:
        day = clean_day(raw_day)
        categories = await self.categories(account_id)
        open_ids = {row["id"] for row in categories if row["closed_at"] is None}
        rows = await self.repo.items_on(account_id, day)
        repeats = {rep["id"]: rep for rep in await self.repo.repeats(account_id)}
        made = {row["repeat_id"] for row in rows if row["repeat_id"] is not None}
        items = [row for row in rows if not row["skipped"]]
        for rep in repeats.values():
            # 끝낸 카테고리의 반복은 멈춘다(CAT-04)
            if rep["id"] not in made and rep["category_id"] in open_ids and repeat_on(rep, day):
                items.append(virtual_row(rep, day))
        items.sort(key=lambda row: (row["position"], row["id"] or 0))
        used = {item["category_id"] for item in items}
        # 끝낸 카테고리는 그날 할 일이 남아 있을 때만(지난 기록)
        shown = [row for row in categories if row["closed_at"] is None or row["id"] in used]
        api_items = [item_to_api(item, repeats.get(item["repeat_id"])) for item in items]
        return {
            "day": day,
            "categories": [category_to_api(row) for row in shown],
            "items": api_items,
        }

    async def days(self, account_id: int, raw_start: Any, raw_end: Any) -> dict[str, Any]:
        start, end = clean_day(raw_start), clean_day(raw_end)
        span = (date.fromisoformat(end) - date.fromisoformat(start)).days
        if span < 0 or span >= MAX_RANGE_DAYS:
            raise TodoError("bad_range")
        summary = {
            row["day"]: {"total": int(row["total"]), "done": int(row["done"] or 0)}
            for row in await self.repo.day_summary(account_id, start, end)
        }
        repeats = await self.repo.repeats(account_id)
        if repeats:
            open_ids = await self._open_category_ids(account_id)
            made = await self.repo.materialized(account_id, start, end)
            for day in day_range(start, end):
                extra = sum(
                    1
                    for rep in repeats
                    if rep["category_id"] in open_ids
                    and (rep["id"], day) not in made
                    and repeat_on(rep, day)
                )
                if extra:
                    entry = summary.setdefault(day, {"total": 0, "done": 0})
                    entry["total"] += extra
        return {"days": summary}

    # ------------------------------------------------------------ 할 일

    async def add_item(
        self,
        account_id: int,
        body: dict[str, Any],
        source: str = "app",
        source_client: str | None = None,
        batch_id: str | None = None,
    ) -> dict[str, Any]:
        await self.categories(account_id)
        category = await self._open_category(account_id, body.get("category_id"))
        values = {
            "category_id": category["id"],
            "title": one_line(body.get("title"), MAX_TITLE, "bad_title"),
            "memo": clean_memo(body.get("memo")),
            "day": clean_day(body.get("day")),
            "time": clean_time(body.get("time")),
            "place": clean_place(body.get("place")),
            "source": source,
            "source_client": source_client,
            "batch_id": batch_id,
        }
        on_day, total = await self.repo.counts(account_id, values["day"])
        if on_day >= MAX_PER_DAY or total >= MAX_TOTAL:
            raise TodoError("too_many_items", 409)
        new_id = await self.repo.add_item(account_id, values, self.now())
        row = await self.repo.item(account_id, new_id)
        if row is None:
            raise TodoError("not_found", 404)
        return item_to_api(row)

    async def _row(self, account_id: int, raw_id: Any, skipped: bool = False) -> dict[str, Any]:
        """할 일 행. 아직 행이 없는 반복 회차(r<반복>:<날짜>)면 지금 만든다."""
        match = VIRTUAL_RE.match(raw_id) if isinstance(raw_id, str) else None
        if match is None:
            row = await self.repo.item(account_id, parse_id(raw_id))
            if row is None or (row["skipped"] and not skipped):
                raise TodoError("not_found", 404)
            return row
        repeat_id, day = int(match.group(1)), clean_day(match.group(2))
        existing = await self.repo.item_for_repeat(account_id, repeat_id, day)
        if existing is not None:
            if existing["skipped"] and not skipped:
                raise TodoError("not_found", 404)
            return existing
        rep = await self.repo.repeat(account_id, repeat_id)
        if rep is None or not repeat_on(rep, day):
            raise TodoError("not_found", 404)
        values = {**virtual_row(rep, day), "skipped": int(skipped)}
        new_id = await self.repo.add_item(account_id, values, self.now())
        row = await self.repo.item(account_id, new_id)
        if row is None:
            raise TodoError("not_found", 404)
        return row

    async def _with_repeat(self, account_id: int, row: dict[str, Any]) -> dict[str, Any]:
        rep = await self.repo.repeat(account_id, row["repeat_id"]) if row["repeat_id"] else None
        return item_to_api(row, rep)

    async def update_item(
        self, account_id: int, raw_id: Any, body: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._row(account_id, raw_id)
        item_id = row["id"]
        changes: dict[str, Any] = {}
        if "title" in body:
            changes["title"] = one_line(body["title"], MAX_TITLE, "bad_title")
        if "memo" in body:
            changes["memo"] = clean_memo(body["memo"])
        if "time" in body:
            changes["time"] = clean_time(body["time"])
        if "place" in body:
            changes["place"] = clean_place(body["place"])
        if "done" in body:
            if not isinstance(body["done"], bool):
                raise TodoError("bad_done")
            if body["done"] and row["done_at"] is None:
                changes["done_at"] = self.now()
            elif not body["done"]:
                changes["done_at"] = None
        moved_day = clean_day(body["day"]) if "day" in body else row["day"]
        moved_category = row["category_id"]
        if "category_id" in body:
            moved_category = (await self._open_category(account_id, body["category_id"]))["id"]
        if moved_day != row["day"] or moved_category != row["category_id"]:
            if moved_day != row["day"]:
                on_day, _ = await self.repo.counts(account_id, moved_day)
                if on_day >= MAX_PER_DAY:
                    raise TodoError("too_many_items", 409)
                if row["repeat_id"] is not None:
                    # 반복 회차를 다른 날로 옮기면 따로인 할 일이 되고, 원래 날 회차는 건너뜀
                    changes["repeat_id"] = None
                    rep = await self.repo.repeat(account_id, row["repeat_id"])
                    if rep is not None:
                        skip = {**virtual_row(rep, row["day"]), "skipped": 1}
                        await self.repo.update_item(
                            account_id, item_id, {"repeat_id": None}, self.now()
                        )
                        await self.repo.add_item(account_id, skip, self.now())
            changes["day"] = moved_day
            changes["category_id"] = moved_category
            changes["position"] = await self.repo.next_position(
                account_id, moved_day, moved_category
            )
        await self.repo.update_item(account_id, item_id, changes, self.now())
        updated = await self.repo.item(account_id, item_id)
        return await self._with_repeat(account_id, updated or row)

    async def reorder_items(
        self, account_id: int, raw_day: Any, raw_category: Any, ids: Any
    ) -> None:
        day = clean_day(raw_day)
        category_id = parse_id(raw_category)
        if not isinstance(ids, list) or len(ids) > MAX_PER_DAY:
            raise TodoError("bad_order")
        shown = await self.day(account_id, day)
        current = {item["id"] for item in shown["items"] if item["category_id"] == str(category_id)}
        wanted = [str(value) for value in ids]
        if set(wanted) != current or len(wanted) != len(current):
            raise TodoError("bad_order")
        now = self.now()
        for position, raw in enumerate(wanted, start=1):
            row = await self._row(account_id, raw)  # 반복 회차면 행을 만든다
            await self.repo.update_item(account_id, row["id"], {"position": position}, now)

    async def delete_item(self, account_id: int, raw_id: Any, scope: str = "today") -> None:
        row = await self._row(account_id, raw_id)
        if row["repeat_id"] is None:
            await self.repo.delete_item(account_id, row["id"])
            return
        if scope == "future":
            await self.stop_repeat(account_id, row["repeat_id"], row["day"], keep_day=False)
            return
        # 오늘 것만: 행은 남기고 건너뜀 표시(그날 회차가 다시 생기지 않게)
        await self.repo.update_item(
            account_id, row["id"], {"skipped": 1, "done_at": None}, self.now()
        )

    # ------------------------------------------------------------ 반복

    def _rule(self, body: dict[str, Any], start_day: str) -> dict[str, Any]:
        rule = body.get("rule")
        if rule not in RULES:
            raise TodoError("bad_rule")
        weekdays = 0
        if rule == "weekly":
            days = body.get("weekdays")
            if not isinstance(days, list) or not days or len(days) > 7:
                raise TodoError("bad_weekdays")
            for value in days:
                if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 6:
                    raise TodoError("bad_weekdays")
                weekdays |= 1 << value
        end_day = body.get("end_day")
        if end_day is not None:
            end_day = clean_day(end_day)
            if end_day < start_day:
                raise TodoError("bad_end_day")
        return {"rule": rule, "weekdays": weekdays, "end_day": end_day}

    async def create_repeat(self, account_id: int, body: dict[str, Any]) -> dict[str, Any]:
        row = await self._row(account_id, body.get("item_id"))
        if row["repeat_id"] is not None:
            raise TodoError("already_repeating", 409)
        if await self.repo.count_repeats(account_id) >= MAX_REPEATS:
            raise TodoError("too_many_repeats", 409)
        rule = self._rule(body, row["day"])
        values = {
            "category_id": row["category_id"],
            "title": row["title"],
            "memo": row["memo"],
            "time": row["time"],
            "place": row["place"],
            "start_day": row["day"],
            "position": row["position"],
            **rule,
        }
        repeat_id = await self.repo.add_repeat(account_id, values, row["id"], self.now())
        rep = await self.repo.repeat(account_id, repeat_id)
        return repeat_to_api(rep) if rep else {}

    async def update_repeat(
        self, account_id: int, repeat_id: int, body: dict[str, Any]
    ) -> dict[str, Any]:
        """규칙(종류, 요일, 끝나는 날)과 앞으로의 이름, 시각, 장소, 메모, 카테고리."""
        rep = await self.repo.repeat(account_id, repeat_id)
        if rep is None:
            raise TodoError("not_found", 404)
        changes: dict[str, Any] = {}
        if "rule" in body:
            changes.update(self._rule(body, rep["start_day"]))
        elif "end_day" in body:
            end_day = None if body["end_day"] is None else clean_day(body["end_day"])
            if end_day is not None and end_day < rep["start_day"]:
                raise TodoError("bad_end_day")
            changes["end_day"] = end_day
        if "title" in body:
            changes["title"] = one_line(body["title"], MAX_TITLE, "bad_title")
        if "memo" in body:
            changes["memo"] = clean_memo(body["memo"])
        if "time" in body:
            changes["time"] = clean_time(body["time"])
        if "place" in body:
            changes["place"] = clean_place(body["place"])
        if "category_id" in body:
            changes["category_id"] = (await self._open_category(account_id, body["category_id"]))[
                "id"
            ]
        await self.repo.update_repeat(account_id, repeat_id, changes, self.now())
        updated = await self.repo.repeat(account_id, repeat_id)
        return repeat_to_api(updated or rep)

    async def stop_repeat(
        self, account_id: int, repeat_id: int, raw_day: Any, keep_day: bool = True
    ) -> None:
        """그날부터 반복 그만. keep_day면 그날 할 일은 따로인 할 일로 남긴다."""
        rep = await self.repo.repeat(account_id, repeat_id)
        if rep is None:
            raise TodoError("not_found", 404)
        day = clean_day(raw_day)
        if keep_day and repeat_on(rep, day):
            row = await self._row(account_id, f"r{repeat_id}:{day}")
            await self.repo.update_item(account_id, row["id"], {"repeat_id": None}, self.now())
        before = (date.fromisoformat(day) - timedelta(days=1)).isoformat()
        await self.repo.delete_repeat_rows_from(account_id, repeat_id, day)
        await self.repo.update_repeat(account_id, repeat_id, {"end_day": before}, self.now())

    # ------------------------------------------------------------ 설정(todo_pref 한 행, JSON)

    async def _prefs(self, account_id: int) -> dict[str, Any]:
        raw = await self.repo.prefs(account_id)
        try:
            prefs = json.loads(raw) if raw else {}
        except ValueError:
            prefs = {}
        return prefs if isinstance(prefs, dict) else {}

    async def raw_prefs(self, account_id: int) -> dict[str, Any]:
        return await self._prefs(account_id)

    async def save_raw_prefs(self, account_id: int, changes: dict[str, Any]) -> None:
        await self._save_prefs(account_id, changes)

    async def row_for_reaction(
        self, account_id: int, raw_id: Any, materialize: bool
    ) -> dict[str, Any] | None:
        """반응을 달 할 일 행. 반복 회차는 반응을 달 때만 행을 만든다(뗄 때는 만들지 않음)."""
        if not materialize and isinstance(raw_id, str):
            match = VIRTUAL_RE.match(raw_id)
            if match is not None:
                return await self.repo.item_for_repeat(
                    account_id, int(match.group(1)), clean_day(match.group(2))
                )
        try:
            return await self._row(account_id, raw_id)
        except TodoError:
            return None

    async def _save_prefs(self, account_id: int, changes: dict[str, Any]) -> None:
        """다른 키는 그대로 두고 바꾼 키만 덮는다."""
        prefs = {**await self._prefs(account_id), **changes}
        await self.repo.save_prefs(account_id, json.dumps(prefs), self.now())

    # ------------------------------------------------------------ 최근 색

    async def recent_colors(self, account_id: int) -> list[str]:
        colors = (await self._prefs(account_id)).get("recent_colors")
        if not isinstance(colors, list):
            return []
        return [value for value in colors if isinstance(value, str) and COLOR_RE.match(value)][
            :MAX_RECENT_COLORS
        ]

    async def remember_color(self, account_id: int, color: str) -> None:
        """기본 색이 아닌 직접 고른 색만 최근 색 맨 앞에(CAT-10)."""
        if color in PRESET_COLORS:
            return
        colors = [color, *(c for c in await self.recent_colors(account_id) if c != color)]
        await self._save_prefs(account_id, {"recent_colors": colors[:MAX_RECENT_COLORS]})

    # ------------------------------------------------------------ 알림 설정(NOTI-01, NOTI-03)

    async def alert_prefs(self, account_id: int) -> dict[str, Any]:
        return alert_prefs_from(await self._prefs(account_id))

    async def update_alert_prefs(self, account_id: int, body: dict[str, Any]) -> dict[str, Any]:
        changes: dict[str, Any] = {}
        for key, value in body.items():
            if key == "alert_lead":
                if value is not None and (isinstance(value, bool) or value not in ALERT_LEADS):
                    raise TodoError("bad_alert_lead")
                changes[key] = value
            elif key == "morning":
                if value is not None and (not isinstance(value, str) or not TIME_RE.match(value)):
                    raise TodoError("bad_time")
                changes[key] = value
            elif key == "tz":
                changes[key] = clean_tz(value)
            elif key == "morning_via":
                if value not in MORNING_VIA:
                    raise TodoError("bad_morning_via")
                changes[key] = value
            elif key == "boss_mode":
                if value not in BOSS_MODES:
                    raise TodoError("bad_boss_mode")
                changes[key] = value
            else:
                raise TodoError("bad_body")
        if changes:
            await self._save_prefs(account_id, changes)
        return await self.alert_prefs(account_id)

    # ------------------------------------------------------------ 소식(NOTI-06)

    async def news(self, account_id: int) -> dict[str, Any]:
        seen = (await self._prefs(account_id)).get("news_seen")
        seen = seen if isinstance(seen, int) and not isinstance(seen, bool) else 0
        items = await self.repo.news(account_id, self.now() - NEWS_DAYS * 86400)
        return {"items": items, "unread": sum(1 for item in items if int(item["id"]) > seen)}

    async def news_seen(self, account_id: int) -> None:
        items = await self.repo.news(account_id, 0)
        if items:
            await self._save_prefs(account_id, {"news_seen": int(items[0]["id"])})


ALERT_LEADS = (0, 10, 30, 60)  # 몇 분 미리(NOTI-01)
MORNING_VIA = ("push", "dm", "both")
# 위장 화면일 때 할 일 알림(NOTI-05): 안 받기, 조용히(내용, 소리 없이 창만), 그대로(내용, 소리)
BOSS_MODES = ("off", "silent", "full")  # 아침 요약 방법(NOTI-03): 기기 알림, 봇 DM, 둘 다
NEWS_DAYS = 30
DEFAULT_TZ = "Asia/Seoul"


def clean_tz(value: Any) -> str:
    """브라우저가 알려 준 시간대. 알 수 없는 이름은 거절(경로 같은 값도 막힘)."""
    if not isinstance(value, str) or not TZ_RE.match(value):
        raise TodoError("bad_tz")
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise TodoError("bad_tz") from error
    return value


def _boss_mode(prefs: dict[str, Any]) -> str:
    mode = prefs.get("boss_mode")
    if mode in BOSS_MODES:
        return str(mode)
    return "silent" if prefs.get("boss_alerts") is True else "off"  # 예전 켜기/끄기 값


def alert_prefs_from(prefs: dict[str, Any]) -> dict[str, Any]:
    """저장된 값이 이상하면 그 항목만 기본값(끔, 서울)."""
    lead = prefs.get("alert_lead")
    morning = prefs.get("morning")
    tz = prefs.get("tz")
    try:
        tz = clean_tz(tz)
    except TodoError:
        tz = DEFAULT_TZ
    return {
        "alert_lead": lead if lead in ALERT_LEADS and not isinstance(lead, bool) else None,
        "morning": morning if isinstance(morning, str) and TIME_RE.match(morning) else None,
        "tz": tz,
        "morning_via": prefs.get("morning_via")
        if prefs.get("morning_via") in MORNING_VIA
        else "push",
        "boss_mode": _boss_mode(prefs),
    }
