from __future__ import annotations

import base64

import pytest

from mos.config import ConfigError, load_settings

SECRET_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()

base_env = {
    "DISCORD_BOT_TOKEN": "token-value",
    "DISCORD_CLIENT_ID": "1573318317446529064",
    "DISCORD_CLIENT_SECRET": "client-secret-value",
    "MOS_SECRET_KEY": SECRET_KEY,
    "PUBLIC_ORIGIN": "https://chat.example.com",
}


def test_minimal_settings() -> None:
    settings = load_settings(base_env)
    assert settings.api_host == "127.0.0.1"
    assert settings.api_port == 8000
    assert settings.cookie_secure is True
    assert settings.connect_redirect_uri == "https://chat.example.com/api/auth/connect/callback"
    assert settings.secret_key == b"k" * 32


def test_secrets_are_hidden_in_repr() -> None:
    text = repr(load_settings(base_env))
    assert "token-value" not in text
    assert "client-secret-value" not in text
    assert "kkkk" not in text


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"DISCORD_BOT_TOKEN": ""}, "DISCORD_BOT_TOKEN"),
        ({"PUBLIC_ORIGIN": "chat.example.com"}, "PUBLIC_ORIGIN"),
        ({"PUBLIC_ORIGIN": "https://chat.example.com/app"}, "PUBLIC_ORIGIN"),
        ({"PUBLIC_ORIGIN": "http://chat.example.com"}, "https"),
        ({"API_PORT": "99999"}, "API_PORT"),
        ({"DISCORD_CLIENT_ID": ""}, "DISCORD_CLIENT_ID"),
        ({"DISCORD_CLIENT_SECRET": ""}, "DISCORD_CLIENT_SECRET"),
        ({"MOS_SECRET_KEY": ""}, "MOS_SECRET_KEY"),
        ({"MOS_SECRET_KEY": "c2hvcnQ"}, "32"),
        ({"MOS_SECRET_KEY": "!!!"}, "MOS_SECRET_KEY"),
    ],
)
def test_invalid_settings(override: dict[str, str], message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_settings({**base_env, **override})


def test_local_http_origin_is_allowed_and_not_secure() -> None:
    settings = load_settings({**base_env, "PUBLIC_ORIGIN": "http://localhost:5173/"})
    assert settings.public_origin == "http://localhost:5173"
    assert settings.cookie_secure is False
