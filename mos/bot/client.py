"""디스코드 봇. 게이트웨이 이벤트를 받아 저장하고 실시간으로 알린다(판단은 services 계층).

API에는 services/directory.py의 Directory 모양으로 서버·채널·멤버 정보를 준다.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import discord
from discord import app_commands

from mos.bot.backfill import backfill_channel, fetch_older_messages, fetch_pinned_messages
from mos.config import Settings
from mos.db.repo import MessageRepo
from mos.services import reactions
from mos.services.directory import (
    ChannelInfo,
    DirectoryError,
    EmojiInfo,
    ForumTagInfo,
    GuildInfo,
    MemberInfo,
    Overwrite,
    StickerInfo,
    VoiceChannelInfo,
    VoiceMemberInfo,
)
from mos.services.messages import message_to_row, row_to_api
from mos.services.realtime import RealtimeHub
from mos.services.sender import OutgoingMessage, SendError, Webhook, WebhookGoneError

if TYPE_CHECKING:
    from mos.services.sender import SenderService

log = logging.getLogger(__name__)

MemberChanged = Callable[[int, int | None], None]  # (서버 ID, 사용자 ID 또는 서버 전체)
NitroSeen = Callable[[int], Awaitable[bool]]  # (디스코드 사용자 ID) → 확인 기간을 늘렸나
_CUSTOM_EMOJI = re.compile(r"<(a?):[A-Za-z0-9_]{1,32}:(\d{15,21})>")
WEBHOOK_NAME = "ㅁㅇㅅ"
THREAD_CACHE_SEC = 300  # 디스코드에서 찾아 온 보관 스레드를 기억하는 시간
THREAD_CACHE_MAX = 2000
DELETE_COMMAND_NAME = "ㅁㅇㅅ 메시지 삭제"
UNKNOWN_WEBHOOK = 10015
UNKNOWN_MESSAGE = 10008
WEB_SENT_GRACE_SEC = 2.0  # 웹훅 메시지의 '웹에서 보낸 기록'을 기다리는 시간
PINS_CACHE_SEC = 60  # 고정 메시지 목록을 다시 묻지 않는 시간(바뀌면 이벤트로 바로 지움)
MAX_PINS_CACHE = 500


def build_intents() -> discord.Intents:
    intents = discord.Intents.none()
    intents.guilds = True
    intents.guild_messages = True
    intents.message_content = True  # 본문·첨부를 읽는 데 필요(검증 결과)
    intents.members = True  # 역할 변경·탈퇴 이벤트(권한 캐시 지우기)
    intents.guild_reactions = True
    intents.emojis_and_stickers = True
    intents.voice_states = True  # 음성 채널에 누가 들어가 있는지(특권 인텐트 아님)
    return intents


def _member_cache_flags() -> discord.MemberCacheFlags:
    """멤버는 캐시하지 않되, 음성 채널에 들어가 있는 사람만 이름과 사진을 위해 기억한다."""
    flags = discord.MemberCacheFlags.none()
    flags.voice = True
    return flags


def _overwrites(channel: Any) -> tuple[Overwrite, ...]:
    result = []
    for target, overwrite in channel.overwrites.items():
        allow, deny = overwrite.pair()
        is_role = isinstance(target, discord.Role) or getattr(target, "type", None) is discord.Role
        result.append(Overwrite(int(target.id), is_role, allow.value, deny.value))
    return tuple(result)


def _bot_can_read(channel: Any) -> bool:
    me = channel.guild.me
    if me is None:
        return False
    permissions = channel.permissions_for(me)
    return permissions.view_channel and permissions.read_message_history


def guild_to_info(guild: discord.Guild) -> GuildInfo:
    return GuildInfo(
        id=guild.id,
        name=guild.name,
        icon_url=str(guild.icon.url) if guild.icon else None,
        owner_id=guild.owner_id or 0,
        role_permissions={role.id: role.permissions.value for role in guild.roles},
    )


def channel_to_info(channel: Any) -> ChannelInfo | None:
    if isinstance(channel, discord.Thread):
        parent = channel.parent
        if parent is None:
            return None
        base = channel_to_info(parent)
        if base is None:
            return None
        return ChannelInfo(
            id=channel.id,
            guild_id=channel.guild.id,
            name=channel.name,
            kind="thread",
            position=0,
            category_id=base.category_id,
            category_name=base.category_name,
            category_position=base.category_position,
            parent_id=parent.id,
            private_thread=channel.type == discord.ChannelType.private_thread,
            thread_locked=bool(channel.locked),
            overwrites=base.overwrites,
            bot_can_read=base.bot_can_read,
            applied_tag_ids=tuple(int(tag_id) for tag_id in getattr(channel, "_applied_tags", [])),
            archived=bool(channel.archived),
            message_count=int(channel.message_count or 0),
            owner_id=channel.owner_id,
            last_message_id=channel.last_message_id,
            archive_ts=channel.archive_timestamp.timestamp() if channel.archive_timestamp else None,
            slowmode=int(channel.slowmode_delay or 0),
        )
    if isinstance(channel, discord.TextChannel):
        kind = "news" if channel.is_news() else "text"
    elif isinstance(channel, discord.ForumChannel):
        kind = "forum"
    else:
        return None
    category = channel.category
    tags: tuple[ForumTagInfo, ...] = ()
    require_tag = False
    if isinstance(channel, discord.ForumChannel):
        tags = tuple(
            ForumTagInfo(
                id=tag.id,
                name=tag.name,
                emoji=str(tag.emoji) if tag.emoji else None,
                moderated=tag.moderated,
            )
            for tag in channel.available_tags
        )
        require_tag = channel.flags.require_tag
    return ChannelInfo(
        id=channel.id,
        guild_id=channel.guild.id,
        name=channel.name,
        kind=kind,
        position=channel.position,
        category_id=category.id if category else None,
        category_name=category.name if category else None,
        category_position=category.position if category else -1,
        overwrites=_overwrites(channel),
        bot_can_read=_bot_can_read(channel),
        forum_tags=tags,
        require_tag=require_tag,
        slowmode=int(getattr(channel, "slowmode_delay", 0) or 0),
    )


def _voice_member(guild: discord.Guild, user_id: int, state: discord.VoiceState) -> VoiceMemberInfo:
    member = guild.get_member(user_id)
    return VoiceMemberInfo(
        user_id=user_id,
        display_name=member.display_name if member else "이름을 불러오지 못함",
        avatar_url=str(member.display_avatar.url) if member else None,
        muted=bool(state.self_mute or state.mute),
        deafened=bool(state.self_deaf or state.deaf),
        streaming=bool(state.self_stream),
        video=bool(state.self_video),
        is_bot=bool(member and member.bot),
    )


def voice_to_info(channel: discord.VoiceChannel | discord.StageChannel) -> VoiceChannelInfo:
    category = channel.category
    me = channel.guild.me
    info = ChannelInfo(
        id=channel.id,
        guild_id=channel.guild.id,
        name=channel.name,
        kind="stage" if isinstance(channel, discord.StageChannel) else "voice",
        position=channel.position,
        category_id=category.id if category else None,
        category_name=category.name if category else None,
        category_position=category.position if category else -1,
        overwrites=_overwrites(channel),
        bot_can_read=bool(me and channel.permissions_for(me).view_channel),
    )
    members = tuple(
        _voice_member(channel.guild, user_id, state)
        for user_id, state in channel.voice_states.items()
    )
    return VoiceChannelInfo(channel=info, members=members)


class MosBot(discord.Client):
    def __init__(self, settings: Settings, repo: MessageRepo, hub: RealtimeHub) -> None:
        super().__init__(
            intents=build_intents(),
            chunk_guilds_at_startup=False,  # 서버 전체 멤버 목록은 받지 않는다
            member_cache_flags=_member_cache_flags(),
            max_messages=500,
        )
        self.settings = settings
        self.repo = repo
        self.hub = hub
        self.member_changed: MemberChanged | None = None
        self.thread_member_changed: MemberChanged | None = None
        self.sender: SenderService | None = None  # main에서 연결(메시지 명령이 쓴다)
        self.nitro_seen: NitroSeen | None = None  # main에서 연결(니트로 확인)
        self.tree = app_commands.CommandTree(self)
        self._backfill_lock = asyncio.Lock()
        self._synced: set[int] = set()
        self._history_done: set[int] = set()
        # 채널 → (받은 시각, 고정 메시지 ID). 고정이 바뀌면 이벤트로 지운다
        self._pins: dict[int, tuple[float, list[int]]] = {}
        self._sync_locks: dict[int, asyncio.Lock] = {}
        self._thread_cache: dict[int, tuple[float, ChannelInfo]] = {}
        self._notify_tasks: set[asyncio.Task[None]] = set()
        self._own_reactions: set[tuple[int, str, int]] = set()

    async def setup_hook(self) -> None:
        self.tree.add_command(
            app_commands.ContextMenu(name=DELETE_COMMAND_NAME, callback=self._delete_command)
        )
        try:
            await self.tree.sync()  # 전역 명령. 바뀐 게 없으면 디스코드가 그대로 둔다
        except discord.HTTPException:
            log.exception("메시지 명령 등록 실패(웹 기능에는 영향 없음)")

        # 멤버 캐시를 끄면 discord.py가 역할 변경 이벤트(on_member_update)를 내보내지 않는다.
        # 원본 처리기는 그대로 두고, 권한 캐시만 지우도록 앞에 끼운다
        parsers = getattr(self._connection, "parsers", None)
        original = parsers.get("GUILD_MEMBER_UPDATE") if isinstance(parsers, dict) else None
        if original is None:
            log.warning("역할 변경 이벤트를 받을 수 없어 권한 캐시는 시간으로만 갱신합니다")
            return

        def on_member_update(data: Any) -> None:
            try:
                self._notify_member(int(data["guild_id"]), int(data["user"]["id"]))
            finally:
                original(data)

        parsers["GUILD_MEMBER_UPDATE"] = on_member_update

    def _notify_member(self, guild_id: int, user_id: int | None) -> None:
        if self.member_changed is not None:
            self.member_changed(guild_id, user_id)

    # ------------------------------------------------------------ Directory

    def is_gateway_ready(self) -> bool:
        return self.is_ready() and not self.is_closed()

    def guild_ids(self) -> set[int]:
        return {guild.id for guild in self.guilds}

    def guilds_info(self) -> list[GuildInfo]:
        return [guild_to_info(guild) for guild in self.guilds]

    def guild_info(self, guild_id: int) -> GuildInfo | None:
        guild = self.get_guild(guild_id)
        return guild_to_info(guild) if guild else None

    def channels_info(self, guild_id: int) -> list[ChannelInfo]:
        guild = self.get_guild(guild_id)
        if guild is None:
            return []
        items = [channel_to_info(channel) for channel in [*guild.text_channels, *guild.forums]]
        channels = [item for item in items if item is not None]
        return sorted(channels, key=lambda c: (c.category_position, c.position, c.id))

    def voice_channels_info(self, guild_id: int) -> list[VoiceChannelInfo]:
        guild = self.get_guild(guild_id)
        if guild is None:
            return []
        rooms = [*guild.voice_channels, *guild.stage_channels]
        voices = [voice_to_info(channel) for channel in rooms]
        return sorted(
            voices,
            key=lambda v: (v.channel.category_position, v.channel.position, v.channel.id),
        )

    def channel_info(self, channel_id: int) -> ChannelInfo | None:
        channel = self.get_channel(channel_id)
        if channel is None:
            for guild in self.guilds:
                channel = guild.get_thread(channel_id)
                if channel is not None:
                    break
        return channel_to_info(channel) if channel is not None else None

    def stickers_info(self, guild_id: int) -> list[StickerInfo]:
        guild = self.get_guild(guild_id)
        if guild is None:
            return []
        return [
            StickerInfo(
                id=sticker.id,
                name=sticker.name,
                format=int(sticker.format.value),
                guild_id=guild_id,
                available=bool(getattr(sticker, "available", True)),
            )
            for sticker in guild.stickers
        ]

    async def sticker_image(self, info: StickerInfo) -> bytes:
        guild = self.get_guild(info.guild_id)
        sticker = discord.utils.get(guild.stickers, id=info.id) if guild else None
        if sticker is None:
            raise DirectoryError("sticker not found")
        try:
            return await sticker.read()
        except discord.HTTPException as error:
            raise DirectoryError(f"sticker download failed: HTTP {error.status}") from error

    def emojis_info(self, guild_id: int) -> list[EmojiInfo]:
        guild = self.get_guild(guild_id)
        if guild is None:
            return []
        return [
            EmojiInfo(
                id=emoji.id,
                name=emoji.name,
                animated=emoji.animated,
                guild_id=guild_id,
                role_ids=frozenset(role.id for role in emoji.roles),
                available=emoji.available,
            )
            for emoji in guild.emojis
        ]

    def _remember_thread(self, info: ChannelInfo) -> None:
        if len(self._thread_cache) >= THREAD_CACHE_MAX:
            self._thread_cache.clear()
        self._thread_cache[info.id] = (time.monotonic(), info)

    async def fetch_channel_info(self, channel_id: int) -> ChannelInfo | None:
        cached = self._thread_cache.get(channel_id)
        if cached and time.monotonic() - cached[0] < THREAD_CACHE_SEC:
            return cached[1]
        try:
            channel = await self.fetch_channel(channel_id)
        except (discord.NotFound, discord.Forbidden):
            return None
        except discord.HTTPException as error:
            raise DirectoryError(f"channel lookup failed: HTTP {error.status}") from error
        if not isinstance(channel, discord.Thread) or channel.guild.id not in self.guild_ids():
            return None
        info = channel_to_info(channel)
        if info is not None:
            self._remember_thread(info)
        return info

    async def edit_thread(self, thread_id: int, name: str, tag_ids: tuple[int, ...]) -> None:
        thread: Any = None
        for guild in self.guilds:
            thread = guild.get_thread(thread_id)
            if thread is not None:
                break
        try:
            if thread is None:
                thread = await self.fetch_channel(thread_id)
            if not isinstance(thread, discord.Thread):
                raise DirectoryError("thread not found")
            changes: dict[str, Any] = {"name": name}
            if isinstance(thread.parent, discord.ForumChannel):
                wanted = set(tag_ids)
                available = thread.parent.available_tags
                changes["applied_tags"] = [tag for tag in available if tag.id in wanted]
            if thread.archived:
                changes["archived"] = False  # 보관된 글은 다시 열어야 고칠 수 있다
            await thread.edit(**changes)
        except discord.Forbidden as error:
            raise PermissionError("bot needs manage threads") from error
        except discord.HTTPException as error:
            raise DirectoryError(f"thread edit failed: HTTP {error.status}") from error

    async def is_thread_member(self, thread_id: int, user_id: int) -> bool:
        thread: Any = None
        for guild in self.guilds:
            thread = guild.get_thread(thread_id)
            if thread is not None:
                break
        try:
            if thread is None:
                thread = await self.fetch_channel(thread_id)
            if not isinstance(thread, discord.Thread):
                return False
            await thread.fetch_member(user_id)
        except (discord.NotFound, discord.Forbidden):
            return False
        except discord.HTTPException as error:
            raise DirectoryError(f"thread member lookup failed: HTTP {error.status}") from error
        return True

    async def list_threads(
        self, parent_id: int, before: float | None, limit: int
    ) -> tuple[list[ChannelInfo], bool]:
        parent = self.get_channel(parent_id)
        if not isinstance(parent, discord.TextChannel | discord.ForumChannel):
            return [], False
        result: list[ChannelInfo] = []
        if before is None:
            active = [thread for thread in parent.threads if not thread.archived]
            active.sort(key=lambda thread: thread.last_message_id or thread.id, reverse=True)
            result.extend(info for info in map(channel_to_info, active) if info is not None)
        archived: list[ChannelInfo] = []
        try:
            cutoff = datetime.fromtimestamp(before, UTC) if before is not None else None
            async for thread in parent.archived_threads(limit=limit + 1, before=cutoff):
                info = channel_to_info(thread)
                if info is not None:
                    archived.append(info)
                    self._remember_thread(info)
        except discord.Forbidden:
            return result, False  # 봇이 보관된 글을 못 읽으면 열린 것만
        except discord.HTTPException as error:
            raise DirectoryError(f"archived threads failed: HTTP {error.status}") from error
        has_more = len(archived) > limit
        return result + archived[:limit], has_more

    async def notify_operator(self, text: str) -> None:
        """운영자에게 디스코드 DM(송신량 경고 등). 운영자 ID가 없으면 로그만."""
        operator_id = self.settings.operator_discord_id
        if operator_id is None:
            log.warning("운영자 알림(OPERATOR_DISCORD_ID 없음): %s", text)
            return
        user = self.get_user(operator_id) or await self.fetch_user(operator_id)
        await user.send(text)

    async def fetch_member(self, guild_id: int, user_id: int) -> MemberInfo | None:
        guild = self.get_guild(guild_id)
        if guild is None:
            return None
        try:
            member = await guild.fetch_member(user_id)
        except discord.NotFound:
            return None
        except discord.HTTPException as error:
            raise DirectoryError(f"member lookup failed: HTTP {error.status}") from error
        until = member.timed_out_until
        return MemberInfo(
            guild_id=guild_id,
            user_id=user_id,
            role_ids=frozenset(role.id for role in member.roles),
            display_name=member.display_name,
            avatar_url=str(member.display_avatar.url),
            timed_out_until=until.timestamp() if until else None,
        )

    async def list_members(self, guild_id: int, limit: int) -> list[MemberInfo]:
        guild = self.get_guild(guild_id)
        if guild is None:
            return []
        result: list[MemberInfo] = []
        try:
            async for member in guild.fetch_members(limit=limit):
                until = member.timed_out_until
                result.append(
                    MemberInfo(
                        guild_id=guild_id,
                        user_id=member.id,
                        role_ids=frozenset(role.id for role in member.roles),
                        display_name=member.display_name,
                        avatar_url=str(member.display_avatar.url),
                        timed_out_until=until.timestamp() if until else None,
                        is_bot=member.bot,
                    )
                )
        except discord.HTTPException as error:
            raise DirectoryError(f"member list failed: HTTP {error.status}") from error
        return result

    async def ensure_synced(self, channel_id: int) -> None:
        if channel_id in self._synced:
            return
        lock = self._sync_locks.setdefault(channel_id, asyncio.Lock())
        async with lock:
            if channel_id in self._synced:
                return
            try:
                await backfill_channel(self, channel_id)
            except discord.Forbidden:
                log.info("봇이 읽을 수 없는 채널: %s", channel_id)
            except discord.HTTPException as error:
                raise DirectoryError(f"history failed: HTTP {error.status}") from error
            self._synced.add(channel_id)

    async def fetch_older(self, channel_id: int, before_id: int, limit: int) -> int:
        if channel_id in self._history_done:
            return 0
        try:
            count = await fetch_older_messages(self, channel_id, before_id, limit)
        except discord.Forbidden:
            count = 0
        except discord.HTTPException as error:
            raise DirectoryError(f"history failed: HTTP {error.status}") from error
        if count < limit:
            self._history_done.add(channel_id)  # 더 오래된 메시지가 없다
        return count

    async def pinned_ids(self, channel_id: int) -> list[int]:
        cached = self._pins.get(channel_id)
        if cached is not None and time.monotonic() - cached[0] < PINS_CACHE_SEC:
            return cached[1]
        try:
            ids = await fetch_pinned_messages(self, channel_id)
        except discord.Forbidden:
            ids = []  # 봇이 기록을 못 읽는 채널
        except discord.HTTPException as error:
            raise DirectoryError(f"pins failed: HTTP {error.status}") from error
        if len(self._pins) >= MAX_PINS_CACHE:
            self._pins.clear()
        self._pins[channel_id] = (time.monotonic(), ids)
        return ids

    async def refresh_attachment_urls(self, urls: list[str]) -> dict[str, str]:
        route = discord.http.Route("POST", "/attachments/refresh-urls")
        data = await self.http.request(route, json={"attachment_urls": urls[:50]})
        result: dict[str, str] = {}
        for item in (data or {}).get("refreshed_urls", []):
            original, refreshed = item.get("original"), item.get("refreshed")
            if isinstance(original, str) and isinstance(refreshed, str):
                result[original] = refreshed
        return result

    async def on_guild_channel_pins_update(self, channel: Any, last_pin: Any) -> None:
        self._pins.pop(channel.id, None)

    # ------------------------------------------------------------ 이벤트

    async def on_ready(self) -> None:
        log.info("디스코드 연결 완료: 서버 %d개", len(self.guilds))
        # 재연결로 on_ready가 다시 와도 겹치지 않게. 이미 받아 둔 채널만 이어 받는다
        async with self._backfill_lock:
            for channel_id in await self.repo.channel_ids():
                if self.get_channel(channel_id) is None:
                    continue  # 지워졌거나 봇이 나간 서버의 채널, 아직 안 연 스레드
                try:
                    await backfill_channel(self, channel_id)
                    self._synced.add(channel_id)
                except discord.HTTPException:
                    log.exception("놓친 메시지 채우기 실패: 채널 %s", channel_id)

    async def on_message(self, message: discord.Message) -> None:
        if message.guild is None:
            return  # DM은 다루지 않는다
        await self.store_and_publish(message, "message_create")
        if not message.author.bot and message.webhook_id is None:
            for animated, emoji_id in _CUSTOM_EMOJI.findall(message.content or ""):
                if self._needs_nitro(message.guild.id, int(emoji_id), animated == "a"):
                    await self._record_nitro(message.author.id)
                    break

    # ------------------------------------------------------------ 반응

    def expect_own_reaction(self, message_id: int, key: str, delta: int) -> None:
        """웹에서 누른 반응을 봇이 달거나 뺄 때. 그 이벤트는 이미 반영했으니 한 번 건너뛴다."""
        self._own_reactions.add((message_id, key, delta))

    def forget_own_reaction(self, message_id: int, key: str, delta: int) -> None:
        self._own_reactions.discard((message_id, key, delta))

    async def _reaction_changed(self, payload: discord.RawReactionActionEvent, delta: int) -> None:
        if payload.guild_id is None:
            return
        emoji = reactions.from_partial(payload.emoji)
        key = reactions.emoji_key(emoji["id"], emoji["name"])
        mine = self.user is not None and payload.user_id == self.user.id
        if mine and (payload.message_id, key, delta) in self._own_reactions:
            self._own_reactions.discard((payload.message_id, key, delta))
            return
        if not await self.repo.change_reaction(payload.message_id, emoji, delta, by_bot=mine):
            return  # 받아 두지 않은 메시지
        if not mine:
            await self.repo.set_reaction_user(
                payload.message_id, key, payload.user_id, "discord", delta > 0
            )
        await self.publish_reactions(payload.channel_id, payload.message_id)

    async def publish_reactions(self, channel_id: int, message_id: int) -> None:
        row = await self.repo.get(message_id)
        if row is None:
            return
        await self.hub.publish(
            channel_id,
            "reactions_update",
            {
                "channel_id": str(channel_id),
                "message_id": str(message_id),
                "reactions": row_to_api(row)["reactions"],
            },
        )

    async def on_raw_reaction_remove(self, payload: discord.RawReactionActionEvent) -> None:
        await self._reaction_changed(payload, -1)

    async def on_raw_reaction_clear(self, payload: discord.RawReactionClearEvent) -> None:
        if payload.guild_id is None:
            return
        await self.repo.clear_reactions(payload.message_id)
        await self.publish_reactions(payload.channel_id, payload.message_id)

    async def on_raw_reaction_clear_emoji(
        self, payload: discord.RawReactionClearEmojiEvent
    ) -> None:
        if payload.guild_id is None:
            return
        emoji = reactions.from_partial(payload.emoji)
        await self.repo.clear_reactions(
            payload.message_id, reactions.emoji_key(emoji["id"], emoji["name"])
        )
        await self.publish_reactions(payload.channel_id, payload.message_id)

    async def on_raw_reaction_add(self, payload: discord.RawReactionActionEvent) -> None:
        await self._reaction_changed(payload, 1)
        emoji = payload.emoji
        if payload.guild_id is None or emoji.id is None:
            return
        member = payload.member
        if member is not None and member.bot:
            return
        if self._needs_nitro(payload.guild_id, emoji.id, emoji.animated):
            await self._record_nitro(payload.user_id)

    def _needs_nitro(self, guild_id: int, emoji_id: int, animated: bool) -> bool:
        """디스코드 앱에서 니트로 없이는 쓸 수 없는 이모지인가(움직이는 것, 다른 서버 것)."""
        if animated:
            return True
        known = self.get_emoji(emoji_id)
        return known is None or known.guild_id != guild_id

    async def _record_nitro(self, user_id: int) -> None:
        if self.nitro_seen is None:
            return
        try:
            if await self.nitro_seen(user_id):
                log.info("니트로 확인 갱신: 사용자 %s", user_id)
        except Exception:
            log.exception("니트로 확인 기록 실패")

    async def on_raw_message_edit(self, payload: discord.RawMessageUpdateEvent) -> None:
        if payload.guild_id is None:
            return
        await self.store_and_publish(payload.message, "message_update")

    # ------------------------------------------------------------ 포럼 글·스레드 목록 실시간

    async def threads_changed(self, parent_id: int | None) -> None:
        """글이 생기거나 바뀌거나 새 댓글이 달리면, 그 목록을 보는 화면에 다시 받으라고 알린다."""
        if parent_id is None:
            return
        await self.hub.publish(parent_id, "threads_changed", {"channel_id": str(parent_id)})

    def _parent_of(self, channel_id: int) -> int | None:
        channel = self.get_channel(channel_id)
        return channel.parent_id if isinstance(channel, discord.Thread) else None

    async def on_thread_create(self, thread: discord.Thread) -> None:
        await self.threads_changed(thread.parent_id)

    async def on_thread_update(self, before: discord.Thread, after: discord.Thread) -> None:
        self._thread_cache.pop(after.id, None)  # 보관·잠금·이름이 바뀌었을 수 있다
        await self.threads_changed(after.parent_id)

    async def on_raw_thread_delete(self, payload: discord.RawThreadDeleteEvent) -> None:
        self._thread_cache.pop(payload.thread_id, None)
        await self.threads_changed(payload.parent_id)

    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent) -> None:
        if payload.guild_id is None:
            return
        await self.threads_changed(self._parent_of(payload.channel_id))
        await self.repo.delete_many([payload.message_id])
        await self.hub.publish(
            payload.channel_id,
            "message_delete",
            {"channel_id": str(payload.channel_id), "ids": [str(payload.message_id)]},
        )

    async def on_raw_bulk_message_delete(self, payload: discord.RawBulkMessageDeleteEvent) -> None:
        if payload.guild_id is None:
            return
        await self.repo.delete_many(payload.message_ids)
        await self.hub.publish(
            payload.channel_id,
            "message_delete",
            {
                "channel_id": str(payload.channel_id),
                "ids": [str(message_id) for message_id in payload.message_ids],
            },
        )

    # 비공개 스레드에 사람이 들어오고 나가면 참여 여부 캐시를 지운다
    def _notify_thread_member(self, thread_id: int, user_id: int | None) -> None:
        if self.thread_member_changed is not None:
            self.thread_member_changed(thread_id, user_id)

    async def on_raw_thread_member_remove(self, payload: discord.RawThreadMembersUpdate) -> None:
        self._notify_thread_member(payload.thread_id, None)

    async def on_thread_member_join(self, member: discord.ThreadMember) -> None:
        self._notify_thread_member(member.thread_id, member.id)

    async def on_voice_state_update(
        self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState
    ) -> None:
        # 들고 남, 옮김, 마이크와 소리, 화면 공유가 바뀌면 그 서버를 보는 화면이 다시 받는다
        await self.hub.voice_changed(member.guild.id)

    async def on_member_join(self, member: discord.Member) -> None:
        self._notify_member(member.guild.id, member.id)  # '서버에 없음' 캐시를 지운다

    async def on_raw_member_remove(self, payload: discord.RawMemberRemoveEvent) -> None:
        self._notify_member(payload.guild_id, payload.user.id)

    async def on_guild_remove(self, guild: discord.Guild) -> None:
        self._notify_member(guild.id, None)

    # ------------------------------------------------------------ 메시지 명령(SEND-12)

    async def _delete_command(
        self, interaction: discord.Interaction, message: discord.Message
    ) -> None:
        """디스코드 앱 › 메시지 › 앱 › ㅁㅇㅅ 메시지 삭제. 본인만 보이는 확인 버튼을 띄운다."""
        sender = self.sender
        owner = await sender.sender_of(message.id) if sender else None
        if sender is None or owner != interaction.user.id:
            await interaction.response.send_message(
                "본인이 ㅁㅇㅅ에서 보낸 메시지만 지울 수 있어요.", ephemeral=True
            )
            return
        view = DeleteConfirmView(sender, interaction.user.id, message.id)
        await interaction.response.send_message("이 메시지를 지울까요?", view=view, ephemeral=True)

    # ------------------------------------------------------------ 공용

    async def store_and_publish(self, message: discord.Message, event_type: str) -> None:
        await self.repo.upsert(message_to_row(message))
        # 웹에서 보낸 메시지면 보낸 사람·답장 정보를 붙여서 알린다
        row = await self.repo.get(message.id)
        if row is not None:
            await self.hub.publish(message.channel.id, event_type, row_to_api(row))
            if event_type == "message_create":
                if isinstance(message.channel, discord.Thread):
                    await self.threads_changed(message.channel.parent_id)  # 댓글 수·최근 활동
                task = asyncio.create_task(self._notify(message.channel.id, row))
                self._notify_tasks.add(task)
                task.add_done_callback(self._notify_tasks.discard)

    async def _notify(self, channel_id: int, row: dict[str, Any]) -> None:
        """알림을 켠 사람에게. 웹에서 보낸 메시지는 보낸 기록이 조금 늦게 남을 수 있어
        잠깐 기다렸다 다시 읽는다(내가 보낸 글이 나에게 알림으로 오지 않게)."""
        try:
            if row["webhook_id"] is not None and row.get("web_sender_id") is None:
                await asyncio.sleep(WEB_SENT_GRACE_SEC)
                row = await self.repo.get(row["id"]) or row
            await self.hub.notify(channel_id, row_to_api(row))
        except Exception:
            log.exception("알림 보내기 실패")


class DeleteConfirmView(discord.ui.View):
    def __init__(self, sender: SenderService, owner_id: int, message_id: int) -> None:
        super().__init__(timeout=60)
        self.sender = sender
        self.owner_id = owner_id
        self.message_id = message_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.owner_id  # 누른 사람 다시 확인

    @discord.ui.button(label="삭제", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        try:
            await self.sender.delete(self.owner_id, self.message_id)
            text = "삭제했어요."
        except SendError:
            text = "이미 지워졌거나 지울 수 없는 메시지예요."
        except Exception:
            log.exception("메시지 명령 삭제 실패")
            text = "삭제하지 못했어요. 잠시 후 다시 해 주세요."
        await interaction.response.edit_message(content=text, view=None)
        self.stop()

    @discord.ui.button(label="취소", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        await interaction.response.edit_message(content="취소했어요.", view=None)
        self.stop()


def _webhook_error(error: discord.HTTPException) -> Exception:
    if isinstance(error, discord.NotFound) and error.code == UNKNOWN_WEBHOOK:
        return WebhookGoneError()
    if isinstance(error, discord.Forbidden):
        return SendError("bot_cannot_send", 403)
    if error.status == 400:
        return SendError("rejected", 400)
    return DirectoryError(f"webhook failed: HTTP {error.status}")


class BotMessenger:
    """웹훅으로 보내기·고치기·지우기. 웹훅 토큰은 로그·오류 메시지에 넣지 않는다."""

    def __init__(self, bot: MosBot) -> None:
        self.bot = bot

    def _hook(self, webhook: Webhook) -> discord.Webhook:
        return discord.Webhook.partial(webhook.id, webhook.token, client=self.bot)

    @staticmethod
    def _mentions(message: OutgoingMessage) -> discord.AllowedMentions:
        everyone = message.allow_everyone
        return discord.AllowedMentions(everyone=everyone, roles=everyone, users=True)

    async def create_webhook(self, channel_id: int) -> Webhook:
        channel = self.bot.get_channel(channel_id)
        if not isinstance(channel, discord.TextChannel | discord.ForumChannel):
            raise SendError("not_found", 404)
        try:
            for hook in await channel.webhooks():
                me = self.bot.user
                if (
                    hook.token
                    and hook.user is not None
                    and me is not None
                    and hook.user.id == me.id
                ):
                    return Webhook(hook.id, hook.token)
            hook = await channel.create_webhook(name=WEBHOOK_NAME, reason="ㅁㅇㅅ 웹에서 보내기")
        except discord.HTTPException as error:
            raise _webhook_error(error) from error
        if not hook.token:
            raise DirectoryError("webhook without token")
        return Webhook(hook.id, hook.token)

    async def send(self, webhook: Webhook, message: OutgoingMessage) -> dict[str, Any]:
        thread = (
            discord.Object(id=message.thread_id) if message.thread_id else discord.utils.MISSING
        )
        try:
            files = [
                discord.File(io.BytesIO(item.data), filename=item.filename, spoiler=item.spoiler)
                for item in message.files
            ]
            sent = await self._hook(webhook).send(
                content=message.content,
                files=files or discord.utils.MISSING,
                thread_name=message.thread_name or discord.utils.MISSING,
                applied_tags=[discord.Object(id=tag) for tag in message.applied_tags]  # type: ignore[misc]
                or discord.utils.MISSING,
                username=message.username,
                avatar_url=message.avatar_url or discord.utils.MISSING,
                allowed_mentions=self._mentions(message),
                thread=thread,
                wait=True,
            )
        except discord.HTTPException as error:
            raise _webhook_error(error) from error
        return message_to_row(sent)

    async def edit(
        self, webhook: Webhook, message_id: int, message: OutgoingMessage
    ) -> dict[str, Any]:
        thread = (
            discord.Object(id=message.thread_id) if message.thread_id else discord.utils.MISSING
        )
        try:
            edited = await self._hook(webhook).edit_message(
                message_id,
                content=message.content,
                allowed_mentions=self._mentions(message),
                thread=thread,
            )
        except discord.HTTPException as error:
            if isinstance(error, discord.NotFound) and error.code == UNKNOWN_MESSAGE:
                raise SendError("not_found", 404) from error
            raise _webhook_error(error) from error
        return message_to_row(edited)

    async def delete(self, webhook: Webhook, message_id: int, thread_id: int | None) -> None:
        thread = discord.Object(id=thread_id) if thread_id else discord.utils.MISSING
        try:
            await self._hook(webhook).delete_message(message_id, thread=thread)
        except discord.HTTPException as error:
            if isinstance(error, discord.NotFound) and error.code == UNKNOWN_MESSAGE:
                return  # 이미 지워짐
            raise _webhook_error(error) from error

    @staticmethod
    def _reaction_text(emoji: dict[str, Any]) -> str:
        if emoji["id"]:
            return f"<{'a' if emoji['animated'] else ''}:{emoji['name']}:{emoji['id']}>"
        return str(emoji["name"])

    async def add_reaction(self, channel_id: int, message_id: int, emoji: dict[str, Any]) -> None:
        key = reactions.emoji_key(emoji["id"], emoji["name"])
        self.bot.expect_own_reaction(message_id, key, 1)
        message = self.bot.get_partial_messageable(channel_id).get_partial_message(message_id)
        try:
            await message.add_reaction(self._reaction_text(emoji))
        except discord.HTTPException as error:
            self.bot.forget_own_reaction(message_id, key, 1)
            if error.status == 400:
                raise SendError("bad_emoji", 400) from error
            if error.status in (403, 404):
                raise SendError("no_permission", 403) from error
            raise SendError("upstream_unavailable", 503) from error

    async def remove_reaction(
        self, channel_id: int, message_id: int, emoji: dict[str, Any]
    ) -> None:
        key = reactions.emoji_key(emoji["id"], emoji["name"])
        self.bot.expect_own_reaction(message_id, key, -1)
        message = self.bot.get_partial_messageable(channel_id).get_partial_message(message_id)
        try:
            me = self.bot.user
            if me is None:
                raise SendError("upstream_unavailable", 503)
            await message.remove_reaction(self._reaction_text(emoji), me)
        except discord.NotFound:
            self.bot.forget_own_reaction(message_id, key, -1)
        except discord.HTTPException as error:
            self.bot.forget_own_reaction(message_id, key, -1)
            raise SendError("upstream_unavailable", 503) from error


class BotDirectory:
    """MosBot을 Directory 모양으로 감싼다(이름이 discord.Client 메서드와 겹치지 않게)."""

    def __init__(self, bot: MosBot) -> None:
        self.bot = bot

    def is_gateway_ready(self) -> bool:
        return self.bot.is_gateway_ready()

    def guild_ids(self) -> set[int]:
        return self.bot.guild_ids()

    def guilds(self) -> list[GuildInfo]:
        return self.bot.guilds_info()

    def guild(self, guild_id: int) -> GuildInfo | None:
        return self.bot.guild_info(guild_id)

    def channels(self, guild_id: int) -> list[ChannelInfo]:
        return self.bot.channels_info(guild_id)

    def channel(self, channel_id: int) -> ChannelInfo | None:
        return self.bot.channel_info(channel_id)

    def voice_channels(self, guild_id: int) -> list[VoiceChannelInfo]:
        return self.bot.voice_channels_info(guild_id)

    def emojis(self, guild_id: int) -> list[EmojiInfo]:
        return self.bot.emojis_info(guild_id)

    def stickers(self, guild_id: int) -> list[StickerInfo]:
        return self.bot.stickers_info(guild_id)

    async def sticker_image(self, sticker: StickerInfo) -> bytes:
        return await self.bot.sticker_image(sticker)

    async def fetch_channel(self, channel_id: int) -> ChannelInfo | None:
        return await self.bot.fetch_channel_info(channel_id)

    async def is_thread_member(self, thread_id: int, user_id: int) -> bool:
        return await self.bot.is_thread_member(thread_id, user_id)

    async def edit_thread(self, thread_id: int, name: str, tag_ids: tuple[int, ...]) -> None:
        await self.bot.edit_thread(thread_id, name, tag_ids)

    async def list_threads(
        self, parent_id: int, before: float | None, limit: int
    ) -> tuple[list[ChannelInfo], bool]:
        return await self.bot.list_threads(parent_id, before, limit)

    async def fetch_member(self, guild_id: int, user_id: int) -> MemberInfo | None:
        return await self.bot.fetch_member(guild_id, user_id)

    async def list_members(self, guild_id: int, limit: int) -> list[MemberInfo]:
        return await self.bot.list_members(guild_id, limit)

    async def ensure_synced(self, channel_id: int) -> None:
        await self.bot.ensure_synced(channel_id)

    async def fetch_older(self, channel_id: int, before_id: int, limit: int) -> int:
        return await self.bot.fetch_older(channel_id, before_id, limit)

    async def pinned_ids(self, channel_id: int) -> list[int]:
        return await self.bot.pinned_ids(channel_id)

    async def refresh_attachment_urls(self, urls: list[str]) -> dict[str, str]:
        return await self.bot.refresh_attachment_urls(urls)
