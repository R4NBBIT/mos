"""사용자 기준 권한 계산. 채널을 보여 줄지·메시지를 줄지는 모두 여기서만 판단한다.

디스코드 공식 계산 순서(https://docs.discord.com/developers/topics/permissions)를 따른다.
1. 서버 주인 → 전부. 2. @everyone + 내 역할 권한 합. 관리자면 전부.
3. 채널 덮어쓰기: @everyone → 역할들(거부 합, 허용 합) → 나 개인 순서.
4. 채널 보기가 없으면 아무것도 없음. 타임아웃이면 보기·기록 읽기만.

멤버 정보(역할)는 봇이 디스코드에서 받아 오고 잠깐(MEMBER_TTL_SEC) 기억한다.
역할이 바뀌면 이벤트로 지우고, 놓쳐도 TTL이 지나면 다시 받는다.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from mos.services.directory import ChannelInfo, Directory, GuildInfo, MemberInfo

ADMINISTRATOR = 1 << 3
VIEW_CHANNEL = 1 << 10
SEND_MESSAGES = 1 << 11
READ_MESSAGE_HISTORY = 1 << 16
MENTION_EVERYONE = 1 << 17
MANAGE_THREADS = 1 << 34
SEND_MESSAGES_IN_THREADS = 1 << 38
ALL_PERMISSIONS = (1 << 53) - 1

MEMBER_TTL_SEC = 120
MEMBER_CACHE_MAX = 5000
_MISSING = object()


def compute_permissions(
    guild: GuildInfo,
    member: MemberInfo,
    channel: ChannelInfo | None = None,
    now: float | None = None,
) -> int:
    if member.user_id == guild.owner_id:
        return ALL_PERMISSIONS

    everyone_id = guild.id
    base = guild.role_permissions.get(everyone_id, 0)
    for role_id in member.role_ids:
        base |= guild.role_permissions.get(role_id, 0)
    if base & ADMINISTRATOR:
        return ALL_PERMISSIONS

    permissions = base
    if channel is not None:
        everyone = [o for o in channel.overwrites if o.is_role and o.target_id == everyone_id]
        for overwrite in everyone:
            permissions &= ~overwrite.deny
            permissions |= overwrite.allow
        allow = deny = 0
        for overwrite in channel.overwrites:
            if overwrite.is_role and overwrite.target_id in member.role_ids:
                if overwrite.target_id == everyone_id:
                    continue
                allow |= overwrite.allow
                deny |= overwrite.deny
        permissions &= ~deny
        permissions |= allow
        for overwrite in channel.overwrites:
            if not overwrite.is_role and overwrite.target_id == member.user_id:
                permissions &= ~overwrite.deny
                permissions |= overwrite.allow
        if not permissions & VIEW_CHANNEL:
            return 0

    current = time.time() if now is None else now
    if member.timed_out_until is not None and member.timed_out_until > current:
        permissions &= VIEW_CHANNEL | READ_MESSAGE_HISTORY
    return permissions


@dataclass(frozen=True)
class ChannelAccess:
    channel: ChannelInfo
    permissions: int

    @property
    def can_read(self) -> bool:
        need = VIEW_CHANNEL | READ_MESSAGE_HISTORY
        return self.permissions & need == need and self.channel.bot_can_read

    @property
    def can_send(self) -> bool:
        if self.channel.kind == "forum":
            return False  # 포럼에는 글(스레드) 안에만 쓸 수 있다
        if self.channel.kind == "thread" and self.channel.thread_locked:
            if not self.permissions & MANAGE_THREADS:
                return False  # 잠긴 글: 웹훅은 막히지 않으므로 여기서 막는다
        flag = SEND_MESSAGES_IN_THREADS if self.channel.kind == "thread" else SEND_MESSAGES
        return bool(self.permissions & flag) and self.can_read

    @property
    def can_create_post(self) -> bool:
        """포럼에 새 글: 포럼 채널의 '메시지 보내기' 권한."""
        return (
            self.channel.kind == "forum"
            and bool(self.permissions & SEND_MESSAGES)
            and self.can_read
        )

    @property
    def can_use_moderated_tags(self) -> bool:
        return bool(self.permissions & MANAGE_THREADS)

    @property
    def can_mention_everyone(self) -> bool:
        """웹훅은 @everyone 권한을 따지지 않아, 본인 권한이 있을 때만 허용한다."""
        return bool(self.permissions & MENTION_EVERYONE)


class PermissionService:
    def __init__(self, directory: Directory, clock: Callable[[], float] = time.monotonic) -> None:
        self.directory = directory
        self.clock = clock
        self._members: OrderedDict[tuple[int, int], tuple[float, MemberInfo | None]] = OrderedDict()

    # ------------------------------------------------------------ 멤버 캐시

    async def member(self, guild_id: int, user_id: int) -> MemberInfo | None:
        key = (guild_id, user_id)
        now = self.clock()
        cached = self._members.get(key, _MISSING)
        if cached is not _MISSING:
            stored_at, value = cached  # type: ignore[misc]
            if now - stored_at < MEMBER_TTL_SEC:
                self._members.move_to_end(key)
                return value
        value = await self.directory.fetch_member(guild_id, user_id)
        self._members[key] = (now, value)
        self._members.move_to_end(key)
        while len(self._members) > MEMBER_CACHE_MAX:
            self._members.popitem(last=False)
        return value

    def forget_member(self, guild_id: int, user_id: int | None = None) -> None:
        """역할이 바뀌었거나 나갔을 때. user_id가 없으면 그 서버 전체."""
        if user_id is not None:
            self._members.pop((guild_id, user_id), None)
            return
        for key in [key for key in self._members if key[0] == guild_id]:
            del self._members[key]

    # ------------------------------------------------------------ 판단

    async def channel_access(self, user_id: int, channel_id: int) -> ChannelAccess | None:
        """볼 수 없으면 None(없는 채널과 구분하지 않는다)."""
        channel = self.directory.channel(channel_id)
        if channel is None:
            channel = await self.directory.fetch_channel(channel_id)  # 보관된 스레드 등
        if channel is None or channel.private_thread:
            return None  # 비공개 스레드는 참여 여부를 알 수 없어 1차에서는 막는다
        guild = self.directory.guild(channel.guild_id)
        if guild is None:
            return None
        member = await self.member(guild.id, user_id)
        if member is None:
            return None
        access = ChannelAccess(channel, compute_permissions(guild, member, channel))
        return access if access.can_read else None

    async def can_read(self, user_id: int, channel_id: int) -> bool:
        return await self.channel_access(user_id, channel_id) is not None

    async def visible_guilds(self, user_id: int) -> list[GuildInfo]:
        result = []
        for guild in self.directory.guilds():
            if await self.member(guild.id, user_id) is not None:
                result.append(guild)
        return result

    async def visible_channels(self, user_id: int, guild_id: int) -> list[ChannelAccess] | None:
        """서버 멤버가 아니면 None."""
        guild = self.directory.guild(guild_id)
        if guild is None:
            return None
        member = await self.member(guild_id, user_id)
        if member is None:
            return None
        result = []
        for channel in self.directory.channels(guild_id):
            access = ChannelAccess(channel, compute_permissions(guild, member, channel))
            if access.can_read:
                result.append(access)
        return result
