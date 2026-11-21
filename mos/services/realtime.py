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
NOTIFY_SCOPES = ("mentions", "pinned")  # 나를 부른 것만 · 나를 부른 것 + 고정한 채널


class JsonSocket(Protocol):
    async def send_json(self, data: Any) -> None: ...


@dataclass
class Subscriber:
    user_id: int
    channel_id: int | None = None
    account_id: int = 0
    # 알림을 받겠다고 한 접속만 범위가 있다(None이면 알림 안 보냄)
    notify_scope: str | None = None


# (구독자, 채널 ID, 메시지) → 알림으로 보낼 내용 또는 None(이 사람에게는 안 보냄)
NotifyRule = Callable[[Subscriber, int, dict[str, Any]], Awaitable[dict[str, Any] | None]]


# 알림 뒤: (채널 ID, 메시지, 알림 연결이 열려 있는 계정들).
# 탭이 없는 계정에 웹 푸시를 보내는 데 쓴다
AfterNotify = Callable[[int, dict[str, Any], set[int]], Awaitable[None]]


async def _after_nothing(_channel_id: int, _message: dict[str, Any], _open: set[int]) -> None:
    return None


async def _notify_nothing(
    _subscriber: Subscriber, _channel_id: int, _message: dict[str, Any]
) -> dict[str, Any] | None:
    return None


async def _allow_nothing(_user_id: int, _channel_id: int) -> bool:
    return False


class RealtimeHub:
    def __init__(self) -> None:
        self._sockets: dict[JsonSocket, Subscriber] = {}
        self._access_check: AccessCheck = _allow_nothing
        self._notify_rule: NotifyRule = _notify_nothing
        self._after_notify: AfterNotify = _after_nothing

    def set_access_check(self, check: AccessCheck) -> None:
        self._access_check = check

    def set_notify_rule(self, rule: NotifyRule) -> None:
        self._notify_rule = rule

    def set_after_notify(self, after: AfterNotify) -> None:
        self._after_notify = after

    @property
    def count(self) -> int:
        return len(self._sockets)

    def add(self, socket: JsonSocket, user_id: int, account_id: int = 0) -> None:
        self._sockets[socket] = Subscriber(user_id=user_id, account_id=account_id)

    def set_notify(self, socket: JsonSocket, scope: str | None) -> None:
        subscriber = self._sockets.get(socket)
        if subscriber is not None:
            subscriber.notify_scope = scope if scope in NOTIFY_SCOPES else None

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
        await self._send_all([(socket, payload) for socket in sockets])

    async def notify(self, channel_id: int, message: dict[str, Any]) -> None:
        """새 메시지를 알림을 켠 접속에 알린다. 볼 수 있는지와 알림 조건은 사람마다 따로 본다."""
        targets = [
            (socket, subscriber)
            for socket, subscriber in list(self._sockets.items())
            if subscriber.notify_scope is not None
        ]
        try:
            await self._after_notify(
                channel_id, message, {subscriber.account_id for _, subscriber in targets}
            )
        except Exception:
            log.exception("웹 푸시 처리 실패")
        if not targets:
            return

        async def decide(subscriber: Subscriber) -> dict[str, Any] | None:
            if not await self._access_check(subscriber.user_id, channel_id):
                return None
            return await self._notify_rule(subscriber, channel_id, message)

        decided = await asyncio.gather(
            *(decide(subscriber) for _, subscriber in targets), return_exceptions=True
        )
        sends = [
            (socket, {"type": "notify", "data": data})
            for (socket, _), data in zip(targets, decided, strict=True)
            if isinstance(data, dict)
        ]
        for result in decided:
            if isinstance(result, Exception):
                log.warning("알림 조건 확인 실패: %s", type(result).__name__)
        await self._send_all(sends)

    async def _send_all(self, sends: list[tuple[JsonSocket, dict[str, Any]]]) -> None:
        if not sends:
            return
        results = await asyncio.gather(
            *(asyncio.wait_for(socket.send_json(data), SEND_TIMEOUT_SEC) for socket, data in sends),
            return_exceptions=True,
        )
        for (socket, _), result in zip(sends, results, strict=True):
            if isinstance(result, Exception):
                # 느리거나 끊긴 접속은 빼고, 다시 붙으면 처음부터 받아 간다
                self.remove(socket)
                log.info("실시간 전송 실패로 접속 제거: %s", type(result).__name__)
