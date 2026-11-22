"""ㅁㅇㅅ 봇 명령어(2026-11-22 사용자 요청).

디스코드 슬래시 명령과 ㅁㅇㅅ 웹 입력칸이 같은 일을 한다.

- /점메추, /메뉴판, /메뉴추가 <메뉴> [공통], /메뉴삭제 <메뉴>  (R4NBOT에서 옮김, services/menu.py)
- /todo 보기 [오늘|내일|YYYY-MM-DD], /todo 추가 <이름> [날짜] [HH:MM] [@장소],
  /todo 완료 <번호 또는 이름>  (TODO를 쓸 수 있는 계정만)

웹에서는 입력칸 글이 '/'로 시작하고 아는 명령이면 메시지로 보내지 않고 여기서 실행한다.
점메추는 디스코드처럼 채널에 봇 메시지로 올리고, 나머지 결과는 쓴 사람에게만 보인다.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from mos.db.database import Database
from mos.services.menu import EMPTY, MenuError, MenuService
from mos.services.todo import TodoError, TodoService
from mos.services.todo_access import TodoAccess

TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHORT_DAY_RE = re.compile(r"^(\d{1,2})[/.](\d{1,2})$")

COMMANDS = [
    {"name": "점메추", "usage": "/점메추", "help": "오늘의 점심 메뉴 추천(리롤 가능)"},
    {"name": "메뉴판", "usage": "/메뉴판", "help": "이 서버에서 보이는 전체 메뉴"},
    {"name": "메뉴추가", "usage": "/메뉴추가 <메뉴> [공통]", "help": "이 서버에 메뉴 추가"},
    {"name": "메뉴삭제", "usage": "/메뉴삭제 <메뉴>", "help": "이 서버에서 메뉴 삭제"},
    {
        "name": "todo 보기",
        "usage": "/todo 보기 [오늘|내일|날짜]",
        "help": "그날 TODO",
        "todo": True,
    },
    {
        "name": "todo 추가",
        "usage": "/todo 추가 <이름> [날짜] [HH:MM] [@장소]",
        "help": "TODO 넣기(첫 카테고리)",
        "todo": True,
    },
    {
        "name": "todo 완료",
        "usage": "/todo 완료 <번호|이름>",
        "help": "TODO 완료 표시",
        "todo": True,
    },
]


@dataclass
class CommandResult:
    text: str
    """쓴 사람에게만 보이는 결과(점메추는 채널에 올린 뒤 안내)"""
    session: str | None = None
    """점메추 리롤에 쓰는 값"""


class CommandError(ValueError):
    pass


class BotCommands:
    def __init__(
        self,
        db: Database,
        menu: MenuService,
        todo: TodoService,
        access: TodoAccess,
        operator_id: int | None,
    ) -> None:
        self.db = db
        self.menu = menu
        self.todo = todo
        self.access = access
        self.operator_id = operator_id
        self.display_name: Callable[[int], Awaitable[str]] | None = None

    # ------------------------------------------------------------ 공용

    def known(self, text: str) -> bool:
        head = text.strip().split(maxsplit=1)[0] if text.strip() else ""
        return head in ("/점메추", "/메뉴판", "/메뉴추가", "/메뉴삭제", "/todo", "/TODO")

    def available(self, user_id: int) -> list[dict[str, Any]]:
        """입력칸에서 '/'를 쓰면 보여 줄 명령(TODO는 쓸 수 있는 계정만)."""
        todo_ok = self.access.allowed(user_id)
        return [
            {key: value for key, value in item.items() if key != "todo"}
            for item in COMMANDS
            if not item.get("todo") or todo_ok
        ]

    async def account_of(self, user_id: int) -> int | None:
        row = await self.db.fetch_one(
            "SELECT id FROM account WHERE discord_user_id = ? AND status = 'active'", (user_id,)
        )
        return int(row[0]) if row else None

    # ------------------------------------------------------------ 웹 입력칸

    async def run_text(
        self, user_id: int, guild_id: int | None, text: str
    ) -> tuple[str, CommandResult | None, str | None]:
        """(명령, 결과, 점메추면 '채널에 올릴 것' 표시). 점메추는 부르는 쪽이 채널에 올린다."""
        parts = text.strip().split(maxsplit=1)
        head, rest = parts[0], (parts[1] if len(parts) > 1 else "")
        if head == "/점메추":
            return "점메추", None, "post"
        if head == "/메뉴판":
            return "메뉴판", CommandResult(await self.menu.board(guild_id)), None
        if head == "/메뉴추가":
            words = rest.split()
            common = bool(words) and words[-1] in ("공통", "공통=예")
            name = " ".join(words[:-1] if common else words)
            return "메뉴추가", await self.menu_add(user_id, guild_id, name, common), None
        if head == "/메뉴삭제":
            return "메뉴삭제", await self.menu_remove(guild_id, rest), None
        sub = rest.split(maxsplit=1)
        action, arg = (sub[0], sub[1] if len(sub) > 1 else "") if sub else ("보기", "")
        if action == "보기":
            return "todo", await self.todo_view(user_id, arg), None
        if action == "추가":
            return "todo", await self.todo_add_text(user_id, arg), None
        if action == "완료":
            return "todo", await self.todo_done(user_id, arg), None
        return "todo", CommandResult("쓸 수 있는 것: /todo 보기, /todo 추가, /todo 완료"), None

    # ------------------------------------------------------------ 메뉴

    async def menu_add(
        self, user_id: int, guild_id: int | None, name: str, common: bool
    ) -> CommandResult:
        try:
            text = await self.menu.add(
                guild_id, name, common, self.operator_id is not None and user_id == self.operator_id
            )
        except MenuError as error:
            text = str(error)
        return CommandResult(text)

    async def menu_remove(self, guild_id: int | None, name: str) -> CommandResult:
        try:
            text = await self.menu.remove(guild_id, name)
        except MenuError as error:
            text = str(error)
        return CommandResult(text)

    async def menu_start(self, guild_id: int | None, user_id: int, who: str = ""):
        roll = await self.menu.start(guild_id, user_id, who)
        if roll is None:
            raise CommandError(EMPTY)
        return roll

    # ------------------------------------------------------------ TODO

    async def _todo_account(self, user_id: int) -> tuple[int, str]:
        if not self.access.allowed(user_id):
            raise CommandError("TODO는 아직 쓸 수 없는 계정이에요.")
        account_id = await self.account_of(user_id)
        if account_id is None:
            raise CommandError("ㅁㅇㅅ에 가입한 뒤 쓸 수 있어요.")
        prefs = await self.todo.alert_prefs(account_id)
        try:
            zone = ZoneInfo(prefs["tz"])
        except Exception:
            zone = ZoneInfo("Asia/Seoul")
        return account_id, datetime.now(zone).date().isoformat()

    @staticmethod
    def _day(word: str, today: str) -> str | None:
        base = date.fromisoformat(today)
        if word in ("오늘", ""):
            return today
        if word == "내일":
            return (base + timedelta(days=1)).isoformat()
        if word == "모레":
            return (base + timedelta(days=2)).isoformat()
        if DAY_RE.match(word):
            return word
        short = SHORT_DAY_RE.match(word)
        if short:
            try:
                value = date(base.year, int(short.group(1)), int(short.group(2)))
            except ValueError:
                return None
            if value < base - timedelta(days=180):
                value = value.replace(year=base.year + 1)
            return value.isoformat()
        return None

    async def _list(self, account_id: int, day: str) -> list[dict[str, Any]]:
        data = await self.todo.day(account_id, day)
        items = data["items"]
        items.sort(key=lambda item: (item["done"], item["time"] or "99", item["title"]))
        return items

    async def todo_view(self, user_id: int, arg: str) -> CommandResult:
        try:
            account_id, today = await self._todo_account(user_id)
        except CommandError as error:
            return CommandResult(str(error))
        day = self._day(arg.strip(), today)
        if day is None:
            return CommandResult("날짜는 오늘, 내일, 11/23, 2026-11-23처럼 써 주세요.")
        items = await self._list(account_id, day)
        value = date.fromisoformat(day)
        head = f"📋 {value.month}월 {value.day}일 ({'월화수목금토일'[value.weekday()]}) TODO"
        if not items:
            return CommandResult(f"{head}\n없어요.")
        lines = [head]
        for number, item in enumerate(items, start=1):
            mark = "✅" if item["done"] else "⬜"
            meta = " ".join(
                part
                for part in (item["time"] or "", f"@{item['place']}" if item["place"] else "")
                if part
            )
            lines.append(f"{number}. {mark} {item['title']}" + (f"  {meta}" if meta else ""))
        lines.append("완료: /todo 완료 <번호>")
        return CommandResult("\n".join(lines))

    async def todo_add_text(self, user_id: int, arg: str) -> CommandResult:
        """'/todo 추가 치과 내일 15:00 @강남역' 모양: 이름 뒤에 날짜, 시각, @장소를 아무 순서로."""
        words = arg.split()
        day_word, time_value, place = "", None, None
        title_words = []
        for word in words:
            if word.startswith("@") and len(word) > 1 and place is None:
                place = word[1:]
            elif TIME_RE.match(word) and time_value is None:
                hour, minute = word.split(":")
                time_value = f"{int(hour):02d}:{minute}"
            elif (
                word in ("오늘", "내일", "모레") or DAY_RE.match(word) or SHORT_DAY_RE.match(word)
            ) and not day_word:
                day_word = word
            else:
                title_words.append(word)
        return await self.todo_add(user_id, " ".join(title_words), day_word, time_value, place)

    async def todo_add(
        self,
        user_id: int,
        title: str,
        day_word: str = "",
        time_value: str | None = None,
        place: str | None = None,
    ) -> CommandResult:
        try:
            account_id, today = await self._todo_account(user_id)
        except CommandError as error:
            return CommandResult(str(error))
        if not title.strip():
            return CommandResult(
                "이름을 써 주세요. 예시 모양: /todo 추가 <이름> [날짜] [HH:MM] [@장소]"
            )
        day = self._day(day_word.strip(), today)
        if day is None:
            return CommandResult("날짜는 오늘, 내일, 11/23, 2026-11-23처럼 써 주세요.")
        categories = [c for c in await self.todo.categories(account_id) if c["closed_at"] is None]
        if not categories:
            return CommandResult("열린 카테고리가 없어요.")
        body = {
            "title": title.strip(),
            "day": day,
            "time": time_value,
            "place": place,
            "category_id": str(categories[0]["id"]),
        }
        try:
            await self.todo.add_item(account_id, body)
        except TodoError as error:
            return CommandResult(f"넣지 못했어요({error.code}).")
        meta = " ".join(part for part in (time_value or "", f"@{place}" if place else "") if part)
        return CommandResult(
            f"✅ {day} [{categories[0]['name']}] {title.strip()}" + (f"  {meta}" if meta else "")
        )

    async def todo_done(self, user_id: int, arg: str) -> CommandResult:
        try:
            account_id, today = await self._todo_account(user_id)
        except CommandError as error:
            return CommandResult(str(error))
        items = await self._list(account_id, today)
        target = arg.strip()
        found = None
        if target.isdigit() and 1 <= int(target) <= len(items):
            found = items[int(target) - 1]
        else:
            matches = [item for item in items if item["title"] == target and not item["done"]]
            found = matches[0] if matches else None
        if found is None:
            return CommandResult("오늘 TODO에서 찾지 못했어요. /todo 보기로 번호를 확인해 주세요.")
        await self.todo.update_item(account_id, found["id"], {"done": True})
        return CommandResult(f"✅ 완료: {found['title']}")
