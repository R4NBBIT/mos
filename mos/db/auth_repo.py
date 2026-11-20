"""계정·기기 테이블 SQL. 항상 매개변수 바인딩."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from mos.db.database import Database


class AuthRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------ 기기

    async def create_device(self, token_hash: str, now: int) -> int:
        async with self.db.writing() as conn:
            cursor = await conn.execute(
                "INSERT INTO device (token_hash, created_at, last_seen_at) VALUES (?, ?, ?)",
                (token_hash, now, now),
            )
            return int(cursor.lastrowid or 0)

    async def device_by_token_hash(self, token_hash: str) -> dict[str, Any] | None:
        row = await self.db.fetch_one("SELECT * FROM device WHERE token_hash = ?", (token_hash,))
        return dict(row) if row else None

    async def rotate_device_token(self, device_id: int, token_hash: str, now: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "UPDATE device SET token_hash = ?, last_seen_at = ? WHERE id = ?",
                (token_hash, now, device_id),
            )

    async def touch_device(self, device_id: int, now: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute("UPDATE device SET last_seen_at = ? WHERE id = ?", (now, device_id))

    async def set_active_account(self, device_id: int, account_id: int | None) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "UPDATE device SET active_account_id = ? WHERE id = ?", (account_id, device_id)
            )

    async def delete_device(self, device_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM device WHERE id = ?", (device_id,))

    async def delete_stale(self, now: int, empty_device_before: int) -> None:
        """만료된 state, 계정 없이 오래 남은 기기를 지운다."""
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM oauth_state WHERE expires_at <= ?", (now,))
            await conn.execute(
                "DELETE FROM device WHERE last_seen_at < ? AND NOT EXISTS "
                "(SELECT 1 FROM device_account WHERE device_account.device_id = device.id)",
                (empty_device_before,),
            )

    # ------------------------------------------------------------ OAuth state

    async def save_state(
        self, state_hash: str, device_id: int, code_verifier: str, purpose: str, expires_at: int
    ) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO oauth_state"
                " (state_hash, device_id, code_verifier, purpose, expires_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (state_hash, device_id, code_verifier, purpose, expires_at),
            )

    async def take_state(self, state_hash: str) -> dict[str, Any] | None:
        """찾으면 바로 지운다(한 번만 쓸 수 있게)."""
        async with self.db.writing() as conn:
            async with conn.execute(
                "SELECT * FROM oauth_state WHERE state_hash = ?", (state_hash,)
            ) as cursor:
                row = await cursor.fetchone()
            if row is None:
                return None
            await conn.execute("DELETE FROM oauth_state WHERE state_hash = ?", (state_hash,))
            return dict(row)

    # ------------------------------------------------------------ 계정

    async def account(self, account_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one("SELECT * FROM account WHERE id = ?", (account_id,))
        return dict(row) if row else None

    async def upsert_account(
        self,
        discord_user_id: int,
        name: str,
        avatar_url: str | None,
        premium_type: int,
        access_enc: str,
        refresh_enc: str | None,
        token_expires_at: int,
        guild_ids: Iterable[int],
        now: int,
    ) -> int:
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO account (discord_user_id, name, avatar_url, premium_type,"
                " status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)"
                " ON CONFLICT(discord_user_id) DO UPDATE SET name = excluded.name,"
                " avatar_url = excluded.avatar_url, premium_type = excluded.premium_type,"
                " status = 'active', updated_at = excluded.updated_at",
                (discord_user_id, name, avatar_url, premium_type, now, now),
            )
            async with conn.execute(
                "SELECT id FROM account WHERE discord_user_id = ?", (discord_user_id,)
            ) as cursor:
                row = await cursor.fetchone()
            account_id = int(row[0])
            await conn.execute(
                "UPDATE account SET oauth_access_enc = ?, oauth_refresh_enc = ?,"
                " token_expires_at = ? WHERE id = ?",
                (access_enc, refresh_enc, token_expires_at, account_id),
            )
            await conn.execute("DELETE FROM account_guild WHERE account_id = ?", (account_id,))
            await conn.executemany(
                "INSERT INTO account_guild (account_id, guild_id) VALUES (?, ?)",
                [(account_id, guild_id) for guild_id in sorted(set(guild_ids))],
            )
            return account_id

    async def set_password_hash(self, account_id: int, password_hash: str, now: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "UPDATE account SET password_hash = ?, updated_at = ? WHERE id = ?",
                (password_hash, now, account_id),
            )
            await conn.execute("DELETE FROM login_attempt WHERE account_id = ?", (account_id,))

    async def account_in_guild(self, account_id: int, guild_id: int) -> bool:
        row = await self.db.fetch_one(
            "SELECT 1 FROM account_guild WHERE account_id = ? AND guild_id = ?",
            (account_id, guild_id),
        )
        return row is not None

    # ------------------------------------------------------------ 기기에 저장된 계정

    async def device_accounts(self, device_id: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT da.*, a.name, a.avatar_url, a.status, a.discord_user_id,"
            " a.password_hash IS NOT NULL AS password_set"
            " FROM device_account da JOIN account a ON a.id = da.account_id"
            " WHERE da.device_id = ? ORDER BY da.added_at, da.account_id",
            (device_id,),
        )
        return [dict(row) for row in rows]

    async def device_account(self, device_id: int, account_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            "SELECT * FROM device_account WHERE device_id = ? AND account_id = ?",
            (device_id, account_id),
        )
        return dict(row) if row else None

    async def add_device_account(self, device_id: int, account_id: int, now: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO device_account (device_id, account_id, added_at) VALUES (?, ?, ?)"
                " ON CONFLICT(device_id, account_id) DO NOTHING",
                (device_id, account_id, now),
            )

    async def update_device_account(self, device_id: int, account_id: int, **fields: Any) -> None:
        allowed = {"unlocked_until", "keep_until", "password_setup_until"}
        if not fields or not set(fields) <= allowed:
            raise ValueError("unknown device_account field")
        names = sorted(fields)
        assignments = ", ".join(f"{name} = ?" for name in names)  # 이름은 위 허용 목록에서만
        async with self.db.writing() as conn:
            await conn.execute(
                f"UPDATE device_account SET {assignments}"  # noqa: S608
                " WHERE device_id = ? AND account_id = ?",
                (*(fields[name] for name in names), device_id, account_id),
            )

    async def remove_device_account(self, device_id: int, account_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM device_account WHERE device_id = ? AND account_id = ?",
                (device_id, account_id),
            )

    # ------------------------------------------------------------ 비밀번호 실패 제한

    async def login_attempt(self, account_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            "SELECT * FROM login_attempt WHERE account_id = ?", (account_id,)
        )
        return dict(row) if row else None

    async def record_failure(self, account_id: int, max_failures: int, lock_until: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO login_attempt (account_id, fail_count, locked_until)"
                " VALUES (?, 1, NULL)"
                " ON CONFLICT(account_id) DO UPDATE SET fail_count = fail_count + 1",
                (account_id,),
            )
            await conn.execute(
                "UPDATE login_attempt SET locked_until = ?, fail_count = 0"
                " WHERE account_id = ? AND fail_count >= ?",
                (lock_until, account_id, max_failures),
            )

    async def clear_failures(self, account_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM login_attempt WHERE account_id = ?", (account_id,))
