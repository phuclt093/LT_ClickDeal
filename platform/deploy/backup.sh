#!/usr/bin/env bash
# Sao lưu Postgres ra platform/server/backups (giữ 14 ngày).
# Bản sao lưu chứa khóa API ĐÃ MÃ HÓA; muốn khôi phục cần MASTER_KEY trong .env → sao lưu .env riêng, cất chỗ khác.
set -euo pipefail
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)"
OUT="$SERVER_DIR/backups"
mkdir -p "$OUT"
chmod 700 "$OUT"
FILE="$OUT/clickdeal-$(date +%F-%H%M).sql.gz"
docker compose --project-directory "$SERVER_DIR" -f "$SERVER_DIR/docker-compose.yml" exec -T db \
  pg_dump -U clickdeal -d clickdeal | gzip > "$FILE"
chmod 600 "$FILE"
find "$OUT" -name 'clickdeal-*.sql.gz' -mtime +14 -delete
echo "$(date -Is) đã sao lưu $FILE"
