"""할 일 SQL. 모든 질의는 계정 ID로 걸러서, 남의 것은 ID를 알아도 찾을 수 없다."""

from __future__ import annotations

from typing import Any

from mos.db.database import Database

CATEGORY_COLUMNS = "id, name, color, visibility, memo_shared, position, closed_at"
ITEM_COLUMNS = (
    "id, category_id, title, memo, day, time, place, visibility, position, done_at, source,"
    " created_at"
)


class TodoRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------ 카테고리

    async def categories(self, account_id: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            f"SELECT {CATEGORY_COLUMNS} FROM todo_category WHERE account_id = ?"  # noqa: S608
            " ORDER BY position, id",
            (account_id,),
        )
        return [dict(row) for row in rows]

    async def category(self, account_id: int, category_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            f"SELECT {CATEGORY_COLUMNS} FROM todo_category"  # noqa: S608
            " WHERE account_id = ? AND id = ?",
            (account_id, category_id),
        )
        return dict(row) if row else None

    async def add_category(
        self, account_id: int, name: str, color: str, visibility: str, limit: int, now: int
    ) -> int | None:
        """한도를 넘으면 None."""
        async with self.db.writing() as conn:
            async with conn.execute(
                "SELECT COUNT(*), COALESCE(MAX(position), 0) FROM todo_category"
                " WHERE account_id = ?",
                (account_id,),
            ) as cursor:
                count, last = await cursor.fetchone()
            if count >= limit:
                return None
            cursor = await conn.execute(
                "INSERT INTO todo_category (account_id, name, color, visibility, position,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (account_id, name, color, visibility, last + 1, now, now),
            )
            return int(cursor.lastrowid or 0)

    async def update_category(
        self, account_id: int, category_id: int, changes: dict[str, Any], now: int
    ) -> None:
        if not changes:
            return
        # 열 이름은 서비스가 정한 목록에서만 온다(사용자 값은 ? 자리로)
        sets = ", ".join(f"{column} = ?" for column in changes)
        async with self.db.writing() as conn:
            await conn.execute(
                f"UPDATE todo_category SET {sets}, updated_at = ?"  # noqa: S608
                " WHERE account_id = ? AND id = ?",
                (*changes.values(), now, account_id, category_id),
            )

    async def delete_category(self, account_id: int, category_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_item WHERE account_id = ? AND category_id = ?",
                (account_id, category_id),
            )
            await conn.execute(
                "DELETE FROM todo_category WHERE account_id = ? AND id = ?",
                (account_id, category_id),
            )

    # ------------------------------------------------------------ 할 일

    async def items_on(self, account_id: int, day: str) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            f"SELECT {ITEM_COLUMNS} FROM todo_item WHERE account_id = ? AND day = ?"  # noqa: S608
            " ORDER BY position, id",
            (account_id, day),
        )
        return [dict(row) for row in rows]

    async def item(self, account_id: int, item_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            f"SELECT {ITEM_COLUMNS} FROM todo_item WHERE account_id = ? AND id = ?",  # noqa: S608
            (account_id, item_id),
        )
        return dict(row) if row else None

    async def day_summary(self, account_id: int, start: str, end: str) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT day, COUNT(*) AS total, SUM(CASE WHEN done_at IS NULL THEN 0 ELSE 1 END)"
            " AS done FROM todo_item WHERE account_id = ? AND day BETWEEN ? AND ?"
            " GROUP BY day",
            (account_id, start, end),
        )
        return [dict(row) for row in rows]

    async def counts(self, account_id: int, day: str) -> tuple[int, int]:
        """(그날 개수, 전체 개수)"""
        row = await self.db.fetch_one(
            "SELECT SUM(CASE WHEN day = ? THEN 1 ELSE 0 END), COUNT(*) FROM todo_item"
            " WHERE account_id = ?",
            (day, account_id),
        )
        if row is None:
            return 0, 0
        return int(row[0] or 0), int(row[1] or 0)

    async def add_item(self, account_id: int, values: dict[str, Any], now: int) -> int:
        async with self.db.writing() as conn:
            async with conn.execute(
                "SELECT COALESCE(MAX(position), 0) FROM todo_item"
                " WHERE account_id = ? AND day = ? AND category_id = ?",
                (account_id, values["day"], values["category_id"]),
            ) as cursor:
                (last,) = await cursor.fetchone()
            cursor = await conn.execute(
                "INSERT INTO todo_item (account_id, category_id, title, memo, day, time, place,"
                " position, source, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    account_id,
                    values["category_id"],
                    values["title"],
                    values["memo"],
                    values["day"],
                    values["time"],
                    values["place"],
                    last + 1,
                    values["source"],
                    now,
                    now,
                ),
            )
            return int(cursor.lastrowid or 0)

    async def update_item(
        self, account_id: int, item_id: int, changes: dict[str, Any], now: int
    ) -> None:
        if not changes:
            return
        sets = ", ".join(f"{column} = ?" for column in changes)
        async with self.db.writing() as conn:
            await conn.execute(
                f"UPDATE todo_item SET {sets}, updated_at = ?"  # noqa: S608
                " WHERE account_id = ? AND id = ?",
                (*changes.values(), now, account_id, item_id),
            )

    async def delete_item(self, account_id: int, item_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_item WHERE account_id = ? AND id = ?", (account_id, item_id)
            )

    async def next_position(self, account_id: int, day: str, category_id: int) -> int:
        row = await self.db.fetch_one(
            "SELECT COALESCE(MAX(position), 0) FROM todo_item"
            " WHERE account_id = ? AND day = ? AND category_id = ?",
            (account_id, day, category_id),
        )
        return int(row[0] if row else 0) + 1
