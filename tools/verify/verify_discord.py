"""ㅁㅇㅅ 개발 1단계 초기 검증: 디스코드가 설계대로 동작하는지 테스트 서버에서 확인한다.

사용(레포 루트에서):
    python tools/verify/verify_discord.py check     # 이모지·첨부·포럼·보관 글·첨부 주소·썸네일
    python tools/verify/verify_discord.py command   # 메시지 명령 'ㅁㅇㅅ 메시지 삭제'(Ctrl+C로 끝)
    python tools/verify/verify_discord.py pkce      # OAuth PKCE (브라우저에서 세 번 승인)
    python tools/verify/verify_discord.py cleanup   # 테스트용 명령·웹훅 정리

설정은 tools/verify/.env (예시: .env.example). 결과는 tools/verify/results.md 에 쌓인다.
테스트 전용 앱과 테스트 서버에서만 실행한다.
"""

from __future__ import annotations

import argparse
import base64
import hmac
import http.server
import io
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

import aiohttp
import discord
from discord import app_commands
from verify_utils import (
    ResultBook,
    add_query,
    make_pkce_pair,
    make_png,
    parse_image_size,
    parse_signed_url,
    read_env_file,
)

HERE = Path(__file__).resolve().parent
ENV_PATH = HERE / ".env"
RESULTS_PATH = HERE / "results.md"
STATE_PATH = HERE / "state.json"
WEBHOOK_NAME = "mos-verify"
DISPLAY_NAME = "mos 검증"
COMMAND_NAME = "ㅁㅇㅅ 메시지 삭제"
FILE_SIZES_MB = (8, 10, 10.5, 25)
USER_AGENT = "mos-verify/0.1"


def load_config() -> dict[str, str]:
    config = read_env_file(ENV_PATH)
    config.update({k: v for k, v in os.environ.items() if k.startswith("VERIFY_")})
    return config


def on_off(value: bool) -> str:
    return "켜짐" if value else "꺼짐"


def require(config: dict[str, str], *keys: str) -> None:
    missing = [key for key in keys if not config.get(key)]
    if missing:
        sys.exit(f"tools/verify/.env 에 값이 없어요: {', '.join(missing)}")


# ================================================================ 봇이 필요한 점검


def run_bot(config: dict[str, str], mode: str) -> None:
    require(config, "VERIFY_BOT_TOKEN", "VERIFY_TEXT_CHANNEL")
    intents = discord.Intents.default()
    client = discord.Client(intents=intents)
    tree = app_commands.CommandTree(client)
    book = ResultBook(RESULTS_PATH, mode)

    async def get_hook(channel: discord.abc.GuildChannel) -> discord.Webhook:
        for hook in await channel.webhooks():
            if hook.name == WEBHOOK_NAME and hook.user and hook.user.id == client.user.id:
                return hook
        return await channel.create_webhook(name=WEBHOOK_NAME, reason="mos 초기 검증")

    def describe_error(error: discord.HTTPException) -> str:
        return f"HTTP {error.status}, 코드 {error.code}: {error.text[:120]}"

    # ------------------------------------------------------------ 1. 이모지

    async def check_emoji(text_channel: discord.TextChannel, hook: discord.Webhook) -> None:
        guild_a = text_channel.guild
        other_id = int(config.get("VERIFY_GUILD_B") or 0)
        guild_b = (
            client.get_guild(other_id)
            if other_id
            else next((g for g in client.guilds if g.id != guild_a.id and g.emojis), None)
        )
        local = next((e for e in guild_a.emojis if e.available and not e.animated), None)
        if guild_b is None or not guild_b.emojis:
            book.add("이모지", "건너뜀", "봇이 들어간 다른 서버에 커스텀 이모지가 없음")
            return
        external = next((e for e in guild_b.emojis if e.available and not e.animated), None)
        animated = next((e for e in guild_b.emojis if e.available and e.animated), None)
        everyone_ok = text_channel.permissions_for(guild_a.default_role).use_external_emojis
        bot_ok = text_channel.permissions_for(guild_a.me).use_external_emojis
        parts = [f"이 서버 {local}" if local else "이 서버 이모지 없음"]
        if external:
            parts.append(f"다른 서버 {external}")
        if animated:
            parts.append(f"움직이는 {animated}")
        try:
            await hook.send("[검증] 이모지: " + " / ".join(parts), username=DISPLAY_NAME, wait=True)
        except discord.HTTPException as error:
            book.add("이모지", "실패", describe_error(error))
            return
        book.add(
            "이모지",
            "눈으로 확인",
            f"보냄. 채널에서 다른 서버 이모지가 그림으로 보이면 통과(글자로 보이면 실패). "
            f"@everyone 외부 이모지 권한={on_off(everyone_ok)}, 봇={on_off(bot_ok)}",
        )

    # ------------------------------------------------------------ 2. 첨부 용량

    async def check_files(text_channel: discord.TextChannel, hook: discord.Webhook) -> None:
        limit_mb = text_channel.guild.filesize_limit / 1024 / 1024
        book.add(
            "첨부 한도(서버 정보)",
            "정보",
            f"filesize_limit={limit_mb:.1f}MB, 부스트 단계={text_channel.guild.premium_tier}",
        )
        for size_mb in FILE_SIZES_MB:
            data = os.urandom(int(size_mb * 1024 * 1024))
            file = discord.File(io.BytesIO(data), filename=f"verify_{size_mb}MB.bin")
            try:
                await hook.send(
                    f"[검증] 첨부 {size_mb}MB", file=file, username=DISPLAY_NAME, wait=True
                )
                book.add(f"웹훅 첨부 {size_mb}MB", "통과", "전송됨")
            except discord.HTTPException as error:
                book.add(f"웹훅 첨부 {size_mb}MB", "거부", describe_error(error))

    # ------------------------------------------------------------ 3·4. 포럼과 보관 글

    async def check_forum(forum: discord.ForumChannel) -> None:
        hook = await get_hook(forum)
        tags = list(forum.available_tags[:2])
        book.add(
            "포럼 정보",
            "정보",
            f"태그 {len(forum.available_tags)}개, 태그 필수={forum.flags.require_tag}",
        )
        try:
            starter = await hook.send(
                "[검증] 웹훅으로 만든 글 본문",
                username=DISPLAY_NAME,
                thread_name="[검증] 웹훅 글",
                applied_tags=tags,
                wait=True,
            )
        except discord.HTTPException as error:
            book.add("포럼 글 만들기(웹훅)", "실패", describe_error(error))
            return
        thread = await client.fetch_channel(starter.channel.id)
        applied = {tag.id for tag in getattr(thread, "applied_tags", [])}
        wanted = {tag.id for tag in tags}
        book.add(
            "포럼 글 만들기(웹훅)",
            "통과" if applied == wanted else "확인 필요",
            f"글 ID=첫 메시지 ID: {thread.id == starter.id}, "
            f"태그 요청 {len(wanted)}개 / 적용 {len(applied)}개",
        )
        try:
            await hook.send("[검증] 웹훅 댓글", username=DISPLAY_NAME, thread=thread, wait=True)
            book.add("포럼 댓글(웹훅)", "통과", "thread 지정으로 댓글 전송")
        except discord.HTTPException as error:
            book.add("포럼 댓글(웹훅)", "실패", describe_error(error))

        if forum.flags.require_tag:
            try:
                await hook.send(
                    "x", username=DISPLAY_NAME, thread_name="[검증] 태그 없음", wait=True
                )
                book.add("태그 필수 포럼에 태그 없이", "확인 필요", "막히지 않고 만들어짐")
            except discord.HTTPException as error:
                book.add(
                    "태그 필수 포럼에 태그 없이", "통과", f"예상대로 거부: {describe_error(error)}"
                )

        await check_archive(hook, thread)

    async def check_archive(hook: discord.Webhook, thread: discord.Thread) -> None:
        try:
            await thread.edit(archived=True)
        except discord.Forbidden:
            book.add(
                "보관 글 재활성화",
                "건너뜀",
                "봇에 '스레드 관리' 권한이 없어 보관 처리를 못 함(테스트 초대 권한 확인)",
            )
            return
        try:
            await hook.send(
                "[검증] 보관된 글에 쓰기", username=DISPLAY_NAME, thread=thread, wait=True
            )
            refreshed = await client.fetch_channel(thread.id)
            book.add(
                "보관 글에 웹훅으로 쓰기",
                "통과",
                f"전송됨, 이후 보관 상태={'보관' if refreshed.archived else '다시 열림'}",
            )
        except discord.HTTPException as error:
            book.add("보관 글에 웹훅으로 쓰기", "실패", describe_error(error))

        try:
            await thread.edit(archived=True, locked=True)
            await hook.send(
                "[검증] 잠긴 글에 쓰기", username=DISPLAY_NAME, thread=thread, wait=True
            )
            book.add(
                "잠긴 글에 웹훅으로 쓰기", "확인 필요", "막히지 않고 전송됨(앱에서 직접 막아야 함)"
            )
        except discord.HTTPException as error:
            book.add("잠긴 글에 웹훅으로 쓰기", "통과", f"예상대로 거부: {describe_error(error)}")
        finally:
            try:
                await thread.edit(archived=False, locked=False)
            except discord.HTTPException:
                pass

    # ------------------------------------------------------------ 5·6. 썸네일과 첨부 주소

    async def check_media(text_channel: discord.TextChannel, hook: discord.Webhook) -> None:
        width, height = 2400, 1600
        image = discord.File(io.BytesIO(make_png(width, height)), filename="verify_image.png")
        try:
            message = await hook.send(
                "[검증] 썸네일·주소", file=image, username=DISPLAY_NAME, wait=True
            )
        except discord.HTTPException as error:
            book.add("썸네일", "실패", describe_error(error))
            return
        attachment = message.attachments[0]

        thumb_url = add_query(
            attachment.proxy_url, {"width": "400", "height": "267", "format": "webp"}
        )
        async with (
            aiohttp.ClientSession(headers={"User-Agent": USER_AGENT}) as session,
            session.get(thumb_url) as response,
        ):
            body = await response.read()
            content_type = response.headers.get("Content-Type", "")
        size_info = parse_image_size(body)
        book.add(
            "썸네일(media 프록시 크기 지정)",
            "통과" if size_info and size_info[1] <= 400 else "확인 필요",
            f"원본 {width}x{height} {attachment.size // 1024}KB → "
            f"HTTP {response.status} {content_type} {len(body) // 1024}KB, 읽은 크기 {size_info}",
        )

        info = parse_signed_url(attachment.url)
        book.add(
            "첨부 주소 서명",
            "정보",
            f"서명={info.has_signature}, 유효 {info.valid_hours}시간, 만료 {info.expires_at}",
        )
        try:
            route = discord.http.Route("POST", "/attachments/refresh-urls")
            data = await client.http.request(route, json={"attachment_urls": [attachment.url]})
            refreshed = (data.get("refreshed_urls") or [{}])[0].get("refreshed", "")
            new_info = parse_signed_url(refreshed) if refreshed else None
            book.add(
                "첨부 주소 갱신 API(봇 토큰)",
                "통과" if new_info and new_info.has_signature else "확인 필요",
                f"새 만료 {new_info.expires_at if new_info else '없음'}",
            )
        except discord.HTTPException as error:
            book.add("첨부 주소 갱신 API(봇 토큰)", "실패", describe_error(error))

        fetched = await text_channel.fetch_message(message.id)
        refetched = parse_signed_url(fetched.attachments[0].url)
        book.add(
            "첨부 주소(메시지 다시 읽기)", "정보", f"다시 읽은 주소 만료 {refetched.expires_at}"
        )

    # ------------------------------------------------------------ 7. 메시지 명령

    sent_registry: dict[str, dict] = {}

    def save_registry() -> None:
        STATE_PATH.write_text(
            json.dumps(sent_registry, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    class ConfirmView(discord.ui.View):
        def __init__(self, owner_id: int, message_id: int, record: dict) -> None:
            super().__init__(timeout=60)
            self.owner_id = owner_id
            self.message_id = message_id
            self.record = record

        async def interaction_check(self, interaction: discord.Interaction) -> bool:
            return interaction.user.id == self.owner_id  # 누른 사람 재확인

        @discord.ui.button(label="삭제", style=discord.ButtonStyle.danger)
        async def confirm(
            self, interaction: discord.Interaction, button: discord.ui.Button
        ) -> None:
            channel = client.get_channel(self.record["channel_id"])
            hook = await get_hook(channel)
            thread_id = self.record.get("thread_id")
            try:
                if thread_id:
                    await hook.delete_message(self.message_id, thread=discord.Object(id=thread_id))
                else:
                    await hook.delete_message(self.message_id)
                sent_registry.pop(str(self.message_id), None)
                save_registry()
                await interaction.response.edit_message(content="삭제했어요.", view=None)
                book.add(
                    "메시지 명령 삭제",
                    "통과",
                    f"본인 확인 후 웹훅으로 삭제(스레드={bool(thread_id)})",
                )
            except discord.HTTPException as error:
                await interaction.response.edit_message(content="삭제하지 못했어요.", view=None)
                book.add("메시지 명령 삭제", "실패", describe_error(error))
            self.stop()

        @discord.ui.button(label="취소", style=discord.ButtonStyle.secondary)
        async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
            await interaction.response.edit_message(content="취소했어요.", view=None)
            book.add("메시지 명령 취소", "통과", "취소 버튼 동작")
            self.stop()

    async def delete_from_app(interaction: discord.Interaction, message: discord.Message) -> None:
        record = sent_registry.get(str(message.id))
        if record is None or record["sender_id"] != interaction.user.id:
            await interaction.response.send_message(
                "본인이 ㅁㅇㅅ에서 보낸 메시지만 지울 수 있어요.", ephemeral=True
            )
            reason = "웹에서 보낸 메시지가 아님" if record is None else "보낸 사람이 아님"
            book.add("메시지 명령 거부", "통과", f"{reason} → 본인 전용 안내")
            return
        view = ConfirmView(interaction.user.id, message.id, record)
        await interaction.response.send_message("이 메시지를 지울까요?", view=view, ephemeral=True)
        book.add("메시지 명령 표시", "통과", f"{interaction.user.display_name}에게 확인 버튼 표시")

    async def prepare_command(text_channel: discord.TextChannel) -> None:
        guild = discord.Object(id=text_channel.guild.id)
        tree.add_command(
            app_commands.ContextMenu(name=COMMAND_NAME, callback=delete_from_app), guild=guild
        )
        await tree.sync(guild=guild)
        app_info = await client.application_info()
        owner_id = app_info.team.owner_id if app_info.team else app_info.owner.id

        if STATE_PATH.exists():
            sent_registry.update(json.loads(STATE_PATH.read_text(encoding="utf-8")))
        hook = await get_hook(text_channel)
        sample = await hook.send("[검증] 삭제 테스트(일반 채널)", username=DISPLAY_NAME, wait=True)
        sent_registry[str(sample.id)] = {"sender_id": owner_id, "channel_id": text_channel.id}

        forum_id = int(config.get("VERIFY_FORUM_CHANNEL") or 0)
        forum = client.get_channel(forum_id) if forum_id else None
        if isinstance(forum, discord.ForumChannel):
            forum_hook = await get_hook(forum)
            starter = await forum_hook.send(
                "[검증] 삭제 테스트 글",
                username=DISPLAY_NAME,
                thread_name="[검증] 삭제 테스트",
                applied_tags=list(forum.available_tags[:1]),
                wait=True,
            )
            reply = await forum_hook.send(
                "[검증] 삭제 테스트(포럼 댓글)",
                username=DISPLAY_NAME,
                thread=discord.Object(id=starter.channel.id),
                wait=True,
            )
            sent_registry[str(reply.id)] = {
                "sender_id": owner_id,
                "channel_id": forum.id,
                "thread_id": starter.channel.id,
            }
        save_registry()
        print(
            "\n준비됐어요. 디스코드(PC·모바일)에서 '[검증] 삭제 테스트' 메시지를\n"
            "  우클릭하거나 길게 눌러\n"
            f"  앱 › {COMMAND_NAME} 을 눌러 보세요.\n"
            "  - 확인 버튼이 나오고 '삭제'를 누르면 지워지면 통과\n"
            "  - 다른 메시지(사람이 쓴 글)에서 누르면 거부 안내가 나와야 함\n"
            "  - 다른 계정이 있으면 그 계정으로도 눌러 보기(거부되어야 함)\n"
            "끝나면 Ctrl+C. (메뉴가 안 보이면 디스코드를 새로고침: Ctrl+R)\n",
            flush=True,
        )

    # ------------------------------------------------------------ 정리

    async def cleanup(text_channel: discord.TextChannel) -> None:
        guild = discord.Object(id=text_channel.guild.id)
        tree.clear_commands(guild=guild)
        await tree.sync(guild=guild)
        removed = 0
        for guild_obj in client.guilds:
            for hook in await guild_obj.webhooks():
                if hook.name == WEBHOOK_NAME and hook.user and hook.user.id == client.user.id:
                    await hook.delete(reason="mos 초기 검증 정리")
                    removed += 1
        STATE_PATH.unlink(missing_ok=True)
        book.add("정리", "통과", f"테스트 명령 삭제, 웹훅 {removed}개 삭제")

    # ------------------------------------------------------------ 실행

    @client.event
    async def on_ready() -> None:
        text_channel = client.get_channel(int(config["VERIFY_TEXT_CHANNEL"]))
        if not isinstance(text_channel, discord.TextChannel):
            book.add("설정", "실패", "VERIFY_TEXT_CHANNEL 이 봇이 볼 수 있는 일반 채팅 채널이 아님")
            await client.close()
            return
        try:
            if mode == "check":
                hook = await get_hook(text_channel)
                await check_emoji(text_channel, hook)
                await check_files(text_channel, hook)
                forum = client.get_channel(int(config.get("VERIFY_FORUM_CHANNEL") or 0))
                if isinstance(forum, discord.ForumChannel):
                    await check_forum(forum)
                else:
                    book.add("포럼", "건너뜀", "VERIFY_FORUM_CHANNEL 이 포럼 채널이 아님")
                await check_media(text_channel, hook)
            elif mode == "command":
                await prepare_command(text_channel)
                return  # Ctrl+C까지 계속 실행
            elif mode == "cleanup":
                await cleanup(text_channel)
        except discord.Forbidden as error:
            book.add("권한", "실패", f"봇 권한 부족: {error.text[:120]}")
        except Exception as error:  # 어떤 오류든 기록하고 종료
            book.add("오류", "실패", f"{type(error).__name__}: {str(error)[:160]}")
        await client.close()

    try:
        client.run(config["VERIFY_BOT_TOKEN"], log_handler=None)
    except KeyboardInterrupt:
        pass
    finally:
        if book.rows:
            book.write()


# ================================================================ OAuth PKCE


def run_pkce(config: dict[str, str]) -> None:
    require(config, "VERIFY_CLIENT_ID", "VERIFY_CLIENT_SECRET")
    port = int(config.get("VERIFY_REDIRECT_PORT") or 53682)
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    book = ResultBook(RESULTS_PATH, "pkce")
    basic = base64.b64encode(
        f"{config['VERIFY_CLIENT_ID']}:{config['VERIFY_CLIENT_SECRET']}".encode()
    ).decode()

    def authorize(label: str) -> tuple[str, str] | None:
        verifier, challenge = make_pkce_pair()
        state = secrets.token_urlsafe(24)
        received: dict[str, str] = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - http.server 규칙
                query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
                if urllib.parse.urlsplit(self.path).path == "/callback":
                    received.update(query)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write("확인됐어요. 이 창은 닫아도 돼요.".encode())

            def log_message(self, *args: object) -> None:  # 주소(코드 포함)를 로그에 남기지 않음
                return

        server = http.server.HTTPServer(("127.0.0.1", port), Handler)
        server.timeout = 1
        params = {
            "response_type": "code",
            "client_id": config["VERIFY_CLIENT_ID"],
            "scope": "identify",
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "prompt": "consent",
        }
        print(f"\n[{label}] 브라우저에서 '승인'을 눌러 주세요.", flush=True)
        webbrowser.open("https://discord.com/oauth2/authorize?" + urllib.parse.urlencode(params))
        for _ in range(180):
            server.handle_request()
            if received:
                break
        server.server_close()
        if not received:
            book.add(f"PKCE {label}", "건너뜀", "3분 안에 승인하지 않음")
            return None
        if not hmac.compare_digest(received.get("state", ""), state):
            book.add(f"PKCE {label}", "실패", "state 불일치")
            return None
        if "code" not in received:
            book.add(f"PKCE {label}", "실패", f"승인 실패: {received.get('error', '알 수 없음')}")
            return None
        return received["code"], verifier

    def exchange(code: str, verifier: str | None) -> tuple[int, dict]:
        form = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri}
        if verifier is not None:
            form["code_verifier"] = verifier
        request = urllib.request.Request(  # noqa: S310 - 고정된 https 주소
            "https://discord.com/api/v10/oauth2/token",
            data=urllib.parse.urlencode(form).encode(),
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": USER_AGENT,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.load(error)
            except ValueError:
                return error.code, {}

    def revoke(access_token: str) -> None:
        request = urllib.request.Request(  # noqa: S310 - 고정된 https 주소
            "https://discord.com/api/v10/oauth2/token/revoke",
            data=urllib.parse.urlencode(
                {"token": access_token, "token_type_hint": "access_token"}
            ).encode(),
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": USER_AGENT,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=20):  # noqa: S310
                pass
        except urllib.error.URLError:
            pass

    print("OAuth PKCE 점검: 브라우저 승인을 세 번 해요(틀린 값, 값 없음, 올바른 값).")
    cases = [
        ("틀린 verifier", lambda _real: make_pkce_pair()[0], False),
        ("verifier 없음", lambda _real: None, False),
        ("올바른 verifier", lambda real: real, True),
    ]
    for label, pick_verifier, should_pass in cases:
        result = authorize(label)
        if result is None:
            continue
        code, real_verifier = result
        status, body = exchange(code, pick_verifier(real_verifier))
        passed = 200 <= status < 300
        if passed and body.get("access_token"):
            revoke(body["access_token"])  # 시험용 토큰은 바로 폐기, 화면에도 남기지 않음
        verdict = "통과" if passed == should_pass else "실패"
        detail = (
            f"HTTP {status} {body.get('error', '')} {body.get('error_description', '')}".strip()
        )
        book.add(f"PKCE {label}", verdict, detail + (" (토큰 즉시 폐기)" if passed else ""))
    if book.rows:
        book.write()


# ================================================================ 시작


def main() -> None:
    parser = argparse.ArgumentParser(description="ㅁㅇㅅ 초기 검증(테스트 서버 전용)")
    parser.add_argument("mode", choices=["check", "command", "pkce", "cleanup"])
    args = parser.parse_args()
    config = load_config()
    if args.mode == "pkce":
        run_pkce(config)
    else:
        run_bot(config, args.mode)


if __name__ == "__main__":
    main()
