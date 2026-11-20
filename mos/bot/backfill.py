"""재시작·재연결 뒤 놓친 메시지를 채운다."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import discord

from mos.services.messages import message_to_row, row_to_api

if TYPE_CHECKING:
    from mos.bot.client import MosBot

log = logging.getLogger(__name__)

FIRST_FILL_LIMIT = 100  # 처음 보는 채널: 최근 100개
CATCH_UP_LIMIT = 1000  # 이어 받기: 한 번에 최대 1000개
BATCH_SIZE = 100


async def backfill_channel(bot: MosBot, channel_id: int) -> int:
    channel = bot.get_channel(channel_id)
    if channel is None:
        channel = await bot.fetch_channel(channel_id)
    if not isinstance(channel, discord.abc.Messageable):
        log.warning("메시지를 읽을 수 없는 채널: %s", channel_id)
        return 0

    last_id = await bot.repo.latest_id(channel_id)
    if last_id is None:
        history = channel.history(limit=FIRST_FILL_LIMIT, oldest_first=False)
        messages = [message async for message in history]
        messages.reverse()
    else:
        history = channel.history(
            limit=CATCH_UP_LIMIT, after=discord.Object(id=last_id), oldest_first=True
        )
        messages = [message async for message in history]

    total = 0
    for start in range(0, len(messages), BATCH_SIZE):
        rows = [message_to_row(message) for message in messages[start : start + BATCH_SIZE]]
        total += await bot.repo.upsert_many(rows)
        for row in rows:
            await bot.hub.broadcast("message_create", row_to_api(row))
    if total:
        log.info("놓친 메시지 %d개 채움: 채널 %s", total, channel_id)
    return total
