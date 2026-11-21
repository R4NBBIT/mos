"""진입점: 봇과 API(uvicorn)를 한 이벤트 루프에서 함께 실행한다.

둘 중 하나가 멈추면 둘 다 끝내고 0이 아닌 코드로 종료한다(systemd가 다시 켠다).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sys

import discord
import uvicorn

from mos.api.app import create_app
from mos.bot.client import BotDirectory, BotMessenger, MosBot
from mos.config import ConfigError, load_settings
from mos.db.database import Database
from mos.db.repo import MessageRepo
from mos.services import retention
from mos.services.permissions import PermissionService
from mos.services.realtime import RealtimeHub
from mos.version import current_version

log = logging.getLogger("mos")
SHUTDOWN_TIMEOUT_SEC = 10


def error_hint(error: BaseException) -> str | None:
    """사람이 고쳐야 하는 봇 오류에 할 일을 알려 준다. 토큰 같은 비밀 값은 넣지 않는다."""
    if isinstance(error, discord.PrivilegedIntentsRequired):
        return (
            "디스코드 개발자 포털 > 이 앱 > Bot > Privileged Gateway Intents에서 "
            "Server Members Intent와 Message Content Intent를 켜고 Save Changes를 누른 뒤 "
            "다시 실행하세요."
        )
    if isinstance(error, discord.LoginFailure):
        return (
            "봇 토큰이 맞지 않습니다. 개발자 포털 > Bot > Reset Token으로 새 토큰을 받아 "
            ".env의 DISCORD_BOT_TOKEN을 바꾼 뒤 다시 실행하세요."
        )
    return None


async def run() -> int:
    settings = load_settings()
    db = Database(settings.db_path)
    await db.open()
    repo = MessageRepo(db)
    hub = RealtimeHub()
    bot = MosBot(settings, repo, hub)
    directory = BotDirectory(bot)
    permissions = PermissionService(directory)
    bot.member_changed = permissions.forget_member  # 역할 변경·탈퇴 때 권한 캐시 지우기
    app = create_app(
        settings,
        db,
        repo,
        hub,
        directory,
        permissions=permissions,
        messenger=BotMessenger(bot),
        notify_operator=bot.notify_operator,
    )
    bot.sender = app.state.sender  # 디스코드 앱의 'ㅁㅇㅅ 메시지 삭제' 명령
    bot.nitro_seen = app.state.sessions.nitro_seen  # '니트로 있어요' 계정의 7일 확인
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=settings.api_host,
            port=settings.api_port,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1",  # Caddy만 믿는다
            access_log=False,  # 주소에 민감한 값이 섞이지 않게 접근 로그는 끔
            ws_max_size=16 * 1024,
            log_level="info",
        )
    )

    log.info("mos 시작: 버전 %s", current_version())
    bot_task = asyncio.create_task(bot.start(settings.discord_bot_token), name="bot")
    api_task = asyncio.create_task(server.serve(), name="api")
    # 90일 지난 메시지 복사본 정리(하루 한 번). 멈춰도 앱은 계속 돈다
    retention_task = asyncio.create_task(retention.run_forever(repo), name="retention")
    done, _pending = await asyncio.wait({bot_task, api_task}, return_when=asyncio.FIRST_COMPLETED)

    exit_code = 0
    for task in done:
        if task.cancelled():
            continue
        error = task.exception()
        if error is not None:
            log.error("%s 작업이 오류로 멈춤: %s", task.get_name(), type(error).__name__)
            hint = error_hint(error)
            if hint:
                log.error("해결 방법: %s", hint)
            exit_code = 1
    if bot_task in done and api_task not in done:
        exit_code = exit_code or 1  # 봇이 끊겼는데 API만 도는 상태로 두지 않는다

    server.should_exit = True  # API는 강제로 끊지 않고 정상 종료를 기다린다
    if not bot.is_closed():
        await bot.close()
    for task in (api_task, bot_task):
        if task.done():
            continue
        try:
            await asyncio.wait_for(asyncio.shield(task), SHUTDOWN_TIMEOUT_SEC)
        except (TimeoutError, Exception):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
    retention_task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await retention_task
    await db.close()
    return exit_code


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("discord.gateway").setLevel(logging.WARNING)
    discord.VoiceClient.warn_nacl = False  # 음성은 쓰지 않는다
    discord.VoiceClient.warn_dave = False
    try:
        exit_code = asyncio.run(run())
    except ConfigError as error:
        log.error("설정 오류: %s", error)
        exit_code = 2
    except KeyboardInterrupt:
        exit_code = 0
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
