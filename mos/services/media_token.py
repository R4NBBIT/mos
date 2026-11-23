"""디스코드 미디어 주소를 화면에 보이지 않게 바꾸기.

서버가 대신 받아 주더라도 화면이 /api/media?u=https://cdn.discordapp.com/... 처럼 원래 주소를
들고 부르면 주소창, 방문 기록, 회사 보안 장비 기록에 디스코드 주소가 글자로 남는다.
그래서 화면에 나가는 모든 응답(API, 실시간)에서 디스코드 미디어 주소를
/api/media/t/<봉인한 글자> 로 바꾸고, 서버만 풀어서 원래 주소를 안다.

- 봉인은 AES-SIV(같은 주소는 늘 같은 글자라 브라우저 캐시가 그대로 듣고, 위조나 변조는 풀리지 않음)
- 열쇠는 MOS_SECRET_KEY에서 용도별로 따로 뽑는다(HKDF). 토큰, 웹훅 암호화 열쇠와 섞이지 않게
- 메시지 본문처럼 사람이 쓴 글은 건드리지 않고, 주소를 담는 이름의 칸만 바꾼다
"""

from __future__ import annotations

import base64
import binascii
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESSIV
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

SEALED_PREFIX = "/api/media/t/"
MAX_TOKEN = 4000
_DISCORD_MEDIA = ("https://cdn.discordapp.com/", "https://media.discordapp.net/")
# 주소를 담는 칸 이름(메시지 본문, 제목, 설명 같은 글 칸은 바꾸지 않는다)
_URL_KEYS = frozenset({"url", "proxy_url", "proxy_icon_url", "avatar", "icon", "author_avatar"})


def _is_url_key(key: str) -> bool:
    return key in _URL_KEYS or key.endswith("_url")


class MediaTokens:
    def __init__(self, secret_key: bytes) -> None:
        key = HKDF(
            algorithm=hashes.SHA256(), length=64, salt=None, info=b"mos media url v1"
        ).derive(secret_key)
        self._siv = AESSIV(key)

    def seal(self, url: str) -> str:
        sealed = self._siv.encrypt(url.encode("utf-8"), None)
        return base64.urlsafe_b64encode(sealed).rstrip(b"=").decode("ascii")

    def open(self, token: str) -> str | None:
        """봉인을 풀어 원래 주소. 위조, 변조, 이상한 글자면 None."""
        if not token or len(token) > MAX_TOKEN:
            return None
        try:
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
            return self._siv.decrypt(raw, None).decode("utf-8")
        except (InvalidTag, ValueError, binascii.Error, UnicodeDecodeError):
            return None

    def path(self, url: str) -> str:
        return SEALED_PREFIX + self.seal(url)

    def hide(self, value: Any, key: str = "") -> Any:
        """응답 안의 디스코드 미디어 주소를 봉인한 주소로(새 값을 돌려준다)."""
        if isinstance(value, dict):
            return {name: self.hide(item, str(name)) for name, item in value.items()}
        if isinstance(value, list):
            return [self.hide(item, key) for item in value]
        if isinstance(value, str) and _is_url_key(key) and value.startswith(_DISCORD_MEDIA):
            return self.path(value)
        return value
