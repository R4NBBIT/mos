"""점메추(점심 메뉴 추천). R4NBOT의 메뉴 기능을 ㅁㅇㅅ 봇으로 옮긴 것(2026-11-22 사용자 요청).

메뉴는 두 종류:
- 공통 메뉴: mos/data/menu.txt + 운영자가 더한 것(menu_override scope 0).
  모든 서버가 같이 씀
- 서버 메뉴: 서버에서 더한 것(added). 공통 메뉴를 지우면 실제로 지우지 않고
  그 서버에서만 숨김(removed)
보이는 메뉴 = (공통 - 이 서버에서 숨긴 것) + 이 서버에서 더한 것.
DM(서버 없음)은 공통 메뉴만.

추천은 채널에 봇 메시지로 올리고 '리롤' 단추를 단다.
디스코드 단추와 ㅁㅇㅅ 웹의 리롤이 같은 기록을 쓴다.
마지막으로 뽑은 뒤 30초가 지나면 추천 기록으로 마무리하고 단추를 없앤다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from mos.db.database import Database

log = logging.getLogger(__name__)

MENU_FILE = Path(__file__).resolve().parent.parent / "data" / "menu.txt"
COMMON = 0
MAX_NAME = 40
REROLL_WINDOW_SEC = 30
EMPTY = "메뉴가 비어있어요 😢"


class MenuError(ValueError):
    pass


class MenuPoster(Protocol):
    """봇이 구현: 채널에 추천 메시지 올리기와 고치기."""

    async def post_menu(self, channel_id: int, content: str, session: str) -> int: ...

    async def edit_menu(
        self, channel_id: int, message_id: int, content: str, button: bool
    ) -> None: ...


@dataclass
class MenuRoll:
    """추천 한 번(메시지 하나)의 기록."""

    session: str
    author_id: int
    menus: list[str]
    channel_id: int = 0
    message_id: int = 0
    history: list[str] = field(default_factory=list)
    rerolls: int = 0
    timer: asyncio.Task[None] | None = None


def _clean_name(raw: object) -> str:
    if not isinstance(raw, str):
        raise MenuError("메뉴 이름을 써 주세요.")
    name = " ".join(raw.split())
    if not name or len(name) > MAX_NAME:
        raise MenuError(f"메뉴 이름은 1~{MAX_NAME}자로 써 주세요.")
    return name


def live_text(roll: MenuRoll, who: str = "") -> str:
    head = f"{who}\n" if who else ""
    return f"{head}🍽️ 오늘의 추천 메뉴는 **{roll.history[-1]}**!\n└ 🎲 리롤: {roll.rerolls}회"


def final_text(roll: MenuRoll, who: str = "") -> str:
    counts = Counter(roll.history)
    ordered = list(dict.fromkeys(roll.history))
    history = ", ".join(f"{m} x{counts[m]}" if counts[m] > 1 else m for m in ordered)
    text = f"{live_text(roll, who)}\n\n📜 추천 기록\n{history}\n"
    if roll.rerolls > 0:
        text += "\n_이쯤 되면 그냥 먹자!_"
    return text


class MenuService:
    def __init__(self, db: Database, clock: Callable[[], float] = time.time) -> None:
        self.db = db
        self.clock = clock
        self.poster: MenuPoster | None = None  # 봇이 이어 줌
        self._rolls: dict[str, MenuRoll] = {}
        self._who: dict[str, str] = {}

    # ------------------------------------------------------------ 메뉴 목록

    def base_menus(self) -> list[str]:
        try:
            lines = MENU_FILE.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        return [line.strip() for line in lines if line.strip()]

    async def _overrides(self, scope: int) -> tuple[set[str], set[str]]:
        rows = await self.db.fetch_all(
            "SELECT name, kind FROM menu_override WHERE scope = ?", (scope,)
        )
        added = {str(r[0]) for r in rows if r[1] == "added"}
        removed = {str(r[0]) for r in rows if r[1] == "removed"}
        return added, removed

    async def common_menus(self) -> set[str]:
        added, _ = await self._overrides(COMMON)
        return set(self.base_menus()) | added

    async def menus(self, guild_id: int | None) -> list[str]:
        common = await self.common_menus()
        if guild_id is None:
            return sorted(common)
        added, removed = await self._overrides(guild_id)
        return sorted((common - removed) | added)

    async def _set(self, scope: int, name: str, kind: str | None) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM menu_override WHERE scope = ? AND name = ?", (scope, name)
            )
            if kind is not None:
                await conn.execute(
                    "INSERT INTO menu_override (scope, name, kind, created_at) VALUES (?, ?, ?, ?)",
                    (scope, name, kind, int(self.clock())),
                )

    async def add(
        self, guild_id: int | None, raw_name: object, common: bool, is_operator: bool
    ) -> str:
        name = _clean_name(raw_name)
        if common:
            if not is_operator:
                raise MenuError("⛔ 공통 메뉴 추가는 운영자만 할 수 있어요.")
            if name in await self.common_menus():
                raise MenuError("⚠️ 이미 등록된 공통 메뉴입니다.")
            await self._set(COMMON, name, "added")
            return f"✅ 공통 메뉴 추가 완료 (모든 서버에 적용): **{name}**"
        if guild_id is None:
            raise MenuError("❌ 서버 메뉴 추가는 서버 안에서만 할 수 있어요 (DM 불가).")
        common_menus = await self.common_menus()
        added, removed = await self._overrides(guild_id)
        if name in common_menus and name in removed:
            await self._set(guild_id, name, None)
            return f"✅ 메뉴를 다시 보이게 했어요 (이 서버에만 적용): **{name}**"
        if name in common_menus or name in added:
            raise MenuError("⚠️ 이미 등록된 메뉴입니다.")
        await self._set(guild_id, name, "added")
        return f"✅ 메뉴 추가 완료 (이 서버에만 적용): **{name}**"

    async def remove(self, guild_id: int | None, raw_name: object) -> str:
        name = _clean_name(raw_name)
        if guild_id is None:
            raise MenuError("❌ 메뉴 삭제는 서버 안에서만 할 수 있어요 (DM 불가).")
        added, removed = await self._overrides(guild_id)
        if name in added:
            await self._set(guild_id, name, None)
            return f"🗑️ 메뉴 삭제 완료 (이 서버에만 적용): **{name}**"
        if name in await self.common_menus() and name not in removed:
            await self._set(guild_id, name, "removed")
            return f"🗑️ 메뉴 삭제 완료 (공통 메뉴는 유지되고, 이 서버에서만 안 보여요): **{name}**"
        raise MenuError("❌ 해당 메뉴는 존재하지 않습니다.")

    async def board(self, guild_id: int | None) -> str:
        menus = await self.menus(guild_id)
        if not menus:
            return EMPTY
        return "🍽️ 메뉴판\n" + "\n".join(f"• {m}" for m in menus)

    # ------------------------------------------------------------ 추천과 리롤

    async def start(self, guild_id: int | None, author_id: int, who: str = "") -> MenuRoll | None:
        """새 추천(첫 메뉴를 뽑아 둔다). 메뉴가 없으면 None."""
        menus = await self.menus(guild_id)
        if not menus:
            return None
        roll = MenuRoll(session=secrets.token_urlsafe(9), author_id=author_id, menus=menus)
        roll.history.append(secrets.choice(menus))
        self._rolls[roll.session] = roll
        self._who[roll.session] = who
        return roll

    def text(self, roll: MenuRoll) -> str:
        return live_text(roll, self._who.get(roll.session, ""))

    def posted(self, roll: MenuRoll, channel_id: int, message_id: int) -> None:
        """메시지를 올렸다(30초 뒤 마무리)."""
        roll.channel_id, roll.message_id = channel_id, message_id
        self._arm(roll)

    def get(self, session: str) -> MenuRoll | None:
        return self._rolls.get(session)

    def by_message(self, message_id: int) -> MenuRoll | None:
        return next((r for r in self._rolls.values() if r.message_id == message_id), None)

    def reroll(self, session: str, user_id: int) -> MenuRoll:
        roll = self._rolls.get(session)
        if roll is None:
            raise MenuError("추천이 이미 끝났어요. 다시 /점메추를 써 주세요.")
        if user_id != roll.author_id:
            raise MenuError("⛔ /점메추를 쓴 사람만 다시 뽑을 수 있어요!")
        roll.rerolls += 1
        roll.history.append(secrets.choice(roll.menus))
        self._arm(roll)
        return roll

    def _arm(self, roll: MenuRoll) -> None:
        if roll.timer is not None:
            roll.timer.cancel()
        with contextlib.suppress(RuntimeError):  # 돌고 있는 이벤트 루프가 없으면(테스트) 생략
            roll.timer = asyncio.get_running_loop().create_task(self._finish_later(roll))

    async def _finish_later(self, roll: MenuRoll) -> None:
        await asyncio.sleep(REROLL_WINDOW_SEC)
        await self.finish(roll.session)

    async def finish(self, session: str) -> None:
        roll = self._rolls.pop(session, None)
        who = self._who.pop(session, "")
        if roll is None or self.poster is None or not roll.message_id:
            return
        try:
            await self.poster.edit_menu(
                roll.channel_id, roll.message_id, final_text(roll, who), button=False
            )
        except Exception:
            log.warning("점메추 마무리 메시지를 고치지 못함")
