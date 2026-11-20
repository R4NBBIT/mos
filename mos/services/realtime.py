"""WebSocket 접속자에게 실시간 이벤트를 보낸다."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

log = logging.getLogger(__name__)
SEND_TIMEOUT_SEC = 5


class JsonSocket(Protocol):
    async def send_json(self, data: Any) -> None: ...


class RealtimeHub:
    def __init__(self) -> None:
        self._sockets: set[JsonSocket] = set()

    @property
    def count(self) -> int:
        return len(self._sockets)

    def add(self, socket: JsonSocket) -> None:
        self._sockets.add(socket)

    def remove(self, socket: JsonSocket) -> None:
        self._sockets.discard(socket)

    async def broadcast(self, event_type: str, data: dict[str, Any]) -> None:
        if not self._sockets:
            return
        payload = {"type": event_type, "data": data}
        sockets = list(self._sockets)
        results = await asyncio.gather(
            *(asyncio.wait_for(socket.send_json(payload), SEND_TIMEOUT_SEC) for socket in sockets),
            return_exceptions=True,
        )
        for socket, result in zip(sockets, results, strict=True):
            if isinstance(result, Exception):
                # 느리거나 끊긴 접속은 빼고, 다시 붙으면 처음부터 받아 간다
                self.remove(socket)
                log.info("실시간 전송 실패로 접속 제거: %s", type(result).__name__)
