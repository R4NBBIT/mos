"""디스코드 봇. 게이트웨이 이벤트를 받아 저장하고 실시간으로 알린다(판단은 services 계층)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import discord

from mos.bot.backfill import backfill_channel
from mos.config import Settings
from mos.db.repo import MessageRepo
from mos.services.messages import message_to_row, row_to_api
from mos.services.realtime import RealtimeHub

log = logging.getLogger(__name__)


def build_intents() -> discord.Intents:
    intents = discord.Intents.none()
    intents.guilds = True
    intents.guild_messages = True
    intents.message_content = True  # 본문·첨부를 읽는 데 필요(검증 결과)
    intents.members = True
    intents.guild_reactions = True
    intents.emojis_and_stickers = True
    return intents


class MosBot(discord.Client):
    def __init__(self, settings: Settings, repo: MessageRepo, hub: RealtimeHub) -> None:
        super().__init__(
            intents=build_intents(),
            chunk_guilds_at_startup=False,  # 서버 전체 멤버 목록은 필요할 때만
            member_cache_flags=discord.MemberCacheFlags.none(),
            max_messages=500,
        )
        self.settings = settings
        self.repo = repo
        self.hub = hub
        self._backfill_lock = asyncio.Lock()

    # ------------------------------------------------------------ 상태(API가 쓴다)

    def is_gateway_ready(self) -> bool:
        return self.is_ready() and not self.is_closed()

    def guild_ids(self) -> set[int]:
        return {guild.id for guild in self.guilds}

    def watched_channel_ids(self) -> set[int]:
        # 2단계: 미리보기 채널 하나만. 3단계부터 권한 계산으로 넓힌다
        channel_id = self.settings.preview_channel_id
        return {channel_id} if channel_id else set()

    def channel_info(self, channel_id: int) -> dict[str, Any] | None:
        channel = self.get_channel(channel_id)
        if channel is None or not hasattr(channel, "guild"):
            return None
        return {
            "id": str(channel.id),
            "name": getattr(channel, "name", ""),
            "guild_id": str(channel.guild.id),
            "guild_name": channel.guild.name,
        }

    # ------------------------------------------------------------ 이벤트

    async def on_ready(self) -> None:
        log.info("디스코드 연결 완료: 서버 %d개", len(self.guilds))
        # 재연결로 on_ready가 다시 와도 겹치지 않게
        async with self._backfill_lock:
            for channel_id in self.watched_channel_ids():
                try:
                    await backfill_channel(self, channel_id)
                except discord.HTTPException:
                    log.exception("놓친 메시지 채우기 실패: 채널 %s", channel_id)

    async def on_message(self, message: discord.Message) -> None:
        if message.channel.id not in self.watched_channel_ids():
            return
        await self.store_and_publish(message, "message_create")

    async def on_raw_message_edit(self, payload: discord.RawMessageUpdateEvent) -> None:
        if payload.channel_id not in self.watched_channel_ids():
            return
        await self.store_and_publish(payload.message, "message_update")

    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent) -> None:
        if payload.channel_id not in self.watched_channel_ids():
            return
        await self.repo.delete_many([payload.message_id])
        await self.hub.broadcast(
            "message_delete",
            {"channel_id": str(payload.channel_id), "ids": [str(payload.message_id)]},
        )

    async def on_raw_bulk_message_delete(self, payload: discord.RawBulkMessageDeleteEvent) -> None:
        if payload.channel_id not in self.watched_channel_ids():
            return
        await self.repo.delete_many(payload.message_ids)
        await self.hub.broadcast(
            "message_delete",
            {
                "channel_id": str(payload.channel_id),
                "ids": [str(message_id) for message_id in payload.message_ids],
            },
        )

    # ------------------------------------------------------------ 공용

    async def store_and_publish(self, message: discord.Message, event_type: str) -> None:
        row = message_to_row(message)
        await self.repo.upsert(row)
        await self.hub.broadcast(event_type, row_to_api(row))
