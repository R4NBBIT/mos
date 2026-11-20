"""기기 세션·계정 잠금·OAuth 연결 흐름(기술 설계서 10장).

- 기기 = 브라우저 1개. 쿠키에는 원문 토큰, DB에는 해시만. 잠금 해제에 성공할 때마다 토큰을 바꾼다.
- 한 기기에 계정 최대 5개. 활성 계정은 하나.
- 잠금: 마지막 요청 후 AUTO_LOCK_SEC가 지나면 잠김. '로그인 유지'면 30일 동안 비밀번호 없이 열림.
- 비밀번호: 처음 연결했거나 재설정 목적이면 5분 동안만 설정할 수 있다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from mos.db.auth_repo import AuthRepo
from mos.services import crypto
from mos.services.discord_oauth import OAuthClient, OAuthError

log = logging.getLogger(__name__)

MAX_ACCOUNTS_PER_DEVICE = 5
STATE_TTL_SEC = 10 * 60
PASSWORD_SETUP_SEC = 5 * 60
AUTO_LOCK_SEC = 30 * 60
KEEP_SIGNED_IN_SEC = 30 * 24 * 3600
MAX_PASSWORD_FAILURES = 5
PASSWORD_LOCK_SEC = 5 * 60
EMPTY_DEVICE_TTL_SEC = 24 * 3600
SLIDE_MIN_STEP_SEC = 60  # 잠금 시간 연장은 1분에 한 번만 DB에 쓴다

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128
COMMON_PASSWORDS = frozenset(
    {
        "12345678", "123456789", "1234567890", "password", "password1", "qwerty123",
        "qwertyuiop", "11111111", "00000000", "88888888", "abcd1234", "1q2w3e4r",
        "1q2w3e4r5t", "asdf1234", "iloveyou", "sunshine", "princess", "football",
        "baseball", "welcome1", "zxcvbnm1", "qwer1234", "a1234567", "aa123456",
        "q1w2e3r4", "letmein1", "admin123", "passw0rd", "p@ssw0rd", "12341234",
        "asdfasdf", "qwerqwer", "discord1", "discord123",
    }
)  # fmt: skip


class SessionError(Exception):
    """사용자에게 보여 줄 수 있는 실패. code는 웹이 구분하는 짧은 문자열."""

    def __init__(self, code: str, status: int = 400, retry_after: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.retry_after = retry_after


@dataclass(frozen=True)
class Device:
    id: int
    active_account_id: int | None


@dataclass(frozen=True)
class ActiveAccount:
    device_id: int
    account_id: int
    discord_user_id: int


def password_problem(password: str, account_name: str = "") -> str | None:
    if len(password) < MIN_PASSWORD_LENGTH:
        return "password_too_short"
    if len(password) > MAX_PASSWORD_LENGTH:
        return "password_too_long"
    lowered = password.lower()
    if lowered in COMMON_PASSWORDS or len(set(password)) <= 2:
        return "password_too_common"
    if account_name and lowered == account_name.lower():
        return "password_too_common"
    return None


class SessionService:
    def __init__(
        self,
        repo: AuthRepo,
        cipher: crypto.TokenCipher,
        oauth: OAuthClient,
        bot_guild_ids: Callable[[], set[int]],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.repo = repo
        self.cipher = cipher
        self.oauth = oauth
        self.bot_guild_ids = bot_guild_ids
        self.clock = clock

    def now(self) -> int:
        return int(self.clock())

    # ------------------------------------------------------------ 기기

    async def device_from_token(self, token: str | None) -> Device | None:
        if not token or len(token) > 128:
            return None
        row = await self.repo.device_by_token_hash(crypto.token_hash(token))
        if row is None:
            return None
        return Device(id=int(row["id"]), active_account_id=row["active_account_id"])

    async def create_device(self) -> tuple[Device, str]:
        token = crypto.new_token()
        device_id = await self.repo.create_device(crypto.token_hash(token), self.now())
        return Device(id=device_id, active_account_id=None), token

    async def rotate_token(self, device: Device) -> str:
        token = crypto.new_token()
        await self.repo.rotate_device_token(device.id, crypto.token_hash(token), self.now())
        return token

    # ------------------------------------------------------------ 상태

    def _is_unlocked(self, link: dict[str, Any], now: int) -> bool:
        if not link.get("password_set"):
            return False
        unlocked_until = link.get("unlocked_until") or 0
        keep_until = link.get("keep_until") or 0
        return unlocked_until > now or keep_until > now

    async def describe(self, device: Device | None) -> dict[str, Any]:
        """웹에 주는 기기 상태. 비밀 값·디스코드 토큰은 넣지 않는다."""
        if device is None:
            return {
                "accounts": [],
                "active_account_id": None,
                "max_accounts": MAX_ACCOUNTS_PER_DEVICE,
            }
        now = self.now()
        links = await self.repo.device_accounts(device.id)
        accounts = []
        for link in links:
            setup_until = link.get("password_setup_until") or 0
            accounts.append(
                {
                    "id": str(link["account_id"]),
                    "name": link["name"],
                    "avatar_url": link["avatar_url"],
                    "password_set": bool(link["password_set"]),
                    "can_set_password": setup_until > now,
                    "locked": not self._is_unlocked(link, now),
                    "kept": (link.get("keep_until") or 0) > now,
                    "disconnected": link["status"] != "active",
                }
            )
        active = device.active_account_id
        if active is not None and not any(item["id"] == str(active) for item in accounts):
            active = None
        return {
            "accounts": accounts,
            "active_account_id": str(active) if active is not None else None,
            "max_accounts": MAX_ACCOUNTS_PER_DEVICE,
        }

    async def require_active(self, device: Device | None) -> ActiveAccount:
        """잠금이 풀린 활성 계정. 요청마다 자동 잠금 시간을 늦춘다."""
        if device is None or device.active_account_id is None:
            raise SessionError("login_required", status=401)
        now = self.now()
        links = {link["account_id"]: link for link in await self.repo.device_accounts(device.id)}
        link = links.get(device.active_account_id)
        if link is None:
            raise SessionError("login_required", status=401)
        if link["status"] != "active":
            raise SessionError("account_disconnected", status=401)
        if not self._is_unlocked(link, now):
            raise SessionError("locked", status=401)
        new_until = now + AUTO_LOCK_SEC
        if new_until - (link.get("unlocked_until") or 0) >= SLIDE_MIN_STEP_SEC:
            await self.repo.update_device_account(
                device.id, device.active_account_id, unlocked_until=new_until
            )
            await self.repo.touch_device(device.id, now)
        return ActiveAccount(
            device_id=device.id,
            account_id=device.active_account_id,
            discord_user_id=int(link["discord_user_id"]),
        )

    async def account_can_see_guild(self, account_id: int, guild_id: int) -> bool:
        return await self.repo.account_in_guild(account_id, guild_id)

    # ------------------------------------------------------------ OAuth 연결

    async def start_connect(self, device: Device, purpose: str) -> str:
        if purpose not in ("connect", "add", "reset"):
            raise SessionError("bad_purpose")
        now = self.now()
        await self.repo.delete_stale(now, now - EMPTY_DEVICE_TTL_SEC)
        state = crypto.new_token()
        verifier, challenge = crypto.pkce_pair()
        await self.repo.save_state(
            crypto.token_hash(state), device.id, verifier, purpose, now + STATE_TTL_SEC
        )
        return self.oauth.authorize_url(state, challenge)

    async def finish_connect(self, device: Device | None, state: str, code: str) -> int:
        """성공하면 계정 ID. 실패는 SessionError(code)로 알린다."""
        if device is None or not state or not code or len(state) > 128 or len(code) > 256:
            raise SessionError("bad_request")
        saved = await self.repo.take_state(crypto.token_hash(state))
        now = self.now()
        if saved is None or saved["device_id"] != device.id or saved["expires_at"] <= now:
            raise SessionError("expired")
        try:
            tokens = await self.oauth.exchange_code(code, saved["code_verifier"])
            user = await self.oauth.fetch_user(tokens.access_token)
            guild_ids = await self.oauth.fetch_guild_ids(tokens.access_token)
        except OAuthError as error:
            log.warning("계정 연결 실패: %s", error)
            raise SessionError("connect_failed", status=502) from error

        shared = guild_ids & self.bot_guild_ids()
        if not shared:
            raise SessionError("no_server", status=403)

        links = await self.repo.device_accounts(device.id)
        known = {int(link["discord_user_id"]): link["account_id"] for link in links}
        if saved["purpose"] == "add" and user.id in known:
            # 디스코드 승인 화면은 브라우저에 로그인된 계정으로 열린다. 같은 계정이면 알려 준다
            raise SessionError("already_added", status=409)
        if user.id not in known and len(links) >= MAX_ACCOUNTS_PER_DEVICE:
            raise SessionError("too_many_accounts", status=409)

        # 같은 사용자는 계정 ID가 그대로이므로 토큰 암호화 문맥에 디스코드 ID를 쓴다
        context = f"discord-user:{user.id}"
        account_id = await self.repo.upsert_account(
            discord_user_id=user.id,
            name=user.name,
            avatar_url=user.avatar_url,
            premium_type=user.premium_type,
            access_enc=self.cipher.encrypt(tokens.access_token, context + ":access"),
            refresh_enc=self.cipher.encrypt(tokens.refresh_token, context + ":refresh")
            if tokens.refresh_token
            else None,
            token_expires_at=tokens.expires_at,
            guild_ids=shared,
            now=now,
        )
        await self.repo.add_device_account(device.id, account_id, now)
        await self.repo.set_active_account(device.id, account_id)

        account = await self.repo.account(account_id)
        needs_password = account is None or account["password_hash"] is None
        if needs_password or saved["purpose"] == "reset":
            # 비밀번호를 정할 5분짜리 권한만 준다. 정하기 전까지는 잠긴 상태
            await self.repo.update_device_account(
                device.id,
                account_id,
                password_setup_until=now + PASSWORD_SETUP_SEC,
                unlocked_until=None,
                keep_until=None,
            )
        else:
            # 디스코드 로그인으로 본인 확인을 마쳤으므로 잠금을 푼다
            await self.repo.update_device_account(
                device.id, account_id, unlocked_until=now + AUTO_LOCK_SEC
            )
        return account_id

    # ------------------------------------------------------------ 비밀번호·잠금

    async def set_password(self, device: Device | None, password: str) -> None:
        if device is None or device.active_account_id is None:
            raise SessionError("login_required", status=401)
        account_id = device.active_account_id
        link = await self.repo.device_account(device.id, account_id)
        now = self.now()
        if link is None or (link.get("password_setup_until") or 0) <= now:
            raise SessionError("setup_expired", status=403)
        account = await self.repo.account(account_id)
        if account is None:
            raise SessionError("login_required", status=401)
        problem = password_problem(password, account["name"])
        if problem:
            raise SessionError(problem)
        password_hash = await asyncio.to_thread(crypto.hash_password, password)
        await self.repo.set_password_hash(account_id, password_hash, now)
        await self.repo.update_device_account(
            device.id,
            account_id,
            password_setup_until=None,
            unlocked_until=now + AUTO_LOCK_SEC,
        )

    async def unlock(
        self, device: Device | None, account_id: int, password: str, keep: bool
    ) -> None:
        if device is None:
            raise SessionError("login_required", status=401)
        link = await self.repo.device_account(device.id, account_id)
        account = await self.repo.account(account_id) if link else None
        if link is None or account is None:
            raise SessionError("not_found", status=404)
        if account["status"] != "active":
            raise SessionError("account_disconnected", status=401)
        if account["password_hash"] is None:
            raise SessionError("password_not_set", status=409)
        now = self.now()
        attempt = await self.repo.login_attempt(account_id)
        if attempt and (attempt["locked_until"] or 0) > now:
            raise SessionError(
                "too_many_attempts", status=429, retry_after=attempt["locked_until"] - now
            )
        ok = len(password) <= MAX_PASSWORD_LENGTH and await asyncio.to_thread(
            crypto.verify_password, account["password_hash"], password
        )
        if not ok:
            await self.repo.record_failure(
                account_id, MAX_PASSWORD_FAILURES, now + PASSWORD_LOCK_SEC
            )
            log.info("잠금 해제 실패: 계정 %d", account_id)
            raise SessionError("wrong_password", status=401)
        await self.repo.clear_failures(account_id)
        await self.repo.update_device_account(
            device.id,
            account_id,
            unlocked_until=now + AUTO_LOCK_SEC,
            keep_until=now + KEEP_SIGNED_IN_SEC if keep else None,
        )
        await self.repo.set_active_account(device.id, account_id)

    async def lock(self, device: Device | None) -> None:
        if device is None or device.active_account_id is None:
            return
        await self.repo.update_device_account(
            device.id, device.active_account_id, unlocked_until=None, keep_until=None
        )

    async def switch(self, device: Device | None, account_id: int) -> None:
        if device is None:
            raise SessionError("login_required", status=401)
        if await self.repo.device_account(device.id, account_id) is None:
            raise SessionError("not_found", status=404)
        await self.repo.set_active_account(device.id, account_id)

    async def remove_account(self, device: Device | None, account_id: int) -> bool:
        """기기에서 계정을 뺀다. 남은 계정이 없으면 기기를 지우고 True."""
        if device is None:
            return True
        await self.repo.remove_device_account(device.id, account_id)
        remaining = await self.repo.device_accounts(device.id)
        if not remaining:
            await self.repo.delete_device(device.id)
            return True
        if device.active_account_id == account_id:
            await self.repo.set_active_account(device.id, remaining[0]["account_id"])
        return False
