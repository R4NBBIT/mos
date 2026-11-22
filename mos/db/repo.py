"""SQL은 이 파일에만 둔다. 항상 매개변수 바인딩."""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from mos.db.database import Database
from mos.services import reactions

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
    "kind",
    "stickers_json",
    "reactions_json",
    "reference_id",
    "flags",
    "created_at",
    "edited_at",
)
MAX_PAGE_SIZE = 100
# 나중에 생긴 열의 기본값(보통 메시지, 스티커 없음)
_LATE_DEFAULTS: dict[str, Any] = {"kind": 0, "stickers_json": "[]", "reactions_json": "[]"}

# 열 이름은 위의 고정 상수에서만 오고, 값은 모두 ? 바인딩이다
_insert_sql = (
    f"INSERT INTO message ({', '.join(MESSAGE_COLUMNS)}) "  # noqa: S608
    f"VALUES ({', '.join('?' for _ in MESSAGE_COLUMNS)}) "
    "ON CONFLICT(id) DO UPDATE SET "
    + ", ".join(
        # 고친 메시지 이벤트에는 반응이 안 실려 오므로, 빈 목록이면 있던 반응을 둔다
        "reactions_json=CASE WHEN excluded.reactions_json = '[]'"
        " THEN message.reactions_json ELSE excluded.reactions_json END"
        if column == "reactions_json"
        else f"{column}=excluded.{column}"
        for column in MESSAGE_COLUMNS
        if column != "id"
    )
)


# 웹에서 보낸 메시지면 보낸 사람(디스코드 사용자 ID)과 답장 대상을 함께 읽는다
_select_sql = (
    "SELECT m.*, ws.reply_to_id AS web_reply_to_id, a.discord_user_id AS web_sender_id"
    " FROM message m"
    " LEFT JOIN web_sent ws ON ws.message_id = m.id"
    " LEFT JOIN account a ON a.id = ws.account_id"
)


class MessageRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def upsert_many(self, rows: Iterable[dict[str, Any]]) -> int:
        # 나중에 생긴 열은 직접 만든 행(웹에서 보낸 메시지 등)에 없을 수 있어 기본값을 쓴다
        values = [
            tuple(
                row.get(col, _LATE_DEFAULTS[col]) if col in _LATE_DEFAULTS else row[col]
                for col in MESSAGE_COLUMNS
            )
            for row in rows
        ]
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
            await conn.executemany("DELETE FROM reaction_user WHERE message_id = ?", ids)
        return len(ids)

    async def purge_before(self, cutoff_id: int, batch: int = 2000) -> int:
        """cutoff_id(그 시각의 디스코드 ID)보다 오래된 메시지 복사본을 지운다.
        포럼 글의 첫 메시지(글 ID = 메시지 ID)는 글 카드·미리보기에 쓰여 남긴다.
        한 번에 조금씩 지워 다른 쓰기를 오래 막지 않는다."""
        total = 0
        while True:
            async with self.db.writing() as conn:
                cursor = await conn.execute(
                    "DELETE FROM message WHERE id IN (SELECT id FROM message"
                    " WHERE id < ? AND id != channel_id LIMIT ?)",
                    (cutoff_id, batch),
                )
                deleted = cursor.rowcount or 0
                if deleted < batch:
                    await conn.execute(
                        "DELETE FROM reaction_user WHERE message_id < ?"
                        " AND message_id NOT IN (SELECT id FROM message)",
                        (cutoff_id,),
                    )
            total += deleted
            if deleted < batch:
                return total

    async def list_page(
        self, channel_id: int, before_id: int | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        """오래된 것부터 순서대로, before_id보다 앞선 최신 limit개."""
        limit = max(1, min(limit, MAX_PAGE_SIZE))
        if before_id is None:
            rows = await self.db.fetch_all(
                _select_sql + " WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?",
                (channel_id, limit),
            )
        else:
            rows = await self.db.fetch_all(
                _select_sql + " WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?",
                (channel_id, before_id, limit),
            )
        return await self._with_reactions([dict(row) for row in reversed(rows)])

    async def get(self, message_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(_select_sql + " WHERE m.id = ?", (message_id,))
        if row is None:
            return None
        return (await self._with_reactions([dict(row)]))[0]

    # ------------------------------------------------------------ 반응

    async def _with_reactions(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """반응이 있는 메시지에만 누가 달았는지(reaction_users)를 붙인다."""
        ids = [int(row["id"]) for row in rows if row.get("reactions_json") not in (None, "[]")]
        users = await self.reaction_users(ids)
        for row in rows:
            row["reaction_users"] = users.get(int(row["id"]), [])
        return rows

    async def reaction_users(self, message_ids: list[int]) -> dict[int, list[tuple[str, int, str]]]:
        if not message_ids:
            return {}
        marks = ", ".join("?" for _ in message_ids)
        rows = await self.db.fetch_all(
            "SELECT message_id, emoji_key, user_id, via FROM reaction_user"  # noqa: S608
            f" WHERE message_id IN ({marks})",
            message_ids,
        )
        result: dict[int, list[tuple[str, int, str]]] = {}
        for row in rows:
            result.setdefault(int(row[0]), []).append((str(row[1]), int(row[2]), str(row[3])))
        return result

    async def change_reaction(
        self, message_id: int, emoji: dict[str, Any], delta: int, by_bot: bool
    ) -> bool:
        """디스코드 반응 수를 고친다. 저장된 메시지가 아니면 False."""
        async with self.db.writing() as conn:
            async with conn.execute(
                "SELECT reactions_json FROM message WHERE id = ?", (message_id,)
            ) as cursor:
                row = await cursor.fetchone()
            if row is None:
                return False
            await conn.execute(
                "UPDATE message SET reactions_json = ? WHERE id = ?",
                (reactions.adjust(row[0], emoji, delta, by_bot), message_id),
            )
        return True

    async def clear_reactions(self, message_id: int, key: str | None = None) -> None:
        """모두 지움(key 없음) 또는 이모지 하나 지움."""
        async with self.db.writing() as conn:
            if key is None:
                await conn.execute(
                    "UPDATE message SET reactions_json = '[]' WHERE id = ?", (message_id,)
                )
                await conn.execute("DELETE FROM reaction_user WHERE message_id = ?", (message_id,))
                return
            async with conn.execute(
                "SELECT reactions_json FROM message WHERE id = ?", (message_id,)
            ) as cursor:
                row = await cursor.fetchone()
            if row is not None:
                kept = [item for item in json.loads(row[0] or "[]") if item.get("key") != key]
                await conn.execute(
                    "UPDATE message SET reactions_json = ? WHERE id = ?",
                    (json.dumps(kept, ensure_ascii=False), message_id),
                )
            await conn.execute(
                "DELETE FROM reaction_user WHERE message_id = ? AND emoji_key = ?",
                (message_id, key),
            )

    async def set_reaction_user(
        self, message_id: int, key: str, user_id: int, via: str, present: bool
    ) -> None:
        async with self.db.writing() as conn:
            if present:
                await conn.execute(
                    "INSERT OR IGNORE INTO reaction_user (message_id, emoji_key, user_id, via)"
                    " VALUES (?, ?, ?, ?)",
                    (message_id, key, user_id, via),
                )
            else:
                await conn.execute(
                    "DELETE FROM reaction_user"
                    " WHERE message_id = ? AND emoji_key = ? AND user_id = ? AND via = ?",
                    (message_id, key, user_id, via),
                )

    async def latest_by_author(self, channel_id: int, author_id: int) -> int | None:
        """그 채널에서 그 사람(디스코드 앱으로 보낸 것)의 마지막 메시지 ID."""
        row = await self.db.fetch_one(
            "SELECT MAX(id) AS last_id FROM message WHERE channel_id = ? AND author_id = ?",
            (channel_id, author_id),
        )
        return row["last_id"] if row and row["last_id"] is not None else None

    async def latest_id(self, channel_id: int) -> int | None:
        row = await self.db.fetch_one(
            "SELECT MAX(id) AS last_id FROM message WHERE channel_id = ?", (channel_id,)
        )
        return row["last_id"] if row and row["last_id"] is not None else None

    async def channel_ids(self) -> list[int]:
        """메시지를 받아 둔 채널(재시작 때 이어 받을 대상)."""
        rows = await self.db.fetch_all("SELECT DISTINCT channel_id FROM message")
        return [int(row[0]) for row in rows]
