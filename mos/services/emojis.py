"""이모지 선택창·보내기에서 쓸 수 있는 사용자 이모지. 디스코드 니트로 규칙 그대로.

- 이 모임(서버)의 멈춘 이모지: 누구나
- 이 모임의 움직이는 이모지: 니트로만
- 다른 모임 이모지: 니트로 + 이 채널의 '외부 이모지 사용' 권한 + 그 모임 멤버
- 역할 전용 이모지: 그 역할이 있어야
웹훅은 이 규칙을 따지지 않으므로 보내기 전에 여기서 확인한다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from mos.services.directory import Directory, EmojiInfo
from mos.services.permissions import ChannelAccess, PermissionService

USE_EXTERNAL_EMOJIS = 1 << 18
_EMOJI_TOKEN = re.compile(r"<a?:[A-Za-z0-9_]{1,32}:(\d{15,21})>")


@dataclass(frozen=True)
class UsableEmoji:
    emoji: EmojiInfo
    group_name: str


class EmojiService:
    def __init__(self, directory: Directory, permissions: PermissionService) -> None:
        self.directory = directory
        self.permissions = permissions

    async def usable(self, user_id: int, premium: bool, access: ChannelAccess) -> list[UsableEmoji]:
        home = access.channel.guild_id
        external_ok = premium and bool(access.permissions & USE_EXTERNAL_EMOJIS)
        guilds = await self.permissions.visible_guilds(user_id)
        guilds.sort(key=lambda guild: (guild.id != home, guild.name.casefold()))
        result: list[UsableEmoji] = []
        for guild in guilds:
            if guild.id != home and not external_ok:
                continue
            member = await self.permissions.member(guild.id, user_id)
            if member is None:
                continue
            for emoji in self.directory.emojis(guild.id):
                if not emoji.available:
                    continue
                if emoji.role_ids and not emoji.role_ids & member.role_ids:
                    continue
                if emoji.animated and not premium:
                    continue
                result.append(UsableEmoji(emoji, guild.name))
        return result

    async def allowed_in(
        self, user_id: int, premium: bool, access: ChannelAccess, content: str
    ) -> bool:
        wanted = {int(match) for match in _EMOJI_TOKEN.findall(content)}
        if not wanted:
            return True
        usable = {item.emoji.id for item in await self.usable(user_id, premium, access)}
        return wanted <= usable
