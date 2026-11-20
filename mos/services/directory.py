"""API가 디스코드(봇 캐시)에서 필요한 정보의 모양. 봇이 구현하고, 테스트는 가짜로 바꾼다.

디스코드 객체를 그대로 넘기지 않고 필요한 값만 담은 불변 데이터로 바꿔서,
권한 계산(services/permissions.py)을 디스코드 없이 시험할 수 있게 한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

ChannelKind = Literal["text", "news", "forum", "thread"]


class DirectoryError(Exception):
    """디스코드에 잠깐 물어볼 수 없음(장애·요청 제한). API는 503으로 답한다."""


@dataclass(frozen=True)
class Overwrite:
    target_id: int
    is_role: bool
    allow: int
    deny: int


@dataclass(frozen=True)
class GuildInfo:
    id: int
    name: str
    icon_url: str | None
    owner_id: int
    # 역할 ID → 권한 값. @everyone 역할의 ID는 서버 ID와 같다
    role_permissions: dict[int, int] = field(default_factory=dict)


@dataclass(frozen=True)
class ChannelInfo:
    id: int
    guild_id: int
    name: str
    kind: ChannelKind
    position: int
    category_id: int | None = None
    category_name: str | None = None
    category_position: int = -1
    # 스레드면 부모 채널. 스레드의 권한은 부모 채널의 덮어쓰기를 따른다
    parent_id: int | None = None
    private_thread: bool = False
    overwrites: tuple[Overwrite, ...] = ()
    # 봇이 이 채널의 메시지를 읽을 수 있는지(못 읽으면 목록에서 뺀다)
    bot_can_read: bool = True


@dataclass(frozen=True)
class MemberInfo:
    guild_id: int
    user_id: int
    role_ids: frozenset[int]
    display_name: str
    avatar_url: str | None
    timed_out_until: float | None = None


class Directory(Protocol):
    def is_gateway_ready(self) -> bool: ...

    def guild_ids(self) -> set[int]: ...

    def guilds(self) -> list[GuildInfo]: ...

    def guild(self, guild_id: int) -> GuildInfo | None: ...

    def channels(self, guild_id: int) -> list[ChannelInfo]:
        """목록에 올릴 채널(글 채널·공지·포럼). 스레드는 빼고."""
        ...

    def channel(self, channel_id: int) -> ChannelInfo | None:
        """스레드도 포함. 스레드면 overwrites는 부모 채널 것."""
        ...

    async def fetch_member(self, guild_id: int, user_id: int) -> MemberInfo | None:
        """서버에 없으면 None. 캐시하지 않는다(PermissionService가 캐시)."""
        ...

    async def ensure_synced(self, channel_id: int) -> None:
        """이번 실행에서 처음 여는 채널이면 디스코드에서 최근·놓친 메시지를 받아 둔다."""
        ...

    async def fetch_older(self, channel_id: int, before_id: int, limit: int) -> int:
        """before_id보다 오래된 메시지를 디스코드에서 받아 저장. 받은 개수."""
        ...
