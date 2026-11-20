#!/bin/sh
# ㅁㅇㅅ 서버 설치(처음 한 번, 그리고 deploy/ 폴더의 파일을 바꿨을 때)
#
# 사용: sudo sh deploy/vm/install.sh <GitHub owner/repo> <도메인>
# 예:   sudo sh deploy/vm/install.sh R4NBBIT/mos chat.example.com
#
# 하는 일
#   - 자동 배포 스크립트·타이머, 앱 서비스, Caddy 설정, 매일 백업을 설치한다
#   - GitHub 읽기 전용 토큰을 처음 한 번 입력받아 root만 읽을 수 있게 저장한다
# 하지 않는 일
#   - /opt/mos/.env 작성(비밀 값은 직접 넣는다)
set -eu

repo="${1:-}"
domain="${2:-}"
if ! printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'; then
	echo "첫 번째 인자는 owner/repo 형식이어야 합니다" >&2
	exit 1
fi
if ! printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; then
	echo "두 번째 인자는 도메인이어야 합니다(예: chat.example.com)" >&2
	exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
	echo "sudo로 실행하세요" >&2
	exit 1
fi
if ! id mos >/dev/null 2>&1; then
	echo "mos 계정이 없습니다. 가이드 4단계를 먼저 하세요" >&2
	exit 1
fi

here=$(cd "$(dirname "$0")" && pwd)
deploy_dir=$(dirname "$here")

# 1) 자동 배포 스크립트
install -d -o root -g root -m 755 /opt/mos-deploy
install -o root -g root -m 755 "$here/mos_deploy.py" /opt/mos-deploy/mos_deploy.py
install -d -o root -g root -m 700 /etc/mos-deploy /var/lib/mos-deploy /var/cache/mos-deploy
printf 'GITHUB_REPO=%s\nBRANCH=main\n' "$repo" >/etc/mos-deploy/config
chmod 600 /etc/mos-deploy/config

if [ ! -s /etc/mos-deploy/token ]; then
	echo "GitHub 토큰(읽기 전용)을 붙여넣고 Enter를 누르세요. 화면에 표시되지 않습니다."
	trap 'stty echo 2>/dev/null || true' EXIT INT TERM
	stty -echo
	read -r token
	stty echo
	echo
	if [ -z "$token" ]; then
		echo "토큰이 비어 있습니다" >&2
		exit 1
	fi
	(umask 077 && printf '%s\n' "$token" >/etc/mos-deploy/token)
	unset token
fi
chown root:root /etc/mos-deploy/token
chmod 600 /etc/mos-deploy/token

# 2) 릴리스 폴더(코드는 root 소유, 앱 계정은 읽기만)
install -d -o mos -g mos -m 750 /opt/mos
install -d -o root -g mos -m 750 /opt/mos/releases
install -d -o mos -g mos -m 700 /opt/mos/data /opt/mos/backup
install -d -o root -g root -m 755 /srv/mos-web /srv/mos-web/releases

# 3) 앱 서비스와 자동 배포 타이머
install -o root -g root -m 644 "$deploy_dir/mos.service" /etc/systemd/system/mos.service
install -o root -g root -m 644 "$here/mos-deploy.service" /etc/systemd/system/mos-deploy.service
install -o root -g root -m 644 "$here/mos-deploy.timer" /etc/systemd/system/mos-deploy.timer

# 4) 매일 백업(04:30)
install -o mos -g mos -m 700 "$here/backup.sh" /opt/mos/backup.sh
printf '30 4 * * * mos /opt/mos/backup.sh\n' >/etc/cron.d/mos-backup
chmod 644 /etc/cron.d/mos-backup

# 5) Caddy
sed "s/{{DOMAIN}}/$domain/g" "$deploy_dir/Caddyfile" >/etc/caddy/Caddyfile.new
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
systemctl reload caddy

systemctl daemon-reload
systemctl enable mos.service
systemctl enable --now mos-deploy.timer

if [ ! -f /opt/mos/.env ]; then
	echo "주의: /opt/mos/.env가 아직 없습니다. 가이드 6단계대로 만든 뒤 첫 배포를 확인하세요."
fi
echo "설치 완료."
echo "첫 배포 확인: sudo systemctl start mos-deploy && journalctl -u mos-deploy -n 50 --no-pager"
