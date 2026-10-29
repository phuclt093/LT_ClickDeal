#!/usr/bin/env bash
# In địa chỉ https://….trycloudflare.com hiện tại của tunnel
set -euo pipefail
sudo journalctl -u clickdeal-tunnel --no-pager -n 300 2>/dev/null \
  | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -n 1
