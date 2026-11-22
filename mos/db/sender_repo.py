"""보내기(웹훅·웹에서 보낸 기록) SQL. 항상 매개변수 바인딩."""

from __future__ import annotations

from typing import Any

from mos.db.database import Database


class SenderRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def webhook(self, channel_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            "SELECT * FROM channel_webhook WHERE channel_id = ?", (channel_id,)
        )
        return dict(row) if row else None

    async def save_webhook(
        self, channel_id: int, webhook_id: int, token_enc: str, now: int
    ) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO channel_webhook"
                " (channel_id, webhook_id, webhook_token_enc, created_at)"
                " VALUES (?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET"
                " webhook_id = excluded.webhook_id,"
                " webhook_token_enc = excluded.webhook_token_enc,"
                " created_at = excluded.created_at",
                (channel_id, webhook_id, token_enc, now),
            )

    async def forget_webhook(self, channel_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM channel_webhook WHERE channel_id = ?", (channel_id,))

    async def sent(self, message_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            "SELECT ws.*, a.discord_user_id FROM web_sent ws"
            " JOIN account a ON a.id = ws.account_id WHERE ws.message_id = ?",
            (message_id,),
        )
        return dict(row) if row else None

    async def sent_by_key(self, account_id: int, key: str) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            "SELECT * FROM web_sent WHERE account_id = ? AND idempotency_key = ?",
            (account_id, key),
        )
        return dict(row) if row else None

    async def record_sent(
        self,
        message_id: int,
        account_id: int,
        channel_id: int,
        reply_to_id: int | None,
        key: str,
        now: int,
    ) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO web_sent (message_id, account_id, channel_id, reply_to_id,"
                " idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (message_id, account_id, channel_id, reply_to_id, key, now),
            )

    async def last_web_send(self, discord_user_id: int, channel_id: int) -> int | None:
        """그 사람이 이 사이트에서 그 채널에 마지막으로 보낸 때(유닉스 초)."""
        row = await self.db.fetch_one(
            "SELECT MAX(ws.created_at) AS last FROM web_sent ws"
            " JOIN account a ON a.id = ws.account_id"
            " WHERE ws.channel_id = ? AND a.discord_user_id = ?",
            (channel_id, discord_user_id),
        )
        return int(row["last"]) if row and row["last"] is not None else None

    async def forget_sent(self, message_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM web_sent WHERE message_id = ?", (message_id,))
