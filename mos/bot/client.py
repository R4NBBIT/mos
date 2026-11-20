"""디스코드 봇. 게이트웨이 이벤트를 받아 저장하고 실시간으로 알린다(판단은 services 계층).

API에는 services/directory.py의 Directory 모양으로 서버·채널·멤버 정보를 준다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import discord
from discord import app_commands

from mos.bot.backfill import backfill_channel, fetch_older_messages
from mos.config import Settings
from mos.db.repo import MessageRepo
from mos.services.directory import ChannelInfo, DirectoryError, GuildInfo, MemberInfo, Overwrite
from mos.services.messages import message_to_row, row_to_api
from mos.services.realtime import RealtimeHub
from mos.services.sender import OutgoingMessage, SendError, Webhook, WebhookGoneError

if TYPE_CHECKING:
    from mos.services.sender import SenderService

log = logging.getLogger(__name__)

MemberChanged = Callable[[int, int | None], None]  # (서버 ID, 사용자 ID 또는 서버 전체)
WEBHOOK_NAME = "ㅁㅇㅅ"
DELETE_COMMAND_NAME = "ㅁㅇㅅ 메시지 삭제"
UNKNOWN_WEBHOOK = 10015
UNKNOWN_MESSAGE = 10008


def build_intents() -> discord.Intents:
    intents = discord.Intents.none()
    intents.guilds = True
    intents.guild_messages = True
    intents.message_content = True  # 본문·첨부를 읽는 데 필요(검증 결과)
    intents.members = True  # 역할 변경·탈퇴 이벤트(권한 캐시 지우기)
    intents.guild_reactions = True
    intents.emojis_and_stickers = True
    return intents


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
        )
    if isinstance(channel, discord.TextChannel):
        kind = "news" if channel.is_news() else "text"
    elif isinstance(channel, discord.ForumChannel):
        kind = "forum"
    else:
        return None
    category = channel.category
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
    )


class MosBot(discord.Client):
    def __init__(self, settings: Settings, repo: MessageRepo, hub: RealtimeHub) -> None:
        super().__init__(
            intents=build_intents(),
            chunk_guilds_at_startup=False,  # 서버 전체 멤버 목록은 받지 않는다
            member_cache_flags=discord.MemberCacheFlags.none(),
            max_messages=500,
        )
        self.settings = settings
        self.repo = repo
        self.hub = hub
        self.member_changed: MemberChanged | None = None
        self.sender: SenderService | None = None  # main에서 연결(메시지 명령이 쓴다)
        self.tree = app_commands.CommandTree(self)
        self._backfill_lock = asyncio.Lock()
        self._synced: set[int] = set()
        self._history_done: set[int] = set()
        self._sync_locks: dict[int, asyncio.Lock] = {}

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

    def channel_info(self, channel_id: int) -> ChannelInfo | None:
        channel = self.get_channel(channel_id)
        if channel is None:
            for guild in self.guilds:
                channel = guild.get_thread(channel_id)
                if channel is not None:
                    break
        return channel_to_info(channel) if channel is not None else None

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

    async def on_raw_message_edit(self, payload: discord.RawMessageUpdateEvent) -> None:
        if payload.guild_id is None:
            return
        await self.store_and_publish(payload.message, "message_update")

    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent) -> None:
        if payload.guild_id is None:
            return
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
            sent = await self._hook(webhook).send(
                content=message.content,
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

    async def fetch_member(self, guild_id: int, user_id: int) -> MemberInfo | None:
        return await self.bot.fetch_member(guild_id, user_id)

    async def ensure_synced(self, channel_id: int) -> None:
        await self.bot.ensure_synced(channel_id)

    async def fetch_older(self, channel_id: int, before_id: int, limit: int) -> int:
        return await self.bot.fetch_older(channel_id, before_id, limit)
