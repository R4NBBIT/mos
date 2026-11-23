"""설정(화면명세서 SCR-10). 정해진 키·값만 받는다.

설정 화면의 항목은 모두 기기(브라우저, 설치한 앱)마다 따로 저장한다(device_setting).
아직 정하지 않은 기기는 계정 설정(예전 값)을 쓴다.
고친 문서 제목, 목록 순서, 숨긴 목록, 처음 사용 안내를 봤는지는 계정 전체(account_setting)에 둔다.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

from mos.db.database import Database

# 기본, 다크, 스프레드시트, 메모장, 노션, Word
THEMES = ("moon", "night", "sheet", "memo", "note", "word")
MAX_TAB_TITLE = 40
# 위장 화면(SCR-12) 템플릿: 주간 업무 보고 · 매출 요약 · 프로젝트 일정표 · 예산 집행 현황 · 내 파일
# 내 파일 내용은 서버로 보내지 않는다(브라우저에만). 여기에는 '내 파일을 쓴다'는 선택만 남는다
# 예시: weekly(스프레드시트), memo(메모장), note(노션), word(Word)
# 내 파일: myfile(스프레드시트), text(메모장), notefile(노션), wordfile(Word)
# 그 밖에: image(내 화면 사진), url(다른 사이트).
# sales, schedule, budget은 예전 표 예시(그대로 받음)
BOSS_TEMPLATES = (
    "weekly",
    "memo",
    "note",
    "word",
    "myfile",
    "text",
    "notefile",
    "wordfile",
    "image",
    "url",
    "sales",
    "schedule",
    "budget",
    "todo",  # TODO(공개 전 기능). 허용 안 된 계정이 골라도 화면은 기본 표로 보인다
)
BOSS_FITS = ("cover", "contain")  # 사진: 화면에 꽉 채우기(가장자리 잘림) · 다 보이게
MAX_BOSS_URL = 300
# 반응: 그대로, 작게('+2'), 숨기기
# 스티커와 큰 이모지: 그대로, 작게(움직이는 이모지는 멈춤), 숨기기
REACTION_VIEWS = ("full", "compact", "hidden")
STICKER_VIEWS = ("full", "small", "hidden")
MEDIA_VIEWS = ("full", "small", "hidden")  # 사진과 동영상
# 화면에서 바로 고친 문서 제목(채널 ID → 제목, 'ID:sub' → 부제목).
# 계정에 저장해 다른 브라우저에서도 그대로
DOC_TITLE_KEY_RE = re.compile(r"[0-9]{15,21}(?::sub)?")
MAX_DOC_TITLE = 80
MAX_DOC_TITLES = 300
# 왼쪽 목록 순서(이 사이트에서만): groups(서버), pinned(고정한 채널), c:<서버 ID>(그 서버의 채널)
LIST_ORDER_KEY_RE = re.compile(r"groups|pinned|c:[0-9]{15,21}")
SNOWFLAKE_RE = re.compile(r"[0-9]{15,21}")
MAX_LIST_ORDERS = 200
MAX_LIST_ORDER_LEN = 500
# 목록에서 숨긴 서버와 채널(ID 목록, 디스코드에는 그대로)
MAX_HIDDEN = 500
# 숨긴 곳의 새 메시지: 세지(알리지) 않기, 나를 부른 것만, 숨기지 않은 곳과 같게.
# hidden_unread는 목록의 안 읽은 수(계정 전체), 알림은 기기마다(notify_prefs의 hidden).
# hidden_notify는 예전 키: 기기 알림 설정을 아직 안 정한 기기의 기본값으로만 쓴다
HIDDEN_NOTIFY = ("none", "mentions", "all")
# 자동 위장, 돌아올 때 잠그기, 알림, 알림에 내용 보이기, 처음 사용 안내를 봤는지,
# 작성자 프로필 사진, 음성 채널 보이기
BOOL_KEYS = (
    "boss_auto",
    "boss_relock",
    "boss_fullscreen",
    "notify",
    "notify_preview",
    "guide_done",
    "show_avatars",
    "voice_view",
)
# 알림 범위: 나를 부른 것만, 나를 부른 것 + 고정한 채널, 모든 새 메시지
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
    "show_avatars": True,
    "voice_view": True,
    "reactions_view": "full",
    "stickers_view": "full",
    "media_view": "full",
    "doc_titles": {},
    "list_order": {},
    "hidden": [],
    # 위장 화면 'TODO'에 보일 카테고리 id(이 기기, 비면 모두, 2026-11-23 사용자 요청)
    "boss_todo_categories": [],
    "hidden_notify": "mentions",
    "hidden_unread": "mentions",
}


# 계정 전체에 두는 키. notify, notify_scope, notify_preview, hidden_notify는 예전 키로
# 기기 알림 설정(notify_prefs)을 아직 안 정한 기기의 기본값으로만 쓴다
SHARED_KEYS = frozenset(
    {
        "doc_titles",
        "list_order",
        "hidden",
        "guide_done",
        "notify",
        "notify_scope",
        "notify_preview",
        "hidden_notify",
    }
)
DEVICE_KEYS = frozenset(DEFAULTS) - SHARED_KEYS


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


def _clean_list_order(value: Any) -> dict[str, list[str] | None]:
    """목록 순서: ID 목록(겹치면 처음 것만). 비었거나 None이면 그 순서를 지운다(디스코드 순서로)."""
    if not isinstance(value, dict) or len(value) > MAX_LIST_ORDERS:
        raise SettingsError("bad_list_order")
    result: dict[str, list[str] | None] = {}
    for key, ids in value.items():
        if not isinstance(key, str) or not LIST_ORDER_KEY_RE.fullmatch(key):
            raise SettingsError("bad_list_order")
        if ids is None:
            result[key] = None
            continue
        if not isinstance(ids, list) or len(ids) > MAX_LIST_ORDER_LEN:
            raise SettingsError("bad_list_order")
        seen: list[str] = []
        for item in ids:
            if not isinstance(item, str) or not SNOWFLAKE_RE.fullmatch(item):
                raise SettingsError("bad_list_order")
            if item not in seen:
                seen.append(item)
        result[key] = seen or None
    return result


def _clean_hidden(value: Any) -> list[str]:
    """숨긴 서버, 채널: 통째로 바꾼다(겹치면 처음 것만)."""
    if not isinstance(value, list) or len(value) > MAX_HIDDEN:
        raise SettingsError("bad_hidden")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not SNOWFLAKE_RE.fullmatch(item):
            raise SettingsError("bad_hidden")
        if item not in result:
            result.append(item)
    return result


MAX_BOSS_TODO_CATEGORIES = 100
TODO_ID_RE = re.compile(r"[0-9]{1,18}")


def _clean_boss_todo_categories(value: Any) -> list[str]:
    """위장 화면 TODO에 보일 카테고리: 통째로 바꾼다(겹치면 처음 것만, 비면 모두)."""
    if not isinstance(value, list) or len(value) > MAX_BOSS_TODO_CATEGORIES:
        raise SettingsError("bad_boss_todo_categories")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not TODO_ID_RE.fullmatch(item):
            raise SettingsError("bad_boss_todo_categories")
        if item not in result:
            result.append(item)
    return result


def _clean_doc_titles(value: Any) -> dict[str, str | None]:
    """문서 제목 바꾸기: 값이 비었거나 None이면 그 제목을 지운다(원래 이름으로)."""
    if not isinstance(value, dict) or len(value) > MAX_DOC_TITLES:
        raise SettingsError("bad_doc_titles")
    result: dict[str, str | None] = {}
    for key, title in value.items():
        if not isinstance(key, str) or not DOC_TITLE_KEY_RE.fullmatch(key):
            raise SettingsError("bad_doc_titles")
        if title is None or (isinstance(title, str) and not title.strip()):
            result[key] = None
        elif isinstance(title, str) and len(title.strip()) <= MAX_DOC_TITLE:
            result[key] = " ".join(title.split())
        else:
            raise SettingsError("bad_doc_titles")
    return result


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
        elif key == "reactions_view":
            if value not in REACTION_VIEWS:
                raise SettingsError("bad_reactions_view")
            result[key] = value
        elif key == "stickers_view":
            if value not in STICKER_VIEWS:
                raise SettingsError("bad_stickers_view")
            result[key] = value
        elif key == "media_view":
            if value not in MEDIA_VIEWS:
                raise SettingsError("bad_media_view")
            result[key] = value
        elif key == "doc_titles":
            result[key] = _clean_doc_titles(value)
        elif key == "list_order":
            result[key] = _clean_list_order(value)
        elif key == "hidden":
            result[key] = _clean_hidden(value)
        elif key == "boss_todo_categories":
            result[key] = _clean_boss_todo_categories(value)
        elif key in ("hidden_notify", "hidden_unread"):
            if value not in HIDDEN_NOTIFY:
                raise SettingsError(f"bad_{key}")
            result[key] = value
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
        # (기기, 계정) → 자동 잠금 초(요청마다 DB를 읽지 않게)
        self._lock_cache: dict[tuple[int, int], int] = {}

    async def lock_seconds(self, account_id: int, device_id: int) -> int:
        key = (device_id, account_id)
        cached = self._lock_cache.get(key)
        if cached is None:
            cached = int((await self.get(account_id, device_id))["lock_minutes"]) * 60
            if len(self._lock_cache) > 5000:
                self._lock_cache.clear()
            self._lock_cache[key] = cached
        return cached

    async def _account_stored(self, account_id: int) -> dict[str, Any]:
        row = await self.db.fetch_one(
            "SELECT settings_json FROM account_setting WHERE account_id = ?", (account_id,)
        )
        return json.loads(row[0]) if row else {}

    async def _device_stored(self, account_id: int, device_id: int) -> dict[str, Any]:
        row = await self.db.fetch_one(
            "SELECT settings_json FROM device_setting WHERE device_id = ? AND account_id = ?",
            (device_id, account_id),
        )
        return json.loads(row[0]) if row else {}

    async def get(self, account_id: int, device_id: int | None = None) -> dict[str, Any]:
        """계정 설정 위에 이 기기 설정을 덮어 쓴 값(device_id가 없으면 계정 설정만)."""
        stored = await self._account_stored(account_id)
        merged = dict(DEFAULTS)
        for key, value in stored.items():
            if key not in DEFAULTS:
                continue
            try:
                merged.update(clean({key: value}))
            except SettingsError:
                pass  # 예전 값이 이상하면 그 항목만 기본값으로
        if "hidden_unread" not in stored:
            merged["hidden_unread"] = merged["hidden_notify"]  # 둘로 나누기 전에 고른 값 그대로
        if device_id is not None:
            for key, value in (await self._device_stored(account_id, device_id)).items():
                if key not in DEVICE_KEYS:
                    continue
                try:
                    merged.update(clean({key: value}))
                except SettingsError:
                    pass
        return merged

    async def update(
        self, account_id: int, update: dict[str, Any], device_id: int | None = None
    ) -> dict[str, Any]:
        changes = clean(update)
        device_changes = (
            {key: value for key, value in changes.items() if key in DEVICE_KEYS}
            if device_id is not None
            else {}
        )
        shared_changes = {key: value for key, value in changes.items() if key not in device_changes}
        now = int(self.clock())
        if shared_changes:
            current = await self.get(account_id)
            titles = shared_changes.pop("doc_titles", None)
            orders = shared_changes.pop("list_order", None)
            current.update(shared_changes)
            if orders is not None:
                # 보낸 목록만 바꾼다(다른 서버 순서는 그대로)
                merged_orders = {**current["list_order"], **orders}
                merged_orders = {key: ids for key, ids in merged_orders.items() if ids}
                if len(merged_orders) > MAX_LIST_ORDERS:
                    raise SettingsError("too_many_list_orders")
                current["list_order"] = merged_orders
            if titles is not None:
                # 보낸 것만 합친다(다른 채널 제목은 그대로)
                merged = {**current["doc_titles"], **titles}
                merged = {key: title for key, title in merged.items() if title}
                if len(merged) > MAX_DOC_TITLES:
                    raise SettingsError("too_many_doc_titles")
                current["doc_titles"] = merged
            async with self.db.writing() as conn:
                await conn.execute(
                    "INSERT INTO account_setting (account_id, settings_json, updated_at)"
                    " VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET"
                    " settings_json = excluded.settings_json, updated_at = excluded.updated_at",
                    (account_id, json.dumps(current, ensure_ascii=False), now),
                )
            if "lock_minutes" in shared_changes:
                self._lock_cache = {k: v for k, v in self._lock_cache.items() if k[1] != account_id}
        if device_changes and device_id is not None:
            stored = await self._device_stored(account_id, device_id)
            stored = {key: value for key, value in stored.items() if key in DEVICE_KEYS}
            stored.update(device_changes)
            async with self.db.writing() as conn:
                await conn.execute(
                    "INSERT INTO device_setting (device_id, account_id, settings_json, updated_at)"
                    " VALUES (?, ?, ?, ?) ON CONFLICT(device_id, account_id) DO UPDATE SET"
                    " settings_json = excluded.settings_json, updated_at = excluded.updated_at",
                    (device_id, account_id, json.dumps(stored, ensure_ascii=False), now),
                )
            self._lock_cache.pop((device_id, account_id), None)
        return await self.get(account_id, device_id)

    async def forget_device(self, device_id: int, account_id: int | None = None) -> None:
        """기기에서 계정을 빼면 그 기기 설정도 지운다."""
        async with self.db.writing() as conn:
            if account_id is None:
                await conn.execute("DELETE FROM device_setting WHERE device_id = ?", (device_id,))
            else:
                await conn.execute(
                    "DELETE FROM device_setting WHERE device_id = ? AND account_id = ?",
                    (device_id, account_id),
                )
        self._lock_cache = {k: v for k, v in self._lock_cache.items() if k[0] != device_id}
