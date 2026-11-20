"""계정별 설정(화면명세서 SCR-10). 정해진 키·값만 받는다."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any

from mos.db.database import Database

THEMES = ("moon", "night", "sheet", "memo")  # 달빛(기본) · 밤하늘 · 스프레드시트 · 메모장
MAX_TAB_TITLE = 40
DEFAULTS: dict[str, Any] = {"theme": "moon", "tab_title": None}


class SettingsError(ValueError):
    pass


def clean(update: dict[str, Any]) -> dict[str, Any]:
    """받은 값 검사. 모르는 키는 거절한다."""
    result: dict[str, Any] = {}
    for key, value in update.items():
        if key == "theme":
            if value not in THEMES:
                raise SettingsError("bad_theme")
            result[key] = value
        elif key == "tab_title":
            if value is None or (isinstance(value, str) and not value.strip()):
                result[key] = None  # 비우면 테마 기본값
            elif isinstance(value, str) and len(value.strip()) <= MAX_TAB_TITLE:
                result[key] = " ".join(value.split())
            else:
                raise SettingsError("bad_tab_title")
        else:
            raise SettingsError("unknown_setting")
    return result


class SettingsStore:
    def __init__(self, db: Database, clock: Callable[[], float] = time.time) -> None:
        self.db = db
        self.clock = clock

    async def get(self, account_id: int) -> dict[str, Any]:
        row = await self.db.fetch_one(
            "SELECT settings_json FROM account_setting WHERE account_id = ?", (account_id,)
        )
        stored = json.loads(row[0]) if row else {}
        merged = dict(DEFAULTS)
        try:
            merged.update(clean({k: v for k, v in stored.items() if k in DEFAULTS}))
        except SettingsError:
            pass  # 예전 값이 이상하면 기본값으로
        return merged

    async def update(self, account_id: int, update: dict[str, Any]) -> dict[str, Any]:
        changes = clean(update)
        current = await self.get(account_id)
        current.update(changes)
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO account_setting (account_id, settings_json, updated_at)"
                " VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET"
                " settings_json = excluded.settings_json, updated_at = excluded.updated_at",
                (account_id, json.dumps(current, ensure_ascii=False), int(self.clock())),
            )
        return current
