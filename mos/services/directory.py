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
class ForumTagInfo:
    id: int
    name: str
    emoji: str | None = None
    # 관리자(스레드 관리 권한)만 붙일 수 있는 태그
    moderated: bool = False


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
    # 잠긴 스레드·포럼 글. 웹훅은 잠금을 무시하고 써지므로 앱이 막는다(검증 결과)
    thread_locked: bool = False
    overwrites: tuple[Overwrite, ...] = ()
    # 봇이 이 채널의 메시지를 읽을 수 있는지(못 읽으면 목록에서 뺀다)
    bot_can_read: bool = True
    # 포럼: 고를 수 있는 태그, 태그가 꼭 있어야 하는지
    forum_tags: tuple[ForumTagInfo, ...] = ()
    require_tag: bool = False
    # 스레드(포럼 글): 붙은 태그, 보관 여부, 메시지 수, 만든 사람, 마지막 메시지, 보관된 때
    applied_tag_ids: tuple[int, ...] = ()
    archived: bool = False
    message_count: int = 0
    owner_id: int | None = None
    last_message_id: int | None = None
    archive_ts: float | None = None


@dataclass(frozen=True)
class StickerInfo:
    """모임 스티커. format: 1 PNG, 2 APNG, 3 Lottie(그림 파일 없음), 4 GIF"""

    id: int
    name: str
    format: int
    guild_id: int
    available: bool = True


@dataclass(frozen=True)
class EmojiInfo:
    id: int
    name: str
    animated: bool
    guild_id: int
    # 비어 있지 않으면 이 역할이 있는 사람만 쓸 수 있다
    role_ids: frozenset[int] = frozenset()
    available: bool = True


@dataclass(frozen=True)
class MemberInfo:
    guild_id: int
    user_id: int
    role_ids: frozenset[int]
    display_name: str
    avatar_url: str | None
    timed_out_until: float | None = None
    is_bot: bool = False


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

    def emojis(self, guild_id: int) -> list[EmojiInfo]: ...

    def stickers(self, guild_id: int) -> list[StickerInfo]:
        """그 모임의 스티커(봇이 받은 목록)."""
        ...

    async def sticker_image(self, sticker: StickerInfo) -> bytes:
        """스티커 그림 파일(PNG·APNG는 .png, GIF는 .gif). 디스코드 CDN에서 받는다."""
        ...

    async def fetch_member(self, guild_id: int, user_id: int) -> MemberInfo | None:
        """서버에 없으면 None. 캐시하지 않는다(PermissionService가 캐시)."""
        ...

    async def list_members(self, guild_id: int, limit: int) -> list[MemberInfo]:
        """서버 멤버를 limit명까지(디스코드에 물어본다). 캐시하지 않는다."""
        ...

    async def fetch_channel(self, channel_id: int) -> ChannelInfo | None:
        """캐시에 없는 채널(주로 보관된 스레드)을 디스코드에서 찾아 본다."""
        ...

    async def is_thread_member(self, thread_id: int, user_id: int) -> bool:
        """비공개 스레드에 그 사람이 들어가 있는지(디스코드에 물어본다)."""
        ...

    async def list_threads(
        self, parent_id: int, before: float | None, limit: int
    ) -> tuple[list[ChannelInfo], bool]:
        """(스레드 목록, 더 있음). before가 없으면 열린 스레드 + 보관된 첫 쪽,
        있으면 그 시각보다 먼저 보관된 것만."""
        ...

    async def ensure_synced(self, channel_id: int) -> None:
        """이번 실행에서 처음 여는 채널이면 디스코드에서 최근·놓친 메시지를 받아 둔다."""
        ...

    async def fetch_older(self, channel_id: int, before_id: int, limit: int) -> int:
        """before_id보다 오래된 메시지를 디스코드에서 받아 저장. 받은 개수."""
        ...
