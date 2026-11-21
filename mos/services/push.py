"""웹 푸시(탭을 닫아도 알림).

내용 없는 푸시만 보낸다(본문 암호화가 필요 없고, 알림 내용이 푸시 회사 서버를 거치지 않는다).
브라우저의 서비스 워커가 푸시를 받으면 /api/push/latest에서
보여 줄 글을 받아 알림을 띄운다.
VAPID(RFC 8292): 서버 열쇠(P-256)로 서명한 짧은 JWT를 붙여 보낸다.
열쇠는 처음 켜질 때 만들어 암호화해 둔다.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import aiohttp
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from mos.db.database import Database
from mos.services.crypto import TokenCipher

log = logging.getLogger(__name__)

SECRET_NAME = "vapid_private_key"  # noqa: S105  (app_secret 행 이름이지 값이 아니다)
TTL_SEC = 3600  # 기기가 꺼져 있으면 1시간 안에 켜질 때만 받는다
MIN_GAP_SEC = 15  # 같은 계정에 너무 자주 보내지 않는다(알림은 하나로 합쳐 보인다)
REQUEST_TIMEOUT_SEC = 10
MAX_SUBS_PER_ACCOUNT = 10
# 브라우저 회사의 푸시 서버만(엉뚱한 주소로 서버가 요청을 보내지 않게)
ALLOWED_HOSTS = (
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
)
ALLOWED_SUFFIXES = (".notify.windows.com", ".push.apple.com", ".push.services.mozilla.com")


class PushError(ValueError):
    pass


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def check_endpoint(endpoint: str) -> str:
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if (
        parts.scheme != "https"
        or len(endpoint) > 1000
        or not (host in ALLOWED_HOSTS or host.endswith(ALLOWED_SUFFIXES))
    ):
        raise PushError("bad_endpoint")
    return endpoint


class PushService:
    def __init__(
        self,
        db: Database,
        cipher: TokenCipher,
        subject: str,
        clock: Callable[[], float] = time.time,
        post: Callable[[str, dict[str, str]], Any] | None = None,
    ) -> None:
        self.db = db
        self.cipher = cipher
        self.subject = subject  # VAPID 연락처(서비스 주소)
        self.clock = clock
        self._key: ec.EllipticCurvePrivateKey | None = None
        self._last_sent: dict[int, float] = {}
        self._post = post or self._http_post

    async def _private_key(self) -> ec.EllipticCurvePrivateKey:
        if self._key is not None:
            return self._key
        row = await self.db.fetch_one("SELECT value FROM app_secret WHERE name = ?", (SECRET_NAME,))
        if row is not None:
            pem = self.cipher.decrypt(row[0], SECRET_NAME).encode("ascii")
            loaded = serialization.load_pem_private_key(pem, password=None)
            if not isinstance(loaded, ec.EllipticCurvePrivateKey):
                raise PushError("bad_key")
            key = loaded
        else:
            key = ec.generate_private_key(ec.SECP256R1())
            pem = key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode("ascii")
            async with self.db.writing() as conn:
                await conn.execute(
                    "INSERT OR IGNORE INTO app_secret (name, value) VALUES (?, ?)",
                    (SECRET_NAME, self.cipher.encrypt(pem, SECRET_NAME)),
                )
        self._key = key
        return key

    async def public_key(self) -> str:
        """브라우저 구독에 쓰는 서버 공개 열쇠(압축 안 한 점, base64url)."""
        key = await self._private_key()
        raw = key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        return _b64url(raw)

    async def _vapid_header(self, endpoint: str) -> str:
        key = await self._private_key()
        parts = urlsplit(endpoint)
        header = _b64url(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
        claims = {
            "aud": f"{parts.scheme}://{parts.netloc}",
            "exp": int(self.clock()) + 12 * 3600,
            "sub": self.subject,
        }
        body = _b64url(json.dumps(claims, separators=(",", ":")).encode())
        signing_input = f"{header}.{body}".encode("ascii")
        r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
        signature = _b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        return f"vapid t={header}.{body}.{signature}, k={await self.public_key()}"

    async def _http_post(self, endpoint: str, headers: dict[str, str]) -> int:
        timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SEC)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(endpoint, headers=headers, data=b"") as response:
                return response.status

    # ------------------------------------------------------------ 구독

    async def subscribe(self, device_id: int, account_id: int, endpoint: str) -> None:
        check_endpoint(endpoint)
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO push_sub (endpoint, device_id, account_id, created_at)"
                " VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET"
                " device_id = excluded.device_id, account_id = excluded.account_id",
                (endpoint, device_id, account_id, int(self.clock())),
            )
            # 계정당 너무 많으면 오래된 것부터 지운다
            await conn.execute(
                "DELETE FROM push_sub WHERE account_id = ? AND endpoint NOT IN ("
                " SELECT endpoint FROM push_sub WHERE account_id = ?"
                " ORDER BY created_at DESC LIMIT ?)",
                (account_id, account_id, MAX_SUBS_PER_ACCOUNT),
            )

    async def unsubscribe(self, endpoint: str, device_id: int) -> None:
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM push_sub WHERE endpoint = ? AND device_id = ?", (endpoint, device_id)
            )

    async def forget_device_account(self, device_id: int, account_id: int | None = None) -> None:
        """브라우저에서 계정을 빼면 그 브라우저의 구독도 지운다."""
        async with self.db.writing() as conn:
            if account_id is None:
                await conn.execute("DELETE FROM push_sub WHERE device_id = ?", (device_id,))
            else:
                await conn.execute(
                    "DELETE FROM push_sub WHERE device_id = ? AND account_id = ?",
                    (device_id, account_id),
                )

    async def subscribed(self, endpoint: str, device_id: int, account_id: int) -> bool:
        row = await self.db.fetch_one(
            "SELECT 1 FROM push_sub WHERE endpoint = ? AND device_id = ? AND account_id = ?",
            (endpoint, device_id, account_id),
        )
        return row is not None

    async def accounts(self) -> list[int]:
        rows = await self.db.fetch_all("SELECT DISTINCT account_id FROM push_sub")
        return [int(row[0]) for row in rows]

    # ------------------------------------------------------------ 보내기

    async def send(self, account_id: int) -> int:
        """그 계정의 모든 구독에 빈 푸시. 보낸 수."""
        now = self.clock()
        if now - self._last_sent.get(account_id, 0) < MIN_GAP_SEC:
            return 0
        self._last_sent[account_id] = now
        rows = await self.db.fetch_all(
            "SELECT endpoint FROM push_sub WHERE account_id = ?", (account_id,)
        )
        sent = 0
        for row in rows:
            endpoint = str(row[0])
            headers = {
                "TTL": str(TTL_SEC),
                "Urgency": "normal",
                "Topic": "mos-notify",  # 꺼져 있던 기기에는 마지막 하나만
                "Authorization": await self._vapid_header(endpoint),
                "Content-Length": "0",
            }
            try:
                status = await self._post(endpoint, headers)
            except Exception as error:  # 네트워크 문제는 다음 알림 때 다시
                log.info("웹 푸시 실패: %s", type(error).__name__)
                continue
            if status in (404, 410):
                async with self.db.writing() as conn:
                    await conn.execute("DELETE FROM push_sub WHERE endpoint = ?", (endpoint,))
            elif 200 <= status < 300:
                sent += 1
            else:
                log.info("웹 푸시 거절: HTTP %s", status)
        return sent
