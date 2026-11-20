from __future__ import annotations

import base64
import hashlib

import pytest

from mos.services import crypto
from mos.services.session import password_problem


def test_cipher_round_trip_and_context_binding() -> None:
    cipher = crypto.TokenCipher(b"x" * 32)
    stored = cipher.encrypt("access-token", "discord-user:1:access")
    assert "access-token" not in stored
    assert cipher.decrypt(stored, "discord-user:1:access") == "access-token"
    with pytest.raises(crypto.DecryptError):
        cipher.decrypt(stored, "discord-user:2:access")  # 다른 칸으로 옮긴 값
    with pytest.raises(crypto.DecryptError):
        crypto.TokenCipher(b"y" * 32).decrypt(stored, "discord-user:1:access")
    assert "x" not in repr(cipher)


def test_same_plaintext_encrypts_differently() -> None:
    cipher = crypto.TokenCipher(b"x" * 32)
    assert cipher.encrypt("a", "c") != cipher.encrypt("a", "c")


def test_password_hash_is_argon2id() -> None:
    hashed = crypto.hash_password("correct horse")
    assert hashed.startswith("$argon2id$")
    assert crypto.verify_password(hashed, "correct horse")
    assert not crypto.verify_password(hashed, "wrong horse")
    assert not crypto.verify_password("not-a-hash", "x")


def test_pkce_challenge_is_s256_of_verifier() -> None:
    verifier, challenge = crypto.pkce_pair()
    digest = hashlib.sha256(verifier.encode()).digest()
    assert challenge == base64.urlsafe_b64encode(digest).decode().rstrip("=")
    assert 43 <= len(verifier) <= 128


@pytest.mark.parametrize(
    ("password", "problem"),
    [
        ("short", "password_too_short"),
        ("x" * 129, "password_too_long"),
        ("password1", "password_too_common"),
        ("aaaaaaaaaa", "password_too_common"),
        ("모카모카짱", "password_too_short"),
        ("mochamocha", "password_too_common"),
        ("달빛 아래 수다 2026", None),
    ],
)
def test_password_rules(password: str, problem: str | None) -> None:
    assert password_problem(password, account_name="mochamocha") == problem
