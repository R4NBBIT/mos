# 개발 1단계: 초기 검증

본 개발 전에, 설계가 기대는 디스코드 동작을 **테스트 전용 앱과 테스트 서버**에서 확인한다. 결과는 `results.md`에 쌓이고, 기능명세서의 'API 제약/초기 검증'에 반영한다.

| 점검 | 명령 | 확인하는 것 |
| --- | --- | --- |
| 이모지 | `check` | 웹훅으로 다른 서버 이모지·움직이는 이모지가 보이는지(눈으로 확인) |
| 첨부 용량 | `check` | 웹훅 첨부 8·10·10.5·25MB 중 어디까지 되는지 |
| 포럼 | `check` | 웹훅으로 글 만들기(태그 포함), 댓글 달기, 태그 필수 포럼 |
| 보관·잠긴 글 | `check` | 보관된 글에 웹훅으로 쓰면 다시 열리는지, 잠긴 글은 막히는지 |
| 썸네일 | `check` | media 프록시에 크기를 지정하면 작게 받아지는지 |
| 첨부 주소 | `check` | 서명 주소의 유효 시간, 봇 토큰으로 주소 갱신 API가 되는지 |
| 메시지 명령 | `command` | 앱 › ㅁㅇㅅ 메시지 삭제: 본인 확인·확인 버튼·삭제·거부 안내 |
| OAuth PKCE | `pkce` | 틀린 값·값 없음은 거부, 올바른 값만 통과하는지 |

## 1. 테스트 앱과 서버 준비(처음 한 번)

본 앱과 **별도의** 테스트 앱을 쓴다. 토큰·시크릿은 `tools/verify/.env`에만 적고 채팅에 붙여 넣지 않는다.

1. [Discord Developer Portal](https://discord.com/developers/applications) › New Application (예: `mos-test`)
2. **Bot** 탭
   - Reset Token → `.env`의 `VERIFY_BOT_TOKEN`
   - Public Bot 끄기
   - Privileged Gateway Intents: Message Content, Server Members 켜기(이후 개발용)
3. **OAuth2** 탭
   - Client ID, Client Secret → `.env`
   - Redirects에 `http://127.0.0.1:53682/callback` 추가
4. 테스트 서버 두 개를 만든다(A, B).
   - A: 일반 채팅 채널 1개, 포럼 채널 1개(태그 2개 이상, 하나는 '태그 필수' 켜도 좋음), 커스텀 이모지 1개
   - B: 커스텀 이모지 1개, 가능하면 움직이는 이모지 1개
5. 봇을 두 서버에 초대한다. 아래 주소의 `<CLIENT_ID>`만 바꿔 연다(검증용 권한, '스레드 관리' 포함).

   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=292595027008
   ```

6. 디스코드 설정 › 고급 › **개발자 모드** 켜기 → A의 채팅 채널·포럼 채널을 우클릭 › ID 복사 → `.env`
7. `.env.example`을 `.env`로 복사해 값을 채운다.

## 2. 실행(VS Code 터미널, 레포 루트)

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r tools/verify/requirements.txt

python tools/verify/verify_discord.py check     # 1~2분. 끝나면 A 채팅 채널에서 이모지가 그림으로 보이는지 확인
python tools/verify/verify_discord.py command   # 안내대로 디스코드 PC·모바일에서 메뉴를 눌러 본 뒤 Ctrl+C
python tools/verify/verify_discord.py pkce      # 브라우저에서 '승인'을 세 번
python tools/verify/verify_discord.py cleanup   # 테스트 명령·웹훅 정리
```

- `check`의 25MB 점검은 업로드에 시간이 조금 걸린다.
- `command`에서 메뉴가 안 보이면 디스코드를 새로고침(Ctrl+R)한다. 다른 계정이 있으면 그 계정으로도 눌러 거부되는지 본다.
- 결과는 `tools/verify/results.md`(git에 올라가지 않음). 토큰·시크릿·서명 값은 기록하지 않는다.
