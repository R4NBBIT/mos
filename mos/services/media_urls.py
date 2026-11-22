"""디스코드 첨부 주소 새로 받기.

디스코드 첨부 주소(cdn.discordapp.com, media.discordapp.net)에는 서명과 만료 시각(ex, 16진 초)이
붙어 있어 하루쯤 지나면 그림이 안 뜬다. 메시지를 화면에 내줄 때 곧 끝날 주소만 모아
봇이 디스코드에 새 주소를 받아 오고(50개씩), DB의 그 메시지에도 고쳐 둔다.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Iterable
from typing import Any, Protocol
from urllib.parse import parse_qs, urlsplit, urlunsplit

log = logging.getLogger(__name__)

MEDIA_HOSTS = ("cdn.discordapp.com", "media.discordapp.net")
REFRESH_MARGIN_SEC = 3600  # 한 시간 안에 끝나는 주소도 미리 새로
REFRESH_BATCH = 50  # 디스코드가 한 번에 받는 수
FAILED_MEMORY_SEC = 600  # 새로 받지 못한 주소는 10분 동안 다시 묻지 않는다(지운 첨부 등)
MAX_FAILED = 5000


class UrlRefresher(Protocol):
    async def refresh_attachment_urls(self, urls: list[str]) -> dict[str, str]:
        """원래 주소 → 새 주소. 받지 못한 것은 빠진다."""
        ...


class MessageStore(Protocol):
    async def set_attachments(self, message_id: int, attachments_json: str) -> None: ...


def expires_at(url: str) -> int | None:
    """주소의 만료 시각(초). 디스코드 첨부 주소가 아니거나 ex가 없으면 None."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme != "https" or parts.hostname not in MEDIA_HOSTS:
        return None
    if not parts.path.startswith("/attachments/"):
        return None
    values = parse_qs(parts.query).get("ex")
    if not values:
        return None
    try:
        return int(values[0], 16)
    except ValueError:
        return None


def _with_query(url: str, query: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


class AttachmentRefresher:
    def __init__(
        self,
        refresher: UrlRefresher,
        store: MessageStore,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.refresher = refresher
        self.store = store
        self.clock = clock
        self._failed: dict[str, float] = {}

    def _stale(self, url: str, now: float) -> bool:
        ends = expires_at(url)
        if ends is None or ends > now + REFRESH_MARGIN_SEC:
            return False
        failed = self._failed.get(url)
        return failed is None or now - failed > FAILED_MEMORY_SEC

    async def fresh(self, rows: Iterable[dict[str, Any]]) -> None:
        """rows의 attachments_json을 그 자리에서 새 주소로 바꾸고 DB에도 저장한다."""
        now = self.clock()
        targets: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        wanted: list[str] = []
        for row in rows:
            raw = row.get("attachments_json") or "[]"
            if raw in ("[]", ""):
                continue
            try:
                items = json.loads(raw)
            except ValueError:
                continue
            stale = [
                item
                for item in items
                if isinstance(item, dict)
                and isinstance(item.get("url"), str)
                and self._stale(item["url"], now)
            ]
            if not stale:
                continue
            targets.append((row, items))
            wanted.extend(item["url"] for item in stale if item["url"] not in wanted)
        if not wanted:
            return
        found: dict[str, str] = {}
        for start in range(0, len(wanted), REFRESH_BATCH):
            chunk = wanted[start : start + REFRESH_BATCH]
            try:
                found.update(await self.refresher.refresh_attachment_urls(chunk))
            except Exception:  # 디스코드가 안 받아 줘도 메시지는 그대로 보여 준다
                log.warning("첨부 주소 새로 받기 실패(%d개)", len(chunk))
        if len(self._failed) > MAX_FAILED:
            self._failed.clear()
        for url in wanted:
            if url not in found:
                self._failed[url] = now
        for row, items in targets:
            changed = False
            for item in items:
                new_url = found.get(item.get("url") or "")
                if not new_url or expires_at(new_url) is None:
                    continue
                item["url"] = new_url
                proxy = item.get("proxy_url")
                if isinstance(proxy, str) and expires_at(proxy) is not None:
                    # media 주소는 같은 서명을 쓴다(경로는 그대로, 뒤 서명만 바꿈)
                    item["proxy_url"] = _with_query(proxy, urlsplit(new_url).query)
                changed = True
            if changed:
                row["attachments_json"] = json.dumps(items, ensure_ascii=False)
                await self.store.set_attachments(int(row["id"]), row["attachments_json"])
