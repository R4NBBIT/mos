"""계정별 설정(화면명세서 SCR-10). 정해진 키·값만 받는다."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

from mos.db.database import Database

THEMES = ("moon", "night", "sheet", "memo", "note")  # 기본, 다크, 스프레드시트, 메모장, 노트
MAX_TAB_TITLE = 40
# 위장 화면(SCR-12) 템플릿: 주간 업무 보고 · 매출 요약 · 프로젝트 일정표 · 예산 집행 현황 · 내 파일
# 내 파일 내용은 서버로 보내지 않는다(브라우저에만). 여기에는 '내 파일을 쓴다'는 선택만 남는다
BOSS_TEMPLATES = ("weekly", "sales", "schedule", "budget", "myfile", "image", "text", "url")
BOSS_FITS = ("cover", "contain")  # 사진: 화면에 꽉 채우기(가장자리 잘림) · 다 보이게
MAX_BOSS_URL = 300
# 자동 위장, 돌아올 때 잠그기, 알림, 알림에 내용 보이기, 처음 사용 안내를 봤는지
BOOL_KEYS = (
    "boss_auto",
    "boss_relock",
    "boss_fullscreen",
    "notify",
    "notify_preview",
    "guide_done",
)
# 알림 범위: 나를 부른 것만 · 나를 부른 것 + 고정한 채널의 새 메시지
NOTIFY_SCOPES = ("mentions", "pinned", "all")
# 자동 잠금(분). 너무 길면 자리를 비운 사이 위험해서 8시간까지만
LOCK_MINUTES = (5, 10, 15, 30, 60, 120, 240, 480)
# 보스키: 보조키 + 키 위치 이름(KeyboardEvent.code), '*2'면 빠르게 두 번.
# 예: Escape*2, Ctrl+Shift+KeyK
BOSS_KEY_RE = re.compile(r"(?:(?:Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z][A-Za-z0-9]{0,24}(?:\*2)?")
DEFAULTS: dict[str, Any] = {
    "theme": "moon",
    "tab_title": None,
    "boss_template": "weekly",
    "boss_auto": False,
    "boss_relock": False,
    "boss_key": "Escape*2",
    "boss_fit": "cover",
    "boss_fullscreen": False,
    "boss_url": None,
    "notify": True,
    "notify_scope": "pinned",
    "notify_preview": False,
    "guide_done": False,
    "lock_minutes": 30,
}


class SettingsError(ValueError):
    pass


def _clean_url(value: Any) -> str | None:
    """위장할 때 옮겨 갈 주소: https만, 주소창에 그대로 넣어도 되는 모양만."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not isinstance(value, str) or len(value) > MAX_BOSS_URL:
        raise SettingsError("bad_boss_url")
    url = value.strip()
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or any(ch.isspace() for ch in url):
        raise SettingsError("bad_boss_url")
    return url


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
        elif key == "boss_template":
            if value not in BOSS_TEMPLATES:
                raise SettingsError("bad_boss_template")
            result[key] = value
        elif key == "boss_fit":
            if value not in BOSS_FITS:
                raise SettingsError("bad_boss_fit")
            result[key] = value
        elif key == "boss_url":
            result[key] = _clean_url(value)
        elif key == "lock_minutes":
            if isinstance(value, bool) or value not in LOCK_MINUTES:
                raise SettingsError("bad_lock_minutes")
            result[key] = value
        elif key == "notify_scope":
            if value not in NOTIFY_SCOPES:
                raise SettingsError("bad_notify_scope")
            result[key] = value
        elif key == "boss_key":
            if not isinstance(value, str) or not BOSS_KEY_RE.fullmatch(value):
                raise SettingsError("bad_boss_key")
            result[key] = value
        elif key in BOOL_KEYS:
            if not isinstance(value, bool):
                raise SettingsError("bad_value")
            result[key] = value
        else:
            raise SettingsError("unknown_setting")
    return result


class SettingsStore:
    def __init__(self, db: Database, clock: Callable[[], float] = time.time) -> None:
        self.db = db
        self.clock = clock
        self._lock_cache: dict[int, int] = {}  # 계정 → 자동 잠금 초(요청마다 DB를 읽지 않게)

    async def lock_seconds(self, account_id: int) -> int:
        cached = self._lock_cache.get(account_id)
        if cached is None:
            cached = int((await self.get(account_id))["lock_minutes"]) * 60
            self._lock_cache[account_id] = cached
        return cached

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
        self._lock_cache[account_id] = int(current["lock_minutes"]) * 60
        return current
