#!/bin/sh
# 매일 DB 백업(앱이 돌고 있어도 안전한 .backup 사용), 7일치 보관
set -eu
day=$(date +%F)
target="/opt/mos/backup/mos-${day}.db"
umask 077
sqlite3 /opt/mos/data/mos.db ".backup '${target}'"
find /opt/mos/backup -name 'mos-*.db' -mtime +7 -delete
