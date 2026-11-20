"""웹에서 메시지 보내기·고치기·지우기(전부 웹훅). 기술 설계서 9장, 기능명세서 SEND.

- 이름·프로필은 보낸 사람의 그 서버 닉네임·프로필로 고정(사칭 방지)
- @everyone·역할 멘션은 보낸 사람에게 그 권한이 있을 때만(웹훅은 권한을 따지지 않는다)
- 같은 요청(nonce)은 한 번만 보낸다
- 답장은 디스코드에 인용 한 줄 + 원문 링크로, ㅁㅇㅅ 화면에는 일반 답장처럼
- 본인이 웹에서 보낸 메시지만 고치고 지운다
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from mos.db.repo import MessageRepo
from mos.db.sender_repo import SenderRepo
from mos.services.crypto import DecryptError, TokenCipher
from mos.services.directory import Directory
from mos.services.messages import REPLY_QUOTE_MARK, row_to_api
from mos.services.permissions import PermissionService
from mos.services.realtime import RealtimeHub

log = logging.getLogger(__name__)

MAX_CONTENT = 2000
QUOTE_SNIPPET = 50
NAME_LIMIT = 80
_NONCE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
_MENTION_TOKEN = re.compile(r"<(@[!&]?|#)\d+>")
_MARKDOWN = re.compile(r"[*_~`|>\[\]()\\]")
# 디스코드가 웹훅 이름에 쓰지 못하게 막는 단어(대소문자 무시)
_BLOCKED_NAME_WORDS = re.compile(r"discord|clyde|everyone|here", re.IGNORECASE)


class SendError(Exception):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class WebhookGoneError(Exception):
    """저장해 둔 웹훅이 디스코드에서 지워짐. 새로 만들고 한 번 다시 시도한다."""


@dataclass(frozen=True)
class Webhook:
    id: int
    token: str = field(repr=False)


@dataclass(frozen=True)
class OutgoingMessage:
    content: str
    username: str
    avatar_url: str | None
    thread_id: int | None
    allow_everyone: bool


class Messenger(Protocol):
    """봇이 구현. 디스코드와 실제로 주고받는 부분."""

    async def create_webhook(self, channel_id: int) -> Webhook: ...

    async def send(self, webhook: Webhook, message: OutgoingMessage) -> dict[str, Any]:
        """보낸 메시지의 DB 행(message_to_row 모양)."""
        ...

    async def edit(
        self, webhook: Webhook, message_id: int, message: OutgoingMessage
    ) -> dict[str, Any]: ...

    async def delete(self, webhook: Webhook, message_id: int, thread_id: int | None) -> None: ...


def safe_username(name: str) -> str:
    cleaned = _BLOCKED_NAME_WORDS.sub(lambda m: m.group(0)[0] + "​" + m.group(0)[1:], name)
    cleaned = cleaned.strip()[:NAME_LIMIT]
    return cleaned or "이름 없음"


def reply_quote(author: str, content: str, link: str) -> str:
    """디스코드 쪽에 보일 인용 한 줄. 멘션·서식은 빼서 다시 알림이 가지 않게 한다."""
    snippet = _MENTION_TOKEN.sub("@…", content).replace("\n", " ")
    snippet = _MARKDOWN.sub("", snippet).strip()
    if len(snippet) > QUOTE_SNIPPET:
        snippet = snippet[:QUOTE_SNIPPET].rstrip() + "…"
    name = _MARKDOWN.sub("", author).strip() or "이름 없음"
    return f"{REPLY_QUOTE_MARK}**{name}**: {snippet or '(첨부)'} [원문]({link})\n"


class SenderService:
    def __init__(
        self,
        messages: MessageRepo,
        repo: SenderRepo,
        cipher: TokenCipher,
        messenger: Messenger,
        directory: Directory,
        permissions: PermissionService,
        hub: RealtimeHub,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.messages = messages
        self.repo = repo
        self.cipher = cipher
        self.messenger = messenger
        self.directory = directory
        self.permissions = permissions
        self.hub = hub
        self.clock = clock
        self._in_flight: set[tuple[int, str]] = set()

    # ------------------------------------------------------------ 웹훅

    async def _webhook(self, channel_id: int) -> Webhook:
        stored = await self.repo.webhook(channel_id)
        if stored is not None:
            try:
                token = self.cipher.decrypt(
                    stored["webhook_token_enc"], f"webhook:{stored['webhook_id']}"
                )
                return Webhook(int(stored["webhook_id"]), token)
            except DecryptError:
                log.warning("웹훅 토큰을 풀 수 없어 새로 만듭니다: 채널 %s", channel_id)
        hook = await self.messenger.create_webhook(channel_id)
        await self.repo.save_webhook(
            channel_id,
            hook.id,
            self.cipher.encrypt(hook.token, f"webhook:{hook.id}"),
            int(self.clock()),
        )
        return hook

    async def _with_webhook(self, channel_id: int, action: Callable[[Webhook], Any]) -> Any:
        hook = await self._webhook(channel_id)
        try:
            return await action(hook)
        except WebhookGoneError:
            await self.repo.forget_webhook(channel_id)
            return await action(await self._webhook(channel_id))

    # ------------------------------------------------------------ 공용

    async def _sendable(self, user_id: int, channel_id: int) -> Any:
        access = await self.permissions.channel_access(user_id, channel_id)
        if access is None:
            raise SendError("not_found", 404)
        if not access.can_send:
            raise SendError("cannot_send", 403)
        return access

    @staticmethod
    def _check_content(content: str, prefix: str = "") -> str:
        if not content.strip():
            raise SendError("empty")
        if len(prefix) + len(content) > MAX_CONTENT:
            raise SendError("too_long")
        return prefix + content

    async def _publish(self, channel_id: int, message_id: int, event: str) -> dict[str, Any]:
        row = await self.messages.get(message_id)
        if row is None:
            raise SendError("not_found", 404)
        api = row_to_api(row)
        await self.hub.publish(channel_id, event, api)
        return api

    # ------------------------------------------------------------ 보내기

    async def send(
        self,
        account_id: int,
        user_id: int,
        channel_id: int,
        content: str,
        nonce: str,
        reply_to_id: int | None = None,
    ) -> dict[str, Any]:
        if not _NONCE.match(nonce):
            raise SendError("bad_nonce")
        access = await self._sendable(user_id, channel_id)
        channel = access.channel

        key = (account_id, nonce)
        done = await self.repo.sent_by_key(account_id, nonce)
        if done is not None:
            return await self._publish(channel_id, int(done["message_id"]), "message_update")
        if key in self._in_flight:
            raise SendError("duplicate", 409)
        self._in_flight.add(key)
        try:
            prefix = ""
            if reply_to_id is not None:
                original = await self.messages.get(reply_to_id)
                if original is None or int(original["channel_id"]) != channel_id:
                    raise SendError("reply_not_found", 404)
                link = f"https://discord.com/channels/{channel.guild_id}/{channel_id}/{reply_to_id}"
                original_text = row_to_api(original)["content"]
                prefix = reply_quote(original["author_name"], original_text, link)
            text = self._check_content(content, prefix)

            member = await self.permissions.member(channel.guild_id, user_id)
            if member is None:
                raise SendError("not_found", 404)
            outgoing = OutgoingMessage(
                content=text,
                username=safe_username(member.display_name),
                avatar_url=member.avatar_url,
                thread_id=channel.id if channel.kind == "thread" else None,
                allow_everyone=access.can_mention_everyone,
            )
            hook_channel = channel.parent_id or channel.id

            async def action(hook: Webhook) -> dict[str, Any]:
                return await self.messenger.send(hook, outgoing)

            row = await self._with_webhook(hook_channel, action)
            row["guild_id"] = channel.guild_id
            message_id = int(row["id"])
            await self.messages.upsert(row)
            await self.repo.record_sent(
                message_id, account_id, channel_id, reply_to_id, nonce, int(self.clock())
            )
        finally:
            self._in_flight.discard(key)
        return await self._publish(channel_id, message_id, "message_update")

    # ------------------------------------------------------------ 고치기·지우기

    async def _own(self, user_id: int, message_id: int) -> dict[str, Any]:
        sent = await self.repo.sent(message_id)
        if sent is None or int(sent["discord_user_id"]) != user_id:
            raise SendError("not_found", 404)  # 남의 메시지는 있는지도 알려 주지 않는다
        return sent

    async def edit(self, user_id: int, message_id: int, content: str) -> dict[str, Any]:
        sent = await self._own(user_id, message_id)
        channel_id = int(sent["channel_id"])
        access = await self._sendable(user_id, channel_id)
        channel = access.channel
        stored = await self.messages.get(message_id)
        prefix = ""
        if stored is not None and sent["reply_to_id"] is not None:
            first_line = stored["content"].partition("\n")[0]
            if first_line.startswith(REPLY_QUOTE_MARK):
                prefix = first_line + "\n"  # 답장 인용은 그대로 둔다
        outgoing = OutgoingMessage(
            content=self._check_content(content, prefix),
            username="",
            avatar_url=None,
            thread_id=channel.id if channel.kind == "thread" else None,
            allow_everyone=access.can_mention_everyone,
        )

        async def action(hook: Webhook) -> dict[str, Any]:
            return await self.messenger.edit(hook, message_id, outgoing)

        row = await self._with_webhook(channel.parent_id or channel.id, action)
        row["guild_id"] = channel.guild_id
        await self.messages.upsert(row)
        return await self._publish(channel_id, message_id, "message_update")

    async def delete(self, user_id: int, message_id: int) -> None:
        sent = await self._own(user_id, message_id)
        channel_id = int(sent["channel_id"])
        channel = self.directory.channel(channel_id)
        if channel is None:
            raise SendError("not_found", 404)
        thread_id = channel.id if channel.kind == "thread" else None

        async def action(hook: Webhook) -> None:
            await self.messenger.delete(hook, message_id, thread_id)

        await self._with_webhook(channel.parent_id or channel.id, action)
        await self.messages.delete_many([message_id])
        await self.repo.forget_sent(message_id)
        await self.hub.publish(
            channel_id, "message_delete", {"channel_id": str(channel_id), "ids": [str(message_id)]}
        )

    async def sender_of(self, message_id: int) -> int | None:
        """디스코드 앱 메시지 명령용: 웹에서 보낸 사람의 디스코드 ID."""
        sent = await self.repo.sent(message_id)
        return int(sent["discord_user_id"]) if sent else None
