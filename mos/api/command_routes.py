"""ㅁㅇㅅ 웹 입력칸의 봇 명령(/점메추, /메뉴판, /메뉴추가, /메뉴삭제, /todo).

디스코드 슬래시 명령과 같은 서비스(BotCommands)를 쓴다. 점메추는 채널에 봇 메시지로 올리고,
나머지 결과는 쓴 사람에게만 돌려준다(메시지로 보내지 않음).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, HTTPException, Request

from mos.api.rate_limit import RateLimiter
from mos.db.database import Database
from mos.services.commands import BotCommands, CommandError
from mos.services.menu import MenuError, MenuService
from mos.services.permissions import PermissionService
from mos.services.session import ActiveAccount


def register_command_routes(
    app: FastAPI,
    *,
    require_account: Callable[[Request], Awaitable[ActiveAccount]],
    commands: BotCommands,
    menu: MenuService,
    perms: PermissionService,
    db: Database,
    clock: Callable[[], float],
) -> None:
    limiter = RateLimiter(limit=5, window_sec=3, clock=clock)

    async def user(request: Request) -> ActiveAccount:
        account = await require_account(request)
        if not limiter.allow(f"cmd:{account.account_id}"):
            raise HTTPException(status_code=429, detail="too_many")
        return account

    async def body(request: Request) -> dict[str, Any]:
        try:
            data = await request.json()
        except ValueError as error:
            raise HTTPException(status_code=400, detail="bad_body") from error
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail="bad_body")
        return data

    @app.get("/api/commands")
    async def command_list(request: Request) -> dict[str, Any]:
        account = await require_account(request)
        return {"commands": commands.available(account.discord_user_id)}

    @app.post("/api/commands")
    async def command_run(request: Request) -> dict[str, Any]:
        account = await user(request)
        data = await body(request)
        text = data.get("text")
        if (
            not isinstance(text, str)
            or len(text) > 500
            or not commands.known(text, account.discord_user_id)
        ):
            raise HTTPException(status_code=400, detail="unknown_command")
        guild_id = None
        channel_id = 0
        raw_channel = data.get("channel_id")
        if isinstance(raw_channel, str) and raw_channel.isdigit():
            channel_id = int(raw_channel)
            access = await perms.channel_access(account.discord_user_id, channel_id)
            if access is None or not access.can_read:
                raise HTTPException(status_code=404, detail="not_found")
            guild_id = access.channel.guild_id
        name, result, action = await commands.run_text(account.discord_user_id, guild_id, text)
        if action == "post":
            if not channel_id:
                raise HTTPException(status_code=400, detail="need_channel")
            access = await perms.channel_access(account.discord_user_id, channel_id)
            if access is None or not access.can_send:
                raise HTTPException(status_code=403, detail="cannot_send")
            if menu.poster is None:
                raise HTTPException(status_code=503, detail="bot_not_ready")
            row = await db.fetch_one("SELECT name FROM account WHERE id = ?", (account.account_id,))
            who = f"**{row[0]}**님의 /점메추" if row else ""
            try:
                roll = await commands.menu_start(guild_id, account.discord_user_id, who)
                message_id = await menu.poster.post_menu(channel_id, menu.text(roll), roll.session)
            except CommandError as error:
                return {"command": name, "text": str(error), "session": None}
            menu.posted(roll, channel_id, message_id)
            return {
                "command": name,
                "text": "채널에 추천을 올렸어요. 30초 안에 다시 뽑을 수 있어요.",
                "session": roll.session,
                "pick": roll.history[-1],
            }
        if result is None:
            raise HTTPException(status_code=400, detail="unknown_command")
        return {
            "command": name,
            "text": result.text,
            "session": result.session,
            "choices": [{"label": label, "text": text} for label, text in result.choices],
        }

    @app.post("/api/commands/menu/{session}/reroll")
    async def command_reroll(session: str, request: Request) -> dict[str, Any]:
        account = await user(request)
        try:
            roll = menu.reroll(session, account.discord_user_id)
        except MenuError as error:
            return {"text": str(error), "session": None}
        if menu.poster is not None:
            await menu.poster.edit_menu(roll.channel_id, roll.message_id, menu.text(roll), True)
        return {
            "text": f"다시 뽑았어요: {roll.history[-1]} (리롤 {roll.rerolls}회)",
            "session": roll.session,
            "pick": roll.history[-1],
        }
