from __future__ import annotations

import asyncio
from pathlib import Path

from mos.db.database import Database, list_migrations
from mos.db.repo import MessageRepo
from mos.services import retention


def make_row(message_id: int, channel_id: int = 10, content: str = "hi") -> dict:
    return {
        "id": message_id,
        "guild_id": 1,
        "channel_id": channel_id,
        "author_id": 5,
        "author_name": "모카",
        "author_avatar": None,
        "author_is_bot": 0,
        "webhook_id": None,
        "content": content,
        "embeds_json": "[]",
        "attachments_json": "[]",
        "components_json": "[]",
        "mentions_json": "{}",
        "reference_id": None,
        "flags": 0,
        "created_at": "2026-11-20T00:00:00+00:00",
        "edited_at": None,
    }


def test_migrations_are_numbered() -> None:
    migrations = list_migrations()
    assert migrations[0][1] == "0001_message.sql"


def test_migrate_twice_is_safe(tmp_path: Path) -> None:
    async def scenario() -> list[int]:
        for _ in range(2):
            db = Database(tmp_path / "a.db")
            await db.open()
            rows = await db.fetch_all("SELECT version FROM schema_migration")
            await db.close()
        return [row[0] for row in rows]

    assert asyncio.run(scenario()) == [number for number, _name, _sql in list_migrations()]


def test_repo_upsert_page_delete(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "b.db")
        await db.open()
        repo = MessageRepo(db)
        await repo.upsert_many([make_row(i) for i in range(1, 8)])
        await repo.upsert(make_row(99, channel_id=11))
        await repo.upsert(make_row(3, content="고침"))

        latest = await repo.list_page(10, limit=3)
        assert [row["id"] for row in latest] == [5, 6, 7]
        older = await repo.list_page(10, before_id=5, limit=3)
        assert [row["id"] for row in older] == [2, 3, 4]
        assert (await repo.get(3))["content"] == "고침"
        assert await repo.latest_id(10) == 7
        assert await repo.latest_id(12) is None

        await repo.delete_many([6, 7])
        assert await repo.latest_id(10) == 5
        assert await db.can_write() is True
        await db.close()
        assert await db.can_write() is False

    asyncio.run(scenario())


def test_page_limit_is_clamped(tmp_path: Path) -> None:
    async def scenario() -> int:
        db = Database(tmp_path / "c.db")
        await db.open()
        repo = MessageRepo(db)
        await repo.upsert_many([make_row(i) for i in range(1, 150)])
        rows = await repo.list_page(10, limit=10_000)
        await db.close()
        return len(rows)

    assert asyncio.run(scenario()) == 100


def test_retention_purges_old_copies_but_keeps_post_starters(tmp_path: Path) -> None:
    now = 1_800_000_000.0  # 2027-01-15
    old = retention.cutoff_snowflake(now, days=91)  # 91일 전 메시지 ID
    fresh = retention.cutoff_snowflake(now, days=10)

    async def scenario() -> set[int]:
        db = Database(tmp_path / "r.db")
        await db.open()
        repo = MessageRepo(db)
        rows = [make_row(old + i, channel_id=10) for i in range(5)]
        rows.append(make_row(fresh, channel_id=10))
        starter = make_row(old + 100, channel_id=old + 100)  # 포럼 글 첫 메시지(ID = 글 ID)
        rows.append(starter)
        await repo.upsert_many(rows)
        deleted = await repo.purge_before(retention.cutoff_snowflake(now), batch=2)
        assert deleted == 5
        left = await db.fetch_all("SELECT id FROM message")
        await db.close()
        return {int(row[0]) for row in left}

    assert asyncio.run(scenario()) == {fresh, old + 100}
    # 디스코드 ID의 시각 부분이 맞는지(90일 전 ≈ 기준 시각)
    millis = (retention.cutoff_snowflake(now) >> 22) + retention.DISCORD_EPOCH_MS
    assert abs(millis / 1000 - (now - 90 * 24 * 3600)) < 1
