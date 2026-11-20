"""SQLite 연결과 마이그레이션. 쓰기는 잠금 하나로 순서대로 처리한다."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import Any

import aiosqlite

log = logging.getLogger(__name__)

MIGRATION_PATTERN = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


def list_migrations() -> list[tuple[int, str, str]]:
    """(번호, 파일 이름, SQL) 목록을 번호 순서로."""
    folder = resources.files("mos.db.migrations")
    found: list[tuple[int, str, str]] = []
    for entry in folder.iterdir():
        match = MIGRATION_PATTERN.match(entry.name)
        if match:
            found.append((int(match.group(1)), entry.name, entry.read_text(encoding="utf-8")))
    found.sort()
    numbers = [number for number, _, _ in found]
    if numbers != list(range(1, len(numbers) + 1)):
        raise RuntimeError(f"마이그레이션 번호가 1부터 이어지지 않습니다: {numbers}")
    return found


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None
        self._write_lock: asyncio.Lock | None = None

    @property
    def is_open(self) -> bool:
        return self._conn is not None

    async def open(self) -> None:
        if self._conn is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(self.path)
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")
        await conn.execute("PRAGMA busy_timeout=5000")
        await conn.execute("PRAGMA synchronous=NORMAL")
        self._conn = conn
        self._write_lock = asyncio.Lock()
        await self._migrate()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None
            self._write_lock = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("DB가 열려 있지 않습니다")
        return self._conn

    async def _migrate(self) -> None:
        conn = self.conn
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migration ("
            "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        await conn.commit()
        async with conn.execute("SELECT version FROM schema_migration") as cursor:
            applied = {row[0] for row in await cursor.fetchall()}
        for number, name, sql in list_migrations():
            if number in applied:
                continue
            stamp = datetime.now(UTC).isoformat()
            # 한 마이그레이션 = 한 트랜잭션. 실패하면 통째로 되돌린다
            script = (
                "BEGIN;\n"
                f"{sql}\n"
                f"INSERT INTO schema_migration (version, name, applied_at) "
                f"VALUES ({number}, '{name}', '{stamp}');\n"
                "COMMIT;"
            )
            try:
                await conn.executescript(script)
            except Exception:
                await conn.rollback()
                raise
            log.info("DB 마이그레이션 적용: %s", name)

    # ------------------------------------------------------------ 실행 도우미

    @asynccontextmanager
    async def writing(self) -> AsyncIterator[aiosqlite.Connection]:
        """쓰기 구역. 끝나면 커밋, 오류면 되돌린다."""
        if self._write_lock is None:
            raise RuntimeError("DB가 열려 있지 않습니다")
        async with self._write_lock:
            try:
                yield self.conn
                await self.conn.commit()
            except Exception:
                await self.conn.rollback()
                raise

    async def fetch_all(self, sql: str, params: Iterable[Any] = ()) -> list[aiosqlite.Row]:
        async with self.conn.execute(sql, tuple(params)) as cursor:
            return list(await cursor.fetchall())

    async def fetch_one(self, sql: str, params: Iterable[Any] = ()) -> aiosqlite.Row | None:
        async with self.conn.execute(sql, tuple(params)) as cursor:
            return await cursor.fetchone()

    async def can_write(self) -> bool:
        """healthz용: 쓰기 잠금을 잡을 수 있는지(실제로 쓰지는 않음)."""
        if self._conn is None or self._write_lock is None:
            return False
        try:
            async with self._write_lock:
                await self.conn.execute("BEGIN IMMEDIATE")
                await self.conn.rollback()
            return True
        except Exception:  # 상태 확인용이라 어떤 오류든 False
            log.exception("DB 쓰기 확인 실패")
            return False
