"""디스코드에서 지난 메시지를 받아 저장한다.

- backfill_channel: 처음 여는 채널은 최근 100개, 받아 둔 적 있는 채널은 마지막 이후(최대 1000개)
- fetch_older_messages: 위로 스크롤할 때, 저장된 것보다 오래된 메시지
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

import discord

from mos.services.messages import message_to_row, row_to_api

if TYPE_CHECKING:
    from mos.bot.client import MosBot

log = logging.getLogger(__name__)

FIRST_FILL_LIMIT = 100
CATCH_UP_LIMIT = 1000
BATCH_SIZE = 100


async def _messageable(bot: MosBot, channel_id: int) -> Any:
    channel: Any = bot.get_channel(channel_id)
    if channel is None:
        for guild in bot.guilds:
            channel = guild.get_thread(channel_id)
            if channel is not None:
                break
    if channel is None:
        channel = await bot.fetch_channel(channel_id)
    if not isinstance(channel, discord.abc.Messageable):
        return None
    return channel


async def backfill_channel(bot: MosBot, channel_id: int) -> int:
    channel = await _messageable(bot, channel_id)
    if channel is None:
        return 0  # 포럼 같은 글 목록 채널은 메시지가 스레드 안에 있다

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
        if last_id is not None:  # 이어 받은 것만 '새 메시지'로 알린다
            for row in rows:
                await bot.hub.publish(channel_id, "message_create", row_to_api(row))
    if total and last_id is not None:
        log.info("놓친 메시지 %d개 채움: 채널 %s", total, channel_id)
    return total


async def fetch_older_messages(bot: MosBot, channel_id: int, before_id: int, limit: int) -> int:
    channel = await _messageable(bot, channel_id)
    if channel is None:
        return 0
    history = channel.history(limit=limit, before=discord.Object(id=before_id), oldest_first=False)
    rows = [message_to_row(message) async for message in history]
    return await bot.repo.upsert_many(rows)
