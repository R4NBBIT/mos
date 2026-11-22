#!/usr/bin/env python3
"""ㅁㅇㅅ 자동 배포.

GitHub Actions가 main에서 만든 최신 배포 묶음(release)을 가져와 새 릴리스 폴더를 만들고,
링크를 바꿔 재시작한 뒤 /api/healthz로 확인한다. 실패하면 직전 버전으로 되돌린다.

- root로 실행한다(mos-deploy.timer가 3분마다 실행).
- 표준 라이브러리만 쓴다.
- 이 파일은 레포에서 자동으로 갱신되지 않는다. 바꾸면 install.sh로 다시 설치한다.
"""

from __future__ import annotations

import argparse
import fcntl
import grp
import hashlib
import json
import os
import pwd
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, BinaryIO

CONFIG_PATH = Path("/etc/mos-deploy/config")
TOKEN_PATH = Path("/etc/mos-deploy/token")
PAUSE_PATH = Path("/etc/mos-deploy/paused")
STATE_DIR = Path("/var/lib/mos-deploy")
PIP_CACHE_DIR = Path("/var/cache/mos-deploy/pip")
LOCK_PATH = Path("/run/mos-deploy.lock")

APP_ROOT = Path("/opt/mos")
APP_RELEASES = APP_ROOT / "releases"
APP_CURRENT = APP_ROOT / "current"
ENV_PATH = APP_ROOT / ".env"
DATA_DIR = APP_ROOT / "data"
DB_BACKUP_DIR = APP_ROOT / "backup"
WEB_ROOT = Path("/srv/mos-web")
WEB_RELEASES = WEB_ROOT / "releases"
WEB_CURRENT = WEB_ROOT / "current"

APP_USER = "mos"
SERVICE_NAME = "mos"
SYSTEM_PYTHON = "/usr/bin/python3"
HEALTH_URL = "http://127.0.0.1:8000/api/healthz"
HEALTH_TIMEOUT_SEC = 90
KEEP_RELEASES = 3
KEEP_PREDEPLOY_BACKUPS = 3
MAX_ATTEMPTS_PER_VERSION = 2
MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024
MAX_UNPACKED_BYTES = 500 * 1024 * 1024
WORKFLOW_FILE = "deploy.yml"
ARTIFACT_NAME = "release"
RUNS_PER_PAGE = 10
USER_AGENT = "mos-deploy/1.0"

SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
REPO_PATTERN = re.compile(r"^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")
BRANCH_PATTERN = re.compile(r"^[A-Za-z0-9._/-]+$")
DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
REDIRECT_CODES = {301, 302, 303, 307, 308}


class TransientError(Exception):
    """네트워크 오류 등 다음 실행 때 다시 시도하면 되는 오류."""


class AuthError(Exception):
    """GitHub 토큰이 만료됐거나 권한이 없다."""


class DeployError(Exception):
    """이 버전을 배포하지 못한 오류. stage에 실패한 단계 이름을 담는다."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """리다이렉트를 따라가지 않는다(인증 헤더가 다른 호스트로 넘어가지 않게)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


# 프록시 환경 변수의 영향을 받지 않는 opener
_remote_opener = urllib.request.build_opener(_NoRedirect)
_local_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def short(sha: str | None) -> str:
    return sha[:7] if sha else "없음"


def read_kv_file(path: Path) -> dict[str, str]:
    """KEY=VALUE 형식 파일을 읽는다. 값은 로그에 남기지 않는다."""
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


# ---------------------------------------------------------------- 상태 기록


def read_attempts(sha: str) -> int:
    path = STATE_DIR / "attempts"
    if not path.exists():
        return 0
    parts = path.read_text(encoding="utf-8").split()
    if len(parts) == 2 and parts[0] == sha and parts[1].isdigit():
        return int(parts[1])
    return 0


def write_attempts(sha: str, count: int) -> None:
    (STATE_DIR / "attempts").write_text(f"{sha} {count}\n", encoding="utf-8")


def clear_attempts() -> None:
    (STATE_DIR / "attempts").unlink(missing_ok=True)


# ---------------------------------------------------------------- GitHub


def github_get_json(url: str, token: str) -> dict:
    request = urllib.request.Request(  # noqa: S310 - https 고정 주소
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with _remote_opener.open(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise AuthError from None
        raise TransientError(f"GitHub 응답 HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise TransientError(f"GitHub 연결 실패: {type(error).__name__}") from None


def latest_success(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """최신 빌드부터 보며 처음 끝까지 성공한 것. 빌드 중인 최신 것은 건너뛴다."""
    for run in items:
        if run.get("status") == "completed" and run.get("conclusion") == "success":
            return run
    return None


def resolve_latest(repo: str, branch: str, token: str) -> tuple[str, int] | None:
    """main의 마지막 성공 빌드 커밋과 그 배포 묶음 ID를 찾는다.
    status=success 거르기는 GitHub 쪽 색인이 수십 분 늦을 때가 있어(2026-11-22 확인),
    거르지 않은 최근 목록에서 직접 고른다."""
    query = urllib.parse.urlencode({"branch": branch, "per_page": str(RUNS_PER_PAGE)})
    runs = github_get_json(
        f"https://api.github.com/repos/{repo}/actions/workflows/{WORKFLOW_FILE}/runs?{query}",
        token,
    )
    run = latest_success(runs.get("workflow_runs") or [])
    if run is None:
        return None
    sha = str(run.get("head_sha", ""))
    run_id = run.get("id")
    if not SHA_PATTERN.match(sha) or not isinstance(run_id, int):
        raise TransientError("빌드 기록 형식이 예상과 다릅니다")
    if run.get("head_branch") != branch:
        return None

    artifacts = github_get_json(
        f"https://api.github.com/repos/{repo}/actions/runs/{run_id}/artifacts?per_page=20",
        token,
    )
    for artifact in artifacts.get("artifacts") or []:
        if artifact.get("name") != ARTIFACT_NAME or artifact.get("expired"):
            continue
        artifact_id = artifact.get("id")
        if not isinstance(artifact_id, int):
            continue
        if int(artifact.get("size_in_bytes") or 0) > MAX_DOWNLOAD_BYTES:
            raise DeployError("download", "배포 묶음이 너무 큽니다")
        return sha, artifact_id
    # 빌드는 성공했지만 묶음이 없음: 아직 서버·웹 코드가 다 갖춰지지 않은 상태
    return None


def copy_limited(source: BinaryIO, target: BinaryIO, limit: int) -> hashlib._Hash:
    """limit 바이트까지만 복사하고 sha256을 함께 계산한다."""
    digest = hashlib.sha256()
    total = 0
    while chunk := source.read(1024 * 1024):
        total += len(chunk)
        if total > limit:
            raise DeployError("download", "배포 묶음이 크기 제한을 넘었습니다")
        digest.update(chunk)
        target.write(chunk)
    return digest


def download_artifact(repo: str, artifact_id: int, token: str, destination: Path) -> None:
    url = f"https://api.github.com/repos/{repo}/actions/artifacts/{artifact_id}/zip"
    request = urllib.request.Request(  # noqa: S310 - https 고정 주소
        url, headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    )
    location = ""
    try:
        with _remote_opener.open(request, timeout=30) as response, destination.open("wb") as out:
            copy_limited(response, out, MAX_DOWNLOAD_BYTES)
            return
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise AuthError from None
        if error.code not in REDIRECT_CODES:
            raise TransientError(f"묶음 받기 실패 HTTP {error.code}") from None
        location = error.headers.get("Location", "")
    except (urllib.error.URLError, TimeoutError) as error:
        raise TransientError(f"묶음 받기 실패: {type(error).__name__}") from None

    if urllib.parse.urlsplit(location).scheme != "https":
        raise DeployError("download", "안전하지 않은 다운로드 주소입니다")
    # 실제 파일 주소는 서명된 임시 주소라 인증 헤더 없이 받는다
    blob_request = urllib.request.Request(location, headers={"User-Agent": USER_AGENT})  # noqa: S310
    try:
        with (
            _remote_opener.open(blob_request, timeout=60) as response,
            destination.open("wb") as out,
        ):
            copy_limited(response, out, MAX_DOWNLOAD_BYTES)
    except urllib.error.HTTPError as error:
        raise TransientError(f"묶음 받기 실패 HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError) as error:
        raise TransientError(f"묶음 받기 실패: {type(error).__name__}") from None


# ---------------------------------------------------------------- 검증과 풀기


def verify_and_extract(zip_path: Path, expected_sha: str, work_dir: Path) -> Path:
    """묶음 해시를 확인하고 안전하게 푼다. 풀린 폴더 경로를 돌려준다."""
    tgz_path = work_dir / "release.tgz"
    try:
        with zipfile.ZipFile(zip_path) as archive:
            names = sorted(info.filename for info in archive.infolist())
            if names != ["release.sha256", "release.tgz"]:
                raise DeployError("verify", f"묶음 구성이 예상과 다릅니다: {names}")
            checksum_fields = archive.read("release.sha256").decode("ascii").split()
            if (
                len(checksum_fields) != 2
                or not DIGEST_PATTERN.match(checksum_fields[0])
                or checksum_fields[1].lstrip("*") != "release.tgz"
            ):
                raise DeployError("verify", "해시 파일 형식이 잘못됐습니다")
            with archive.open("release.tgz") as source, tgz_path.open("wb") as target:
                digest = copy_limited(source, target, MAX_DOWNLOAD_BYTES)
    except (zipfile.BadZipFile, UnicodeDecodeError, KeyError) as error:
        raise DeployError("verify", f"묶음을 열 수 없습니다: {type(error).__name__}") from None

    if digest.hexdigest() != checksum_fields[0]:
        raise DeployError("verify", "해시가 맞지 않습니다")

    package_dir = work_dir / "pkg"
    package_dir.mkdir()
    try:
        with tarfile.open(tgz_path, "r:gz") as bundle:
            members = bundle.getmembers()
            if sum(member.size for member in members) > MAX_UNPACKED_BYTES:
                raise DeployError("verify", "풀린 크기가 제한을 넘었습니다")
            # data 필터: 절대 경로, '..', 밖을 가리키는 링크, 특수 파일을 거부한다
            bundle.extractall(package_dir, members=members, filter="data")
    except (tarfile.TarError, OSError) as error:
        raise DeployError("verify", f"묶음을 풀 수 없습니다: {type(error).__name__}") from None

    version_path = package_dir / "VERSION"
    bundle_version = ""
    if version_path.is_file():
        bundle_version = version_path.read_text(encoding="utf-8").strip()
    if bundle_version != expected_sha:
        raise DeployError("verify", "묶음의 버전이 빌드 기록과 다릅니다")
    for required in ("app/mos/main.py", "app/requirements.txt", "web/index.html"):
        if not (package_dir / required).is_file():
            raise DeployError("verify", f"필수 파일이 없습니다: {required}")
    return package_dir


# ---------------------------------------------------------------- 릴리스 만들기


def run_command(args: list[str], stage: str, env: dict[str, str] | None = None) -> None:
    result = subprocess.run(  # noqa: S603 - 인자는 이 스크립트가 만든 고정 값
        args, capture_output=True, text=True, env=env, timeout=900, check=False
    )
    if result.returncode != 0:
        output_tail = (result.stdout + result.stderr)[-2000:]
        log(f"{stage} 명령 실패(코드 {result.returncode}):\n{output_tail}")
        raise DeployError(stage, f"{Path(args[0]).name} 실행 실패")


def set_tree_permissions(root: Path, uid: int, gid: int, dir_mode: int, file_mode: int) -> None:
    """소유자와 권한을 일괄 지정한다. 실행 파일은 폴더와 같은 권한을 받는다."""
    for current, dir_names, file_names in os.walk(root):
        current_path = Path(current)
        os.chown(current_path, uid, gid)
        os.chmod(current_path, dir_mode)
        for name in [*dir_names, *file_names]:
            path = current_path / name
            if path.is_symlink():
                os.chown(path, uid, gid, follow_symlinks=False)
                continue
            if path.is_dir():
                continue
            is_executable = bool(path.stat().st_mode & 0o111)
            os.chown(path, uid, gid)
            os.chmod(path, dir_mode if is_executable else file_mode)


def remove_release(sha: str) -> None:
    for path in (APP_RELEASES / sha, WEB_RELEASES / sha):
        if path.exists() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)


def build_release(package_dir: Path, sha: str) -> None:
    """릴리스 폴더(app·venv·web)를 만든다. 코드는 root 소유, 앱 계정은 읽기만 한다."""
    remove_release(sha)  # 이전에 중간에 멈춘 흔적 정리
    app_release = APP_RELEASES / sha
    web_release = WEB_RELEASES / sha
    app_release.mkdir()
    shutil.move(package_dir / "app", app_release / "app")
    shutil.copyfile(package_dir / "VERSION", app_release / "app" / "VERSION")
    shutil.move(package_dir / "web", web_release)

    venv_dir = app_release / "venv"
    run_command([SYSTEM_PYTHON, "-m", "venv", str(venv_dir)], "venv")
    pip_env = {
        "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": str(STATE_DIR),
        "PIP_CACHE_DIR": str(PIP_CACHE_DIR),
        "LANG": "C.UTF-8",
    }
    run_command(
        [
            str(venv_dir / "bin" / "pip"),
            "install",
            "--require-hashes",
            "--only-binary=:all:",  # 소스 빌드(설치 중 코드 실행) 금지
            "--no-input",
            "--disable-pip-version-check",
            "--root-user-action=ignore",
            "-r",
            str(app_release / "app" / "requirements.txt"),
        ],
        "pip",
        env=pip_env,
    )

    app_gid = grp.getgrnam(APP_USER).gr_gid
    set_tree_permissions(app_release, 0, app_gid, 0o750, 0o640)
    set_tree_permissions(web_release, 0, 0, 0o755, 0o644)


def point_link(link: Path, target: Path) -> None:
    """심볼릭 링크를 원자적으로 바꾼다."""
    temp_link = link.with_name(f".{link.name}.new")
    if temp_link.is_symlink() or temp_link.exists():
        temp_link.unlink()
    os.symlink(target, temp_link)
    os.replace(temp_link, link)


def switch_to(sha: str) -> None:
    try:
        point_link(APP_CURRENT, APP_RELEASES / sha)
        point_link(WEB_CURRENT, WEB_RELEASES / sha)
    except OSError as error:
        raise DeployError("switch", f"링크 교체 실패: {type(error).__name__}") from None


def current_sha() -> str | None:
    if not APP_CURRENT.is_symlink():
        return None
    name = Path(os.readlink(APP_CURRENT)).name
    return name if SHA_PATTERN.match(name) else None


def prune_releases(keep: set[str]) -> None:
    for releases_dir in (APP_RELEASES, WEB_RELEASES):
        entries = sorted(
            (p for p in releases_dir.iterdir() if p.is_dir() and SHA_PATTERN.match(p.name)),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for index, path in enumerate(entries):
            if path.name in keep or index < KEEP_RELEASES:
                continue
            shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------- DB 백업


def backup_database(env_values: dict[str, str], sha: str) -> None:
    db_path = Path(env_values.get("DB_PATH", str(DATA_DIR / "mos.db"))).resolve()
    if DATA_DIR.resolve() not in db_path.parents:
        raise DeployError("backup", "DB_PATH가 데이터 폴더 밖을 가리킵니다")
    if not db_path.exists():
        log("DB가 아직 없어 배포 전 백업을 건너뜁니다")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    # 백업 폴더는 앱 계정 소유라, root 전용 폴더에서 만들고 권한까지 정한 뒤 옮긴다
    # (앱 계정이 미리 심어 둔 링크를 root가 따라가 쓰는 일을 막는다)
    staging = STATE_DIR / f"predeploy-{stamp}.db"
    target = DB_BACKUP_DIR / f"predeploy-{stamp}-{short(sha)}.db"
    staging.unlink(missing_ok=True)
    try:
        source = sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True)
        try:
            destination = sqlite3.connect(staging)
            try:
                source.backup(destination)
            finally:
                destination.close()
        finally:
            source.close()
    except sqlite3.Error as error:
        staging.unlink(missing_ok=True)
        raise DeployError("backup", f"배포 전 DB 백업 실패: {type(error).__name__}") from None

    app_account = pwd.getpwnam(APP_USER)
    os.chown(staging, app_account.pw_uid, app_account.pw_gid)
    os.chmod(staging, 0o600)
    os.replace(staging, target)  # rename은 대상 링크를 따라가지 않는다
    old_backups = sorted(DB_BACKUP_DIR.glob("predeploy-*.db"))[:-KEEP_PREDEPLOY_BACKUPS]
    for path in old_backups:
        path.unlink(missing_ok=True)


# ---------------------------------------------------------------- 재시작과 확인


def restart_service() -> None:
    run_command(["/usr/bin/systemctl", "restart", SERVICE_NAME], "restart")


def stop_service() -> None:
    subprocess.run(  # noqa: S603
        ["/usr/bin/systemctl", "stop", SERVICE_NAME], capture_output=True, check=False, timeout=60
    )


def wait_healthy(expected_sha: str, timeout_sec: int = HEALTH_TIMEOUT_SEC) -> bool:
    """healthz가 ok=true, version=expected_sha를 돌려줄 때까지 기다린다."""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        time.sleep(3)
        try:
            with _local_opener.open(HEALTH_URL, timeout=5) as response:
                body = json.load(response)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            continue
        if not isinstance(body, dict):
            continue
        if body.get("ok") is True and body.get("version") == expected_sha:
            return True
    return False


# ---------------------------------------------------------------- 알림


def _post_json(url: str, payload: dict, headers: dict[str, str]) -> dict:
    request = urllib.request.Request(  # noqa: S310 - https 고정 주소
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    with _remote_opener.open(request, timeout=15) as response:
        return json.load(response)


def notify(env_values: dict[str, str], text: str) -> None:
    """운영자에게 디스코드 DM을 보낸다. 실패해도 배포 흐름은 멈추지 않는다."""
    bot_token = env_values.get("DISCORD_BOT_TOKEN", "")
    operator_id = env_values.get("OPERATOR_DISCORD_ID", "")
    if not bot_token or not operator_id.isdigit():
        log("DM 설정이 없어 알림을 건너뜁니다")
        return
    headers = {
        "Authorization": f"Bot {bot_token}",
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://discord.com, 1.0)",
    }
    try:
        channel = _post_json(
            "https://discord.com/api/v10/users/@me/channels", {"recipient_id": operator_id}, headers
        )
        channel_id = str(channel.get("id", ""))
        if not channel_id.isdigit():
            raise ValueError("bad channel id")
        _post_json(
            f"https://discord.com/api/v10/channels/{channel_id}/messages",
            {"content": text[:1900], "allowed_mentions": {"parse": []}},
            headers,
        )
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
        log(f"DM 알림 실패: {type(error).__name__}")


# ---------------------------------------------------------------- 배포 흐름


def deploy(repo: str, branch: str, token: str, env_values: dict[str, str], force: bool) -> int:
    latest = resolve_latest(repo, branch, token)
    (STATE_DIR / "auth_failed").unlink(missing_ok=True)
    if latest is None:
        log("배포할 묶음이 없습니다")
        return 0

    sha, artifact_id = latest
    previous_sha = current_sha()
    if sha == previous_sha:
        return 0
    attempts = read_attempts(sha)
    if attempts >= MAX_ATTEMPTS_PER_VERSION and not force:
        log(f"{short(sha)}은 {attempts}번 실패해 건너뜁니다(다시 하려면 --force)")
        return 0

    log(f"새 버전 {short(sha)} 배포 시작(현재 {short(previous_sha)})")
    write_attempts(sha, attempts + 1)
    work_dir = Path(tempfile.mkdtemp(prefix="work-", dir=STATE_DIR))
    switched = False
    try:
        zip_path = work_dir / "release.zip"
        download_artifact(repo, artifact_id, token, zip_path)
        package_dir = verify_and_extract(zip_path, sha, work_dir)
        build_release(package_dir, sha)
        backup_database(env_values, sha)
        switch_to(sha)
        switched = True
        restart_service()
        if not wait_healthy(sha):
            raise DeployError("health", "새 버전이 정상 응답하지 않습니다")
    except DeployError as error:
        log(f"배포 실패({error.stage}): {error}")
        result_text = handle_failure(sha, previous_sha, switched)
        notify(
            env_values,
            f"ㅁㅇㅅ 배포 실패 {short(sha)} · 단계 {error.stage} · {error}\n{result_text}",
        )
        return 1
    except (TransientError, AuthError):
        if not switched:
            remove_release(sha)
        write_attempts(sha, attempts)  # 네트워크·토큰 문제는 시도 횟수에 넣지 않는다
        raise
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    clear_attempts()
    prune_releases(keep={sha, previous_sha} if previous_sha else {sha})
    log(f"배포 완료: {short(sha)}")
    notify(env_values, f"ㅁㅇㅅ 배포 완료 {short(sha)}")
    return 0


def handle_failure(sha: str, previous_sha: str | None, switched: bool) -> str:
    """실패한 버전을 정리하고 되돌린다. 결과 설명을 돌려준다."""
    if not switched:
        remove_release(sha)
        return f"서비스는 그대로 {short(previous_sha)} 버전입니다."
    if previous_sha is None:
        stop_service()  # 첫 배포 실패: 재시작 반복을 막는다
        return "첫 배포라 되돌릴 버전이 없어 서비스를 멈췄습니다."
    try:
        switch_to(previous_sha)
        restart_service()
        if wait_healthy(previous_sha):
            return f"{short(previous_sha)} 버전으로 되돌렸습니다."
        return f"{short(previous_sha)}로 되돌렸지만 정상 응답이 없습니다. 서버를 확인하세요."
    except (DeployError, OSError) as error:
        log(f"되돌리기 실패: {error}")
        return "되돌리기에도 실패했습니다. 서버를 직접 확인하세요."


def main() -> int:
    parser = argparse.ArgumentParser(description="ㅁㅇㅅ 자동 배포")
    parser.add_argument(
        "--force", action="store_true", help="실패 기록이 있어도 최신 버전을 다시 시도"
    )
    args = parser.parse_args()

    if os.geteuid() != 0:
        print("root로 실행해야 합니다", file=sys.stderr)
        return 2
    os.umask(0o077)
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)

    with LOCK_PATH.open("w") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("다른 배포가 진행 중입니다")
            return 0

        if PAUSE_PATH.exists():
            log(f"일시정지 중이라 건너뜁니다({PAUSE_PATH})")
            return 0

        config = read_kv_file(CONFIG_PATH)
        repo = config.get("GITHUB_REPO", "")
        branch = config.get("BRANCH", "main")
        if not REPO_PATTERN.match(repo) or not BRANCH_PATTERN.match(branch):
            log(f"설정 오류: {CONFIG_PATH}의 GITHUB_REPO·BRANCH를 확인하세요")
            return 2
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
        if not token:
            log(f"토큰이 비어 있습니다: {TOKEN_PATH}")
            return 2
        env_values = read_kv_file(ENV_PATH) if ENV_PATH.exists() else {}

        try:
            return deploy(repo, branch, token, env_values, force=args.force)
        except AuthError:
            log("GitHub 토큰이 만료됐거나 권한이 없습니다")
            flag = STATE_DIR / "auth_failed"
            if not flag.exists():
                flag.touch()
                notify(
                    env_values, "ㅁㅇㅅ 자동 배포 중단: GitHub 토큰이 만료됐거나 권한이 없습니다."
                )
            return 1
        except TransientError as error:
            log(f"다음 실행 때 다시 시도합니다: {error}")
            return 0


if __name__ == "__main__":
    sys.exit(main())
