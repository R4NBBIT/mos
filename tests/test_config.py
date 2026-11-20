from __future__ import annotations

import pytest

from mos.config import ConfigError, load_settings

base_env = {
    "DISCORD_BOT_TOKEN": "token-value",
    "PUBLIC_ORIGIN": "https://chat.example.com",
}


def test_minimal_settings() -> None:
    settings = load_settings(base_env)
    assert settings.api_host == "127.0.0.1"
    assert settings.api_port == 8000
    assert settings.cookie_secure is True
    assert settings.preview_channel_id is None


def test_secrets_are_hidden_in_repr() -> None:
    env = {**base_env, "PREVIEW_CHANNEL_ID": "1573319705849102408", "PREVIEW_ACCESS_KEY": "k" * 30}
    text = repr(load_settings(env))
    assert "token-value" not in text
    assert "k" * 30 not in text


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"DISCORD_BOT_TOKEN": ""}, "DISCORD_BOT_TOKEN"),
        ({"PUBLIC_ORIGIN": "chat.example.com"}, "PUBLIC_ORIGIN"),
        ({"PUBLIC_ORIGIN": "https://chat.example.com/app"}, "PUBLIC_ORIGIN"),
        ({"PUBLIC_ORIGIN": "http://chat.example.com"}, "https"),
        ({"API_PORT": "99999"}, "API_PORT"),
        ({"PREVIEW_CHANNEL_ID": "abc"}, "PREVIEW_CHANNEL_ID"),
        ({"PREVIEW_CHANNEL_ID": "1573319705849102408", "PREVIEW_ACCESS_KEY": "short"}, "24"),
    ],
)
def test_invalid_settings(override: dict[str, str], message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_settings({**base_env, **override})


def test_local_http_origin_is_allowed_and_not_secure() -> None:
    settings = load_settings({**base_env, "PUBLIC_ORIGIN": "http://localhost:5173/"})
    assert settings.public_origin == "http://localhost:5173"
    assert settings.cookie_secure is False
