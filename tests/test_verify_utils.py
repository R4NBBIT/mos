"""tools/verify/verify_utils.py 테스트(디스코드 연결 없이)."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import struct
import sys
from pathlib import Path

utils_path = Path(__file__).resolve().parents[1] / "tools" / "verify" / "verify_utils.py"
spec = importlib.util.spec_from_file_location("verify_utils", utils_path)
verify_utils = importlib.util.module_from_spec(spec)
sys.modules["verify_utils"] = verify_utils  # dataclass가 모듈을 찾을 수 있게
spec.loader.exec_module(verify_utils)


def test_make_png_size_is_readable() -> None:
    data = verify_utils.make_png(64, 32)
    assert verify_utils.parse_image_size(data) == ("png", 64, 32)


def test_parse_webp_lossless_header() -> None:
    width, height = 400, 267
    bits = (width - 1) | ((height - 1) << 14)
    header = (
        b"RIFF"
        + b"\0\0\0\0"
        + b"WEBP"
        + b"VP8L"
        + b"\0\0\0\0"
        + b"\x2f"
        + bits.to_bytes(4, "little")
    )
    assert verify_utils.parse_image_size(header + b"\0" * 8) == ("webp", 400, 267)


def test_parse_webp_extended_header() -> None:
    header = (
        b"RIFF\0\0\0\0WEBPVP8X"
        + b"\0" * 8
        + (399).to_bytes(3, "little")
        + (266).to_bytes(3, "little")
    )
    assert verify_utils.parse_image_size(header) == ("webp", 400, 267)


def test_parse_jpeg_header() -> None:
    sof = b"\xff\xc0" + struct.pack(">HBHH", 17, 8, 267, 400) + b"\0" * 10
    data = b"\xff\xd8" + b"\xff\xe0" + struct.pack(">H", 4) + b"\0\0" + sof
    assert verify_utils.parse_image_size(data) == ("jpeg", 400, 267)


def test_unknown_image_returns_none() -> None:
    assert verify_utils.parse_image_size(b"not an image at all") is None


def test_parse_signed_url_reads_times_without_keeping_signature() -> None:
    url = "https://cdn.discordapp.com/attachments/1/2/a.png?ex=6a5a5443&is=6a5902c3&hm=abc&"
    info = verify_utils.parse_signed_url(url)
    assert info.path == "cdn.discordapp.com/attachments/1/2/a.png"
    assert info.has_signature is True
    assert info.valid_hours == round((0x6A5A5443 - 0x6A5902C3) / 3600, 1)
    assert "abc" not in repr(info)


def test_add_query_keeps_existing_params() -> None:
    url = verify_utils.add_query("https://media.discordapp.net/x.png?ex=1&hm=2", {"width": "400"})
    assert url == "https://media.discordapp.net/x.png?ex=1&hm=2&width=400"


def test_pkce_pair_matches_s256() -> None:
    verifier, challenge = verify_utils.make_pkce_pair()
    assert 43 <= len(verifier) <= 128
    digest = hashlib.sha256(verifier.encode()).digest()
    assert challenge == base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def test_read_env_file(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text("# 주석\nVERIFY_TEXT_CHANNEL = '123'\n\nbroken\n", encoding="utf-8")
    assert verify_utils.read_env_file(path) == {"VERIFY_TEXT_CHANNEL": "123"}
    assert verify_utils.read_env_file(tmp_path / "none") == {}


def test_result_book_strips_table_breakers(tmp_path: Path) -> None:
    book = verify_utils.ResultBook(tmp_path / "r.md", "check")
    book.add("항목", "통과", "a|b\nc")
    book.write()
    text = (tmp_path / "r.md").read_text(encoding="utf-8")
    assert "| 항목 | 통과 | a/b c |" in text
