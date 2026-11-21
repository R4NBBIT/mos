"""위장 화면 파일·고친 내용을 계정에 저장(SCR-12 2차). 내용은 암호화해서 DB에 둔다.

- sheet: 브라우저가 읽은 표(JSON). 원본 .xlsx는 서버로 보내지 않는다.
- image: 업무 화면 스크린샷(PNG·JPEG·WebP·GIF). 실제 파일 머리를 보고 형식을 정한다.
- text: 메모장 글 원본(UTF-8).
- note: 노션 페이지 글(.md, .txt, UTF-8).
- word: Word 문서에서 브라우저가 뽑은 글(제목, 목록 표시만 남긴 UTF-8). 원본 .docx는 보내지 않는다.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Callable
from typing import Any

from mos.db.database import Database
from mos.services.crypto import BytesCipher

KINDS = ("sheet", "image", "text", "note", "word")
MAX_BYTES = {
    "sheet": 2 * 1024 * 1024,
    "image": 4 * 1024 * 1024,
    "text": 200 * 1024,
    "note": 200 * 1024,
    "word": 200 * 1024,
}
MAX_EDITS_BYTES = 300 * 1024
MAX_NAME = 80
EDIT_KEY_RE = re.compile(r"[a-z0-9:._-]{1,80}")


class BossFileError(ValueError):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def image_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def clean_name(name: str) -> str:
    base = re.split(r"[\\/]", name or "")[-1]
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip()
    return base[:MAX_NAME] or "제목 없음"


def check_asset(kind: str, data: bytes) -> str:
    """형식 확인. 돌려주는 값은 내려줄 때 쓸 MIME."""
    if kind not in KINDS:
        raise BossFileError("not_found", 404)
    if not data:
        raise BossFileError("empty_file")
    if len(data) > MAX_BYTES[kind]:
        raise BossFileError("file_too_large", 413)
    if kind == "image":
        mime = image_mime(data)
        if mime is None:
            raise BossFileError("bad_image")
        return mime
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BossFileError("bad_text") from error
    if kind == "sheet":
        try:
            value = json.loads(text)
        except ValueError as error:
            raise BossFileError("bad_sheet") from error
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("sheets"), list)
            or not value["sheets"]
        ):
            raise BossFileError("bad_sheet")
        return "application/json"
    return "text/plain; charset=utf-8"


class BossFiles:
    def __init__(
        self, db: Database, cipher: BytesCipher, clock: Callable[[], float] = time.time
    ) -> None:
        self.db = db
        self.cipher = cipher
        self.clock = clock

    @staticmethod
    def _context(account_id: int, kind: str) -> str:
        return f"boss:{account_id}:{kind}"

    async def info(self, account_id: int) -> dict[str, Any]:
        rows = await self.db.fetch_all(
            "SELECT kind, name, mime, size, version, updated_at FROM boss_asset"
            " WHERE account_id = ?",
            (account_id,),
        )
        return {
            row["kind"]: {
                "name": row["name"],
                "mime": row["mime"],
                "size": row["size"],
                "version": row["version"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        }

    async def save(self, account_id: int, kind: str, name: str, data: bytes) -> dict[str, Any]:
        mime = check_asset(kind, data)
        version = hashlib.sha256(data).hexdigest()[:16]
        sealed = self.cipher.encrypt(data, self._context(account_id, kind))
        now = int(self.clock())
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO boss_asset"
                " (account_id, kind, name, mime, data, size, version, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(account_id, kind) DO UPDATE SET name = excluded.name,"
                " mime = excluded.mime, data = excluded.data, size = excluded.size,"
                " version = excluded.version, updated_at = excluded.updated_at",
                (account_id, kind, clean_name(name), mime, sealed, len(data), version, now),
            )
        return {"name": clean_name(name), "mime": mime, "size": len(data), "version": version}

    async def load(self, account_id: int, kind: str) -> tuple[bytes, str, str] | None:
        """(내용, MIME, 버전)"""
        if kind not in KINDS:
            return None
        row = await self.db.fetch_one(
            "SELECT data, mime, version FROM boss_asset WHERE account_id = ? AND kind = ?",
            (account_id, kind),
        )
        if row is None:
            return None
        data = self.cipher.decrypt(bytes(row["data"]), self._context(account_id, kind))
        return data, row["mime"], row["version"]

    async def delete(self, account_id: int, kind: str) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM boss_asset WHERE account_id = ? AND kind = ?", (account_id, kind)
            )

    async def reset(self, account_id: int) -> None:
        """모두 처음으로: 올린 파일과 고친 내용을 전부 지운다."""
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM boss_asset WHERE account_id = ?", (account_id,))
            await conn.execute("DELETE FROM boss_edit WHERE account_id = ?", (account_id,))

    # ------------------------------------------------------------ 고친 내용

    @staticmethod
    def check_key(key: str) -> None:
        if not EDIT_KEY_RE.fullmatch(key):
            raise BossFileError("not_found", 404)

    async def edits(self, account_id: int, key: str) -> Any:
        self.check_key(key)
        row = await self.db.fetch_one(
            "SELECT edits_json FROM boss_edit WHERE account_id = ? AND edit_key = ?",
            (account_id, key),
        )
        return json.loads(row[0]) if row else None

    async def save_edits(self, account_id: int, key: str, value: Any) -> None:
        self.check_key(key)
        text = json.dumps(value, ensure_ascii=False)
        if len(text.encode("utf-8")) > MAX_EDITS_BYTES:
            raise BossFileError("file_too_large", 413)
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO boss_edit (account_id, edit_key, edits_json, updated_at)"
                " VALUES (?, ?, ?, ?) ON CONFLICT(account_id, edit_key) DO UPDATE SET"
                " edits_json = excluded.edits_json, updated_at = excluded.updated_at",
                (account_id, key, text, int(self.clock())),
            )

    async def delete_edits(self, account_id: int, key: str) -> None:
        self.check_key(key)
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM boss_edit WHERE account_id = ? AND edit_key = ?", (account_id, key)
            )
