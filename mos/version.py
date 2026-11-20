"""실행 중인 버전(배포 커밋). 자동 배포가 app/VERSION 파일을 넣어 준다."""

from __future__ import annotations

from functools import cache
from pathlib import Path

VERSION_PATH = Path(__file__).resolve().parents[1] / "VERSION"


@cache
def current_version() -> str:
    try:
        return VERSION_PATH.read_text(encoding="utf-8").strip() or "dev"
    except OSError:
        return "dev"
