"""웹에서 메시지 보내기·고치기·지우기(전부 웹훅). 기술 설계서 9장, 기능명세서 SEND.

- 이름·프로필은 보낸 사람의 그 서버 닉네임·프로필로 고정(사칭 방지)
- @everyone·역할 멘션은 보낸 사람에게 그 권한이 있을 때만(웹훅은 권한을 따지지 않는다)
- 같은 요청(nonce)은 한 번만 보낸다
- 답장은 디스코드에 인용 한 줄 + 원문 링크로, ㅁㅇㅅ 화면에는 일반 답장처럼
- 본인이 웹에서 보낸 메시지만 고치고 지운다
"""

from __future__ import annotations

import logging
import math
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from mos.db.repo import MessageRepo
from mos.db.sender_repo import SenderRepo
from mos.services.crypto import DecryptError, TokenCipher
from mos.services.directory import Directory
from mos.services.emojis import EmojiService
from mos.services.messages import REPLY_QUOTE_MARK, row_to_api
from mos.services.permissions import PermissionService
from mos.services.realtime import RealtimeHub

DISCORD_EPOCH_MS = 1_420_070_400_000

log = logging.getLogger(__name__)

MAX_CONTENT = 2000
MAX_FILES = 10
MAX_POST_TITLE = 100
MAX_POST_TAGS = 5
MAX_FILES_BYTES = 10 * 1024 * 1024  # 디스코드 기본 한도(검증상 20MB까지 되지만 늘리지 않음)
_FILENAME_SAFE = re.compile(r"[^\w.\-가-힣 ]")
QUOTE_SNIPPET = 50
NAME_LIMIT = 80
_NONCE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
_MENTION_TOKEN = re.compile(r"<(@[!&]?|#)\d+>")
_MARKDOWN = re.compile(r"[*_~`|>\[\]()\\]")
# 디스코드가 웹훅 이름에 쓰지 못하게 막는 단어(대소문자 무시)
_BLOCKED_NAME_WORDS = re.compile(r"discord|clyde|everyone|here", re.IGNORECASE)


class SendError(Exception):
    def __init__(self, code: str, status: int = 400, retry_after: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.retry_after = retry_after


class WebhookGoneError(Exception):
    """저장해 둔 웹훅이 디스코드에서 지워짐. 새로 만들고 한 번 다시 시도한다."""


@dataclass(frozen=True)
class Webhook:
    id: int
    token: str = field(repr=False)


@dataclass(frozen=True)
class OutgoingFile:
    filename: str
    data: bytes = field(repr=False)
    spoiler: bool = False


@dataclass(frozen=True)
class OutgoingMessage:
    content: str
    username: str
    avatar_url: str | None
    thread_id: int | None
    allow_everyone: bool
    files: tuple[OutgoingFile, ...] = ()
    # 포럼 새 글: 글 제목과 태그(웹훅이 글을 만든다)
    thread_name: str | None = None
    applied_tags: tuple[int, ...] = ()


def safe_filename(name: str) -> str:
    """경로·특수문자를 뺀 파일 이름(디스코드에 그대로 보인다)."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = _FILENAME_SAFE.sub("_", base).strip(" .")
    if len(base) > 100:
        stem, dot, ext = base.rpartition(".")
        base = (stem[:90] + dot + ext[:9]) if dot else base[:100]
    return base or "file"


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

    async def add_reaction(self, channel_id: int, message_id: int, emoji: dict[str, Any]) -> None:
        """봇 이름으로 반응 하나(웹에서 누른 사람들의 몫)."""
        ...

    async def remove_reaction(
        self, channel_id: int, message_id: int, emoji: dict[str, Any]
    ) -> None: ...


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
        emojis: EmojiService | None = None,
    ) -> None:
        self.messages = messages
        self.repo = repo
        self.cipher = cipher
        self.messenger = messenger
        self.directory = directory
        self.permissions = permissions
        self.hub = hub
        self.clock = clock
        self.emojis = emojis or EmojiService(directory, permissions)
        self._in_flight: set[tuple[int, str]] = set()
        # 슬로우 모드: (사람, 채널) → 이 사이트로 마지막 보낸 때(재시작 사이에는 DB로 다시 셈)
        self._last_sent: dict[tuple[int, int], float] = {}

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

    async def _check_slowmode(self, user_id: int, access: Any) -> None:
        """디스코드는 웹훅에 슬로우 모드를 걸지 않아서 여기서 막는다.
        디스코드 앱으로 보낸 것도 센다."""
        delay = access.slowmode
        if delay <= 0:
            return
        channel_id = access.channel.id
        last = self._last_sent.get((user_id, channel_id), 0.0)
        web = await self.repo.last_web_send(user_id, channel_id)
        if web is not None:
            last = max(last, float(web))
        own = await self.messages.latest_by_author(channel_id, user_id)
        if own is not None:
            last = max(last, ((int(own) >> 22) + DISCORD_EPOCH_MS) / 1000)
        wait = last + delay - self.clock()
        if wait > 0:
            raise SendError("slowmode", 429, retry_after=math.ceil(wait))

    def _mark_sent(self, user_id: int, channel_id: int) -> None:
        if len(self._last_sent) > 10_000:
            self._last_sent.clear()
        self._last_sent[(user_id, channel_id)] = self.clock()

    @staticmethod
    def _check_content(content: str, prefix: str = "", has_files: bool = False) -> str:
        if not content.strip() and not has_files:
            raise SendError("empty")
        if len(prefix) + len(content) > MAX_CONTENT:
            raise SendError("too_long")
        return prefix + content

    async def _check_emojis(self, user_id: int, premium: bool, access: Any, content: str) -> None:
        if not await self.emojis.allowed_in(user_id, premium, access, content):
            raise SendError("emoji_not_allowed", 403)  # 니트로 규칙(웹훅은 따지지 않는다)

    @staticmethod
    def _check_files(files: Sequence[OutgoingFile]) -> tuple[OutgoingFile, ...]:
        if len(files) > MAX_FILES:
            raise SendError("too_many_files")
        if sum(len(item.data) for item in files) > MAX_FILES_BYTES:
            raise SendError("files_too_large", 413)
        if any(not item.data for item in files):
            raise SendError("empty_file")
        return tuple(files)

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
        premium: bool = False,
        files: Sequence[OutgoingFile] = (),
    ) -> dict[str, Any]:
        if not _NONCE.match(nonce):
            raise SendError("bad_nonce")
        access = await self._sendable(user_id, channel_id)
        channel = access.channel
        attached = self._check_files(files)

        key = (account_id, nonce)
        done = await self.repo.sent_by_key(account_id, nonce)
        if done is not None:
            return await self._publish(channel_id, int(done["message_id"]), "message_update")
        if key in self._in_flight:
            raise SendError("duplicate", 409)
        await self._check_slowmode(user_id, access)
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
            text = self._check_content(content, prefix, has_files=bool(attached))
            await self._check_emojis(user_id, premium, access, content)

            member = await self.permissions.member(channel.guild_id, user_id)
            if member is None:
                raise SendError("not_found", 404)
            outgoing = OutgoingMessage(
                content=text,
                username=safe_username(member.display_name),
                avatar_url=member.avatar_url,
                thread_id=channel.id if channel.kind == "thread" else None,
                allow_everyone=access.can_mention_everyone,
                files=attached,
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
            self._mark_sent(user_id, channel_id)
        finally:
            self._in_flight.discard(key)
        return await self._publish(channel_id, message_id, "message_update")

    # ------------------------------------------------------------ 고치기·지우기

    async def _own(self, user_id: int, message_id: int) -> dict[str, Any]:
        sent = await self.repo.sent(message_id)
        if sent is None or int(sent["discord_user_id"]) != user_id:
            raise SendError("not_found", 404)  # 남의 메시지는 있는지도 알려 주지 않는다
        return sent

    async def edit(
        self, user_id: int, message_id: int, content: str, premium: bool = False
    ) -> dict[str, Any]:
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
        await self._check_emojis(user_id, premium, access, content)
        has_files = bool(stored and stored["attachments_json"] not in ("[]", ""))
        outgoing = OutgoingMessage(
            content=self._check_content(content, prefix, has_files=has_files),
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

    async def create_post(
        self,
        account_id: int,
        user_id: int,
        forum_id: int,
        title: str,
        content: str,
        tag_ids: Sequence[int],
        nonce: str,
        premium: bool = False,
        files: Sequence[OutgoingFile] = (),
    ) -> dict[str, Any]:
        """포럼 새 글. 글(스레드) ID = 첫 메시지 ID(검증 결과)."""
        if not _NONCE.match(nonce):
            raise SendError("bad_nonce")
        access = await self.permissions.channel_access(user_id, forum_id)
        if access is None:
            raise SendError("not_found", 404)
        if not access.can_create_post:
            raise SendError("cannot_send", 403)
        forum = access.channel
        name = " ".join(title.split())
        if not 1 <= len(name) <= MAX_POST_TITLE:
            raise SendError("bad_title")
        tags = list(dict.fromkeys(tag_ids))
        known = {tag.id: tag for tag in forum.forum_tags}
        if len(tags) > MAX_POST_TAGS or any(tag not in known for tag in tags):
            raise SendError("bad_tags")
        if forum.require_tag and not tags:
            raise SendError("tag_required")
        if any(known[tag].moderated for tag in tags) and not access.can_use_moderated_tags:
            raise SendError("tag_not_allowed", 403)
        attached = self._check_files(files)
        text = self._check_content(content, has_files=bool(attached))
        await self._check_emojis(user_id, premium, access, content)

        key = (account_id, nonce)
        done = await self.repo.sent_by_key(account_id, nonce)
        if done is not None:
            return {"thread_id": str(done["channel_id"])}
        if key in self._in_flight:
            raise SendError("duplicate", 409)
        await self._check_slowmode(user_id, access)
        self._in_flight.add(key)
        try:
            member = await self.permissions.member(forum.guild_id, user_id)
            if member is None:
                raise SendError("not_found", 404)
            outgoing = OutgoingMessage(
                content=text,
                username=safe_username(member.display_name),
                avatar_url=member.avatar_url,
                thread_id=None,
                allow_everyone=access.can_mention_everyone,
                files=attached,
                thread_name=name,
                applied_tags=tuple(tags),
            )

            async def action(hook: Webhook) -> dict[str, Any]:
                return await self.messenger.send(hook, outgoing)

            row = await self._with_webhook(forum.id, action)
            row["guild_id"] = forum.guild_id
            thread_id = int(row["channel_id"])
            await self.messages.upsert(row)
            await self.repo.record_sent(
                int(row["id"]), account_id, thread_id, None, nonce, int(self.clock())
            )
            self._mark_sent(user_id, forum.id)
        finally:
            self._in_flight.discard(key)
        return {"thread_id": str(thread_id)}

    async def can_edit_post(self, user_id: int, access: Any) -> bool:
        """포럼 글, 스레드의 제목과 태그를 고칠 수 있는지.
        글쓴이(이 사이트로 썼으면 보낸 기록, 디스코드 앱이면 만든 사람) 또는 스레드 관리 권한."""
        channel = access.channel
        if channel.kind != "thread":
            return False
        if access.can_use_moderated_tags:
            return True
        if channel.owner_id == user_id:
            return True
        sent = await self.repo.sent(channel.id)  # 글 ID = 첫 메시지 ID
        return sent is not None and int(sent["discord_user_id"]) == user_id

    async def edit_post(
        self, user_id: int, thread_id: int, title: str | None, tag_ids: Sequence[int] | None
    ) -> None:
        access = await self.permissions.channel_access(user_id, thread_id)
        if access is None:
            raise SendError("not_found", 404)
        thread = access.channel
        if not await self.can_edit_post(user_id, access):
            raise SendError("cannot_edit_post", 403)
        name = thread.name if title is None else " ".join(title.split())
        if not 1 <= len(name) <= MAX_POST_TITLE:
            raise SendError("bad_title")
        tags = list(thread.applied_tag_ids) if tag_ids is None else list(dict.fromkeys(tag_ids))
        parent = self.directory.channel(thread.parent_id) if thread.parent_id else None
        if tag_ids is not None:
            known = {tag.id: tag for tag in (parent.forum_tags if parent else ())}
            if len(tags) > MAX_POST_TAGS or any(tag not in known for tag in tags):
                raise SendError("bad_tags")
            if parent is not None and parent.require_tag and not tags:
                raise SendError("tag_required")
            before = set(thread.applied_tag_ids)
            changed = {tag for tag in tags if tag not in before} | (before - set(tags))
            if any(known[tag].moderated for tag in changed if tag in known) and not (
                access.can_use_moderated_tags
            ):
                raise SendError("tag_not_allowed", 403)
        try:
            await self.directory.edit_thread(thread.id, name, tuple(tags))
        except PermissionError as error:
            raise SendError("bot_cannot_manage_threads", 403) from error
        if thread.parent_id:
            await self.hub.publish(
                thread.parent_id, "threads_changed", {"channel_id": str(thread.parent_id)}
            )

    async def sender_of(self, message_id: int) -> int | None:
        """디스코드 앱 메시지 명령용: 웹에서 보낸 사람의 디스코드 ID."""
        sent = await self.repo.sent(message_id)
        return int(sent["discord_user_id"]) if sent else None
