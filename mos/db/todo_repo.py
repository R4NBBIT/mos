"""할 일 SQL. 모든 질의는 계정 ID로 걸러서, 남의 것은 ID를 알아도 찾을 수 없다."""

from __future__ import annotations

from typing import Any

from mos.db.database import Database

NEWS_KEEP = 50
CATEGORY_COLUMNS = "id, name, color, visibility, memo_shared, position, closed_at"
ITEM_COLUMNS = (
    "id, category_id, title, memo, day, time, place, visibility, position, done_at, source,"
    " created_at, repeat_id, skipped"
)
REPEAT_COLUMNS = (
    "id, category_id, title, memo, time, place, rule, weekdays, start_day, end_day, position"
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
            " AS done FROM todo_item WHERE account_id = ? AND day BETWEEN ? AND ? AND skipped = 0"
            " GROUP BY day",
            (account_id, start, end),
        )
        return [dict(row) for row in rows]

    async def counts(self, account_id: int, day: str) -> tuple[int, int]:
        """(그날 개수, 전체 개수)"""
        row = await self.db.fetch_one(
            "SELECT SUM(CASE WHEN day = ? THEN 1 ELSE 0 END), COUNT(*) FROM todo_item"
            " WHERE account_id = ? AND skipped = 0",
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
            position = values.get("position") or last + 1
            cursor = await conn.execute(
                "INSERT INTO todo_item (account_id, category_id, title, memo, day, time, place,"
                " position, source, repeat_id, skipped, done_at, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    account_id,
                    values["category_id"],
                    values["title"],
                    values["memo"],
                    values["day"],
                    values["time"],
                    values["place"],
                    position,
                    values["source"],
                    values.get("repeat_id"),
                    int(values.get("skipped", 0)),
                    values.get("done_at"),
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

    async def materialized(self, account_id: int, start: str, end: str) -> set[tuple[int, str]]:
        """반복 할 일 중 행이 이미 있는 (반복 ID, 날짜)."""
        rows = await self.db.fetch_all(
            "SELECT repeat_id, day FROM todo_item WHERE account_id = ? AND repeat_id IS NOT NULL"
            " AND day BETWEEN ? AND ?",
            (account_id, start, end),
        )
        return {(int(row[0]), str(row[1])) for row in rows}

    async def item_for_repeat(
        self, account_id: int, repeat_id: int, day: str
    ) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            f"SELECT {ITEM_COLUMNS} FROM todo_item"  # noqa: S608
            " WHERE account_id = ? AND repeat_id = ? AND day = ?",
            (account_id, repeat_id, day),
        )
        return dict(row) if row else None

    async def delete_repeat_rows_from(self, account_id: int, repeat_id: int, day: str) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_item WHERE account_id = ? AND repeat_id = ? AND day >= ?",
                (account_id, repeat_id, day),
            )

    # ------------------------------------------------------------ 반복

    async def repeats(self, account_id: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            f"SELECT {REPEAT_COLUMNS} FROM todo_repeat WHERE account_id = ? ORDER BY id",  # noqa: S608
            (account_id,),
        )
        return [dict(row) for row in rows]

    async def repeat(self, account_id: int, repeat_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            f"SELECT {REPEAT_COLUMNS} FROM todo_repeat"  # noqa: S608
            " WHERE account_id = ? AND id = ?",
            (account_id, repeat_id),
        )
        return dict(row) if row else None

    async def count_repeats(self, account_id: int) -> int:
        row = await self.db.fetch_one(
            "SELECT COUNT(*) FROM todo_repeat WHERE account_id = ?", (account_id,)
        )
        return int(row[0]) if row else 0

    async def add_repeat(
        self, account_id: int, values: dict[str, Any], item_id: int, now: int
    ) -> int:
        """할 일 하나를 반복으로: 규칙을 만들고 그 할 일을 첫 회차로 묶는다."""
        async with self.db.writing() as conn:
            cursor = await conn.execute(
                "INSERT INTO todo_repeat (account_id, category_id, title, memo, time, place,"
                " rule, weekdays, start_day, end_day, position, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    account_id,
                    values["category_id"],
                    values["title"],
                    values["memo"],
                    values["time"],
                    values["place"],
                    values["rule"],
                    values["weekdays"],
                    values["start_day"],
                    values["end_day"],
                    values["position"],
                    now,
                    now,
                ),
            )
            repeat_id = int(cursor.lastrowid or 0)
            await conn.execute(
                "UPDATE todo_item SET repeat_id = ?, updated_at = ?"
                " WHERE account_id = ? AND id = ?",
                (repeat_id, now, account_id, item_id),
            )
            return repeat_id

    async def update_repeat(
        self, account_id: int, repeat_id: int, changes: dict[str, Any], now: int
    ) -> None:
        if not changes:
            return
        sets = ", ".join(f"{column} = ?" for column in changes)
        async with self.db.writing() as conn:
            await conn.execute(
                f"UPDATE todo_repeat SET {sets}, updated_at = ?"  # noqa: S608
                " WHERE account_id = ? AND id = ?",
                (*changes.values(), now, account_id, repeat_id),
            )

    # ------------------------------------------------------------ 할 일 설정

    async def prefs(self, account_id: int) -> str | None:
        row = await self.db.fetch_one(
            "SELECT prefs_json FROM todo_pref WHERE account_id = ?", (account_id,)
        )
        return str(row[0]) if row else None

    async def save_prefs(self, account_id: int, prefs_json: str, now: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO todo_pref (account_id, prefs_json, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT (account_id) DO UPDATE SET prefs_json = excluded.prefs_json,"
                " updated_at = excluded.updated_at",
                (account_id, prefs_json, now),
            )

    # ------------------------------------------------------------ 알림(NOTI-01, NOTI-03)

    async def pref_rows(self) -> list[tuple[int, str]]:
        rows = await self.db.fetch_all("SELECT account_id, prefs_json FROM todo_pref")
        return [(int(row[0]), str(row[1])) for row in rows]

    async def mark_alert(self, account_id: int, key: str, now: int) -> bool:
        """처음 보내는 알림이면 True(표시를 남김), 이미 보냈으면 False."""
        async with self.db.writing() as conn:
            cursor = await conn.execute(
                "INSERT OR IGNORE INTO todo_alert_sent (account_id, alert_key, sent_at)"
                " VALUES (?, ?, ?)",
                (account_id, key, now),
            )
            return cursor.rowcount == 1

    async def forget_alerts_before(self, before: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM todo_alert_sent WHERE sent_at < ?", (before,))

    # ------------------------------------------------------------ 소식(NOTI-06)

    async def add_news(self, account_id: int, kind: str, title: str, body: str, now: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO todo_news (account_id, kind, title, body, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (account_id, kind, title, body, now),
            )
            # 계정당 최근 것만 남긴다
            await conn.execute(
                "DELETE FROM todo_news WHERE account_id = ? AND id NOT IN"
                " (SELECT id FROM todo_news WHERE account_id = ? ORDER BY id DESC LIMIT ?)",
                (account_id, account_id, NEWS_KEEP),
            )

    async def news(self, account_id: int, since: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT id, kind, title, body, created_at FROM todo_news"
            " WHERE account_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?",
            (account_id, since, NEWS_KEEP),
        )
        return [
            {
                "id": str(row[0]),
                "kind": str(row[1]),
                "title": str(row[2]),
                "body": str(row[3]),
                "created_at": int(row[4]),
            }
            for row in rows
        ]

    async def forget_news_before(self, before: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM todo_news WHERE created_at < ?", (before,))
