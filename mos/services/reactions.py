"""반응(이모지 반응).

디스코드는 웹훅이 반응을 달 수 없어, ㅁㅇㅅ 웹에서 누른 반응은 봇이 대신 하나 달고
누가 눌렀는지는 ㅁㅇㅅ DB(reaction_user, via='web')에 남긴다.
화면에 보이는 수 = 디스코드 수 - 봇 몫 1 + 웹에서 누른 사람 수(디스코드에서도 단 사람은 한 번만).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from typing import Any

_CUSTOM = re.compile(r"<(a?):([A-Za-z0-9_]{1,32}):(\d{15,21})>")
MAX_UNICODE_LENGTH = 16  # 가족·깃발처럼 여러 글자를 이은 이모지도 이 안에 든다


class ReactionError(ValueError):
    pass


def emoji_key(emoji_id: int | None, name: str) -> str:
    return str(emoji_id) if emoji_id else name


def parse_emoji(text: str) -> dict[str, Any]:
    """웹에서 고른 이모지: 사용자 이모지 코드(<:이름:ID>) 또는 기본 이모지 글자."""
    text = text.strip()
    match = _CUSTOM.fullmatch(text)
    if match:
        animated, name, emoji_id = match.groups()
        return {"id": int(emoji_id), "name": name, "animated": animated == "a"}
    if not text or len(text) > MAX_UNICODE_LENGTH or any(ch.isspace() for ch in text):
        raise ReactionError("bad_emoji")
    if not any(ord(ch) > 0x2000 for ch in text):
        raise ReactionError("bad_emoji")  # 글자·숫자만 있는 건 이모지가 아니다
    return {"id": None, "name": text, "animated": False}


def from_partial(emoji: Any) -> dict[str, Any]:
    """discord.PartialEmoji·Emoji·글자 → 저장 모양."""
    if isinstance(emoji, str):
        return {"id": None, "name": emoji, "animated": False}
    emoji_id = getattr(emoji, "id", None)
    return {
        "id": int(emoji_id) if emoji_id else None,
        "name": str(getattr(emoji, "name", "") or ""),
        "animated": bool(getattr(emoji, "animated", False)),
    }


def reactions_to_json(reactions: Iterable[Any]) -> str:
    """discord.Message.reactions → reactions_json."""
    items = []
    for reaction in reactions:
        emoji = from_partial(reaction.emoji)
        if not emoji["name"] and not emoji["id"]:
            continue
        items.append(
            {
                "key": emoji_key(emoji["id"], emoji["name"]),
                **emoji,
                "count": int(getattr(reaction, "count", 0) or 0),
                "bot": bool(getattr(reaction, "me", False)),
            }
        )
    return json.dumps(items, ensure_ascii=False)


def adjust(raw: str | None, emoji: dict[str, Any], delta: int, by_bot: bool) -> str:
    """반응 하나가 달리거나(delta=1) 빠졌을 때(delta=-1) reactions_json을 고친다."""
    items: list[dict[str, Any]] = json.loads(raw or "[]")
    key = emoji_key(emoji["id"], emoji["name"])
    found = next((item for item in items if item["key"] == key), None)
    if found is None:
        if delta <= 0:
            return json.dumps(items, ensure_ascii=False)
        found = {"key": key, **emoji, "count": 0, "bot": False}
        items.append(found)
    found["count"] = max(0, int(found["count"]) + delta)
    if by_bot:
        found["bot"] = delta > 0
    items = [item for item in items if item["count"] > 0]
    return json.dumps(items, ensure_ascii=False)


def build(raw: str | None, users: Iterable[tuple[str, int, str]]) -> list[dict[str, Any]]:
    """화면에 줄 반응 목록. users: (emoji_key, user_id, via)."""
    items: list[dict[str, Any]] = json.loads(raw or "[]")
    discord_users: dict[str, set[int]] = {}
    web_users: dict[str, set[int]] = {}
    for key, user_id, via in users:
        (web_users if via == "web" else discord_users).setdefault(key, set()).add(int(user_id))
    result = []
    for item in items:
        key = item["key"]
        known = discord_users.get(key, set())
        web_only = web_users.get(key, set()) - known
        count = int(item["count"])
        if item.get("bot") and web_users.get(key):
            count -= 1  # 봇이 단 하나는 웹에서 누른 사람들의 몫이다
        count += len(web_only)
        if count <= 0:
            continue
        result.append(
            {
                "key": key,
                "emoji": {
                    "id": str(item["id"]) if item.get("id") else None,
                    "name": item.get("name") or "",
                    "animated": bool(item.get("animated")),
                },
                "count": count,
                "users": sorted(str(user) for user in known | web_users.get(key, set())),
                "web_users": sorted(str(user) for user in web_users.get(key, set())),
            }
        )
    return result
