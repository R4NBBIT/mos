"""할 일 규칙(기능명세서 TODO, CAT). 화면에서 온 값도 여기서 다시 검사한다."""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from datetime import date
from typing import Any

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

DAY_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
COLOR_RE = re.compile(r"^#[0-9A-F]{6}$")
SPACES_RE = re.compile(r"\s+")


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


def item_to_api(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "category_id": str(row["category_id"]),
        "title": row["title"],
        "memo": row["memo"],
        "day": row["day"],
        "time": row["time"],
        "place": row["place"],
        "done": row["done_at"] is not None,
        "source": row["source"],
        "position": row["position"],
    }


class TodoService:
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

    async def day(self, account_id: int, raw_day: Any) -> dict[str, Any]:
        day = clean_day(raw_day)
        categories = await self.categories(account_id)
        items = await self.repo.items_on(account_id, day)
        used = {item["category_id"] for item in items}
        # 끝낸 카테고리는 그날 할 일이 남아 있을 때만(지난 기록)
        shown = [row for row in categories if row["closed_at"] is None or row["id"] in used]
        return {
            "day": day,
            "categories": [category_to_api(row) for row in shown],
            "items": [item_to_api(item) for item in items],
        }

    async def days(self, account_id: int, raw_start: Any, raw_end: Any) -> dict[str, Any]:
        start, end = clean_day(raw_start), clean_day(raw_end)
        span = (date.fromisoformat(end) - date.fromisoformat(start)).days
        if span < 0 or span >= MAX_RANGE_DAYS:
            raise TodoError("bad_range")
        rows = await self.repo.day_summary(account_id, start, end)
        return {
            "days": {
                row["day"]: {"total": int(row["total"]), "done": int(row["done"] or 0)}
                for row in rows
            }
        }

    # ------------------------------------------------------------ 할 일

    async def add_item(
        self, account_id: int, body: dict[str, Any], source: str = "app"
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
        }
        on_day, total = await self.repo.counts(account_id, values["day"])
        if on_day >= MAX_PER_DAY or total >= MAX_TOTAL:
            raise TodoError("too_many_items", 409)
        new_id = await self.repo.add_item(account_id, values, self.now())
        row = await self.repo.item(account_id, new_id)
        if row is None:
            raise TodoError("not_found", 404)
        return item_to_api(row)

    async def update_item(
        self, account_id: int, item_id: int, body: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self.repo.item(account_id, item_id)
        if row is None:
            raise TodoError("not_found", 404)
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
            changes["day"] = moved_day
            changes["category_id"] = moved_category
            changes["position"] = await self.repo.next_position(
                account_id, moved_day, moved_category
            )
        await self.repo.update_item(account_id, item_id, changes, self.now())
        updated = await self.repo.item(account_id, item_id)
        return item_to_api(updated or row)

    async def reorder_items(
        self, account_id: int, raw_day: Any, raw_category: Any, ids: Any
    ) -> None:
        day = clean_day(raw_day)
        category_id = parse_id(raw_category)
        if not isinstance(ids, list) or len(ids) > MAX_PER_DAY:
            raise TodoError("bad_order")
        wanted = [parse_id(value) for value in ids]
        current = {
            item["id"]
            for item in await self.repo.items_on(account_id, day)
            if item["category_id"] == category_id
        }
        if set(wanted) != current or len(wanted) != len(current):
            raise TodoError("bad_order")
        now = self.now()
        for position, item_id in enumerate(wanted, start=1):
            await self.repo.update_item(account_id, item_id, {"position": position}, now)

    async def delete_item(self, account_id: int, item_id: int) -> None:
        if await self.repo.item(account_id, item_id) is None:
            raise TodoError("not_found", 404)
        await self.repo.delete_item(account_id, item_id)
