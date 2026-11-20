"""초기 검증 스크립트의 순수 도우미(디스코드 라이브러리 없이 테스트 가능)."""

from __future__ import annotations

import base64
import hashlib
import secrets
import struct
import time
import urllib.parse
import zlib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE 형식 파일을 읽는다. 없는 파일이면 빈 값."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


# ---------------------------------------------------------------- 이미지


def make_png(width: int, height: int) -> bytes:
    """세로 그라데이션 PNG를 만든다(외부 라이브러리 없이)."""
    raw_rows = bytearray()
    for y in range(height):
        shade = (y * 255) // max(height - 1, 1)
        raw_rows.append(0)  # 필터 없음
        raw_rows.extend(bytes((shade, 120, 255 - shade)) * width)

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return (
            struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw_rows), 6))
        + chunk(b"IEND", b"")
    )


def parse_image_size(data: bytes) -> tuple[str, int, int] | None:
    """PNG·WebP·JPEG의 형식과 가로·세로를 읽는다. 모르면 None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return "png", width, height
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        kind = data[12:16]
        if kind == b"VP8X":
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
            return "webp", width, height
        if kind == b"VP8 ":
            width = struct.unpack("<H", data[26:28])[0] & 0x3FFF
            height = struct.unpack("<H", data[28:30])[0] & 0x3FFF
            return "webp", width, height
        if kind == b"VP8L":
            b0, b1, b2, b3 = data[21:25]
            width = 1 + (((b1 & 0x3F) << 8) | b0)
            height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
            return "webp", width, height
        return None
    if data[:2] == b"\xff\xd8":
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE):
                height, width = struct.unpack(">HH", data[index + 5 : index + 9])
                return "jpeg", width, height
            segment_length = struct.unpack(">H", data[index + 2 : index + 4])[0]
            index += 2 + segment_length
    return None


# ---------------------------------------------------------------- 첨부 주소


@dataclass(frozen=True)
class SignedUrlInfo:
    path: str
    expires_at: datetime | None
    issued_at: datetime | None
    has_signature: bool

    @property
    def valid_hours(self) -> float | None:
        if self.expires_at is None or self.issued_at is None:
            return None
        return round((self.expires_at - self.issued_at).total_seconds() / 3600, 1)


def parse_signed_url(url: str) -> SignedUrlInfo:
    """디스코드 첨부 주소의 ex(만료)·is(발급)·hm(서명)을 읽는다. 서명 값은 보관하지 않는다."""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query)

    def hex_time(key: str) -> datetime | None:
        value = (query.get(key) or [""])[0]
        try:
            return datetime.fromtimestamp(int(value, 16), tz=UTC)
        except ValueError:
            return None

    return SignedUrlInfo(
        path=f"{parts.netloc}{parts.path}",
        expires_at=hex_time("ex"),
        issued_at=hex_time("is"),
        has_signature=bool(query.get("hm")),
    )


def add_query(url: str, extra: dict[str, str]) -> str:
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    query.extend(extra.items())
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


# ---------------------------------------------------------------- PKCE


def make_pkce_pair() -> tuple[str, str]:
    """(verifier, challenge). verifier는 64자(규격 43~128자), challenge는 S256."""
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


# ---------------------------------------------------------------- 결과 기록


@dataclass
class ResultBook:
    """검증 결과를 모아 마크다운 파일에 덧붙인다. 비밀 값은 넣지 않는다."""

    path: Path
    title: str
    rows: list[tuple[str, str, str]] = field(default_factory=list)

    def add(self, item: str, status: str, detail: str) -> None:
        clean_detail = detail.replace("|", "/").replace("\n", " ")
        self.rows.append((item, status, clean_detail))
        print(f"[{status}] {item}: {clean_detail}", flush=True)

    def write(self) -> None:
        stamp = time.strftime("%Y-%m-%d %H:%M")
        lines = [f"\n## {stamp} {self.title}\n", "| 항목 | 결과 | 세부 |", "| --- | --- | --- |"]
        lines += [f"| {item} | {status} | {detail} |" for item, status, detail in self.rows]
        with self.path.open("a", encoding="utf-8") as out:
            out.write("\n".join(lines) + "\n")
        print(f"\n결과를 {self.path} 에 저장했어요.")
