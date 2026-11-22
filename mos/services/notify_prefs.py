"""기기(브라우저)별 알림 설정.

알림 받기, 알려 줄 메시지, 숨긴 곳 알림, 내용 보이기, 위장 중 알림은 기기마다 따로 정한다.
아직 정하지 않은 기기는 예전 계정 설정 값
(notify, notify_scope, notify_preview, hidden_notify)을 쓴다.
"""

from __future__ import annotations

import json
from typing import Any

from mos.db.database import Database
from mos.services.settings import HIDDEN_NOTIFY, NOTIFY_SCOPES, SettingsStore


class NotifyPrefsError(ValueError):
    pass


def clean(update: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in update.items():
        if key in ("notify", "preview", "boss", "todo"):
            if not isinstance(value, bool):
                raise NotifyPrefsError("bad_value")
        elif key == "scope":
            if value not in NOTIFY_SCOPES:
                raise NotifyPrefsError("bad_scope")
        elif key == "hidden":
            if value not in HIDDEN_NOTIFY:
                raise NotifyPrefsError("bad_hidden")
        else:
            raise NotifyPrefsError("unknown_setting")
        result[key] = value
    return result


class NotifyPrefs:
    def __init__(self, db: Database, settings: SettingsStore) -> None:
        self.db = db
        self.settings = settings
        self._cache: dict[tuple[int, int], dict[str, Any]] = {}

    async def _defaults(self, account_id: int) -> dict[str, Any]:
        prefs = await self.settings.get(account_id)
        return {
            "notify": prefs["notify"],
            "scope": prefs["notify_scope"],
            "preview": prefs["notify_preview"],
            "hidden": prefs["hidden_notify"],
            "boss": False,  # 위장 화면일 때도 알림(기본은 받지 않음)
            "todo": True,  # TODO 알림(채팅 알림과 따로, 2026-11-22 사용자 요청)
        }

    async def get(self, device_id: int, account_id: int) -> dict[str, Any]:
        key = (device_id, account_id)
        cached = self._cache.get(key)
        if cached is not None:
            return dict(cached)
        merged = await self._defaults(account_id)
        row = await self.db.fetch_one(
            "SELECT prefs_json FROM device_notify WHERE device_id = ? AND account_id = ?",
            (device_id, account_id),
        )
        if row is not None:
            for name, value in json.loads(row[0]).items():
                try:
                    merged.update(clean({name: value}))
                except NotifyPrefsError:
                    pass  # 예전 값이 이상하면 그 항목만 기본값
        if len(self._cache) > 5000:
            self._cache.clear()
        self._cache[key] = merged
        return dict(merged)

    async def update(
        self, device_id: int, account_id: int, update: dict[str, Any]
    ) -> dict[str, Any]:
        changes = clean(update)
        current = await self.get(device_id, account_id)
        current.update(changes)
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO device_notify (device_id, account_id, prefs_json) VALUES (?, ?, ?)"
                " ON CONFLICT(device_id, account_id) DO UPDATE"
                " SET prefs_json = excluded.prefs_json",
                (device_id, account_id, json.dumps(current)),
            )
        self._cache[(device_id, account_id)] = dict(current)
        return current

    async def forget(self, device_id: int, account_id: int | None = None) -> None:
        async with self.db.writing() as conn:
            if account_id is None:
                await conn.execute("DELETE FROM device_notify WHERE device_id = ?", (device_id,))
            else:
                await conn.execute(
                    "DELETE FROM device_notify WHERE device_id = ? AND account_id = ?",
                    (device_id, account_id),
                )
        self._cache = {k: v for k, v in self._cache.items() if k[0] != device_id}

    def account_changed(self, account_id: int) -> None:
        """계정 설정(기본값 바탕)이 바뀌면 그 계정 기억을 지운다."""
        self._cache = {k: v for k, v in self._cache.items() if k[1] != account_id}
