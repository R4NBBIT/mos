from __future__ import annotations

import asyncio

from mos.services.directory import ChannelInfo, GuildInfo, MemberInfo, Overwrite
from mos.services.permissions import (
    ADMINISTRATOR,
    ALL_PERMISSIONS,
    READ_MESSAGE_HISTORY,
    SEND_MESSAGES,
    SEND_MESSAGES_IN_THREADS,
    VIEW_CHANNEL,
    ChannelAccess,
    PermissionService,
    compute_permissions,
)

GUILD = 100
ROLE_A = 201
ROLE_B = 202
USER = 300
BASIC = VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES

guild = GuildInfo(GUILD, "g", None, owner_id=999, role_permissions={GUILD: BASIC, ROLE_A: 0})


def member(*roles: int, timed_out_until: float | None = None) -> MemberInfo:
    return MemberInfo(GUILD, USER, frozenset({GUILD, *roles}), "u", None, timed_out_until)


def channel(*overwrites: Overwrite, kind: str = "text") -> ChannelInfo:
    return ChannelInfo(1, GUILD, "c", kind, 0, overwrites=overwrites)  # type: ignore[arg-type]


def test_owner_and_admin_get_everything() -> None:
    owner = GuildInfo(GUILD, "g", None, owner_id=USER, role_permissions={GUILD: 0})
    locked = channel(Overwrite(GUILD, True, 0, VIEW_CHANNEL))
    assert compute_permissions(owner, member(), locked) == ALL_PERMISSIONS
    admin_guild = GuildInfo(GUILD, "g", None, 999, {GUILD: 0, ROLE_A: ADMINISTRATOR})
    assert compute_permissions(admin_guild, member(ROLE_A), locked) == ALL_PERMISSIONS


def test_everyone_deny_then_role_allow() -> None:
    locked = channel(
        Overwrite(GUILD, True, 0, VIEW_CHANNEL), Overwrite(ROLE_A, True, VIEW_CHANNEL, 0)
    )
    assert compute_permissions(guild, member(), locked) == 0
    assert compute_permissions(guild, member(ROLE_A), locked) & VIEW_CHANNEL


def test_role_allow_beats_other_role_deny() -> None:
    # 역할끼리는 거부를 먼저 모두 빼고 허용을 모두 더한다 → 하나라도 허용이면 허용
    both = channel(
        Overwrite(ROLE_A, True, 0, SEND_MESSAGES), Overwrite(ROLE_B, True, SEND_MESSAGES, 0)
    )
    assert compute_permissions(guild, member(ROLE_A, ROLE_B), both) & SEND_MESSAGES


def test_member_overwrite_is_last() -> None:
    allow_role_deny_me = channel(
        Overwrite(ROLE_A, True, VIEW_CHANNEL, 0), Overwrite(USER, False, 0, VIEW_CHANNEL)
    )
    assert compute_permissions(guild, member(ROLE_A), allow_role_deny_me) == 0
    deny_everyone_allow_me = channel(
        Overwrite(GUILD, True, 0, VIEW_CHANNEL), Overwrite(USER, False, VIEW_CHANNEL, 0)
    )
    assert compute_permissions(guild, member(), deny_everyone_allow_me) & VIEW_CHANNEL


def test_overwrite_for_role_i_do_not_have_is_ignored() -> None:
    other_role = channel(Overwrite(ROLE_B, True, 0, VIEW_CHANNEL))
    assert compute_permissions(guild, member(ROLE_A), other_role) & VIEW_CHANNEL


def test_timeout_leaves_only_reading() -> None:
    perms = compute_permissions(guild, member(timed_out_until=2000.0), channel(), now=1000.0)
    assert perms == VIEW_CHANNEL | READ_MESSAGE_HISTORY
    after = compute_permissions(guild, member(timed_out_until=2000.0), channel(), now=3000.0)
    assert after & SEND_MESSAGES


def test_access_needs_history_and_bot_reading() -> None:
    no_history = GuildInfo(GUILD, "g", None, 999, {GUILD: VIEW_CHANNEL})
    perms = compute_permissions(no_history, member(), channel())
    assert not ChannelAccess(channel(), perms).can_read
    bot_blind = ChannelInfo(1, GUILD, "c", "text", 0, bot_can_read=False)
    assert not ChannelAccess(bot_blind, BASIC).can_read
    thread = channel(kind="thread")
    assert not ChannelAccess(thread, BASIC).can_send  # 스레드는 '스레드에서 보내기' 권한
    assert ChannelAccess(thread, BASIC | SEND_MESSAGES_IN_THREADS).can_send


class CountingDirectory:
    def __init__(self) -> None:
        self.calls = 0
        self.is_member = True

    async def fetch_member(self, guild_id: int, user_id: int) -> MemberInfo | None:
        self.calls += 1
        return member() if self.is_member else None


def test_member_cache_ttl_and_forget() -> None:
    directory = CountingDirectory()
    now = [0.0]
    service = PermissionService(directory, clock=lambda: now[0])  # type: ignore[arg-type]

    async def scenario() -> None:
        await service.member(GUILD, USER)
        await service.member(GUILD, USER)
        assert directory.calls == 1
        now[0] = 121
        await service.member(GUILD, USER)
        assert directory.calls == 2
        directory.is_member = False
        service.forget_member(GUILD)
        assert await service.member(GUILD, USER) is None
        assert directory.calls == 3

    asyncio.run(scenario())
