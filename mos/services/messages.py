"""디스코드 메시지 ↔ DB 행 ↔ API 응답 변환. 디스코드 ID는 API에서 문자열로 준다."""

from __future__ import annotations

import json
import re
from typing import Any

# 웹에 넘기는 첨부 정보(필요한 것만)
_ATTACHMENT_FIELDS = (
    "id",
    "filename",
    "size",
    "content_type",
    "url",
    "proxy_url",
    "width",
    "height",
)


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def attachment_to_dict(attachment: Any) -> dict[str, Any]:
    data = {name: getattr(attachment, name, None) for name in _ATTACHMENT_FIELDS}
    data["id"] = str(data["id"])
    data["spoiler"] = bool(getattr(attachment, "is_spoiler", lambda: False)())
    return data


def sticker_to_dict(sticker: Any) -> dict[str, Any]:
    """스티커는 id·이름·형식(1 PNG, 2 APNG, 3 Lottie, 4 GIF)만 둔다."""
    kind = getattr(sticker, "format", None)
    return {
        "id": str(sticker.id),
        "name": str(getattr(sticker, "name", "") or ""),
        "format": int(getattr(kind, "value", kind) or 1),
    }


def _display_name(item: Any) -> str:
    return str(getattr(item, "display_name", None) or getattr(item, "name", None) or "")


def mentions_to_dict(message: Any) -> dict[str, dict[str, str]]:
    """본문에 들어 있는 멘션 코드의 이름을 받을 때 시점 기준으로 모아 둔다."""
    return {
        "users": {
            str(user.id): _display_name(user) for user in getattr(message, "mentions", []) or []
        },
        "roles": {
            str(role.id): str(role.name) for role in getattr(message, "role_mentions", []) or []
        },
        "channels": {
            str(channel.id): str(channel.name)
            for channel in getattr(message, "channel_mentions", []) or []
        },
    }


def message_to_row(message: Any) -> dict[str, Any]:
    """discord.Message(또는 같은 모양의 객체)를 DB 행으로."""
    author = message.author
    avatar = getattr(author, "display_avatar", None)
    reference = getattr(message, "reference", None)
    guild = getattr(message, "guild", None)
    return {
        "id": int(message.id),
        "guild_id": int(guild.id) if guild is not None else None,
        "channel_id": int(message.channel.id),
        "author_id": int(author.id),
        "author_name": str(getattr(author, "display_name", None) or author.name),
        "author_avatar": str(avatar.url) if avatar is not None else None,
        "author_is_bot": 1 if getattr(author, "bot", False) else 0,
        "webhook_id": int(message.webhook_id) if message.webhook_id else None,
        "content": message.content or "",
        "embeds_json": json.dumps(
            [embed.to_dict() for embed in message.embeds], ensure_ascii=False
        ),
        "attachments_json": json.dumps(
            [attachment_to_dict(item) for item in message.attachments], ensure_ascii=False
        ),
        "components_json": "[]",
        "mentions_json": json.dumps(mentions_to_dict(message), ensure_ascii=False),
        "kind": int(getattr(getattr(message, "type", None), "value", 0) or 0),
        "stickers_json": json.dumps(
            [sticker_to_dict(item) for item in getattr(message, "stickers", None) or []],
            ensure_ascii=False,
        ),
        "reference_id": int(reference.message_id)
        if reference is not None and reference.message_id
        else None,
        "flags": int(getattr(message.flags, "value", 0) or 0),
        "created_at": _iso(message.created_at),
        "edited_at": _iso(message.edited_at),
    }


def _load_mentions(raw: str | None) -> dict[str, dict[str, str]]:
    data = json.loads(raw) if raw else {}
    return {key: dict(data.get(key) or {}) for key in ("users", "roles", "channels")}


# 웹에서 답장으로 보낸 메시지의 첫 줄(디스코드에 보이는 인용). ㅁㅇㅅ 화면에서는 떼고 보여 준다
REPLY_QUOTE_MARK = "> ↪ "


# 인용 줄 끝의 원문 링크(디스코드 메시지 주소)에서 원문 메시지 ID를 꺼낸다
_QUOTE_LINK_RE = re.compile(r"\]\(https://discord\.com/channels/\d+/\d+/(\d{15,21})\)\s*$")


def quoted_reply_id(content: str) -> int | None:
    """ㅁㅇㅅ 답장 인용 줄이면 원문 메시지 ID. 아니면 None."""
    if not content.startswith(REPLY_QUOTE_MARK):
        return None
    first_line = content.partition("\n")[0]
    match = _QUOTE_LINK_RE.search(first_line)
    return int(match.group(1)) if match else None


def strip_reply_quote(content: str) -> str:
    if not content.startswith(REPLY_QUOTE_MARK):
        return content
    _quote, _newline, rest = content.partition("\n")
    return rest


def row_to_api(row: dict[str, Any]) -> dict[str, Any]:
    """DB 행을 웹 응답으로. ID는 문자열(자바스크립트 숫자 정밀도 문제)."""

    def snowflake(value: int | None) -> str | None:
        return str(value) if value is not None else None

    web_sender = row.get("web_sender_id")
    web_reply = row.get("web_reply_to_id")
    content = row["content"]
    reference = row["reference_id"]
    if web_reply is not None:
        content = strip_reply_quote(content)
        reference = web_reply
    elif row["webhook_id"] is not None:
        # 보낸 기록이 없는 예전 웹 메시지도 인용 줄(디스코드 원문 링크)은 떼고 일반 답장처럼
        quoted = quoted_reply_id(content)
        if quoted is not None:
            content = strip_reply_quote(content)
            reference = reference or quoted
    return {
        "id": str(row["id"]),
        "channel_id": str(row["channel_id"]),
        "guild_id": snowflake(row["guild_id"]),
        "author": {
            "id": str(row["author_id"]),
            "name": row["author_name"],
            "avatar_url": row["author_avatar"],
            "bot": bool(row["author_is_bot"]),
            "webhook": row["webhook_id"] is not None,
        },
        "content": content,
        # 디스코드 메시지 종류. 0·19(답장)·20·23(명령 응답) 말고는 입장·고정 같은 시스템 알림
        "kind": int(row.get("kind") or 0),
        # 웹(ㅁㅇㅅ)에서 보낸 메시지면 보낸 사람의 디스코드 ID. 본인 것만 수정·삭제 버튼을 보인다
        "web_sender_id": snowflake(web_sender),
        "embeds": json.loads(row["embeds_json"]),
        "attachments": json.loads(row["attachments_json"]),
        "mentions": _load_mentions(row.get("mentions_json")),
        "stickers": json.loads(row.get("stickers_json") or "[]"),
        "reference_id": snowflake(reference),
        "created_at": row["created_at"],
        "edited_at": row["edited_at"],
    }
