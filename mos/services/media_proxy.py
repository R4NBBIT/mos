"""디스코드 그림, 동영상, 파일을 ㅁㅇㅅ 서버가 대신 받아 넘겨주기.

브라우저가 cdn.discordapp.com 같은 디스코드 주소에 직접 가면 회사 망 기록에 디스코드가 남는다.
그래서 화면은 /api/media?u=<디스코드 주소> 로만 부르고, 서버가 받아 그대로 흘려보낸다.

안전 규칙
- 디스코드 미디어 주소(정해진 호스트와 경로 모양)만 받는다. 다른 곳으로는 절대 가지 않는다(SSRF).
- 넘겨줄 때 그림, 동영상, 소리만 화면에 띄울 수 있는 종류로 두고, 나머지(HTML, SVG 등)는
  내려받기로만 준다. 우리 주소에서 남의 HTML이 열리면 안 되기 때문이다.
"""

from __future__ import annotations

import re
import time
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

MEDIA_HOSTS = ("cdn.discordapp.com", "media.discordapp.net")
_ID = r"[0-9]{15,21}"
_FILE = r"[^/?#]{1,200}"
_HASH = r"(?:a_)?[0-9a-f]{32}"
_IMAGE_EXT = r"(?:png|jpe?g|webp|gif)"
# 받는 경로 모양: (종류, 정규식). attachments는 채널 ID로 권한을 다시 본다
PATHS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("attachment", re.compile(rf"/attachments/({_ID})/{_ID}/{_FILE}")),
    ("avatar", re.compile(rf"/avatars/{_ID}/{_HASH}\.{_IMAGE_EXT}")),
    ("avatar", re.compile(rf"/guilds/{_ID}/users/{_ID}/avatars/{_HASH}\.{_IMAGE_EXT}")),
    ("avatar", re.compile(r"/embed/avatars/[0-9]{1,2}\.png")),
    ("emoji", re.compile(rf"/emojis/{_ID}\.{_IMAGE_EXT}")),
    ("sticker", re.compile(rf"/stickers/{_ID}\.(?:png|gif|webp)")),
)
# 화면에 그대로 띄워도 되는 종류. 나머지는 내려받기로만
INLINE_TYPES = re.compile(
    r"image/(?:png|jpeg|gif|webp|avif|apng)|video/(?:mp4|webm|quicktime|ogg)|audio/[a-z0-9.+-]{1,30}"
)
# 그대로 넘겨줄 디스코드 응답 머리
PASS_HEADERS = ("content-length", "content-range", "accept-ranges", "last-modified", "etag")
MAX_URL = 2000
SMALL_CACHE_BYTES = 512 * 1024  # 이모지, 스티커, 프로필 사진만 기억(작은 것)
CACHE_TOTAL_BYTES = 32 * 1024 * 1024
CACHE_SEC = 24 * 3600
CHUNK = 64 * 1024


@dataclass(frozen=True)
class MediaTarget:
    url: str
    kind: str
    channel_id: int | None
    filename: str


def parse_media_url(value: str) -> MediaTarget | None:
    """디스코드 미디어 주소면 (주소, 종류, 첨부의 채널 ID, 파일 이름). 아니면 None."""
    if not value or len(value) > MAX_URL:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme != "https" or parts.hostname not in MEDIA_HOSTS:
        return None
    if parts.port is not None or parts.username or parts.password or parts.fragment:
        return None
    for kind, pattern in PATHS:
        found = pattern.fullmatch(parts.path)
        if found is None:
            continue
        channel = int(found.group(1)) if kind == "attachment" else None
        name = parts.path.rsplit("/", 1)[-1]
        query = f"?{parts.query}" if parts.query else ""
        url = f"https://{parts.hostname}{parts.path}{query}"
        return MediaTarget(url, kind, channel, name)
    return None


def thumbnail_of(url: str, width: int) -> str:
    """media.discordapp.net 그림은 폭과 webp를 붙여 작게(디스코드가 줄여 준다). 그 밖은 그대로."""
    parts = urlsplit(url)
    if parts.hostname != "media.discordapp.net":
        return url
    kept = parse_qsl(parts.query)
    query = [(key, value) for key, value in kept if key not in ("width", "format")]
    query += [("width", str(width)), ("format", "webp")]
    return f"https://{parts.hostname}{parts.path}?{urlencode(query)}"


def response_headers(upstream: dict[str, str], filename: str, download: bool) -> dict[str, str]:
    """넘겨줄 머리. 띄울 수 없는 종류나 내려받기 요청이면 attachment로."""
    content_type = upstream.get("content-type", "").split(";")[0].strip().lower()
    inline = not download and INLINE_TYPES.fullmatch(content_type) is not None
    headers = {key: upstream[key] for key in PASS_HEADERS if key in upstream}
    headers["Content-Type"] = content_type if inline else "application/octet-stream"
    safe_name = quote(filename, safe="")
    headers["Content-Disposition"] = (
        f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{safe_name}"
    )
    headers["X-Content-Type-Options"] = "nosniff"
    headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    headers["Cache-Control"] = "private, max-age=86400"
    headers["Referrer-Policy"] = "no-referrer"
    return headers


class MediaCache:
    """작은 그림만 메모리에(가장 오래 안 쓴 것부터 지움)."""

    def __init__(self, clock: Any = time.monotonic) -> None:
        self.clock = clock
        self._items: OrderedDict[str, tuple[float, dict[str, str], bytes]] = OrderedDict()
        self._size = 0

    def get(self, url: str) -> tuple[dict[str, str], bytes] | None:
        item = self._items.get(url)
        if item is None:
            return None
        stored, headers, body = item
        if self.clock() - stored > CACHE_SEC:
            self._drop(url)
            return None
        self._items.move_to_end(url)
        return headers, body

    def put(self, url: str, headers: dict[str, str], body: bytes) -> None:
        if len(body) > SMALL_CACHE_BYTES:
            return
        if url in self._items:
            self._drop(url)
        self._items[url] = (self.clock(), headers, body)
        self._size += len(body)
        while self._size > CACHE_TOTAL_BYTES and self._items:
            self._drop(next(iter(self._items)))

    def _drop(self, url: str) -> None:
        _, _, body = self._items.pop(url)
        self._size -= len(body)


async def stream_body(response: Any, limit: int) -> AsyncIterator[bytes]:
    """디스코드 응답을 조각으로 흘려보낸다. limit를 넘으면 끊는다."""
    sent = 0
    try:
        async for chunk in response.content.iter_chunked(CHUNK):
            sent += len(chunk)
            if sent > limit:
                break
            yield chunk
    finally:
        response.release()


@dataclass
class Fetched:
    status: int
    headers: dict[str, str]
    chunks: AsyncIterator[bytes]


class DiscordFetcher:
    """aiohttp로 디스코드에서 받기(봇과 같은 라이브러리). 넘겨주는 쪽만 쓴다."""

    TIMEOUT_SEC = 20
    MAX_BYTES = 100 * 1024 * 1024  # 디스코드 첨부 최대(니트로 500MB)보다 작게: e2-micro 보호

    def __init__(self) -> None:
        self._session: Any = None

    async def fetch(self, url: str, range_header: str | None) -> Fetched:
        import aiohttp  # 서버 쪽만 필요(테스트는 가짜를 쓴다)

        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=self.TIMEOUT_SEC)
            self._session = aiohttp.ClientSession(
                timeout=timeout, headers={"User-Agent": "mos-media/1"}
            )
        headers = {"Range": range_header} if range_header else {}
        response = await self._session.get(url, headers=headers, allow_redirects=False)
        upstream = {key.lower(): value for key, value in response.headers.items()}
        return Fetched(response.status, upstream, stream_body(response, self.MAX_BYTES))

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
