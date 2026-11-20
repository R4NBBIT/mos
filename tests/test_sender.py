from __future__ import annotations

from mos.services.messages import strip_reply_quote
from mos.services.sender import reply_quote, safe_username


def test_safe_username_avoids_blocked_words() -> None:
    assert "discord" not in safe_username("discord 좋아").lower()
    assert "everyone" not in safe_username("Everyone").lower()
    assert safe_username("   ") == "이름 없음"
    assert len(safe_username("가" * 200)) == 80


def test_reply_quote_has_no_pings_or_markup() -> None:
    line = reply_quote(
        "모*카*", "<@123456789012345678> 보세요 <@&5> **굵게**\n둘째 줄", "https://x/1"
    )
    assert line.startswith("> ↪ **모카**: @… 보세요 @… 굵게 둘째 줄 [원문](https://x/1)")
    assert line.endswith("\n")
    long = reply_quote("a", "가" * 100, "l")
    assert "…" in long and len(long) < 120
    assert "(첨부)" in reply_quote("a", "", "l")


def test_strip_reply_quote() -> None:
    assert strip_reply_quote("> ↪ **a**: b [원문](l)\n본문") == "본문"
    assert strip_reply_quote("> 그냥 인용\n본문") == "> 그냥 인용\n본문"
