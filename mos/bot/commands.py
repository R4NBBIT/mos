"""ㅁㅇㅅ 봇 슬래시 명령(2026-11-22 사용자 요청): 점메추(R4NBOT에서 옮김)와 TODO.

일은 services/commands.py(BotCommands)와 services/menu.py(MenuService)가 하고,
여기서는 디스코드 명령을 등록하고 결과를 보여 준다. ㅁㅇㅅ 웹 입력칸도 같은 서비스를 쓴다.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal

import discord
from discord import app_commands

from mos.services.commands import TODO_HELP, CommandError
from mos.services.menu import EMPTY, MenuError

if TYPE_CHECKING:
    from mos.bot.client import MosBot

log = logging.getLogger(__name__)


class MenuView(discord.ui.View):
    """점메추 리롤 단추. 기록과 30초 마무리는 MenuService가 한다(웹 리롤과 같은 기록)."""

    def __init__(self, bot: MosBot, session: str) -> None:
        super().__init__(timeout=None)
        self.bot = bot
        self.session = session

    @discord.ui.button(label="🎲 리롤", style=discord.ButtonStyle.blurple)
    async def reroll(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        menu = self.bot.menu
        if menu is None:
            return
        try:
            roll = menu.reroll(self.session, interaction.user.id)
        except MenuError as error:
            await interaction.response.send_message(str(error), ephemeral=True)
            return
        await interaction.response.edit_message(content=menu.text(roll), view=self)


class ChoiceView(discord.ui.View):
    """/todo가 되물을 때(오전, 오후) 고르는 단추. 누르면 고른 말로 다시 실행한다."""

    def __init__(self, bot: MosBot, user_id: int, choices: list[tuple[str, str]]) -> None:
        super().__init__(timeout=300)
        self.bot = bot
        self.user_id = user_id
        for label, text in choices[:20]:
            button: discord.ui.Button[ChoiceView] = discord.ui.Button(
                label=label[:80], style=discord.ButtonStyle.secondary
            )
            button.callback = self._runner(text)
            self.add_item(button)

    def _runner(self, text: str):
        async def run(interaction: discord.Interaction) -> None:
            if interaction.user.id != self.user_id or self.bot.commands is None:
                await interaction.response.send_message("이 단추는 쓸 수 없어요.", ephemeral=True)
                return
            said = text.removeprefix("/todo").strip()
            result = await self.bot.commands.todo_text(interaction.user.id, said)
            # 또 물어보면(오전/오후 다음 카테고리) 새 단추로
            view = ChoiceView(self.bot, self.user_id, result.choices) if result.choices else None
            await interaction.response.edit_message(content=result.text, view=view)

        return run


def register_commands(bot: MosBot) -> None:
    tree = bot.tree

    @tree.command(name="점메추", description="오늘의 점심 메뉴 추천")
    async def recommend(interaction: discord.Interaction) -> None:
        if bot.commands is None or bot.menu is None:
            await interaction.response.send_message("잠시 후 다시 해 주세요.", ephemeral=True)
            return
        guild_id = interaction.guild.id if interaction.guild else None
        try:
            roll = await bot.commands.menu_start(guild_id, interaction.user.id)
        except CommandError:
            await interaction.response.send_message(EMPTY)
            return
        await interaction.response.send_message(
            bot.menu.text(roll), view=MenuView(bot, roll.session)
        )
        message = await interaction.original_response()
        bot.menu.posted(roll, interaction.channel_id or 0, message.id)

    @tree.command(name="메뉴판", description="전체 메뉴 보기")
    async def board(interaction: discord.Interaction) -> None:
        if bot.menu is None:
            return
        guild_id = interaction.guild.id if interaction.guild else None
        await interaction.response.send_message(await bot.menu.board(guild_id), ephemeral=True)

    # 메뉴추가, 메뉴삭제는 운영자 전용(2026-11-23 사용자 요청). default_permissions()를 비워 두면
    # 서버 관리자가 아닌 사람에게는 명령 목록에도 안 보인다. 실행할 때도 운영자인지 다시 본다.
    @tree.command(name="메뉴추가", description="메뉴 추가 (운영자 전용, 기본: 이 서버에만 적용)")
    @app_commands.default_permissions()
    @app_commands.rename(name="메뉴", common="공통")
    @app_commands.describe(
        name="추가할 메뉴 이름", common="예로 하면 모든 서버 공통 메뉴에 추가(운영자만)"
    )
    async def add_menu(
        interaction: discord.Interaction, name: str, common: Literal["예", "아니오"] = "아니오"
    ) -> None:
        if bot.commands is None:
            return
        guild_id = interaction.guild.id if interaction.guild else None
        try:
            result = await bot.commands.menu_add(
                interaction.user.id, guild_id, name, common == "예"
            )
        except CommandError as error:
            await interaction.response.send_message(str(error), ephemeral=True)
            return
        await interaction.response.send_message(result.text, ephemeral=True)

    @tree.command(name="메뉴삭제", description="메뉴 삭제 (운영자 전용, 이 서버에만 적용)")
    @app_commands.default_permissions()
    @app_commands.rename(name="메뉴")
    @app_commands.describe(name="삭제할 메뉴 이름")
    async def remove_menu(interaction: discord.Interaction, name: str) -> None:
        if bot.commands is None:
            return
        guild_id = interaction.guild.id if interaction.guild else None
        try:
            result = await bot.commands.menu_remove(interaction.user.id, guild_id, name)
        except CommandError as error:
            await interaction.response.send_message(str(error), ephemeral=True)
            return
        await interaction.response.send_message(result.text, ephemeral=True)

    @tree.command(name="todo", description=TODO_HELP)
    @app_commands.rename(said="할말")
    @app_commands.describe(said="하고 싶은 말(비우면 오늘 TODO, '도움말'이면 쓰는 법)")
    async def todo_command(interaction: discord.Interaction, said: str = "") -> None:
        if bot.commands is None:
            return
        result = await bot.commands.todo_text(interaction.user.id, said)
        view = ChoiceView(bot, interaction.user.id, result.choices) if result.choices else None
        if view is None:
            await interaction.response.send_message(result.text, ephemeral=True)
        else:
            await interaction.response.send_message(result.text, ephemeral=True, view=view)

    _ = (recommend, board, add_menu, remove_menu, todo_command)


class BotMenuPoster:
    """MenuPoster: ㅁㅇㅅ 웹에서 부른 점메추를 채널에 봇 메시지로 올리고 고친다."""

    def __init__(self, bot: MosBot) -> None:
        self.bot = bot

    async def post_menu(self, channel_id: int, content: str, session: str) -> int:
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            channel = await self.bot.fetch_channel(channel_id)
        if not isinstance(channel, discord.TextChannel | discord.Thread):
            raise CommandError("이 채널에는 올릴 수 없어요.")
        message = await channel.send(
            content,
            view=MenuView(self.bot, session),
            allowed_mentions=discord.AllowedMentions.none(),
        )
        return message.id

    async def edit_menu(self, channel_id: int, message_id: int, content: str, button: bool) -> None:
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            channel = await self.bot.fetch_channel(channel_id)
        if not isinstance(channel, discord.TextChannel | discord.Thread):
            return
        message = channel.get_partial_message(message_id)
        session_view = None
        if button and self.bot.menu is not None:
            roll = self.bot.menu.by_message(message_id)
            session_view = MenuView(self.bot, roll.session) if roll else None
        await message.edit(
            content=content, view=session_view, allowed_mentions=discord.AllowedMentions.none()
        )
