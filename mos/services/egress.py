"""월 송신량 보호(구글 무료 등급 1GB). 기술 설계서 9장.

나가는 양 = API 응답 크기 + 디스코드로 올린 첨부 크기.
(Caddy 압축 전 기준이라 실제보다 조금 크게 센다)
80%가 되면 운영자에게 한 번 알리고, 95%가 되면 첨부 보내기만 막는다(글은 계속).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable

from mos.db.lists_repo import ListsRepo

log = logging.getLogger(__name__)

FLUSH_INTERVAL_SEC = 60
FLUSH_BYTES = 256 * 1024
ALERT_RATIO = 0.80
BLOCK_RATIO = 0.95

Notify = Callable[[str], Awaitable[None]]


def month_key(now: float) -> str:
    return time.strftime("%Y-%m", time.gmtime(now))


class EgressMeter:
    def __init__(
        self,
        repo: ListsRepo,
        limit_bytes: int,
        notify: Notify | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.repo = repo
        self.limit_bytes = limit_bytes
        self.notify = notify
        self.clock = clock
        self._pending = 0
        self._last_flush = clock()

    async def record(self, size: int, force: bool = False) -> None:
        """API 응답처럼 잦은 것은 모았다가 가끔 쓰고, 첨부는 바로 쓴다(force)."""
        if size > 0:
            self._pending += size
        now = self.clock()
        due = now - self._last_flush >= FLUSH_INTERVAL_SEC or self._pending >= FLUSH_BYTES
        if self._pending <= 0 or not (force or due):
            return
        size, self._pending, self._last_flush = self._pending, 0, now
        month = month_key(now)
        total, alerted = await self.repo.add_egress(month, size)
        if not alerted and total >= self.limit_bytes * ALERT_RATIO:
            await self.repo.mark_egress_alerted(month)
            percent = total * 100 // self.limit_bytes
            message = (
                f"[ㅁㅇㅅ] 이번 달 송신량이 무료 한도의 {percent}%예요"
                f" ({total / 1024 / 1024:.0f}MB / {self.limit_bytes / 1024 / 1024:.0f}MB)."
                f" {int(BLOCK_RATIO * 100)}%가 되면 첨부 보내기를 막아요."
            )
            log.warning("송신량 %d%% 도달", percent)
            if self.notify is not None:
                try:
                    await self.notify(message)
                except Exception:
                    log.exception("송신량 알림 실패")

    async def attachments_allowed(self) -> bool:
        await self.record(0, force=True)
        total = await self.repo.egress(month_key(self.clock()))
        return total < self.limit_bytes * BLOCK_RATIO

    async def usage(self) -> tuple[int, int]:
        return await self.repo.egress(month_key(self.clock())), self.limit_bytes
