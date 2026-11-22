"""deploy/vm/mos_deploy.py의 검증·풀기·링크 교체 테스트."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import os
import tarfile
import zipfile
from pathlib import Path

import pytest

script_path = Path(__file__).resolve().parents[1] / "deploy" / "vm" / "mos_deploy.py"
spec = importlib.util.spec_from_file_location("mos_deploy", script_path)
mos_deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mos_deploy)

sample_sha = "a" * 40


def make_tgz(files: dict[str, bytes], extra_members: list[tarfile.TarInfo] | None = None) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            bundle.addfile(info, io.BytesIO(content))
        for member in extra_members or []:
            bundle.addfile(member)
    return buffer.getvalue()


def make_zip(
    path: Path, tgz: bytes, digest: str | None = None, extra: dict[str, bytes] | None = None
) -> Path:
    digest = digest or hashlib.sha256(tgz).hexdigest()
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("release.tgz", tgz)
        archive.writestr("release.sha256", f"{digest}  release.tgz\n")
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return path


def valid_files(version: str = sample_sha) -> dict[str, bytes]:
    return {
        "./VERSION": f"{version}\n".encode(),
        "./app/mos/main.py": b"print('hi')\n",
        "./app/requirements.txt": b"",
        "./web/index.html": b"<!doctype html>",
    }


def test_valid_bundle_extracts(tmp_path: Path) -> None:
    zip_path = make_zip(tmp_path / "r.zip", make_tgz(valid_files()))
    package_dir = mos_deploy.verify_and_extract(zip_path, sample_sha, tmp_path)
    assert (package_dir / "app" / "mos" / "main.py").is_file()
    assert (package_dir / "web" / "index.html").is_file()


def test_wrong_hash_is_rejected(tmp_path: Path) -> None:
    zip_path = make_zip(tmp_path / "r.zip", make_tgz(valid_files()), digest="0" * 64)
    with pytest.raises(mos_deploy.DeployError, match="해시"):
        mos_deploy.verify_and_extract(zip_path, sample_sha, tmp_path)


def test_extra_file_in_zip_is_rejected(tmp_path: Path) -> None:
    zip_path = make_zip(tmp_path / "r.zip", make_tgz(valid_files()), extra={"evil.sh": b"x"})
    with pytest.raises(mos_deploy.DeployError, match="구성"):
        mos_deploy.verify_and_extract(zip_path, sample_sha, tmp_path)


def test_version_mismatch_is_rejected(tmp_path: Path) -> None:
    zip_path = make_zip(tmp_path / "r.zip", make_tgz(valid_files(version="b" * 40)))
    with pytest.raises(mos_deploy.DeployError, match="버전"):
        mos_deploy.verify_and_extract(zip_path, sample_sha, tmp_path)


def test_missing_required_file_is_rejected(tmp_path: Path) -> None:
    files = valid_files()
    del files["./web/index.html"]
    zip_path = make_zip(tmp_path / "r.zip", make_tgz(files))
    with pytest.raises(mos_deploy.DeployError, match="필수 파일"):
        mos_deploy.verify_and_extract(zip_path, sample_sha, tmp_path)


def test_path_traversal_is_rejected(tmp_path: Path) -> None:
    files = valid_files()
    files["../escape.txt"] = b"x"
    zip_path = make_zip(tmp_path / "r.zip", make_tgz(files))
    with pytest.raises(mos_deploy.DeployError, match="풀 수 없습니다"):
        mos_deploy.verify_and_extract(zip_path, sample_sha, tmp_path)
    assert not (tmp_path / "escape.txt").exists()


def test_outside_symlink_is_rejected(tmp_path: Path) -> None:
    link = tarfile.TarInfo("./app/link")
    link.type = tarfile.SYMTYPE
    link.linkname = "/etc/passwd"
    zip_path = make_zip(tmp_path / "r.zip", make_tgz(valid_files(), extra_members=[link]))
    with pytest.raises(mos_deploy.DeployError, match="풀 수 없습니다"):
        mos_deploy.verify_and_extract(zip_path, sample_sha, tmp_path)


def test_point_link_replaces_atomically(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    link = tmp_path / "current"
    mos_deploy.point_link(link, first)
    mos_deploy.point_link(link, second)
    assert os.readlink(link) == str(second)
    assert not (tmp_path / ".current.new").exists()


def test_read_kv_file_skips_comments(tmp_path: Path) -> None:
    path = tmp_path / "config"
    content = "# 주석\nGITHUB_REPO=owner/repo\nBRANCH = 'main'\n\nbroken line\n"
    path.write_text(content, encoding="utf-8")
    assert mos_deploy.read_kv_file(path) == {"GITHUB_REPO": "owner/repo", "BRANCH": "main"}


def test_copy_limited_stops_at_limit() -> None:
    with pytest.raises(mos_deploy.DeployError, match="크기"):
        mos_deploy.copy_limited(io.BytesIO(b"x" * 10), io.BytesIO(), limit=5)


def test_latest_success_skips_running_and_failed_builds() -> None:
    runs = [
        {"head_sha": "c" * 40, "status": "in_progress", "conclusion": None},
        {"head_sha": "b" * 40, "status": "completed", "conclusion": "failure"},
        {"head_sha": "a" * 40, "status": "completed", "conclusion": "success"},
    ]
    found = mos_deploy.latest_success(runs)
    assert found is not None and found["head_sha"] == "a" * 40
    assert mos_deploy.latest_success(runs[:2]) is None
