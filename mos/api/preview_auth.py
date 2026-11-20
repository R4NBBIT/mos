"""2단계(읽기 최소판) 임시 운영자 로그인. 3단계에서 디스코드 OAuth·앱 비밀번호로 바뀐다.

- 열쇠는 환경 변수 PREVIEW_ACCESS_KEY와 비교(시간 일정 비교)
- 세션 토큰은 HttpOnly 쿠키, 서버에는 해시만 메모리에 보관(재시작하면 다시 로그인)
- 같은 IP에서 5번 틀리면 10분 잠금
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass, field

COOKIE_NAME = "mos_preview"
SESSION_TTL_SEC = 12 * 3600
MAX_FAILURES = 5
LOCK_SEC = 10 * 60
MAX_SESSIONS = 20


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass
class PreviewAuth:
    access_key: str = field(repr=False)
    sessions: dict[str, float] = field(default_factory=dict, repr=False)
    failures: dict[str, tuple[int, float]] = field(default_factory=dict)

    @property
    def enabled(self) -> bool:
        return bool(self.access_key)

    def is_locked(self, client_ip: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        count, locked_until = self.failures.get(client_ip, (0, 0.0))
        return count >= MAX_FAILURES and now < locked_until

    def login(self, client_ip: str, key: str, now: float | None = None) -> str | None:
        """성공하면 새 세션 토큰(쿠키에 넣을 원문), 실패하면 None."""
        now = time.monotonic() if now is None else now
        if not self.enabled or self.is_locked(client_ip, now):
            return None
        if not hmac.compare_digest(key.encode("utf-8"), self.access_key.encode("utf-8")):
            count, _ = self.failures.get(client_ip, (0, 0.0))
            count += 1
            self.failures[client_ip] = (count, now + LOCK_SEC if count >= MAX_FAILURES else 0.0)
            return None
        self.failures.pop(client_ip, None)
        self._prune(now)
        token = secrets.token_urlsafe(32)
        self.sessions[_hash(token)] = now + SESSION_TTL_SEC
        return token

    def check(self, token: str | None, now: float | None = None) -> bool:
        if not token or not self.enabled:
            return False
        now = time.monotonic() if now is None else now
        expires_at = self.sessions.get(_hash(token))
        if expires_at is None or now >= expires_at:
            return False
        return True

    def logout(self, token: str | None) -> None:
        if token:
            self.sessions.pop(_hash(token), None)

    def _prune(self, now: float) -> None:
        expired = [key for key, expires_at in self.sessions.items() if expires_at <= now]
        for key in expired:
            del self.sessions[key]
        while len(self.sessions) >= MAX_SESSIONS:  # 오래된 것부터 정리
            oldest = min(self.sessions, key=self.sessions.__getitem__)
            del self.sessions[oldest]
