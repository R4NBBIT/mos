"""환경 변수에서 설정을 읽는다.

비밀 값은 systemd가 넣어 준 환경 변수로만 받는다(파일을 직접 읽지 않음).
"""

from __future__ import annotations

import base64
import binascii
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

SECRET_KEY_BYTES = 32  # AES-256-GCM
CONNECT_CALLBACK_PATH = "/api/auth/connect/callback"


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


def _read_secret_key(environ: Mapping[str, str]) -> bytes:
    raw = environ.get("MOS_SECRET_KEY", "").strip()
    if not raw:
        raise ConfigError("MOS_SECRET_KEY 가 필요합니다(32바이트 무작위 값의 base64)")
    try:
        key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except (binascii.Error, ValueError) as error:
        raise ConfigError("MOS_SECRET_KEY 는 base64 형식이어야 합니다") from error
    if len(key) != SECRET_KEY_BYTES:
        raise ConfigError(f"MOS_SECRET_KEY 는 {SECRET_KEY_BYTES}바이트여야 합니다")
    return key


@dataclass(frozen=True)
class Settings:
    discord_bot_token: str = field(repr=False)
    discord_client_id: int
    discord_client_secret: str = field(repr=False)
    secret_key: bytes = field(repr=False)
    public_origin: str
    db_path: Path
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    operator_discord_id: int | None = None
    # 임시 설정: 볼 채널 하나. 3-2단계(권한 계산·채널 목록)에서 없어진다
    preview_channel_id: int | None = None

    @property
    def cookie_secure(self) -> bool:
        return self.public_origin.startswith("https://")

    @property
    def connect_redirect_uri(self) -> str:
        """디스코드 개발자 포털 OAuth2 › Redirects에 똑같이 등록해야 하는 주소."""
        return self.public_origin + CONNECT_CALLBACK_PATH


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

    client_id = _read_snowflake(env, "DISCORD_CLIENT_ID", required=True)
    if client_id is None:  # required=True라 오지 않지만 타입을 좁힌다
        raise ConfigError("DISCORD_CLIENT_ID 가 필요합니다")
    client_secret = env.get("DISCORD_CLIENT_SECRET", "").strip()
    if not client_secret:
        raise ConfigError("DISCORD_CLIENT_SECRET 이 필요합니다")

    return Settings(
        discord_bot_token=token,
        discord_client_id=client_id,
        discord_client_secret=client_secret,
        secret_key=_read_secret_key(env),
        public_origin=origin,
        db_path=Path(env.get("DB_PATH", "data/mos.db").strip()),
        api_host=env.get("API_HOST", "127.0.0.1").strip(),
        api_port=int(port_raw),
        operator_discord_id=_read_snowflake(env, "OPERATOR_DISCORD_ID", required=False),
        preview_channel_id=_read_snowflake(env, "PREVIEW_CHANNEL_ID", required=False),
    )
