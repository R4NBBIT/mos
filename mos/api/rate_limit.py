"""메모리 요청 제한(고정 창). 프로세스 하나라 이걸로 충분하다."""

from __future__ import annotations

import time
from collections.abc import Callable

MAX_KEYS = 10_000


class RateLimiter:
    def __init__(
        self, limit: int, window_sec: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.limit = limit
        self.window_sec = window_sec
        self.clock = clock
        self._hits: dict[str, tuple[float, int]] = {}

    def allow(self, key: str) -> bool:
        now = self.clock()
        started, count = self._hits.get(key, (now, 0))
        if now - started >= self.window_sec:
            started, count = now, 0
        if count >= self.limit:
            return False
        if len(self._hits) >= MAX_KEYS and key not in self._hits:
            self._prune(now)
        self._hits[key] = (started, count + 1)
        return True

    def _prune(self, now: float) -> None:
        expired = [k for k, (start, _) in self._hits.items() if now - start >= self.window_sec]
        for key in expired:
            del self._hits[key]
        if len(self._hits) >= MAX_KEYS:  # 그래도 많으면 전부 비운다(공격 상황)
            self._hits.clear()
