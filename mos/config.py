"""환경 변수에서 설정을 읽는다.

비밀 값은 systemd가 넣어 준 환경 변수로만 받는다(파일을 직접 읽지 않음).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

MIN_PREVIEW_KEY_LENGTH = 24


class ConfigError(ValueError):
    """설정 값이 없거나 잘못됨. 메시지에 비밀 값은 넣지 않는다."""


def _read_snowflake(environ: Mapping[str, str], key: str, required: bool) -> int | None:
    raw = environ.get(key, "").strip()
    if not raw:
        if required:
            raise ConfigError(f"{key} 가 필요합니다")
        return None
    if not raw.isdigit() or not 15 <= len(raw) <= 21:
        raise ConfigError(f"{key} 는 디스코드 ID(숫자)여야 합니다")
    return int(raw)


@dataclass(frozen=True)
class Settings:
    discord_bot_token: str = field(repr=False)
    public_origin: str
    db_path: Path
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    operator_discord_id: int | None = None
    # 2단계(읽기 최소판) 임시 설정: 운영자 한 명이 채널 하나만 본다
    preview_channel_id: int | None = None
    preview_access_key: str = field(default="", repr=False)

    @property
    def cookie_secure(self) -> bool:
        return self.public_origin.startswith("https://")


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if environ is None else environ

    token = env.get("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        raise ConfigError("DISCORD_BOT_TOKEN 이 필요합니다")

    origin = env.get("PUBLIC_ORIGIN", "").strip().rstrip("/")
    parts = urlsplit(origin)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path:
        raise ConfigError("PUBLIC_ORIGIN 은 https://도메인 형태여야 합니다(경로 없이)")
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1"):
        raise ConfigError("PUBLIC_ORIGIN 은 로컬 개발이 아니면 https 여야 합니다")

    port_raw = env.get("API_PORT", "8000").strip()
    if not port_raw.isdigit() or not 1 <= int(port_raw) <= 65535:
        raise ConfigError("API_PORT 는 1~65535 숫자여야 합니다")

    preview_key = env.get("PREVIEW_ACCESS_KEY", "").strip()
    preview_channel = _read_snowflake(env, "PREVIEW_CHANNEL_ID", required=False)
    if preview_channel is not None and len(preview_key) < MIN_PREVIEW_KEY_LENGTH:
        raise ConfigError(f"PREVIEW_ACCESS_KEY 는 {MIN_PREVIEW_KEY_LENGTH}자 이상이어야 합니다")

    return Settings(
        discord_bot_token=token,
        public_origin=origin,
        db_path=Path(env.get("DB_PATH", "data/mos.db").strip()),
        api_host=env.get("API_HOST", "127.0.0.1").strip(),
        api_port=int(port_raw),
        operator_discord_id=_read_snowflake(env, "OPERATOR_DISCORD_ID", required=False),
        preview_channel_id=preview_channel,
        preview_access_key=preview_key,
    )
