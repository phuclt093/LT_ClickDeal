#!/usr/bin/env bash
# Cài ClickDeal trên Ubuntu (22.04/24.04): Docker + Postgres + API + Cloudflare Tunnel + sao lưu hằng ngày.
# Chạy:  bash platform/deploy/install.sh     (chạy lại nhiều lần cũng an toàn)
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$DEPLOY_DIR/../server" && pwd)"
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mLỖI: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "Đừng chạy bằng root. Chạy bằng user thường có quyền sudo."
command -v sudo >/dev/null || die "Cần sudo."
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "Cảnh báo: script viết cho Ubuntu, máy này là ${PRETTY_NAME:-không rõ}."

say "1/5 Cài Docker và công cụ cần thiết"
if ! command -v docker >/dev/null || ! sudo docker compose version >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose-v2 openssl curl
fi
sudo systemctl enable --now docker

say "2/5 Tạo file cấu hình bí mật .env (chỉ lần đầu)"
ENV_FILE="$SERVER_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  PGPW="$(openssl rand -hex 24)"
  MK="$(openssl rand -base64 32)"
  umask 077
  cat > "$ENV_FILE" <<CONF
PORT=8080
PUBLIC_BASE_URL=
POSTGRES_PASSWORD=$PGPW
DATABASE_URL=postgres://clickdeal:$PGPW@db:5432/clickdeal
MASTER_KEY=$MK
COOKIE_SECURE=true
AUTO_APPROVE_AFFILIATES=true
ACCESSTRADE_BASE_URL=https://api.accesstrade.vn
SHOPEE_GRAPHQL_URL=https://open-api.affiliate.shopee.vn/graphql
SYNC_INTERVAL_MS=1200000
NETWORK_MIN_INTERVAL_MS=6500
CONF
  echo "Đã tạo $ENV_FILE (quyền 600). HÃY SAO LƯU FILE NÀY RA CHỖ AN TOÀN: mất MASTER_KEY = mất toàn bộ dữ liệu mã hóa."
else
  echo "Đã có $ENV_FILE, giữ nguyên."
fi
# Affiliate mặc định cho người mua đăng ký không có mã mời:  DEFAULT_INVITE_CODE=PHUC bash platform/deploy/install.sh
if [ -n "${DEFAULT_INVITE_CODE:-}" ]; then
  CODE="$(printf '%s' "$DEFAULT_INVITE_CODE" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z0-9')"
  if grep -q '^DEFAULT_INVITE_CODE=' "$ENV_FILE"; then
    sed -i "s/^DEFAULT_INVITE_CODE=.*/DEFAULT_INVITE_CODE=$CODE/" "$ENV_FILE"
  else
    echo "DEFAULT_INVITE_CODE=$CODE" >> "$ENV_FILE"
  fi
  echo "Người mua không có mã mời sẽ được gắn vào affiliate $CODE."
fi

say "3/5 Build và chạy Postgres + API + worker"
sudo docker compose --project-directory "$SERVER_DIR" -f "$SERVER_DIR/docker-compose.yml" up -d --build
printf 'Chờ API sẵn sàng'
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then echo " OK"; break; fi
  printf '.'; sleep 2
done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null || die "API chưa chạy. Xem log: sudo docker compose --project-directory $SERVER_DIR logs api"

say "4/5 Cài Cloudflare Tunnel (đưa ra internet có HTTPS, không mở port modem)"
if ! command -v cloudflared >/dev/null; then
  ARCH="$(dpkg --print-architecture)"
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/cloudflared.deb" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb"
  sudo dpkg -i "$TMP/cloudflared.deb"
  rm -rf "$TMP"
fi
sudo install -m 644 "$DEPLOY_DIR/clickdeal-tunnel.service" /etc/systemd/system/clickdeal-tunnel.service
sudo systemctl daemon-reload
sudo systemctl enable clickdeal-tunnel
sudo systemctl restart clickdeal-tunnel

say "5/5 Sao lưu cơ sở dữ liệu lúc 3 giờ sáng mỗi ngày (giữ 14 ngày)"
chmod +x "$DEPLOY_DIR/backup.sh" "$DEPLOY_DIR/tunnel-url.sh"
echo "0 3 * * * root $DEPLOY_DIR/backup.sh >> /var/log/clickdeal-backup.log 2>&1" | sudo tee /etc/cron.d/clickdeal-backup >/dev/null

printf 'Lấy địa chỉ công khai'
URL=""
for _ in $(seq 1 30); do
  URL="$("$DEPLOY_DIR/tunnel-url.sh" 2>/dev/null || true)"
  [ -n "$URL" ] && break
  printf '.'; sleep 2
done
echo
if [ -n "$URL" ]; then
  say "XONG! Địa chỉ của bạn: $URL"
  echo "  Trang affiliate:  $URL/aff/"
  echo "  Link mời khách:   $URL/j/<MÃ-AFFILIATE>"
  echo "Lưu ý: địa chỉ trycloudflare đổi mỗi khi máy/tunnel khởi động lại. Xem lại: $DEPLOY_DIR/tunnel-url.sh"
else
  echo "Tunnel đang khởi động, chạy lại sau ít giây: $DEPLOY_DIR/tunnel-url.sh"
fi
