#!/usr/bin/env bash
# install-service.sh — pasang agent-hub sebagai systemd --user service.
set -euo pipefail
HUB="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR" "$HUB/logs"

if [ ! -f "$HUB/.env.hub" ]; then
  cp "$HUB/.env.hub.example" "$HUB/.env.hub"
  echo ">> dibuat $HUB/.env.hub — sesuaikan SERVER_URL/token, lalu jalankan ulang bila perlu."
fi

sed "s#__HUB__#$HUB#g" "$HUB/contrib/agent-hub.service" > "$UNIT_DIR/agent-hub.service"
systemctl --user daemon-reload
systemctl --user enable --now agent-hub.service
sleep 2
systemctl --user --no-pager status agent-hub.service | head -20
echo ">> health:"; curl -s --max-time 5 http://localhost:${PORT:-4000}/api/health || echo " (belum merespons)"
