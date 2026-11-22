"""할 일 알림(NOTI-01 시각 알림, NOTI-03 아침 요약). 서버가 1분마다 보낼 것을 고른다.

보낼 내용만 만들고, 실제로 보내기(웹 푸시)는 app이 한다. 보낸 표시는 DB에 남겨
서버가 다시 켜지거나 같은 분에 두 번 불려도 한 번만 보낸다.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from mos.db.todo_repo import TodoRepo
from mos.services.todo import TodoService, alert_prefs_from

log = logging.getLogger(__name__)

LATE_SEC = 180  # 서버가 잠깐 멈췄어도 3분 안이면 보낸다(그보다 늦으면 안 보냄)
MORNING_LATE_SEC = 30 * 60
KEEP_SEC = 3 * 86400
NEWS_KEEP_SEC = 30 * 86400
MORNING_TOP = 3
URL = "/#/todo"


def _title_line(item: dict[str, Any]) -> str:
    place = f" @{item['place']}" if item.get("place") else ""
    return f"{item['time']} {item['title']}{place}"


def _joined(lines: list[str]) -> str:
    if len(lines) == 1:
        return lines[0]
    return f"{lines[0]} 외 {len(lines) - 1}개"


@dataclass
class TodoAlert:
    account_id: int
    # 기기 알림(웹 푸시, 열린 탭)으로 보낼 내용. 없으면 None
    push: dict[str, Any] | None
    # 봇 DM으로 보낼 글(아침 요약을 DM으로 고른 경우). 없으면 None
    dm: str | None
    # 위장 화면일 때도 알림 창을 띄울지(할 일 알림 설정)
    boss: bool


class TodoAlerts:
    def __init__(
        self, todo: TodoService, repo: TodoRepo, clock: Callable[[], float] = time.time
    ) -> None:
        self.todo = todo
        self.repo = repo
        self.clock = clock
        self._last_cleanup = 0.0

    async def due(self) -> list[TodoAlert]:
        """지금 보낼 (계정, 알림 내용). 계정마다 하나로 합친다."""
        now = self.clock()
        if now - self._last_cleanup > 3600:
            self._last_cleanup = now
            await self.repo.forget_alerts_before(int(now - KEEP_SEC))
            await self.repo.forget_news_before(int(now - NEWS_KEEP_SEC))
        result: list[TodoAlert] = []
        for account_id, raw in await self.repo.pref_rows():
            try:
                prefs = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(prefs, dict):
                continue
            settings = alert_prefs_from(prefs)
            if settings["alert_lead"] is None and settings["morning"] is None:
                continue
            try:
                alert = await self._for_account(account_id, settings, now)
            except Exception:  # 한 계정의 문제로 다른 계정 알림이 멈추지 않게
                log.exception("할 일 알림 고르기 실패")
                continue
            if alert is not None:
                result.append(alert)
        return result

    async def _for_account(
        self, account_id: int, settings: dict[str, Any], now: float
    ) -> TodoAlert | None:
        zone = ZoneInfo(settings["tz"])
        local = datetime.fromtimestamp(now, zone)
        today = local.date()
        parts: list[dict[str, str]] = []
        dm: str | None = None

        lead = settings["alert_lead"]
        if lead is not None:
            lines: list[str] = []
            # 자정 직후 할 일을 전날 밤에 미리 알리는 경우까지(최대 60분)
            for day in (today, today + timedelta(days=1)):
                data = await self.todo.day(account_id, day.isoformat())
                for item in data["items"]:
                    if item["done"] or not item["time"]:
                        continue
                    at = _at(day, item["time"], zone) - timedelta(minutes=lead)
                    if not at <= local < at + timedelta(seconds=LATE_SEC):
                        continue
                    key = f"t:{item['id']}:{item['day']}:{item['time']}:{lead}"
                    if await self.repo.mark_alert(account_id, key, int(now)):
                        lines.append(_title_line(item))
            if lines:
                head = "할 일 시각이에요" if lead == 0 else f"{lead}분 뒤 할 일"
                parts.append({"title": head, "body": _joined(lines)})
                await self.repo.add_news(account_id, "time", head, _joined(lines), int(now))

        morning = settings["morning"]
        if morning is not None:
            at = _at(today, morning, zone)
            if at <= local < at + timedelta(seconds=MORNING_LATE_SEC):
                data = await self.todo.day(account_id, today.isoformat())
                left = [item for item in data["items"] if not item["done"]]
                key = f"m:{today.isoformat()}"
                if left and await self.repo.mark_alert(account_id, key, int(now)):
                    left.sort(key=lambda item: (item["time"] is None, item["time"] or ""))
                    names = [
                        f"{item['time']} {item['title']}" if item["time"] else item["title"]
                        for item in left[:MORNING_TOP]
                    ]
                    more = f" 외 {len(left) - MORNING_TOP}개" if len(left) > MORNING_TOP else ""
                    title = f"오늘 할 일 {len(left)}개"
                    body = ", ".join(names) + more
                    await self.repo.add_news(account_id, "morning", title, body, int(now))
                    via = settings["morning_via"]
                    if via in ("dm", "both"):
                        lines_dm = [f"- {name}" for name in names]
                        if more:
                            lines_dm.append(f"-{more}")
                        dm = "\n".join([f"좋은 아침이에요. {title}", *lines_dm])
                    if via in ("push", "both"):
                        parts.append({"title": title, "body": body})

        push: dict[str, Any] | None = None
        if len(parts) == 1:
            push = {"kind": "todo", **parts[0], "url": URL}
        elif parts:
            push = {
                "kind": "todo",
                "title": parts[0]["title"],
                "body": " · ".join(part["body"] for part in parts),
                "url": URL,
            }
        if push is None and dm is None:
            return None
        return TodoAlert(account_id, push, dm, settings["boss_alerts"])


def _at(day: date, hhmm: str, zone: ZoneInfo) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone)
