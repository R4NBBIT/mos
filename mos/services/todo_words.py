"""'/todo <하고 싶은 말>'을 규칙으로 알아듣는다(2026-11-23 사용자 결정: LLM 없이 규칙으로).

날짜, 시각, 장소(@), 메모(//)를 떼는 규칙은 웹 입력칸(web/src/todo/parseWhen.ts)과 같다.
1~12시를 오전, 오후 없이 쓰면 추측하지 않고 물어본다. 그 위에 무엇을 하려는지(넣기, 보기,
완료, 완료 취소, 옮기기)를 말끝으로 가린다. 삭제는 하지 않는다(앱이나 AI에서만).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta

WEEKDAYS = "일월화수목금토"
TAIL = r"(?:까지|부터|에|에는|은|는|로|으로|쯤)?"


def _wrap(body: str) -> re.Pattern[str]:
    # 앞은 맨 앞 또는 공백, 뒤는 끝 또는 공백(낱말 중간은 건드리지 않는다)
    return re.compile(rf"(^|\s){body}{TAIL}(?=\s|$)")


def _day(year: int, month: int, day: int) -> str | None:
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def _plus(today: str, days: int) -> str:
    return (date.fromisoformat(today) + timedelta(days=days)).isoformat()


def _sunday_index(today: str) -> int:
    return (date.fromisoformat(today).weekday() + 1) % 7  # 일요일 0


def _iso(m: re.Match[str], _today: str) -> str | None:
    return _day(int(m[2]), int(m[3]), int(m[4]))


def _month_day(m: re.Match[str], today: str) -> str | None:
    return _day(date.fromisoformat(today).year, int(m[2]), int(m[3]))


def _relative(m: re.Match[str], today: str) -> str | None:
    return _plus(today, {"오늘": 0, "내일": 1, "모레": 2, "글피": 3, "어제": -1}[m[2]])


def _week_day(m: re.Match[str], today: str) -> str | None:
    words = re.sub(r"\s", "", m[2])
    weeks = 0 if words == "이번주" else 2 if words == "다다음주" else 1
    sunday = _plus(today, -_sunday_index(today))  # 한 주는 일요일 시작
    return _plus(sunday, weeks * 7 + WEEKDAYS.index(m[3]))


def _weekday(m: re.Match[str], today: str) -> str | None:
    # 오늘부터 가장 가까운 그 요일(오늘이 그 요일이면 오늘)
    return _plus(today, (WEEKDAYS.index(m[2]) - _sunday_index(today) + 7) % 7)


def _month_only(m: re.Match[str], today: str) -> str | None:
    # 이번 달 그날, 이미 지났으면 다음 달
    now = date.fromisoformat(today)
    here = _day(now.year, now.month, int(m[2]))
    if here and here >= today:
        return here
    year, month = (now.year + 1, 1) if now.month == 12 else (now.year, now.month + 1)
    return _day(year, month, int(m[2]))


DATE_RULES = [
    (_wrap(r"(\d{4})-(\d{1,2})-(\d{1,2})"), _iso),
    (_wrap(r"(\d{1,2})월\s?(\d{1,2})일"), _month_day),
    (_wrap(r"(\d{1,2})\.(\d{1,2})"), _month_day),
    (_wrap(r"(\d{1,2})/(\d{1,2})"), _month_day),
    (_wrap(r"(오늘|내일|모레|글피|어제)"), _relative),
    (_wrap(r"(이번\s?주|다음\s?주|담주|다다음\s?주)\s?([일월화수목금토])요일?"), _week_day),
    (_wrap(r"([일월화수목금토])요일"), _weekday),
    (_wrap(r"(\d{1,2})일"), _month_only),
]

# 기간: 앞 날짜 ~ 뒤 날짜(뒤의 달은 빼고 써도 됨). 2026-11-23 사용자 요청: 기간 동안 날마다 넣기
MAX_RANGE_DAYS = 31
_SIDE = r"(?:(\d{1,2})(?:[./]|월\s?))?(\d{1,2})일?"
RANGE = _wrap(rf"{_SIDE}\s?(?:~|〜|부터)\s?{_SIDE}")


def take_range(text: str, today: str) -> tuple[str, str, str] | None:
    """(첫날, 마지막 날, 남은 글). 기간이 아니면 None.
    달도 '일'도 없는 '3~5'는 날짜로 보지 않는다."""
    match = RANGE.search(text)
    if not match or (not match[2] and not match[4] and "일" not in match[0]):
        return None
    now = date.fromisoformat(today)
    start_month = int(match[2] or match[4] or now.month)
    end_month = int(match[4]) if match[4] else start_month
    if not match[4] and int(match[5]) < int(match[3]):
        end_month = start_month + 1  # 25~3일: 다음 달
    end_year = now.year + 1 if end_month > 12 or end_month < start_month else now.year
    first = _day(now.year, start_month, int(match[3]))
    last = _day(end_year, end_month - 12 if end_month > 12 else end_month, int(match[5]))
    if not first or not last or last <= first:
        return None
    if (date.fromisoformat(last) - date.fromisoformat(first)).days >= MAX_RANGE_DAYS:
        return None
    return first, last, _cut(text, match)


def days_between(first: str, last: str) -> list[str]:
    start, end = date.fromisoformat(first), date.fromisoformat(last)
    return [(start + timedelta(days=n)).isoformat() for n in range((end - start).days + 1)][
        :MAX_RANGE_DAYS
    ]


MORNING = ("오전", "아침", "새벽")
EVENING = ("오후", "저녁", "밤")


@dataclass
class Ask:
    """1~12시를 오전, 오후 없이 썼을 때 고를 두 시각"""

    am: str
    pm: str
    label: str


def _clock(word: str | None, hour: int, minute: int, twenty_four: bool) -> str | Ask | None:
    if not (0 <= minute <= 59 and 0 <= hour <= 23):
        return None

    def at(value: int) -> str:
        return f"{value:02d}:{minute:02d}"

    if word in MORNING:
        return None if hour > 12 else at(0 if hour == 12 else hour)
    if word in EVENING:
        if hour > 12:
            return at(hour)
        if word == "밤" and hour == 12:
            return at(0)
        return at(12 if hour == 12 else hour + 12)
    if word == "낮":
        return None if hour > 12 else at(hour + 12 if 1 <= hour <= 6 else hour)
    if hour == 0 or hour >= 13 or twenty_four:
        return at(hour)
    label = f"{hour}시 {minute}분" if minute else f"{hour}시"
    return Ask(
        am=at(0 if hour == 12 else hour), pm=at(12 if hour == 12 else hour + 12), label=label
    )


TIME_WORDS = r"(?:(오전|오후|아침|낮|저녁|밤|새벽)\s?)?"
NOON = _wrap(r"(정오|자정)")
HOUR = _wrap(TIME_WORDS + r"(\d{1,2})시(?:\s?(반|(\d{1,2})분))?")
COLON = _wrap(TIME_WORDS + r"(\d{1,2}):(\d{2})")


def _cut(text: str, match: re.Match[str]) -> str:
    start = match.start() + len(match[1] or "")
    return f"{text[:start]} {text[match.end() :]}"


def _tidy(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def take_days(text: str, today: str) -> tuple[list[str], str]:
    """글에 나온 날짜를 나온 순서대로 모두 떼어 낸다(옮기기는 두 날짜를 쓴다)."""
    found: list[tuple[int, str]] = []
    changed = True
    while changed:
        changed = False
        for pattern, resolve in DATE_RULES:
            match = pattern.search(text)
            if not match:
                continue
            value = resolve(match, today)
            if value:
                found.append((match.start(), value))
                text = _cut(text, match)
                changed = True
                break
    found.sort()
    return [value for _, value in found], text


def take_time(text: str) -> tuple[str | Ask | None, str]:
    match = NOON.search(text)
    if match:
        return ("12:00" if match[2] == "정오" else "00:00"), _cut(text, match)
    match = HOUR.search(text)
    if match:
        minute = 30 if match[4] == "반" else int(match[5]) if match[5] else 0
        value = _clock(match[2], int(match[3]), minute, False)
        return value, (_cut(text, match) if value else text)
    match = COLON.search(text)
    if match:
        value = _clock(match[2], int(match[3]), int(match[4]), len(match[3]) == 2)
        return value, (_cut(text, match) if value else text)
    return None, text


# ------------------------------------------------------------ 무엇을 하려는지

ADD_WORDS = re.compile(r"(넣어|넣기|추가|등록|적어|기록해|잡아|만들어)")
VIEW_WORDS = re.compile(
    r"(보여|뭐\s?있|뭐야|뭐지|목록|알려|확인해|있어\??$|있나\??$|(?:^|\s)보기$)"
)
DONE_WORDS = re.compile(
    r"(완료했어|완료|끝냈어|끝냈|끝났어|끝났|끝남|다\s?했어|다\s?했|했어|했음|했다|체크)"
)
UNDO_WORDS = re.compile(r"(취소|안\s?했|못\s?했|되돌려|풀어)")
MOVE_WORDS = re.compile(r"(미뤄|미루|옮겨|옮기|바꿔|변경)")
DELETE_WORDS = re.compile(r"(삭제|지워|빼\s?줘|없애)")

# 말끝(시키는 말)과 군더더기: 이름에서 뺀다
FILLER = re.compile(
    r"(?:^|\s)(?:좀|일정|할\s?일|TODO|todo|투두|"
    r"(?:넣어|추가해|등록해|적어|기록해|잡아|만들어|보여|알려|확인해|완료해|체크해|미뤄|옮겨|바꿔)"
    r"(?:줘|주세요|줄래|줄래요|봐|요)?|넣기|추가|등록|보기|완료|체크|해줘|해|줘|주세요)(?=\s|$)"
)
NUMBER = re.compile(r"(^|\s)(\d{1,2})\s?번(?:째)?(?:을|를|은|는)?(?=\s|$)")
PARTICLE = re.compile(r"(?:을|를|은|는|이|가|도|에|로)$")


@dataclass
class Understood:
    action: str  # add, view, done, undo, move, delete, empty
    title: str = ""
    days: list[str] = field(default_factory=list)
    time: str | None = None
    ask: Ask | None = None
    place: str | None = None
    memo: str | None = None
    number: int | None = None
    category: str | None = None
    # 기간으로 썼을 때 마지막 날(days[0]부터 이 날까지 날마다)
    end_day: str | None = None


def _strip_title(text: str) -> str:
    text = FILLER.sub(" ", text)
    text = _tidy(text)
    words = text.split(" ") if text else []
    if words:
        words[-1] = PARTICLE.sub("", words[-1]) or words[-1]
    return _tidy(" ".join(words))


def understand(raw: str, today: str, categories: list[str] | None = None) -> Understood:
    text = _tidy(raw)
    if not text:
        return Understood("view", days=[today])
    # [카테고리]는 메모(//, 끝까지)보다 먼저 뗀다: 단추가 글 끝에 [이름]을 붙여 다시 보낸다
    category = None
    bracket = re.search(r"\[([^\]]{1,30})\]", text)
    if bracket:
        category = bracket[1].strip()
        text = _tidy(text[: bracket.start()] + " " + text[bracket.end() :])
    memo = None
    memo_at = re.search(r"(^|\s)//", text)
    if memo_at:
        mark = text.index("//", memo_at.start())
        memo = _tidy(text[mark + 2 :]) or None
        text = text[:mark]
    place = None
    place_match = re.search(r"(^|\s)@\s?(\S.*)$", text)
    if place_match and len(_tidy(place_match[2])) <= 40:
        place = _tidy(place_match[2])
        text = text[: place_match.start() + len(place_match[1] or "")]
    else:
        # 'X에서'는 장소로 본다(강남역에서 치과)
        where = re.search(r"(^|\s)(\S{1,20})에서(?=\s|$)", text)
        if where and where[2] not in ("오늘", "내일", "모레"):
            place = where[2]
            text = _cut(text, where)

    if category is None and categories:
        for name in sorted(categories, key=len, reverse=True):
            hit = re.search(rf"(^|\s){re.escape(name)}(?:\s?카테고리)?(?:에|에다|로)(?=\s|$)", text)
            if hit:
                category = name
                text = _cut(text, hit)
                break

    ranged = take_range(text, today)
    end_day = None
    if ranged:
        days, end_day, text = [ranged[0]], ranged[1], ranged[2]
    else:
        days, text = take_days(text, today)
    clock, text = take_time(text)
    time_value = clock if isinstance(clock, str) else None
    ask = clock if isinstance(clock, Ask) else None
    number_match = NUMBER.search(text)
    number = int(number_match[2]) if number_match else None
    if number_match:
        text = _cut(text, number_match)

    plain = text
    if DELETE_WORDS.search(plain) and not ADD_WORDS.search(plain):
        action = "delete"
    elif MOVE_WORDS.search(plain) and days:
        action = "move"
    elif DONE_WORDS.search(plain) and UNDO_WORDS.search(plain):
        action = "undo"
    elif DONE_WORDS.search(plain) and not ADD_WORDS.search(plain):
        action = "done"
    elif VIEW_WORDS.search(plain) and not ADD_WORDS.search(plain):
        action = "view"
    else:
        action = "add"
    for words in (DONE_WORDS, UNDO_WORDS, MOVE_WORDS, DELETE_WORDS, VIEW_WORDS):
        if action != "add":
            plain = words.sub(" ", plain)
    title = "" if action == "view" else _strip_title(plain)
    return Understood(
        action=action,
        title=title,
        days=days,
        time=time_value,
        ask=ask,
        place=place,
        memo=memo,
        number=number,
        category=category,
        end_day=end_day if action == "add" else None,
    )
