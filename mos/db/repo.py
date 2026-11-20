"""SQL은 이 파일에만 둔다. 항상 매개변수 바인딩."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from mos.db.database import Database

MESSAGE_COLUMNS = (
    "id",
    "guild_id",
    "channel_id",
    "author_id",
    "author_name",
    "author_avatar",
    "author_is_bot",
    "webhook_id",
    "content",
    "embeds_json",
    "attachments_json",
    "components_json",
    "mentions_json",
    "reference_id",
    "flags",
    "created_at",
    "edited_at",
)
MAX_PAGE_SIZE = 100

# 열 이름은 위의 고정 상수에서만 오고, 값은 모두 ? 바인딩이다
_insert_sql = (
    f"INSERT INTO message ({', '.join(MESSAGE_COLUMNS)}) "  # noqa: S608
    f"VALUES ({', '.join('?' for _ in MESSAGE_COLUMNS)}) "
    "ON CONFLICT(id) DO UPDATE SET "
    + ", ".join(f"{column}=excluded.{column}" for column in MESSAGE_COLUMNS if column != "id")
)


class MessageRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def upsert_many(self, rows: Iterable[dict[str, Any]]) -> int:
        values = [tuple(row[column] for column in MESSAGE_COLUMNS) for row in rows]
        if not values:
            return 0
        async with self.db.writing() as conn:
            await conn.executemany(_insert_sql, values)
        return len(values)

    async def upsert(self, row: dict[str, Any]) -> None:
        await self.upsert_many([row])

    async def delete_many(self, message_ids: Iterable[int]) -> int:
        ids = [(int(message_id),) for message_id in message_ids]
        if not ids:
            return 0
        async with self.db.writing() as conn:
            await conn.executemany("DELETE FROM message WHERE id = ?", ids)
        return len(ids)

    async def list_page(
        self, channel_id: int, before_id: int | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        """오래된 것부터 순서대로, before_id보다 앞선 최신 limit개."""
        limit = max(1, min(limit, MAX_PAGE_SIZE))
        if before_id is None:
            rows = await self.db.fetch_all(
                "SELECT * FROM message WHERE channel_id = ? ORDER BY id DESC LIMIT ?",
                (channel_id, limit),
            )
        else:
            rows = await self.db.fetch_all(
                "SELECT * FROM message WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                (channel_id, before_id, limit),
            )
        return [dict(row) for row in reversed(rows)]

    async def get(self, message_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one("SELECT * FROM message WHERE id = ?", (message_id,))
        return dict(row) if row else None

    async def latest_id(self, channel_id: int) -> int | None:
        row = await self.db.fetch_one(
            "SELECT MAX(id) AS last_id FROM message WHERE channel_id = ?", (channel_id,)
        )
        return row["last_id"] if row and row["last_id"] is not None else None

    async def channel_ids(self) -> list[int]:
        """메시지를 받아 둔 채널(재시작 때 이어 받을 대상)."""
        rows = await self.db.fetch_all("SELECT DISTINCT channel_id FROM message")
        return [int(row[0]) for row in rows]
