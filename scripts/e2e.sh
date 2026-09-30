#!/usr/bin/env bash
# e2e.sh — uji E2E agent-hub TANPA memakai kuota agy asli.
# Menjalankan mock-server + runner dengan `agy` tiruan di PATH.
# Mode: MODE=ok (gate hijau -> COMPLETED) | MODE=red (exit 0 tapi gate merah -> FAILED)
set -uo pipefail

HUB="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${MODE:-ok}"
WORK="${WORK:-/tmp/ah-e2e}"
REPO="$WORK/repo"
BIN="$WORK/bin"
OUT="$WORK/callback.jsonl"
MOCK_PORT="${MOCK_PORT:-4555}"
HUB_PORT="${HUB_PORT:-4400}"

echo "=== E2E agent-hub | mode=$MODE | work=$WORK ==="
rm -rf "$WORK"; mkdir -p "$REPO" "$BIN"

# --- scratch repo + gate ---
cd "$REPO"
git init -q
git config user.email e2e@local; git config user.name e2e
printf '#!/usr/bin/env bash\n[ -f ok.txt ]\n' > run-gate.sh; chmod +x run-gate.sh
printf '{ "gate": ["bash run-gate.sh"] }\n' > .agent-hub.json
echo base > base.txt
git add -A; git commit -qm base

# --- agy tiruan ---
cat > "$BIN/agy" <<EOF
#!/usr/bin/env bash
# fake agy (mode=$MODE)
case "$MODE" in
  ok)  echo "fake-agy: sukses, menulis ok.txt"; echo ok > "$REPO/ok.txt"; exit 0 ;;
  red) echo "fake-agy: exit 0 tapi tidak ada perubahan"; exit 0 ;;
  *)   echo "fake-agy: gagal"; exit 2 ;;
esac
EOF
chmod +x "$BIN/agy"

# --- start mock server ---
E2E_REPO="$REPO" E2E_OUT="$OUT" MOCK_PORT="$MOCK_PORT" bun "$HUB/scripts/mock-server.ts" \
  > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
sleep 1

# --- start runner (cwd=WORK supaya sqlite terpisah) ---
cd "$WORK"
PATH="$BIN:$PATH" \
SERVER_URL="http://localhost:$MOCK_PORT" \
PORT="$HUB_PORT" POLL_MS=1000 AGENT_NAME=agent-hub \
bun "$HUB/runner.ts" > "$WORK/runner.log" 2>&1 &
RUN_PID=$!

# --- tunggu callback (max ~40s) ---
for i in $(seq 1 40); do
  [ -s "$OUT" ] && break
  sleep 1
done

kill "$RUN_PID" "$MOCK_PID" 2>/dev/null
wait 2>/dev/null

echo "--- callback ---"
if [ -s "$OUT" ]; then cat "$OUT"; else echo "(TIDAK ADA CALLBACK)"; fi
echo "--- runner log (tail) ---"; tail -12 "$WORK/runner.log"

STATUS=$(python3 -c "import json,sys;print(json.loads(open('$OUT').read().splitlines()[-1])['status'])" 2>/dev/null || echo NONE)
echo "=== HASIL: mode=$MODE status=$STATUS ==="

if [ "$MODE" = "ok" ]  && [ "$STATUS" = "COMPLETED" ]; then echo "PASS"; exit 0; fi
if [ "$MODE" = "red" ] && [ "$STATUS" = "FAILED" ] && grep -q "GATE GAGAL\|gate" "$OUT"; then echo "PASS"; exit 0; fi
echo "FAIL"; exit 1
