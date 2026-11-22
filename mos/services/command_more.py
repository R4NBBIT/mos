"""/todo로 AI(MCP)에서 할 수 있는 일을 거의 다.

2026-11-23 사용자 요청: 'LLM한테 시킬 수 있는 건 다'.

LLM 없이 규칙으로 알아듣는다. 넣기, 보기, 완료, 옮기기, 삭제는 commands.py가 하고
여기서는 그 밖의 일을 맡는다:

- TODO 고치기: '치과 시각 15:00으로', '치과 장소 강남역으로', '치과 메모 보험증으로',
  '치과 이름 치과 예약으로', '치과 카테고리 업무로'
- 카테고리: '카테고리 보여줘', '운동 카테고리 만들어줘', '운동 카테고리 끝내기/다시 열기/삭제'
- 반복: '반복 보여줘', '매일 9시 출근 반복 만들어줘', '출근 반복 끝내기', '출근 반복 삭제'
- 친구: '친구 보여줘', '라떼에게 친구 요청', '라떼 친구 수락', '라떼 친구 끊기',
  '라떼 비공개', '라떼 비공개 풀기'(예전 말 '차단'도 알아들음)
- 휴지통: '휴지통 보여줘', '휴지통 2번 되살려줘'

되돌리기 어려운 일(삭제, 끝내기, 친구 끊기, 비공개)은 [확인] [취소] 단추로 한 번 묻는다.
단추가 보내는 말은 '/todo 확인 <종류> <ID>'(사람이 쓰는 말이 아님).
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from mos.services.todo import TodoError, TodoService
from mos.services.todo_words import DATE_RULES, take_days, take_time

ACT = r"(?:해\s?줘|해\s?주세요|해|줘|주세요)?"
CONFIRM = re.compile(r"확인 (catclose|catdel|repend|repdel|unfriend|block) (\d{1,18})")
WEEK = "일월화수목금토"


@dataclass
class Reply:
    text: str
    choices: list[tuple[str, str]] = field(default_factory=list)


def _ask(text: str, kind: str, target: str, label: str) -> Reply:
    return Reply(text, [(label, f"/todo 확인 {kind} {target}"), ("취소", "/todo 삭제 취소")])


class MoreCommands:
    def __init__(
        self,
        todo: TodoService,
        friends: Any = None,
        trash_list: Callable[[int], Awaitable[list[dict[str, Any]]]] | None = None,
        trash_restore: Callable[[int, Any], Awaitable[bool]] | None = None,
    ) -> None:
        self.todo = todo
        self.friends = friends
        self.trash_list = trash_list
        self.trash_restore = trash_restore

    # ------------------------------------------------------------ 입구

    async def handle(
        self,
        account_id: int,
        today: str,
        raw: str,
        find_item: Callable[[str, str], Awaitable[tuple[dict[str, Any] | None, Reply | None]]],
        ask: Callable[[str], Reply] | None = None,
    ) -> Reply | None:
        """맡을 말이면 답, 아니면 None(넣기, 보기 같은 기본 말로 넘긴다).
        ask가 있으면 바꾸는 일은 하지 않고 '…할까요?'와 [확인] [취소]를 돌려준다."""
        text = re.sub(r"\s+", " ", raw).strip().rstrip(".!?")
        confirm = CONFIRM.fullmatch(text)
        if confirm:
            return await self._confirmed(account_id, today, confirm[1], confirm[2])
        for handler in (self._trash, self._friends, self._categories, self._repeats):
            reply = await handler(account_id, today, text, ask)
            if reply is not None:
                return reply
        return await self._edit(account_id, today, text, find_item, ask)

    # ------------------------------------------------------------ 확인 단추 뒤

    async def _confirmed(self, account_id: int, today: str, kind: str, target: str) -> Reply:
        try:
            if kind == "catclose":
                await self.todo.update_category(account_id, int(target), {"closed": True})
                return Reply(
                    "📁 카테고리를 끝냈어요. "
                    "카테고리 화면 아래 '끝낸 카테고리'에서 다시 열 수 있어요."
                )
            if kind == "catdel":
                await self.todo.delete_category(account_id, int(target))
                return Reply("🗑️ 카테고리를 삭제했어요. 휴지통에서 7일 동안 되돌릴 수 있어요.")
            if kind == "repend":
                await self.todo.end_repeat(account_id, target, today)
                return Reply("🔁 반복을 오늘까지만 하게 했어요. 지난 TODO는 그대로 남아요.")
            if kind == "repdel":
                await self.todo.delete_repeat_series(account_id, target, today)
                return Reply(
                    "🗑️ 반복을 삭제했어요. "
                    "오늘까지의 TODO는 남고, 휴지통에서 7일 동안 되돌릴 수 있어요."
                )
            if self.friends is None:
                return Reply("지금은 할 수 없어요.")
            if kind == "unfriend":
                await self.friends.remove(account_id, target)
                return Reply("친구를 끊었어요.")
            await self.friends.block(account_id, target)
            return Reply("🔒 비공개로 했어요. '이름 비공개 풀기'로 풀 수 있어요.")
        except TodoError as error:
            return Reply(f"하지 못했어요({error.code}).")

    # ------------------------------------------------------------ 휴지통

    async def _trash(
        self, account_id: int, _today: str, text: str, ask: Any = None
    ) -> Reply | None:
        if not text.startswith("휴지통") or self.trash_list is None:
            return None
        items = await self.trash_list(account_id)
        restore = re.search(r"(\d{1,2})\s?번", text)
        if restore and re.search(r"되살|복구|살려|돌려", text):
            number = int(restore[1])
            if not 1 <= number <= len(items) or self.trash_restore is None:
                return Reply("그 번호가 휴지통에 없어요.")
            if ask:
                return ask(f"휴지통에서 되살릴까요? {items[number - 1]['title']}")
            ok = await self.trash_restore(account_id, items[number - 1]["id"])
            return Reply(
                f"♻️ 되살렸어요: {items[number - 1]['title']}" if ok else "되살리지 못했어요."
            )
        if not items:
            return Reply("🗑️ 휴지통이 비어 있어요.")
        lines = [f"{n}. {item['title']} | {item['day']}" for n, item in enumerate(items[:20], 1)]
        return Reply(
            "🗑️ 휴지통(7일 동안)\n" + "\n".join(lines) + "\n되살리기: /todo 휴지통 1번 되살려줘"
        )

    # ------------------------------------------------------------ 친구

    async def _friends(
        self, account_id: int, _today: str, text: str, ask: Any = None
    ) -> Reply | None:
        if self.friends is None or not re.search(r"친구|차단|비공개", text):
            return None
        if re.fullmatch(
            r"(?:내\s?)?친구(?:\s?목록)?\s?(?:보여" + ACT + r"|알려" + ACT + r"|목록)?", text
        ):
            people = await self.friends.people(account_id)
            parts = [
                "👥 친구: " + (" | ".join(p["name"] for p in people["friends"]) or "없어요"),
            ]
            if people["incoming"]:
                parts.append("받은 요청: " + " | ".join(p["name"] for p in people["incoming"]))
            if people["outgoing"]:
                parts.append("보낸 요청: " + " | ".join(p["name"] for p in people["outgoing"]))
            if people["blocked"]:
                parts.append("비공개: " + " | ".join(p["name"] for p in people["blocked"]))
            return Reply("\n".join(parts))
        patterns = (
            ("request", r"(.+?)\s?(?:에게|한테|께)\s?친구\s?(?:요청|신청)" + ACT),
            ("accept", r"(.+?)(?:의)?\s?친구\s?(?:요청\s?)?(?:수락|받아)" + ACT),
            ("unfriend", r"(.+?)(?:랑|와|과)?\s?친구\s?(?:끊어|끊기|끊|삭제)" + ACT),
            ("unblock", r"(.+?)\s?(?:차단|비공개)\s?(?:풀어|풀기|해제)" + ACT),
            ("block", r"(.+?)\s?(?:차단|비공개)(?:로)?\s?" + ACT),
        )
        for kind, pattern in patterns:
            found = re.fullmatch(pattern, text)
            if found and kind in ("block", "unblock") and "카테고리" in found[1]:
                return (
                    None  # '회사 카테고리 비공개로' 같은 카테고리 공개 범위 말은 사람 비공개가 아님
                )
            if found:
                return await self._friend_action(account_id, kind, found[1].strip(), ask)
        return None

    async def _friend_action(self, account_id: int, kind: str, name: str, ask: Any = None) -> Reply:
        people = await self.friends.people(account_id)
        pools = {
            "request": people["candidates"] + people["incoming"],
            "accept": people["incoming"],
            "unfriend": people["friends"],
            "block": people["friends"]
            + people["incoming"]
            + people["outgoing"]
            + people["candidates"],
            "unblock": people["blocked"],
        }[kind]
        matches = [p for p in pools if p["name"] == name] or [
            p for p in pools if name.casefold() in p["name"].casefold()
        ]
        if not matches:
            return Reply(f"'{name}'을(를) 찾지 못했어요.")
        if len(matches) > 1:
            return Reply("같은 이름이 여럿이에요: " + " | ".join(p["name"] for p in matches))
        person = matches[0]
        words = {"request": "에게 친구 요청을 보낼까요?", "accept": "의 친구 요청을 수락할까요?"}
        if ask and kind in ("request", "accept", "unblock"):
            return ask(person["name"] + words.get(kind, " 비공개를 풀까요?"))
        try:
            if kind == "request":
                await self.friends.request(account_id, person["id"])
                return Reply(f"👋 {person['name']}에게 친구 요청을 보냈어요.")
            if kind == "accept":
                await self.friends.accept(account_id, person["id"])
                return Reply(f"🤝 {person['name']}와(과) 친구가 됐어요.")
            if kind == "unblock":
                await self.friends.unblock(account_id, person["id"])
                return Reply(f"{person['name']} 비공개를 풀었어요.")
        except TodoError as error:
            return Reply(f"하지 못했어요({error.code}).")
        if kind == "unfriend":
            return _ask(
                f"{person['name']}와(과) 친구를 끊을까요?", "unfriend", person["id"], "끊기"
            )
        return _ask(
            f"{person['name']}에게 비공개로 할까요? 친구와 요청이 끊기고 서로 TODO가 안 보여요.",
            "block",
            person["id"],
            "비공개",
        )

    # ------------------------------------------------------------ 카테고리

    async def _categories(
        self, account_id: int, _today: str, text: str, ask: Any = None
    ) -> Reply | None:
        if "카테고리" not in text:
            return None
        cats = await self.todo.categories(account_id)
        if re.fullmatch(r"카테고리\s?(?:목록|보여" + ACT + r"|알려" + ACT + r"|뭐\s?있어)?", text):
            open_names = [c["name"] for c in cats if c["closed_at"] is None]
            closed = [c["name"] for c in cats if c["closed_at"] is not None]
            reply = "📁 카테고리: " + (" | ".join(open_names) or "없어요")
            if closed:
                reply += "\n끝낸 카테고리: " + " | ".join(closed)
            return Reply(reply)
        found = re.fullmatch(
            r"(.+?)\s?카테고리\s?(만들어|추가|끝내|닫아|다시\s?열어|열어|삭제)(?:기|줘|해\s?줘|주세요)?",
            text,
        ) or re.fullmatch(
            r"카테고리\s?(.+?)\s?(만들어|추가|끝내|닫아|다시\s?열어|열어|삭제)(?:기|줘|해\s?줘|주세요)?",
            text,
        )
        if not found:
            return None
        name, verb = found[1].strip().strip("'\""), found[2]
        if verb in ("만들어", "추가"):
            if ask:
                return ask(f"'{name}' 카테고리를 만들까요? 나만 보이게 만들어져요.")
            try:
                await self.todo.create_category(account_id, {"name": name})
            except TodoError as error:
                return Reply(f"만들지 못했어요({error.code}).")
            return Reply(f"📁 '{name}' 카테고리를 만들었어요. 나만 보이게 만들어져요.")
        match = [c for c in cats if c["name"] == name]
        if not match:
            return Reply(f"'{name}' 카테고리가 없어요.")
        cat = match[0]
        if verb.replace(" ", "") in ("다시열어", "열어"):
            if ask:
                return ask(f"'{name}' 카테고리를 다시 열까요?")
            await self.todo.update_category(account_id, int(cat["id"]), {"closed": False})
            return Reply(f"📁 '{name}' 카테고리를 다시 열었어요.")
        if verb == "삭제":
            return _ask(
                f"'{name}' 카테고리를 삭제할까요? 안의 TODO와 반복도 같이 지워지고, "
                "휴지통에서 7일 동안 되돌릴 수 있어요.",
                "catdel",
                str(cat["id"]),
                "삭제",
            )
        return _ask(
            f"'{name}' 카테고리를 끝낼까요? 다시 열 수 있어요.",
            "catclose",
            str(cat["id"]),
            "끝내기",
        )

    # ------------------------------------------------------------ 반복

    async def _repeats(
        self, account_id: int, today: str, text: str, ask: Any = None
    ) -> Reply | None:
        if "반복" not in text:
            return None
        series = await self.todo.repeat_series(account_id, today)
        if re.fullmatch(r"반복\s?(?:목록|보여" + ACT + r"|알려" + ACT + r"|뭐\s?있어)?", text):
            live = [s for s in series if not s["ended"]]
            if not live:
                return Reply("🔁 반복이 없어요.")
            return Reply(
                "🔁 반복\n" + "\n".join(f"- {self._repeat_line(s['current'])}" for s in live)
            )
        ending = re.fullmatch(r"(.+?)\s?반복\s?(끝내|그만|삭제)(?:기|줘|해\s?줘|해|주세요)?", text)
        if ending:
            name = ending[1].strip()
            match = [s for s in series if s["current"]["title"] == name and not s["ended"]] or [
                s for s in series if name in s["current"]["title"] and not s["ended"]
            ]
            if not match:
                return Reply(f"'{name}' 반복을 찾지 못했어요.")
            if len(match) > 1:
                return Reply("같은 이름이 여럿이에요. 반복 화면에서 골라 주세요.")
            target = match[0]
            if ending[2] == "삭제":
                return _ask(
                    f"'{target['current']['title']}' 반복을 삭제할까요? "
                    "내일부터 생길 TODO만 지워지고 지난 것은 남아요.",
                    "repdel",
                    target["id"],
                    "삭제",
                )
            return _ask(
                f"'{target['current']['title']}' 반복을 오늘까지만 할까요?",
                "repend",
                target["id"],
                "끝내기",
            )
        if re.search(r"반복\s?(?:만들어|추가|넣어|등록)", text):
            return await self._new_repeat(account_id, today, text, ask)
        return None

    @staticmethod
    def _repeat_line(period: dict[str, Any]) -> str:
        rule = period["rule"]
        word = {
            "daily": "매일",
            "weekdays": "평일마다",
            "weekends": "주말마다",
            "monthly": "매달",
        }.get(rule, "매주 " + " ".join(WEEK[d] for d in period.get("weekdays", [])))
        return " | ".join(
            x
            for x in (period["title"], word, period.get("time") or "", period.get("place") or "")
            if x
        )

    async def _new_repeat(self, account_id: int, today: str, text: str, ask: Any = None) -> Reply:
        body = re.sub(r"\s?반복\s?(?:으로\s?)?(?:만들어|추가|넣어|등록)\S*", " ", text)
        rule, weekdays = None, []
        if re.search(r"매일", body):
            rule = "daily"
        elif re.search(r"평일", body):
            rule = "weekdays"
        elif re.search(r"주말", body):
            rule = "weekends"
        else:
            days = re.findall(r"([일월화수목금토])요일", body)
            if days:
                rule, weekdays = "weekly", sorted({WEEK.index(d) for d in days})
        if rule is None:
            return Reply("어떻게 반복할지 써 주세요(매일, 평일, 주말, 월요일 같은 요일).")
        body = re.sub(
            r"매일|평일(?:마다)?|주말(?:마다)?|매주|(?:[일월화수목금토]요일[,와과]?\s?)+(?:마다)?",
            " ",
            body,
        )
        clock, body = take_time(body)
        if clock is not None and not isinstance(clock, str):
            hour = clock.label.split("시")[0]
            particle = "이" if clock.label.endswith("분") else "가"

            def half(word: str) -> str:
                return re.sub(rf"(^|\s)({re.escape(hour)}시)", rf"\1{word} \2", text, count=1)

            return Reply(
                f"{clock.label}{particle} 오전인가요, 오후인가요?",
                [
                    (f"오전 ({clock.am})", f"/todo {half('오전')}"),
                    (f"오후 ({clock.pm})", f"/todo {half('오후')}"),
                ],
            )
        place = None
        where = re.search(r"(^|\s)(\S{1,20})에서(?=\s|$)", body) or re.search(
            r"(^|\s)@(\S{1,40})", body
        )
        if where:
            place = where[2]
            body = body[: where.start()] + " " + body[where.end() :]
        cats = [c for c in await self.todo.categories(account_id) if c["closed_at"] is None]
        category = None
        bracket = re.search(r"\[([^\]]{1,30})\]", body)
        if bracket:
            category = next((c for c in cats if c["name"] == bracket[1].strip()), None)
            body = body[: bracket.start()] + " " + body[bracket.end() :]
        title = re.sub(r"\s+", " ", body).strip()
        title = re.sub(r"(?:을|를)$", "", title).strip()
        if not title:
            return Reply("반복할 TODO 이름을 써 주세요.")
        if category is None:
            picks = [
                (str(c["name"]), f"/todo {text} [{c['name']}]")
                for c in cats
                if "]" not in str(c["name"])
            ]
            return Reply("어느 카테고리에 넣을까요?", picks[:20])
        period = {"title": title, "rule": rule, "weekdays": weekdays, "time": clock, "place": place}
        if ask:
            return ask(
                f"반복을 만들까요? {self._repeat_line(period)} | {category['name']} | 오늘부터"
            )
        try:
            await self.todo.new_repeat(
                account_id,
                {
                    "title": title,
                    "category_id": str(category["id"]),
                    "rule": rule,
                    "weekdays": weekdays or None,
                    "start_day": today,
                    "time": clock,
                    "place": place,
                },
            )
        except TodoError as error:
            return Reply(f"만들지 못했어요({error.code}).")
        return Reply(f"🔁 반복을 만들었어요: {self._repeat_line(period)} | {category['name']}")

    # ------------------------------------------------------------ TODO 고치기

    async def _edit(
        self,
        account_id: int,
        today: str,
        text: str,
        find_item: Callable[[str, str], Awaitable[tuple[dict[str, Any] | None, Reply | None]]],
        ask: Any = None,
    ) -> Reply | None:
        found = re.fullmatch(
            r"(.+?)\s(시각|시간|장소|메모|이름|카테고리)(?:을|를|은|는)?\s(.+?)(?:\s?(?:으로|로))?\s?(?:바꿔|변경|수정|고쳐)?"
            + ACT,
            text,
        )
        if not found:
            return None
        # '회의 장소 정하기 넣어줘' 같은 넣기와 헷갈리지 않게:
        # 바꾸는 말(…로, 바꿔, 변경, 수정)이 있어야 고치기로 본다
        if re.search(r"넣어|추가|등록", text) or not re.search(
            r"(?:바꿔|변경|수정|고쳐)\S*$|(?:으로|로)" + ACT + "$", text
        ):
            return None
        subject, field_name, value = found[1].strip(), found[2], found[3].strip()
        days, subject = take_days(subject, today)
        day = days[0] if days else today
        item, reply = await find_item(day, re.sub(r"\s+", " ", subject).strip())
        if item is None:
            return reply or Reply("무엇을 바꿀지 이름이나 번호를 써 주세요.")
        changes: dict[str, Any] = {}
        if field_name in ("시각", "시간"):
            if value in ("없음", "빼", "삭제", "없이"):
                changes["time"] = None
            else:
                clock, _ = take_time(value)
                if clock is None:
                    return Reply("시각은 15:00이나 오후 3시처럼 써 주세요.")
                if not isinstance(clock, str):
                    return Reply(
                        f"{clock.label}가 오전인가요, 오후인가요? "
                        f"'오전 {clock.label}'처럼 써 주세요."
                    )
                changes["time"] = clock
        elif field_name == "장소":
            changes["place"] = None if value in ("없음", "삭제") else value
        elif field_name == "메모":
            changes["memo"] = "" if value in ("없음", "삭제") else value
        elif field_name == "이름":
            changes["title"] = value
        else:
            cats = [c for c in await self.todo.categories(account_id) if c["closed_at"] is None]
            match = next((c for c in cats if c["name"] == value), None)
            if match is None:
                return Reply(f"'{value}' 카테고리가 없어요.")
            changes["category_id"] = str(match["id"])
        if ask:
            return ask(f"바꿀까요? {item['title']} | {field_name} → {value}")
        try:
            await self.todo.update_item(account_id, item["id"], changes)
        except TodoError as error:
            return Reply(f"바꾸지 못했어요({error.code}).")
        return Reply(f"✏️ 바꿨어요: {item['title']} | {field_name} → {value}")


_ = DATE_RULES  # 날짜 규칙은 todo_words와 같은 것을 쓴다(take_days)
