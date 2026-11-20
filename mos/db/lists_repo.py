"""고정·안 읽음·월 송신량 SQL. 항상 매개변수 바인딩(IN 목록도 ? 자리표시자)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from mos.db.database import Database


def _marks(count: int) -> str:
    return ", ".join("?" for _ in range(count))


class ListsRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------ 고정

    async def pins(self, account_id: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT kind, target_id, position FROM pin WHERE account_id = ?"
            " ORDER BY kind, position",
            (account_id,),
        )
        return [dict(row) for row in rows]

    async def add_pin(self, account_id: int, kind: str, target_id: int, limit: int) -> bool:
        """이미 있으면 True, 한도를 넘으면 False."""
        async with self.db.writing() as conn:
            async with conn.execute(
                "SELECT COUNT(*), COALESCE(MAX(position), 0),"
                " SUM(CASE WHEN target_id = ? THEN 1 ELSE 0 END)"
                " FROM pin WHERE account_id = ? AND kind = ?",
                (target_id, account_id, kind),
            ) as cursor:
                count, last, existing = await cursor.fetchone()
            if existing:
                return True
            if count >= limit:
                return False
            await conn.execute(
                "INSERT INTO pin (account_id, kind, target_id, position) VALUES (?, ?, ?, ?)",
                (account_id, kind, target_id, last + 1),
            )
            return True

    async def remove_pin(self, account_id: int, kind: str, target_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM pin WHERE account_id = ? AND kind = ? AND target_id = ?",
                (account_id, kind, target_id),
            )

    # ------------------------------------------------------------ 안 읽음

    async def mark_read(self, account_id: int, channel_id: int, last_id: int) -> None:
        """뒤로 가지 않는다(다른 탭이 더 최근까지 읽었으면 그대로)."""
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO read_state (account_id, channel_id, last_read_id) VALUES (?, ?, ?)"
                " ON CONFLICT(account_id, channel_id) DO UPDATE SET"
                " last_read_id = MAX(last_read_id, excluded.last_read_id)",
                (account_id, channel_id, last_id),
            )

    async def unread(
        self, account_id: int, user_id: int, channel_ids: Sequence[int]
    ) -> dict[int, tuple[int, int]]:
        """채널 → (안 읽은 수, 나를 부른 수). 내가 쓴 메시지(디스코드·웹)는 빼고 센다."""
        if not channel_ids:
            return {}
        ids = list(channel_ids)
        sql = (
            "SELECT m.channel_id, COUNT(*),"  # noqa: S608  (자리표시자 개수만 만든다)
            " SUM(CASE WHEN m.mentions_json LIKE ? THEN 1 ELSE 0 END)"
            " FROM message m"
            " JOIN read_state r ON r.account_id = ? AND r.channel_id = m.channel_id"
            " LEFT JOIN web_sent ws ON ws.message_id = m.id"
            f" WHERE m.channel_id IN ({_marks(len(ids))}) AND m.id > r.last_read_id"
            " AND m.author_id != ? AND (ws.account_id IS NULL OR ws.account_id != ?)"
            " GROUP BY m.channel_id"
        )
        params = [f'%"{user_id}"%', account_id, *ids, user_id, account_id]
        rows = await self.db.fetch_all(sql, params)
        return {int(row[0]): (int(row[1]), int(row[2] or 0)) for row in rows}

    # ------------------------------------------------------------ 월 송신량

    async def add_egress(self, month: str, size: int) -> tuple[int, bool]:
        """(이번 달 합계, 80% 알림을 이미 보냈는지)"""
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO egress_month (month, bytes_out) VALUES (?, ?)"
                " ON CONFLICT(month) DO UPDATE SET bytes_out = bytes_out + excluded.bytes_out",
                (month, size),
            )
            async with conn.execute(
                "SELECT bytes_out, alerted_80 FROM egress_month WHERE month = ?", (month,)
            ) as cursor:
                total, alerted = await cursor.fetchone()
        return int(total), bool(alerted)

    async def egress(self, month: str) -> int:
        row = await self.db.fetch_one(
            "SELECT bytes_out FROM egress_month WHERE month = ?", (month,)
        )
        return int(row[0]) if row else 0

    async def mark_egress_alerted(self, month: str) -> None:
        async with self.db.writing() as conn:
            await conn.execute("UPDATE egress_month SET alerted_80 = 1 WHERE month = ?", (month,))
