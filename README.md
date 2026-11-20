# mos

ㅁㅇㅅ(몰래 읽는 수다방) 서버와 웹 화면. 설계 문서는 프로젝트의 기능명세서·기술 설계서를 따른다.

| 폴더 | 내용 |
| --- | --- |
| `mos/` | 서버(파이썬 3.12): 디스코드 봇 + API(FastAPI)를 한 프로세스에서 실행 |
| `web/` | 웹 화면(React + TypeScript + Vite) |
| `tests/` | 서버 테스트(pytest) |
| `deploy/` | 자동 배포(VM) |
| `tools/verify/` | 개발 1단계 초기 검증 스크립트 |
| `tools/dev/` | 내 PC에서 실행하는 도구 |

## 내 PC에서 실행(2단계: 읽기 최소판)

테스트 앱(mos-test)과 테스트 서버에서만 한다. 처음 한 번:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install --require-hashes -r requirements.txt
.venv\Scripts\python -m pip install -r requirements-dev.txt
cd web; npm ci; cd ..
```

`tools/dev/.env.example`을 `tools/dev/.env`로 복사해 채운다(봇 토큰, OAuth 클라이언트 ID·시크릿, 암호화 열쇠, 볼 채널 ID).
개발자 포털 › OAuth2 › Redirects에 `http://localhost:5173/api/auth/connect/callback`을 등록해 둔다.

터미널 두 개에서:

```powershell
# 1) 서버(봇 + API, 127.0.0.1:8000)
.venv\Scripts\python tools/dev/run_local.py

# 2) 웹 화면(http://localhost:5173)
cd web; npm run dev
```

브라우저에서 http://localhost:5173 을 연다(127.0.0.1 주소는 안 됨). 계정 연결 → 비밀번호 정하기 → 채널 하나가 실시간으로 보인다.

## 검사

```powershell
.venv\Scripts\python -m pytest -q
.venv\Scripts\ruff check .
cd web; npm run build
```

main에 push하면 GitHub Actions가 같은 검사를 하고, 통과하면 VM이 3분 안에 새 버전을 가져간다(`deploy/README.md`).

## 의존성 바꾸기

`requirements.in`을 고친 뒤 해시 고정 파일을 다시 만든다(서버는 해시가 맞는 휠만 설치).

```powershell
pip install uv
uv pip compile requirements.in --universal --python-version 3.12 --generate-hashes -o requirements.txt
```
