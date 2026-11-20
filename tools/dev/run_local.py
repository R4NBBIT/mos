"""내 PC에서 mos 서버를 실행한다(개발용).

tools/dev/.env 의 값을 환경 변수로 넣고 `python -m mos.main` 과 같은 일을 한다.
서버 코드 자체는 파일을 읽지 않고 환경 변수만 본다(운영에서는 systemd가 넣어 줌).

사용(레포 루트): .venv\\Scripts\\python tools/dev/run_local.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ENV_PATH = HERE / ".env"


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main() -> None:
    if not ENV_PATH.exists():
        sys.exit("tools/dev/.env 가 없어요. tools/dev/.env.example 을 복사해 채워 주세요.")
    os.environ.update(read_env_file(ENV_PATH))
    os.chdir(ROOT)  # DB_PATH=data/mos.db 가 레포 안 data 폴더를 가리키게
    sys.path.insert(0, str(ROOT))

    from mos.main import main as run_server

    run_server()


if __name__ == "__main__":
    main()
