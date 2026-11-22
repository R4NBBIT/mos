"""ㅁㅇㅅ 봇 명령어(2026-11-22 사용자 요청).

디스코드 슬래시 명령과 ㅁㅇㅅ 웹 입력칸이 같은 일을 한다.

- /점메추, /메뉴판, /메뉴추가 <메뉴> [공통], /메뉴삭제 <메뉴>  (R4NBOT에서 옮김, services/menu.py)
  메뉴추가, 메뉴삭제는 운영자(묘먕)만: 다른 사람에게는 목록에도 안 보이고
  실행도 안 된다(2026-11-23 사용자 요청)
- /todo <하고 싶은 말>  (TODO를 쓸 수 있는 계정만, 2026-11-23 사용자 요청: 하위 명령 대신 말 한 줄)
  LLM 없이 규칙으로 알아듣는다(services/todo_words.py): 넣기, 보기, 완료, 완료 취소, 옮기기.
  1~12시를 오전, 오후 없이 쓰면 고를 단추(choices)를 돌려준다. 삭제는 하지 않는다

웹에서는 입력칸 글이 '/'로 시작하고 아는 명령이면 메시지로 보내지 않고 여기서 실행한다.
점메추는 디스코드처럼 채널에 봇 메시지로 올리고, 나머지 결과는 쓴 사람에게만 보인다.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from mos.db.database import Database
from mos.services.menu import EMPTY, MenuError, MenuService
from mos.services.todo import TodoError, TodoService
from mos.services.todo_access import TodoAccess
from mos.services.todo_words import HOUR, Understood, understand

DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHORT_DAY_RE = re.compile(r"^(\d{1,2})[/.](\d{1,2})$")

COMMANDS = [
    {"name": "점메추", "usage": "/점메추", "help": "오늘의 점심 메뉴 추천(리롤 가능)"},
    {"name": "메뉴판", "usage": "/메뉴판", "help": "이 서버에서 보이는 전체 메뉴"},
    {
        "name": "메뉴추가",
        "usage": "/메뉴추가 <메뉴> [공통]",
        "help": "이 서버에 메뉴 추가(운영자만)",
        "operator": True,
    },
    {
        "name": "메뉴삭제",
        "usage": "/메뉴삭제 <메뉴>",
        "help": "이 서버에서 메뉴 삭제(운영자만)",
        "operator": True,
    },
    {
        "name": "todo",
        "usage": "/todo <하고 싶은 말>",
        "help": "TODO 넣기, 보기, 완료, 미루기를 말로(나만 보여요)",
        "todo": True,
    },
]


@dataclass
class CommandResult:
    text: str
    """쓴 사람에게만 보이는 결과(점메추는 채널에 올린 뒤 안내)"""
    session: str | None = None
    """점메추 리롤에 쓰는 값"""
    choices: list[tuple[str, str]] = field(default_factory=list)
    """고를 단추(보이는 글, 누르면 실행할 명령 글). 오전, 오후 묻기에 쓴다"""


class CommandError(ValueError):
    pass


OPERATOR_ONLY = "운영자만 쓸 수 있는 명령이에요."


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

    def is_operator(self, user_id: int) -> bool:
        return self.operator_id is not None and user_id == self.operator_id

    def known(self, text: str, user_id: int | None = None) -> bool:
        """그 사람이 쓸 수 있는 명령인지(운영자 전용은 운영자에게만 명령, 남에게는 그냥 글)."""
        head = text.strip().split(maxsplit=1)[0] if text.strip() else ""
        if head in ("/메뉴추가", "/메뉴삭제"):
            return user_id is not None and self.is_operator(user_id)
        return head in ("/점메추", "/메뉴판", "/todo", "/TODO")

    def available(self, user_id: int) -> list[dict[str, Any]]:
        """입력칸에서 '/'를 쓰면 보여 줄 명령(TODO는 쓸 수 있는 계정만, 메뉴 관리는 운영자만)."""
        todo_ok = self.access.allowed(user_id)
        operator = self.is_operator(user_id)
        return [
            {key: value for key, value in item.items() if key not in ("todo", "operator")}
            for item in COMMANDS
            if (not item.get("todo") or todo_ok) and (not item.get("operator") or operator)
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
            return "메뉴삭제", await self.menu_remove(user_id, guild_id, rest), None
        return "todo", await self.todo_text(user_id, rest), None

    # ------------------------------------------------------------ 메뉴

    async def menu_add(
        self, user_id: int, guild_id: int | None, name: str, common: bool
    ) -> CommandResult:
        if not self.is_operator(user_id):
            raise CommandError(OPERATOR_ONLY)
        try:
            text = await self.menu.add(guild_id, name, common, True)
        except MenuError as error:
            text = str(error)
        return CommandResult(text)

    async def menu_remove(self, user_id: int, guild_id: int | None, name: str) -> CommandResult:
        if not self.is_operator(user_id):
            raise CommandError(OPERATOR_ONLY)
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

    @staticmethod
    def _line(number: int, item: dict[str, Any]) -> str:
        mark = "✅" if item["done"] else "⬜"
        meta = " ".join(
            part
            for part in (item["time"] or "", f"@{item['place']}" if item["place"] else "")
            if part
        )
        return f"{number}. {mark} {item['title']}" + (f"  {meta}" if meta else "")

    @staticmethod
    def _day_word(day: str) -> str:
        value = date.fromisoformat(day)
        return f"{value.month}월 {value.day}일 ({'월화수목금토일'[value.weekday()]})"

    async def todo_view(self, user_id: int, day_word: str = "") -> CommandResult:
        try:
            account_id, today = await self._todo_account(user_id)
        except CommandError as error:
            return CommandResult(str(error))
        day = self._day(day_word.strip(), today) or today
        return await self._view(account_id, day)

    async def _view(self, account_id: int, day: str) -> CommandResult:
        items = await self._list(account_id, day)
        head = f"📋 {self._day_word(day)} TODO"
        if not items:
            return CommandResult(f"{head}\n없어요.")
        lines = [head, *(self._line(n, item) for n, item in enumerate(items, start=1))]
        return CommandResult("\n".join(lines))

    async def todo_text(self, user_id: int, raw: str) -> CommandResult:
        """'/todo 내일 오후 3시 강남역에서 치과 넣어줘', '/todo 오늘 뭐 있어',
        '/todo 1번 완료' 같은 말."""
        try:
            account_id, today = await self._todo_account(user_id)
        except CommandError as error:
            return CommandResult(str(error))
        categories = [c for c in await self.todo.categories(account_id) if c["closed_at"] is None]
        words = understand(raw, today, [str(c["name"]) for c in categories])
        if words.action == "view":
            return await self._view(account_id, words.days[0] if words.days else today)
        if words.action == "delete":
            return CommandResult("삭제는 ㅁㅇㅅ TODO 화면이나 연결한 AI에서 해 주세요.")
        if words.action in ("done", "undo", "move"):
            return await self._change(account_id, today, words)
        return await self._add(account_id, today, raw, words, categories)

    async def _add(
        self,
        account_id: int,
        today: str,
        raw: str,
        words: Understood,
        categories: list[dict[str, Any]],
    ) -> CommandResult:
        if not words.title:
            return CommandResult("무엇을 넣을지 이름을 써 주세요.")
        if words.ask is not None:
            hour = words.ask.label.split("시")[0]
            return CommandResult(
                f"{words.ask.label}가 오전인가요, 오후인가요?",
                choices=[
                    (f"오전 ({words.ask.am})", "/todo " + self._half(raw, hour, "오전")),
                    (f"오후 ({words.ask.pm})", "/todo " + self._half(raw, hour, "오후")),
                    ("시각 없이", "/todo " + self._no_time(raw)),
                ],
            )
        if not categories:
            return CommandResult("열린 카테고리가 없어요.")
        category = categories[0]
        if words.category:
            match = [c for c in categories if c["name"] == words.category]
            if not match:
                names = ", ".join(str(c["name"]) for c in categories)
                return CommandResult(
                    f"'{words.category}' 카테고리가 없어요. 열린 카테고리: {names}"
                )
            category = match[0]
        day = words.days[0] if words.days else today
        body = {
            "title": words.title,
            "day": day,
            "time": words.time,
            "place": words.place,
            "memo": words.memo or "",
            "category_id": str(category["id"]),
        }
        try:
            await self.todo.add_item(account_id, body)
        except TodoError as error:
            return CommandResult(f"넣지 못했어요({error.code}).")
        meta = " ".join(
            part for part in (words.time or "", f"@{words.place}" if words.place else "") if part
        )
        memo = "\n메모: " + words.memo if words.memo else ""
        return CommandResult(
            f"✅ 넣었어요: {self._day_word(day)} [{category['name']}] {words.title}"
            + (f"  {meta}" if meta else "")
            + memo
        )

    @staticmethod
    def _half(raw: str, hour: str, half: str) -> str:
        return re.sub(rf"(^|\s)({re.escape(hour)}시)", rf"\1{half} \2", raw, count=1).strip()

    @staticmethod
    def _no_time(raw: str) -> str:
        match = HOUR.search(raw)
        if not match:
            return raw.strip()
        start = match.start() + len(match[1] or "")
        return re.sub(r"\s+", " ", raw[:start] + " " + raw[match.end() :]).strip()

    async def _change(self, account_id: int, today: str, words: Understood) -> CommandResult:
        if words.action == "move":
            if len(words.days) >= 2:
                source, target = words.days[0], words.days[-1]
            else:
                source, target = today, words.days[0]
        else:
            source, target = (words.days[0] if words.days else today), ""
        items = await self._list(account_id, source)
        found: dict[str, Any] | None = None
        if words.number is not None:
            if 1 <= words.number <= len(items):
                found = items[words.number - 1]
        elif words.title:
            exact = [item for item in items if item["title"] == words.title]
            close = exact or [item for item in items if words.title in item["title"]]
            if words.action == "done":
                close = [item for item in close if not item["done"]] or close
            if len(close) > 1:
                lines = [self._line(items.index(item) + 1, item) for item in close]
                return CommandResult("여러 개가 있어요. 번호로 말해 주세요.\n" + "\n".join(lines))
            found = close[0] if close else None
        if found is None:
            view = await self._view(account_id, source)
            return CommandResult(f"{self._day_word(source)}에서 찾지 못했어요.\n{view.text}")
        if words.action == "move":
            try:
                await self.todo.update_item(account_id, found["id"], {"day": target})
            except TodoError as error:
                return CommandResult(f"옮기지 못했어요({error.code}).")
            return CommandResult(f"📅 옮겼어요: {found['title']} → {self._day_word(target)}")
        done = words.action == "done"
        await self.todo.update_item(account_id, found["id"], {"done": done})
        return CommandResult(
            f"✅ 완료: {found['title']}" if done else f"↩️ 완료 취소: {found['title']}"
        )
