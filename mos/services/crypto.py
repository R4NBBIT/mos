"""암호화·해시 도구. 비밀 값은 로그나 예외 메시지에 넣지 않는다.

- 토큰 암호화: AES-256-GCM(무작위 12바이트 nonce), 저장 형태는 'v1.' + base64(nonce + 암호문)
- 비밀번호: argon2id(argon2-cffi 기본 매개변수)
- 기기 토큰: 256비트 무작위, DB에는 SHA-256 해시만
"""

from __future__ import annotations

import base64
import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_PREFIX = "v1."
_NONCE_BYTES = 12
_password_hasher = PasswordHasher()  # argon2id


class DecryptError(Exception):
    """복호화 실패(키가 바뀌었거나 값이 변조됨)."""


class TokenCipher:
    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("key must be 32 bytes")
        self._aead = AESGCM(key)

    def __repr__(self) -> str:
        return "TokenCipher(<hidden>)"

    def encrypt(self, plaintext: str, context: str) -> str:
        """context를 함께 묶어, 다른 칸에 옮겨 붙인 값은 풀리지 않게 한다."""
        nonce = secrets.token_bytes(_NONCE_BYTES)
        sealed = self._aead.encrypt(nonce, plaintext.encode("utf-8"), context.encode("utf-8"))
        return _PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode("ascii")

    def decrypt(self, stored: str, context: str) -> str:
        if not stored.startswith(_PREFIX):
            raise DecryptError("unknown format")
        try:
            raw = base64.urlsafe_b64decode(stored[len(_PREFIX) :])
            nonce, sealed = raw[:_NONCE_BYTES], raw[_NONCE_BYTES:]
            return self._aead.decrypt(nonce, sealed, context.encode("utf-8")).decode("utf-8")
        except (InvalidTag, ValueError) as error:
            raise DecryptError("cannot decrypt") from error


class BytesCipher:
    """파일 같은 바이트 덩어리용(같은 열쇠, 앞에 nonce를 붙여 저장)."""

    def __init__(self, cipher: TokenCipher) -> None:
        self._aead = cipher._aead

    def encrypt(self, data: bytes, context: str) -> bytes:
        nonce = secrets.token_bytes(_NONCE_BYTES)
        return nonce + self._aead.encrypt(nonce, data, context.encode("utf-8"))

    def decrypt(self, stored: bytes, context: str) -> bytes:
        try:
            return self._aead.decrypt(
                stored[:_NONCE_BYTES], stored[_NONCE_BYTES:], context.encode("utf-8")
            )
        except (InvalidTag, ValueError) as error:
            raise DecryptError("cannot decrypt") from error


def hash_password(password: str) -> str:
    return _password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _password_hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def pkce_pair() -> tuple[str, str]:
    """(code_verifier, code_challenge[S256])"""
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge
