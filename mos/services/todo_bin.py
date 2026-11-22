"""TODO 휴지통의 '묶음' 지우기(2026-11-22 사용자 결정: 모든 지우기는 휴지통을 거쳐 되살릴 수 있게).

TODO 하나(item, skip)는 todo_ai_actions가 다루고, 여기서는 여러 행을 한 번에 지우는 것을 다룬다.
- 카테고리 지우기: 카테고리, 그 안의 TODO, 반복, 일부 공개 대상, 받은 반응
- 반복 '앞으로 것까지' 지우기: 그날부터의 회차 행, 반복의 끝 날
- 친구 그룹 지우기: 그룹, 사람, 그 그룹으로 고른 일부 공개 대상

지우기 직전의 행을 그대로(JSON) todo_trash.kind = 'bundle'에 담아 두고, 되살릴 때 다시 넣는다.
ID가 그사이 다른 행에 쓰였으면 새 ID를 받고, 그 ID를 가리키는 행도 따라 바꾼다.
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable
from typing import Any

import aiosqlite

from mos.db.database import Database

TRASH_KEEP_SEC = 7 * 86400
MAX_NAME = 20
RESTORED_MARK = "(되살림)"

# 되살릴 수 있는 표(이 밖의 이름은 받지 않는다)
TABLES = (
    "todo_category",
    "todo_repeat",
    "todo_item",
    "todo_category_audience",
    "todo_reaction",
    "todo_friend_group",
    "todo_friend_group_member",
)

# (표, 열) → 그 열이 가리키는 표. 되살릴 때 새 ID로 바뀌었으면 따라 바꾼다
REFS: dict[tuple[str, str], str] = {
    ("todo_repeat", "category_id"): "todo_category",
    ("todo_item", "category_id"): "todo_category",
    ("todo_item", "repeat_id"): "todo_repeat",
    ("todo_category_audience", "category_id"): "todo_category",
    ("todo_reaction", "item_id"): "todo_item",
    ("todo_friend_group_member", "group_id"): "todo_friend_group",
}

# 바꿔 넣을 수 있는 열(반복 '앞으로 것까지'를 되살릴 때 끝 날만)
UPDATABLE = {("todo_repeat", "end_day")}


def _dict(row: aiosqlite.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}  # noqa: SIM118  aiosqlite.Row


class TodoBin:
    def __init__(self, db: Database, clock: Callable[[], float] = time.time) -> None:
        self.db = db
        self.clock = clock
        self._columns: dict[str, set[str]] = {}

    def now(self) -> int:
        return int(self.clock())

    async def _rows(
        self, conn: aiosqlite.Connection, table: str, where: str, params: tuple[Any, ...]
    ) -> list[dict[str, Any]]:
        if table not in TABLES:
            raise ValueError(table)
        async with conn.execute(f"SELECT * FROM {table} WHERE {where}", params) as cursor:  # noqa: S608
            return [_dict(row) for row in await cursor.fetchall()]

    async def _put(
        self,
        conn: aiosqlite.Connection,
        account_id: int,
        label: str,
        bundle: dict[str, Any],
        client: str,
    ) -> None:
        now = self.now()
        await conn.execute("DELETE FROM todo_trash WHERE deleted_at < ?", (now - TRASH_KEEP_SEC,))
        await conn.execute(
            "INSERT INTO todo_trash (account_id, kind, item_id, payload, label, day,"
            " client_name, deleted_at) VALUES (?, 'bundle', NULL, ?, ?, '', ?, ?)",
            (account_id, json.dumps(bundle), label, client, now),
        )

    # ------------------------------------------------------------ 지우기

    async def category(self, account_id: int, category_id: int, client: str = "") -> bool:
        async with self.db.writing() as conn:
            found = await self._rows(
                conn, "todo_category", "id = ? AND account_id = ?", (category_id, account_id)
            )
            if not found:
                return False
            repeats = await self._rows(conn, "todo_repeat", "category_id = ?", (category_id,))
            items = await self._rows(conn, "todo_item", "category_id = ?", (category_id,))
            audience = await self._rows(
                conn, "todo_category_audience", "category_id = ?", (category_id,)
            )
            reactions = await self._rows(
                conn,
                "todo_reaction",
                "item_id IN (SELECT id FROM todo_item WHERE category_id = ?)",
                (category_id,),
            )
            rows = [("todo_category", row) for row in found]
            rows += [("todo_repeat", row) for row in repeats]
            rows += [("todo_item", row) for row in items]
            rows += [("todo_category_audience", row) for row in audience]
            rows += [("todo_reaction", row) for row in reactions]
            shown = [row for row in items if not row["skipped"]]
            label = f"'{found[0]['name']}' 카테고리"
            if shown or repeats:
                label += f"(TODO {len(shown)}개" + (f", 반복 {len(repeats)}개)" if repeats else ")")
            await self._put(conn, account_id, label, {"rows": _pack(rows)}, client)
            # TODO, 반복, 대상, 반응은 ON DELETE CASCADE로 같이 지워진다
            await conn.execute(
                "DELETE FROM todo_category WHERE id = ? AND account_id = ?",
                (category_id, account_id),
            )
        return True

    async def repeat_from(
        self, account_id: int, repeat_id: int, day: str, before: str, title: str, client: str = ""
    ) -> bool:
        """반복을 그날부터 그만(그날부터의 회차 행을 지우고 끝 날을 전날로)."""
        async with self.db.writing() as conn:
            found = await self._rows(
                conn, "todo_repeat", "id = ? AND account_id = ?", (repeat_id, account_id)
            )
            if not found:
                return False
            items = await self._rows(
                conn, "todo_item", "repeat_id = ? AND day >= ?", (repeat_id, day)
            )
            reactions = await self._rows(
                conn,
                "todo_reaction",
                "item_id IN (SELECT id FROM todo_item WHERE repeat_id = ? AND day >= ?)",
                (repeat_id, day),
            )
            rows = [("todo_item", row) for row in items]
            rows += [("todo_reaction", row) for row in reactions]
            bundle = {
                "rows": _pack(rows),
                "updates": [
                    {
                        "table": "todo_repeat",
                        "id": repeat_id,
                        "set": {"end_day": found[0]["end_day"]},
                    }
                ],
            }
            await self._put(conn, account_id, f"반복 '{title}'({day}부터)", bundle, client)
            await conn.execute(
                "DELETE FROM todo_item WHERE account_id = ? AND repeat_id = ? AND day >= ?",
                (account_id, repeat_id, day),
            )
            await conn.execute(
                "UPDATE todo_repeat SET end_day = ?, updated_at = ?"
                " WHERE id = ? AND account_id = ?",
                (before, self.now(), repeat_id, account_id),
            )
        return True

    async def repeat_series(self, account_id: int, series_id: int, today: str) -> bool:
        """반복 화면에서 반복 하나(모든 기간) 지우기. 오늘부터의 회차는 같이 지우고,
        지난 회차(행)는 따로인 TODO로 남긴다(되살리면 다시 반복에 묶는다)."""
        async with self.db.writing() as conn:
            periods = await self._rows(
                conn,
                "todo_repeat",
                "account_id = ? AND (id = ? OR series_id = ?)",
                (account_id, series_id, series_id),
            )
            if not periods:
                return False
            ids = [row["id"] for row in periods]
            marks = ", ".join("?" for _ in ids)
            items = await self._rows(
                conn, "todo_item", f"repeat_id IN ({marks}) AND day >= ?", (*ids, today)
            )
            past = await self._rows(
                conn, "todo_item", f"repeat_id IN ({marks}) AND day < ?", (*ids, today)
            )
            reactions = await self._rows(
                conn,
                "todo_reaction",
                f"item_id IN (SELECT id FROM todo_item WHERE repeat_id IN ({marks})"  # noqa: S608
                " AND day >= ?)",
                (*ids, today),
            )
            rows = [("todo_repeat", row) for row in periods]
            rows += [("todo_item", row) for row in items]
            rows += [("todo_reaction", row) for row in reactions]
            relink = [{"item": row["id"], "repeat": row["repeat_id"]} for row in past]
            title = periods[-1]["title"]
            await self._put(
                conn, account_id, f"반복 '{title}'", {"rows": _pack(rows), "relink": relink}, ""
            )
            await conn.execute(
                f"DELETE FROM todo_item WHERE account_id = ? AND repeat_id IN ({marks})"  # noqa: S608
                " AND day >= ?",
                (account_id, *ids, today),
            )
            # 지난 회차는 repeat_id가 NULL이 되어 따로인 TODO로 남는다(ON DELETE SET NULL)
            await conn.execute(
                f"DELETE FROM todo_repeat WHERE account_id = ? AND id IN ({marks})",  # noqa: S608
                (account_id, *ids),
            )
        return True

    async def group(self, account_id: int, group_id: int) -> bool:
        async with self.db.writing() as conn:
            found = await self._rows(
                conn, "todo_friend_group", "id = ? AND account_id = ?", (group_id, account_id)
            )
            if not found:
                return False
            members = await self._rows(
                conn, "todo_friend_group_member", "group_id = ?", (group_id,)
            )
            audience = await self._rows(
                conn,
                "todo_category_audience",
                "kind = 'group' AND target = ?"
                " AND category_id IN (SELECT id FROM todo_category WHERE account_id = ?)",
                (group_id, account_id),
            )
            rows = [("todo_friend_group", row) for row in found]
            rows += [("todo_friend_group_member", row) for row in members]
            rows += [("todo_category_audience", row) for row in audience]
            await self._put(
                conn, account_id, f"'{found[0]['name']}' 그룹", {"rows": _pack(rows)}, ""
            )
            await conn.execute(
                "DELETE FROM todo_category_audience WHERE kind = 'group' AND target = ?",
                (group_id,),
            )
            await conn.execute(
                "DELETE FROM todo_friend_group WHERE id = ? AND account_id = ?",
                (group_id, account_id),
            )
        return True

    # ------------------------------------------------------------ 되살리기

    async def _table_columns(self, conn: aiosqlite.Connection, table: str) -> set[str]:
        if table not in self._columns:
            async with conn.execute(f"PRAGMA table_info({table})") as cursor:
                self._columns[table] = {str(row[1]) for row in await cursor.fetchall()}
        return self._columns[table]

    async def _free_name(
        self, conn: aiosqlite.Connection, table: str, account_id: int, name: str
    ) -> str:
        async with conn.execute(
            f"SELECT 1 FROM {table} WHERE account_id = ? AND name = ?",  # noqa: S608
            (account_id, name),
        ) as cursor:
            if await cursor.fetchone() is None:
                return name
        base = name[: MAX_NAME - len(RESTORED_MARK)]
        for number in range(1, 100):
            mark = RESTORED_MARK if number == 1 else f"({number})"
            candidate = (name[: MAX_NAME - len(mark)] if number > 1 else base) + mark
            async with conn.execute(
                f"SELECT 1 FROM {table} WHERE account_id = ? AND name = ?",  # noqa: S608
                (account_id, candidate),
            ) as cursor:
                if await cursor.fetchone() is None:
                    return candidate
        return base + RESTORED_MARK

    async def restore(self, account_id: int, bundle: dict[str, Any]) -> None:
        ids: dict[str, dict[int, int]] = {table: {} for table in TABLES}
        async with self.db.writing() as conn:
            for entry in bundle.get("rows", []):
                table, row = entry.get("table"), dict(entry.get("row") or {})
                if table not in TABLES or not row:
                    continue
                columns = await self._table_columns(conn, table)
                if not set(row) <= columns:
                    continue
                if "account_id" in row and row["account_id"] != account_id:
                    continue  # 다른 사람 행은 넣지 않는다
                for (ref_table, column), target in REFS.items():
                    if ref_table == table and row.get(column) is not None:
                        row[column] = ids[target].get(row[column], row[column])
                if table == "todo_repeat" and row.get("series_id") is not None:
                    row["series_id"] = ids["todo_repeat"].get(row["series_id"], row["series_id"])
                if table == "todo_category_audience" and row.get("kind") == "group":
                    row["target"] = ids["todo_friend_group"].get(row["target"], row["target"])
                if table in ("todo_category", "todo_friend_group"):
                    row["name"] = await self._free_name(conn, table, account_id, row["name"])
                if table == "todo_category":
                    async with conn.execute(
                        "SELECT COALESCE(MAX(position), 0) + 1 FROM todo_category"
                        " WHERE account_id = ?",
                        (account_id,),
                    ) as cursor:
                        position = await cursor.fetchone()
                    row["position"] = int(position[0]) if position else 0
                old_id = row.get("id")
                if old_id is not None:
                    async with conn.execute(
                        f"SELECT 1 FROM {table} WHERE id = ?",  # noqa: S608
                        (old_id,),
                    ) as cursor:
                        if await cursor.fetchone() is not None:
                            del row["id"]  # 그사이 다른 행이 쓰면 새 ID
                keys = list(row)
                try:
                    cursor = await conn.execute(
                        f"INSERT INTO {table} ({', '.join(keys)})"  # noqa: S608
                        f" VALUES ({', '.join('?' for _ in keys)})",
                        tuple(row[key] for key in keys),
                    )
                except sqlite3.IntegrityError:
                    continue  # 가리키던 행이 이제 없으면(예: 지운 카테고리의 대상) 건너뜀
                if old_id is not None:
                    ids[table][int(old_id)] = int(cursor.lastrowid or old_id)
            for link in bundle.get("relink", []):
                # 반복을 지울 때 따로 남겼던 지난 회차를 다시 반복에 묶는다
                repeat_id = ids["todo_repeat"].get(int(link["repeat"]), int(link["repeat"]))
                await conn.execute(
                    "UPDATE todo_item SET repeat_id = ? WHERE id = ? AND account_id = ?"
                    " AND repeat_id IS NULL",
                    (repeat_id, int(link["item"]), account_id),
                )
            for update in bundle.get("updates", []):
                table = update.get("table")
                changes = update.get("set") or {}
                if not all((table, column) in UPDATABLE for column in changes):
                    continue
                for column, value in changes.items():
                    await conn.execute(
                        f"UPDATE {table} SET {column} = ? WHERE id = ? AND account_id = ?",  # noqa: S608
                        (value, update.get("id"), account_id),
                    )


def _pack(rows: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    return [{"table": table, "row": row} for table, row in rows]
