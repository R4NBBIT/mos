"""WebSocket 접속자에게 실시간 이벤트를 보낸다.

접속마다 '누가(디스코드 사용자) 어느 채널을 보고 있는지'를 기억하고,
그 채널 이벤트만, 보낼 때마다 권한을 다시 확인한 뒤 보낸다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

log = logging.getLogger(__name__)
SEND_TIMEOUT_SEC = 5

AccessCheck = Callable[[int, int], Awaitable[bool]]  # (사용자 ID, 채널 ID) → 볼 수 있나


class JsonSocket(Protocol):
    async def send_json(self, data: Any) -> None: ...


@dataclass
class Subscriber:
    user_id: int
    channel_id: int | None = None


async def _allow_nothing(_user_id: int, _channel_id: int) -> bool:
    return False


class RealtimeHub:
    def __init__(self) -> None:
        self._sockets: dict[JsonSocket, Subscriber] = {}
        self._access_check: AccessCheck = _allow_nothing

    def set_access_check(self, check: AccessCheck) -> None:
        self._access_check = check

    @property
    def count(self) -> int:
        return len(self._sockets)

    def add(self, socket: JsonSocket, user_id: int) -> None:
        self._sockets[socket] = Subscriber(user_id=user_id)

    def remove(self, socket: JsonSocket) -> None:
        self._sockets.pop(socket, None)

    def subscribe(self, socket: JsonSocket, channel_id: int | None) -> None:
        """권한 확인은 부르는 쪽(API)이 먼저 한다. 보낼 때 다시 확인한다."""
        subscriber = self._sockets.get(socket)
        if subscriber is not None:
            subscriber.channel_id = channel_id

    async def publish(self, channel_id: int, event_type: str, data: dict[str, Any]) -> None:
        targets = [
            (socket, subscriber)
            for socket, subscriber in list(self._sockets.items())
            if subscriber.channel_id == channel_id
        ]
        if not targets:
            return
        allowed = await asyncio.gather(
            *(self._access_check(subscriber.user_id, channel_id) for _, subscriber in targets),
            return_exceptions=True,
        )
        sockets = [socket for (socket, _), ok in zip(targets, allowed, strict=True) if ok is True]
        if not sockets:
            return
        payload = {"type": event_type, "data": data}
        results = await asyncio.gather(
            *(asyncio.wait_for(socket.send_json(payload), SEND_TIMEOUT_SEC) for socket in sockets),
            return_exceptions=True,
        )
        for socket, result in zip(sockets, results, strict=True):
            if isinstance(result, Exception):
                # 느리거나 끊긴 접속은 빼고, 다시 붙으면 처음부터 받아 간다
                self.remove(socket)
                log.info("실시간 전송 실패로 접속 제거: %s", type(result).__name__)
