"""메시지 보관 기간: 받아 둔 메시지 복사본은 90일이 지나면 서버 DB에서 지운다.

디스코드의 원래 메시지는 그대로다. 화면에서 위로 올려 더 오래된 글을 보려 하면
서버가 그때 디스코드에서 다시 받아 온다(받아 온 것도 다음 정리 때 다시 지워진다).
목적: 디스크를 아끼고, 서버가 털렸을 때 새어 나갈 수 있는 양을 줄인다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable

from mos.db.repo import MessageRepo

log = logging.getLogger(__name__)

RETENTION_DAYS = 90
FIRST_RUN_DELAY_SEC = 10 * 60  # 시작 직후 놓친 메시지 채우기와 겹치지 않게
RUN_EVERY_SEC = 24 * 3600
DISCORD_EPOCH_MS = 1420070400000


def cutoff_snowflake(now: float, days: int = RETENTION_DAYS) -> int:
    """now에서 days일 전 시각에 해당하는 가장 작은 디스코드 ID."""
    millis = int((now - days * 24 * 3600) * 1000) - DISCORD_EPOCH_MS
    return max(0, millis) << 22


async def purge_once(repo: MessageRepo, clock: Callable[[], float] = time.time) -> int:
    deleted = await repo.purge_before(cutoff_snowflake(clock()))
    if deleted:
        log.info("보관 기간(%d일)이 지난 메시지 %d개를 지움", RETENTION_DAYS, deleted)
    return deleted


async def run_forever(repo: MessageRepo) -> None:
    await asyncio.sleep(FIRST_RUN_DELAY_SEC)
    while True:
        try:
            await purge_once(repo)
        except Exception:
            log.exception("오래된 메시지 정리 실패(다음에 다시)")
        await asyncio.sleep(RUN_EVERY_SEC)
