# 배포

main에 push하면 GitHub Actions가 검사하고 배포 묶음을 만든다. VM은 3분마다 마지막 성공 빌드를 확인해 새 버전이면 가져가서 교체한다. 자세한 서버 준비는 구축 가이드 문서를 따른다.

```
push(main) → Actions: ruff·pytest·웹 빌드 → 묶음(release) 업로드
VM 타이머(3분) → 새 커밋이면 내려받기 → 해시 확인 → 새 릴리스 폴더 → DB 백업
              → 링크 교체 → 재시작 → /api/healthz 확인 → 실패 시 직전 버전으로 되돌림
              → 결과를 운영자에게 디스코드 DM
```

## 폴더

| 파일 | 위치(VM) | 갱신 |
| --- | --- | --- |
| `vm/mos_deploy.py` | `/opt/mos-deploy/` | 수동(`install.sh` 다시 실행) |
| `vm/mos-deploy.service`, `.timer` | `/etc/systemd/system/` | 수동 |
| `mos.service` | `/etc/systemd/system/` | 수동 |
| `Caddyfile` | `/etc/caddy/Caddyfile` | 수동 |
| `vm/backup.sh` | `/opt/mos/backup.sh` | 수동 |
| 앱 코드·웹 화면 | `/opt/mos/releases/<커밋>`, `/srv/mos-web/releases/<커밋>` | **자동** |

배포 도구와 서버 설정은 일부러 자동 갱신하지 않는다. main에 push할 수 있는 사람이 root 권한까지 얻지 않게 하고, 설정 실수로 접속이 막히는 일을 막기 위해서다.

설치·갱신(VM에서):

```bash
sudo sh deploy/vm/install.sh R4NBBIT/<레포> <도메인>
```

## 앱이 지켜야 할 약속

자동 배포가 제대로 동작하려면 서버 코드가 다음을 지킨다.

1. **`GET /api/healthz`**: `{"ok": true, "version": "<커밋>", "db": true, "gateway": true}`를 돌려준다.
   - `version`은 `mos/` 옆의 `VERSION` 파일 내용(`Path(__file__).resolve().parents[1] / "VERSION"`). 로컬 개발처럼 파일이 없으면 `"dev"`.
   - `ok`는 DB 쓰기 가능 **그리고** 디스코드 게이트웨이 연결 완료일 때만 `true`. 아니면 HTTP 503.
   - 시작 후 90초 안에 `ok: true`가 되지 않으면 배포 실패로 보고 되돌린다.
2. **비밀 값은 환경 변수로만 읽는다.** `.env` 파일을 직접 열지 않는다(systemd가 넣어 준다. 파일은 root만 읽을 수 있다).
3. **쓰기는 `/opt/mos/data`에만.** 코드 폴더는 읽기 전용이다.
4. **DB 변경은 앱 시작 때 자동 적용하고, "추가만" 한다.** 컬럼·테이블 삭제나 이름 변경은 다음 배포로 나눈다. 되돌린 직전 버전이 새 DB 구조에서도 돌아가야 하기 때문이다.
5. **재연결 시 메시지 보충.** 재시작 동안(5~10초) 놓친 메시지는 봇이 다시 연결된 뒤 채널별 마지막 메시지 이후를 불러와 채운다.
6. **파이썬 패키지는 해시 고정.** `requirements.in`을 고친 뒤 `pip-compile --generate-hashes -o requirements.txt requirements.in`. 서버는 휠(바이너리)만 설치하므로 휠이 없는 패키지는 쓸 수 없다.
7. **웹 화면 새 버전 적용.** 열려 있는 화면은 잠금 해제나 탭을 다시 열 때 서버 버전을 확인해 조용히 새로고침한다. 위장 화면이 떠 있는 동안에는 절대 새로고침하지 않는다.

## 자주 쓰는 명령(VM)

```bash
# 지금 바로 확인·배포
sudo systemctl start mos-deploy
journalctl -u mos-deploy -n 50 --no-pager

# 자동 배포 잠시 멈춤 / 다시 시작
sudo touch /etc/mos-deploy/paused
sudo rm /etc/mos-deploy/paused

# 2번 실패해 건너뛰는 버전을 다시 시도
sudo python3 -I /opt/mos-deploy/mos_deploy.py --force

# 지금 돌고 있는 버전
readlink /opt/mos/current

# GitHub 토큰 교체(만료 시 DM이 온다)
sudo sh -c 'umask 077; cat > /etc/mos-deploy/token'   # 붙여넣고 Ctrl+D
```

문제가 있는 버전을 되돌릴 때는 GitHub에서 그 커밋을 `git revert`해 main에 올리면 자동으로 배포된다.
